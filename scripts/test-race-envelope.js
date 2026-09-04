/**
 * Test manual — Roadmap P.6 / fix C-6 (sobres duplicados por doble pestaña).
 *
 * Crea un Miembro real y dispara DOS POST /api/docusign/envelope en
 * paralelo (Promise.all, no en secuencia) contra el MISMO memberId+token,
 * simulando dos pestañas apretando "Firmar" casi a la vez. Después consulta
 * la base directamente (no confía solo en las respuestas HTTP) para contar
 * cuántos sobres quedaron realmente:
 *   - member_envelopes debe tener exactamente 1 fila para este Miembro.
 *   - members.envelope_id debe ser ese mismo sobre.
 *
 * Requiere el servidor corriendo (BASE_URL) contra la MISMA base que carga
 * este script vía DATABASE_URL (.env) — así la verificación es contra la
 * fuente real, no contra lo que cada response HTTP dice por separado.
 *
 * Uso:
 *   BASE_URL=http://localhost:3000 node scripts/test-race-envelope.js
 *
 * OJO: crea un Miembro real (fila en `members`) y, si el fix falla, sobres
 * reales en la cuenta DEMO de DocuSign. No corran esto contra credenciales
 * de producción de DocuSign.
 */
require("dotenv").config();
const { Pool } = require("pg");

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let ok = 0, ko = 0;
const chk = (n, c, d) => { c ? ok++ : ko++; console.log(`  ${c ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };

(async () => {
  console.log(`Backend: ${BASE_URL}\n`);

  console.log("== Setup: creando Miembro de prueba ==");
  const email = `race-test-${Date.now()}@example.com`;
  const createRes = await fetch(`${BASE_URL}/api/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Race Test", docId: `RACE-${Date.now()}`, email, amountUsd: 1000 }),
  });
  const createBody = await createRes.json();
  if (!createRes.ok || !createBody.memberId || !createBody.token) {
    console.error("No se pudo crear el Miembro de prueba:", createRes.status, createBody);
    process.exit(1);
  }
  const { memberId, token } = createBody;
  console.log(`  Miembro creado — memberId=${memberId}\n`);

  console.log("== Disparando 2x POST /api/docusign/envelope EN PARALELO (mismo memberId) ==");
  const fireEnvelope = () =>
    fetch(`${BASE_URL}/api/docusign/envelope`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ memberId }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const t0 = Date.now();
  const [r1, r2] = await Promise.all([fireEnvelope(), fireEnvelope()]);
  const elapsedMs = Date.now() - t0;
  console.log(`  request A → HTTP ${r1.status} (${JSON.stringify(r1.body).slice(0, 120)})`);
  console.log(`  request B → HTTP ${r2.status} (${JSON.stringify(r2.body).slice(0, 120)})`);
  console.log(`  (${elapsedMs}ms totales para ambas — si el lock serializa, esto tarda ~2x una sola llamada, no ~1x)\n`);

  chk("ambas requests concurrentes devuelven 200", r1.status === 200 && r2.status === 200);

  console.log("\n== Verificando contra la base de datos (no contra lo que dicen las responses) ==");
  const { rows: memberRows } = await pool.query(
    `SELECT public_token, status, envelope_id FROM members WHERE public_token = $1`,
    [memberId]
  );
  const member = memberRows[0];
  chk("el Miembro quedó en 'firma_pendiente'", member && member.status === "firma_pendiente", `status=${member && member.status}`);
  chk("members.envelope_id quedó cargado", !!(member && member.envelope_id));

  const { rows: envelopeRows } = await pool.query(
    `SELECT envelope_id, created_at FROM member_envelopes WHERE member_public_token = $1 ORDER BY created_at`,
    [memberId]
  );
  console.log(`  member_envelopes para este Miembro: ${envelopeRows.length} fila(s) — ${envelopeRows.map(r => r.envelope_id).join(", ") || "(ninguna)"}`);
  chk("se creó EXACTAMENTE UN sobre en member_envelopes (no 2)", envelopeRows.length === 1);
  if (envelopeRows.length >= 1 && member) {
    chk("members.envelope_id coincide con el sobre registrado", member.envelope_id === envelopeRows[0].envelope_id);
  }

  console.log(`\n  ${ok} OK · ${ko} fallidos`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch(async (err) => {
  console.error("Error inesperado:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
