#!/usr/bin/env node
/**
 * Exporta el comprobante de transferencia de un Miembro a un archivo local.
 *
 * No hay panel de administración en este proyecto — el equipo de Ditelli
 * confirma las transferencias a mano (ver scripts/check-estado.sql), y este
 * script es la forma de bajar el comprobante que subió el Miembro para
 * poder mirarlo antes de confirmar.
 *
 * Uso:
 *   node scripts/export-transfer-receipt.js <memberId>
 *
 * Guarda el archivo en el directorio actual, con el nombre original que
 * subió el Miembro (o "comprobante" + la extensión que corresponda al tipo
 * de archivo si no se pudo determinar el nombre original).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("./../src/db");

const EXT_POR_TIPO = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

(async () => {
  const memberId = process.argv[2];
  if (!memberId) {
    console.error("Uso: node scripts/export-transfer-receipt.js <memberId>");
    process.exit(1);
  }

  const receipt = await db.getTransferReceipt(memberId);
  if (!receipt) {
    console.error(`El Miembro ${memberId} no tiene ningún comprobante de transferencia guardado.`);
    process.exit(1);
  }

  const nombre = receipt.filename || `comprobante${EXT_POR_TIPO[receipt.contentType] || ""}`;
  const destino = path.join(process.cwd(), `${memberId}-${nombre}`);
  fs.writeFileSync(destino, receipt.data);
  console.log(`Guardado: ${destino} (${receipt.contentType}, ${receipt.data.length} bytes)`);
  process.exit(0);
})().catch((err) => {
  console.error("Error exportando el comprobante:", err);
  process.exit(1);
});
