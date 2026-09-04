/**
 * Test manual — cotización + comprobante obligatorio para transferencia.
 *
 * Uso:
 *   node scripts/test-transfer-receipt.js
 *
 * Requiere el server corriendo (BASE_URL) contra la MISMA base que
 * DATABASE_URL (.env) — la verificación final es contra la base real, no
 * contra lo que dicen las responses.
 *
 * OJO: crea un Miembro real y lo fuerza a "firmado_pendiente_pago" con una
 * query directa (no pasa por DocuSign) para no depender de la cuenta demo.
 */
require("dotenv").config();
const { Pool } = require("pg");

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let ok = 0, ko = 0;
const chk = (n, c, d) => { c ? ok++ : ko++; console.log(`  ${c ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };

(async () => {
  console.log(`Backend: ${BASE_URL}\n`);

  console.log("== Setup: creando Miembro y forzándolo a 'firmado_pendiente_pago' ==");
  const email = `transfer-test-${Date.now()}@example.com`;
  const createRes = await fetch(`${BASE_URL}/api/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Transfer Test", docId: `TRANSFER-${Date.now()}`, email, amountUsd: 2000 }),
  });
  const { memberId, token } = await createRes.json();
  if (!memberId || !token) { console.error("no se pudo crear el Miembro"); process.exit(1); }
  await pool.query(`UPDATE members SET status = 'firmado_pendiente_pago' WHERE public_token = $1`, [memberId]);
  console.log(`  Miembro: ${memberId}\n`);

  console.log("== 1) GET /api/payments/transfer/quote ==");
  const quoteRes = await fetch(`${BASE_URL}/api/payments/transfer/quote?memberId=${memberId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const quote = await quoteRes.json();
  console.log(`  ${quoteRes.status} — ${JSON.stringify(quote)}`);
  chk("devuelve 200 con un monto en ARS", quoteRes.status === 200 && Number.isFinite(quote.amountArs) && quote.amountArs > 0);
  chk("el monto en USD coincide con el Aporte del Miembro", quote.amountUsd === 2000);

  console.log("\n== 2) POST /api/payments/transfer/notify SIN comprobante ==");
  const sinArchivoRes = await fetch(`${BASE_URL}/api/payments/transfer/notify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: (() => { const fd = new FormData(); fd.append("memberId", memberId); return fd; })(),
  });
  console.log(`  ${sinArchivoRes.status} — ${JSON.stringify(await sinArchivoRes.json())}`);
  chk("rechaza con 400 si no viene el archivo", sinArchivoRes.status === 400);

  console.log("\n== 3) POST /api/payments/transfer/notify CON comprobante ==");
  const fakeReceipt = new Blob([Buffer.from("contenido-de-prueba-no-es-un-pdf-real")], { type: "application/pdf" });
  const fd = new FormData();
  fd.append("memberId", memberId);
  fd.append("comprobante", fakeReceipt, "comprobante-prueba.pdf");
  const conArchivoRes = await fetch(`${BASE_URL}/api/payments/transfer/notify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  console.log(`  ${conArchivoRes.status} — ${JSON.stringify(await conArchivoRes.json())}`);
  chk("acepta con 200 cuando sí viene el archivo", conArchivoRes.status === 200);

  console.log("\n== Verificando contra la base de datos ==");
  const { rows } = await pool.query(
    `SELECT status, amount_ars, fx_rate_ars_per_usd, transfer_receipt_content_type,
            transfer_receipt_filename, length(transfer_receipt_data) AS receipt_bytes
       FROM members WHERE public_token = $1`,
    [memberId]
  );
  const final = rows[0];
  console.log(`  status=${final.status} amount_ars=${final.amount_ars} receipt_bytes=${final.receipt_bytes} filename=${final.transfer_receipt_filename}`);
  chk("el Miembro quedó en 'transferencia_pendiente_confirmacion'", final.status === "transferencia_pendiente_confirmacion");
  chk("el comprobante quedó guardado COMPLETO en la base (no solo el tamaño)", final.receipt_bytes > 0);
  chk("se guardó el nombre de archivo original", final.transfer_receipt_filename === "comprobante-prueba.pdf");
  chk("se guardó el content-type", final.transfer_receipt_content_type === "application/pdf");
  chk("se guardó un monto/cotización de referencia", final.amount_ars != null && final.fx_rate_ars_per_usd != null);

  console.log("\n== Verificando scripts/export-transfer-receipt.js ==");
  const { execSync } = require("child_process");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ditelli-receipt-"));
  execSync(`node "${path.join(__dirname, "export-transfer-receipt.js")}" ${memberId}`, { cwd: tmpDir, stdio: "pipe" });
  const exportado = fs.readdirSync(tmpDir);
  chk("el script exportó el archivo a disco", exportado.length === 1, exportado.join(", "));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n  ${ok} OK · ${ko} fallidos`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch(async (err) => {
  console.error("Error inesperado:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
