/**
 * Test manual — guarda atómica de db.confirmTransfer (panel de admin, Fase 2).
 *
 * A diferencia de markPaid (test-markpaid.js), confirmTransfer no tiene
 * lógica JS separable para extraer y fakear: es un único
 * `UPDATE ... WHERE status = 'transferencia_pendiente_confirmacion' ...
 * RETURNING` — la guarda contra doble-confirmación ES la cláusula WHERE.
 * Mismo criterio que test-race-payment.js / test-transfer-receipt.js: para
 * probar de verdad una guarda que vive en SQL, hay que correrla contra
 * Postgres real, no contra un mock que reimplemente a mano la semántica que
 * se está intentando validar.
 *
 * Uso:
 *   node scripts/test-confirm-transferencia.js
 *
 * OJO: crea un Miembro de prueba real (fila en `members`, vía
 * db.createMemberManual) y lo borra al final. Si el script se corta a mitad
 * de camino (Ctrl+C, crash), puede quedar una fila huérfana con email
 * "confirm-transfer-test-*@example.com" — se puede borrar a mano.
 */
require("dotenv").config();
const db = require("../src/db");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let ok = 0, ko = 0;
const chk = (n, c, d) => { c ? ok++ : ko++; console.log(`  ${c ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };

async function crearMiembroDePrueba(sufijo) {
  return db.createMemberManual({
    name: `Confirm Transfer Test ${sufijo}`,
    docId: `CONFIRMTEST-${sufijo}`,
    email: `confirm-transfer-test-${sufijo}@example.com`,
    phone: null,
    amountUsd: 1000,
    status: "transferencia_pendiente_confirmacion",
    proportionalPct: 0.2,
  });
}

(async () => {
  const idsACrear = [];
  try {
    console.log("== 1) Confirmar una transferencia legítima ==");
    const m1 = await crearMiembroDePrueba(`${Date.now()}-A`);
    idsACrear.push(m1.id);
    const confirmado = await db.confirmTransfer(m1.id, "admin-test-1");
    chk("confirmTransfer devuelve el Miembro actualizado", !!confirmado);
    chk("pasa a 'activo'", confirmado && confirmado.status === "activo");
    chk("registra quién confirmó", confirmado && confirmado.transferConfirmedBy === "admin-test-1");
    chk("registra cuándo", confirmado && confirmado.transferConfirmedAt instanceof Date);

    console.log("\n== 2) Reintentar confirmar el MISMO Miembro (ya está 'activo') ==");
    const reintento = await db.confirmTransfer(m1.id, "admin-test-2");
    chk("la guarda bloquea la doble confirmación (no devuelve nada)", reintento === undefined);
    const { rows: filaFinal } = await pool.query(
      `SELECT status, transfer_confirmed_by FROM members WHERE public_token = $1`,
      [m1.id]
    );
    chk(
      "el segundo intento NO pisa quién confirmó primero",
      filaFinal[0].transfer_confirmed_by === "admin-test-1",
      `quedó: ${filaFinal[0].transfer_confirmed_by}`
    );

    console.log("\n== 3) Confirmar un Miembro que NUNCA estuvo en 'transferencia_pendiente_confirmacion' ==");
    const m2 = await db.createMember({ name: "Confirm Transfer Test B", docId: `CONFIRMTEST-${Date.now()}-B`, email: `confirm-transfer-test-${Date.now()}-b@example.com`, phone: null, amountUsd: 500 });
    idsACrear.push(m2.id); // status='nuevo' por defecto (ver db.createMember)
    const bloqueado = await db.confirmTransfer(m2.id, "admin-test-3");
    chk("la guarda también bloquea un Miembro en cualquier otro estado ('nuevo')", bloqueado === undefined);

    console.log("\n== 4) Dos confirmaciones EN PARALELO sobre el mismo Miembro (condición de carrera real) ==");
    const m3 = await crearMiembroDePrueba(`${Date.now()}-C`);
    idsACrear.push(m3.id);
    const [ra, rb] = await Promise.all([
      db.confirmTransfer(m3.id, "admin-paralelo-A"),
      db.confirmTransfer(m3.id, "admin-paralelo-B"),
    ]);
    const ganadores = [ra, rb].filter(Boolean);
    chk("de dos confirmaciones simultáneas, gana exactamente UNA", ganadores.length === 1, `resultados: ${JSON.stringify([!!ra, !!rb])}`);
    const { rows: filaParalelo } = await pool.query(
      `SELECT transfer_confirmed_by FROM members WHERE public_token = $1`,
      [m3.id]
    );
    chk(
      "quien ganó coincide con quien quedó grabado en la base",
      ganadores[0] && ganadores[0].transferConfirmedBy === filaParalelo[0].transfer_confirmed_by
    );

    console.log(`\n  ${ok} OK · ${ko} fallidos`);
  } finally {
    console.log("\n== Limpieza: borrando Miembros de prueba ==");
    if (idsACrear.length) {
      const { rowCount } = await pool.query(
        `DELETE FROM members WHERE public_token = ANY($1::uuid[])`,
        [idsACrear]
      );
      console.log(`  Borrados: ${rowCount}`);
    }
    await pool.end();
  }
  process.exit(ko ? 1 : 0);
})().catch(async (err) => {
  console.error("Error inesperado:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
