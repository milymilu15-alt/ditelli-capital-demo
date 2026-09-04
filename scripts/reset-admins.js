#!/usr/bin/env node
/**
 * Borra TODOS los usuarios del panel de administración y crea dos nuevos.
 *
 * Complementa a create-admin.js, que solo sabe crear/actualizar de a uno y
 * nunca borra. Acá el borrado y las altas van dentro de UNA transacción: si
 * algo falla en el medio se revierte todo, para que no quede una base sin
 * ningún admin (que dejaría el panel inaccesible, porque admin_users no
 * tiene endpoint de registro a propósito).
 *
 * Uso:
 *   node scripts/reset-admins.js --confirmar "<pass-matias>" "<pass-milagros>"
 *
 * Sin --confirmar solo LISTA los admins actuales y no toca nada.
 *
 * Las contraseñas se pasan por argumento y nunca se escriben en este
 * archivo, igual que en create-admin.js. Ojo con el historial de la shell.
 */
require("dotenv").config();
const { Pool } = require("pg");
const adminAuth = require("../src/adminAuth");

const USUARIOS = ["matias", "milagros"];

const useSSL =
  (process.env.DATABASE_URL || "").includes("sslmode=require") ||
  (process.env.DATABASE_URL || "").includes("neon.tech");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

(async () => {
  const confirmar = process.argv.includes("--confirmar");
  const passwords = process.argv.slice(2).filter((a) => a !== "--confirmar");

  // A qué base nos estamos conectando. Este proyecto tiene una base para
  // demo y producción y varias branches en Neon: crear los admins en la
  // equivocada da un "usuario o contraseña incorrectos" imposible de
  // diagnosticar desde el navegador. Se muestra sin la contraseña.
  try {
    const u = new URL(process.env.DATABASE_URL || "");
    console.log(`\nBase de datos: ${u.hostname}${u.pathname}  (usuario ${u.username})`);
  } catch {
    console.error("\n DATABASE_URL vacía o mal formada en el .env — no puedo continuar.");
    process.exit(1);
  }

  // Siempre se muestra el estado actual antes de tocar nada.
  const { rows: actuales } = await pool.query(
    "SELECT id, username, created_at FROM admin_users ORDER BY id"
  );
  console.log(`\nAdmins actuales (${actuales.length}):`);
  if (actuales.length === 0) console.log("   (ninguno)");
  actuales.forEach((a) =>
    console.log(`   [${a.id}] ${a.username}  — creado ${new Date(a.created_at).toLocaleString("es-AR")}`)
  );

  if (!confirmar) {
    console.log(
      '\nModo lectura. Para aplicar los cambios:\n' +
      '   node scripts/reset-admins.js --confirmar "<pass-matias>" "<pass-milagros>"\n'
    );
    await pool.end();
    process.exit(0);
  }

  if (passwords.length !== USUARIOS.length) {
    console.error(
      `\n Hacen falta ${USUARIOS.length} contraseñas (${USUARIOS.join(", ")}) y llegaron ${passwords.length}.`
    );
    await pool.end();
    process.exit(1);
  }
  const corta = passwords.find((p) => p.length < 8);
  if (corta) {
    console.error("\n Todas las contraseñas tienen que tener al menos 8 caracteres.");
    await pool.end();
    process.exit(1);
  }

  // Se hashea ANTES de abrir la transacción: bcrypt con cost 12 tarda, y no
  // conviene tener la tabla bloqueada mientras tanto.
  const hashes = [];
  for (const p of passwords) hashes.push(await adminAuth.hashPassword(p));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount: borrados } = await client.query("DELETE FROM admin_users");
    for (let i = 0; i < USUARIOS.length; i++) {
      await client.query(
        `INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [USUARIOS[i], hashes[i]]
      );
    }
    await client.query("COMMIT");
    console.log(`\n Borrados: ${borrados}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n Falló: se revirtió todo, la tabla quedó como estaba.\n", err.message);
    await client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  const { rows: finales } = await pool.query(
    "SELECT id, username FROM admin_users ORDER BY id"
  );
  console.log(` Admins ahora (${finales.length}):`);
  finales.forEach((a) => console.log(`   [${a.id}] ${a.username}`));
  console.log("\nListo. Entrá en /admin.html con esos usuarios.\n");

  await pool.end();
  process.exit(0);
})().catch(async (err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
