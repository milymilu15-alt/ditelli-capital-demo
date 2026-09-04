/**
 * Test manual — condición de carrera en markPaid (hallazgo de la auditoría
 * de producción: el mismo tipo de bug que C-6 resolvió para los sobres de
 * DocuSign, pero sin corregir del lado de los pagos hasta ahora).
 *
 * Extrae el markPaid REAL de server.js (misma técnica que
 * scripts/test-markpaid.js) pero, a diferencia de ese test, lo corre contra
 * la base de datos REAL (src/db.js, no un stub) envuelto en
 * db.withMemberLock — así se prueba el mecanismo de lock de verdad, no solo
 * la lógica de markPaid en aislamiento.
 *
 * Escenario: dos pagos DISTINTOS (RACE-A y RACE-B) aprobados para el MISMO
 * Miembro, cuyos webhooks llegan casi al mismo tiempo — dispara los dos
 * "webhooks" con Promise.all (paralelo real) y verifica en la base que:
 *   - Se guardó exactamente UNO de los dos payment IDs (no se perdió
 *     ninguno en silencio, no se pisaron entre sí).
 *   - El otro quedó logueado como "COBRO DUPLICADO" para revisar a mano.
 *
 * No requiere credenciales de Mercado Pago/Stripe: markPaid no le pega a
 * ningún proveedor, solo lee/escribe el Miembro.
 *
 * Uso:
 *   node scripts/test-race-payment.js
 *
 * OJO: crea un Miembro real (fila en `members`) y lo fuerza a mano a
 * "firmado_pendiente_pago" con una query directa (no pasa por DocuSign).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("../src/db");

let ok = 0, ko = 0;
const chk = (n, c, d) => { c ? ok++ : ko++; console.log(`  ${c ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };

(async () => {
  console.log("== Extrayendo markPaid real de server.js ==");
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const m = src.match(/async function markPaid\(member, patch, origen, client\) \{[\s\S]*?\n\}/);
  if (!m) { console.error("No se encontró markPaid en server.js (¿cambió la firma?)"); process.exit(1); }

  const logs = [];
  const consoleCapturado = { log: () => {}, warn: () => {}, error: (s) => logs.push(String(s)) };
  // markPaid usa `db.updateMember` y `db.withMemberLock` — se le pasa el
  // módulo REAL de src/db.js, no un stub, para probar el lock de verdad.
  const markPaid = new Function("db", "console", `${m[0]}; return markPaid;`)(db, consoleCapturado);

  console.log("== Creando Miembro de prueba y forzándolo a 'firmado_pendiente_pago' ==");
  const email = `race-payment-${Date.now()}@example.com`;
  const member = await db.createMember({
    name: "Race Payment Test", docId: `RACEPAY-${Date.now()}`, email, phone: null, amountUsd: 1000,
  });
  // Query directa solo para el setup del test — el flujo real llega a este
  // estado vía DocuSign, que no hace falta acá porque markPaid no lo toca.
  const { Pool } = require("pg");
  const setupPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await setupPool.query(`UPDATE members SET status = 'firmado_pendiente_pago' WHERE public_token = $1`, [member.id]);
  console.log(`  Miembro: ${member.id}\n`);

  console.log("== Disparando 2 'webhooks' de pagos DISTINTOS EN PARALELO para el mismo Miembro ==");
  const fireWebhook = (paymentId) =>
    db.withMemberLock(member.id, async (lockedMember, client) => {
      if (!lockedMember) return null;
      return markPaid(lockedMember, { mpPaymentId: paymentId }, "Test", client);
    });

  // Únicos por corrida: mp_payment_id tiene un UNIQUE index (uq_members_mp_payment_id)
  // — un valor fijo choca contra el que dejó una corrida anterior.
  const idA = `RACE-A-${Date.now()}`;
  const idB = `RACE-B-${Date.now()}`;
  const t0 = Date.now();
  await Promise.all([fireWebhook(idA), fireWebhook(idB)]);
  console.log(`  (${Date.now() - t0}ms totales para ambos — si el lock serializa, no corren en 0ms cada uno)\n`);

  console.log("== Verificando contra la base de datos ==");
  const { rows } = await setupPool.query(
    `SELECT status, mp_payment_id FROM members WHERE public_token = $1`,
    [member.id]
  );
  const final = rows[0];
  console.log(`  estado final: status=${final.status} mp_payment_id=${final.mp_payment_id}`);

  chk("el Miembro quedó 'activo'", final.status === "activo");
  chk(
    "quedó guardado UNO de los dos pagos (no se perdió ninguno en silencio)",
    final.mp_payment_id === idA || final.mp_payment_id === idB,
    `mp_payment_id=${final.mp_payment_id}`
  );
  chk(
    "el OTRO pago quedó logueado como COBRO DUPLICADO (no desapareció sin dejar rastro)",
    logs.some((l) => /COBRO DUPLICADO/.test(l)),
    logs[0] ? logs[0].slice(0, 90) + "…" : "sin alerta en el log"
  );

  console.log(`\n  ${ok} OK · ${ko} fallidos`);
  await setupPool.end();
  process.exit(ko ? 1 : 0);
})().catch(async (err) => {
  console.error("Error inesperado:", err);
  process.exit(1);
});
