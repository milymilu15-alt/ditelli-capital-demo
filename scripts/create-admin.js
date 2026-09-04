#!/usr/bin/env node
/**
 * Crea (o resetea la contraseña de) un usuario del panel de administración.
 *
 * admin_users no tiene ningún endpoint de registro a propósito — un panel
 * que mueve gente a "activo" no puede tener una ruta HTTP pública de "creá
 * tu cuenta". Este script es la única forma de dar de alta un admin, y
 * sirve tanto para el primero (bootstrap) como para cualquiera después:
 * si el username ya existe, actualiza su contraseña en vez de fallar (ver
 * db.createAdminUser, ON CONFLICT DO UPDATE).
 *
 * Uso:
 *   node scripts/create-admin.js <usuario> <contraseña>
 *
 * La contraseña se pasa por argumento (nunca hardcodeada acá) — en un
 * servidor compartido, preferí exportarla como variable de entorno y
 * pasarla con $ADMIN_PASSWORD en vez de dejarla en el historial de la
 * shell.
 */
require("dotenv").config();
const adminAuth = require("../src/adminAuth");
const db = require("../src/db");

(async () => {
  const username = (process.argv[2] || "").trim();
  const password = process.argv[3] || "";

  if (!username || !password) {
    console.error("Uso: node scripts/create-admin.js <usuario> <contraseña>");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("La contraseña debe tener al menos 8 caracteres.");
    process.exit(1);
  }

  const passwordHash = await adminAuth.hashPassword(password);
  const admin = await db.createAdminUser({ username, passwordHash });
  console.log(`✅ Admin "${admin.username}" listo (id ${admin.id}). Ya puede loguearse en /api/admin/login.`);
  process.exit(0);
})().catch((err) => {
  console.error("Error creando el admin:", err);
  process.exit(1);
});
