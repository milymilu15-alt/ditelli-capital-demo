/**
 * Storage del PDF firmado — integración lista para activar, sin decidir
 * proveedor por vos.
 *
 * Hoy `saveSignedDocument` (src/db.js) solo guarda el TAMAÑO en bytes del
 * PDF como comprobante de que se descargó de DocuSign — el archivo en sí no
 * se persiste en ningún lado (queda recuperable a mano desde el panel de
 * DocuSign, pero no automatizado). Este módulo sube el PDF a un bucket
 * S3-compatible (funciona con AWS S3, Cloudflare R2, Backblaze B2, o
 * cualquier otro que hable el protocolo S3 — basta con cambiar
 * STORAGE_S3_ENDPOINT) y devuelve la key/URL para guardar en la base.
 *
 * Se mantiene DESACTIVADO por defecto: si STORAGE_S3_BUCKET no está seteado
 * en el entorno, uploadSignedPdf() no hace nada y devuelve null — el resto
 * del flujo (marcar al Miembro como firmado, activarlo cuando paga) sigue
 * funcionando exactamente igual que hoy, con o sin esto configurado. No se
 * agregó a REQUIRED_ENV_VARS en server.js a propósito: activarlo es
 * opcional, no bloqueante para el MVP.
 *
 * Qué falta para activarlo de verdad (decisión de infraestructura, no de
 * código — ver la sección 3 del informe de auditoría):
 *   1) Elegir proveedor (S3, R2, B2, ...) y crear el bucket, PRIVADO (estos
 *      PDFs tienen datos personales y la firma de un inversor real).
 *   2) Generar credenciales con permiso de escritura solo a ese bucket.
 *   3) Cargar STORAGE_S3_BUCKET, STORAGE_S3_REGION, STORAGE_S3_ENDPOINT
 *      (dejar sin setear si es AWS S3 "real" — solo hace falta para
 *      R2/B2/MinIO), STORAGE_S3_ACCESS_KEY_ID y STORAGE_S3_SECRET_ACCESS_KEY.
 *
 * NO PROBADO contra un bucket real (no se generaron credenciales para esta
 * auditoría, a propósito — ver alcance). Antes de confiar en esto en
 * producción, activalo contra un bucket de prueba y confirmá que
 * downloadSignedDocument → uploadSignedPdf → la URL guardada en la base
 * abre el PDF correcto.
 */

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

function isConfigured() {
  return Boolean(process.env.STORAGE_S3_BUCKET);
}

let cachedClient = null;
function getClient() {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: process.env.STORAGE_S3_REGION || "auto",
    // Sin STORAGE_S3_ENDPOINT, el SDK usa el endpoint estándar de AWS S3
    // según la región — solo hace falta setearlo para S3-compatibles
    // (R2, B2, MinIO, etc.).
    ...(process.env.STORAGE_S3_ENDPOINT ? { endpoint: process.env.STORAGE_S3_ENDPOINT } : {}),
    credentials: {
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY,
    },
  });
  return cachedClient;
}

/**
 * Sube el PDF firmado de un Miembro. No lanza si falla — el flujo de
 * negocio (Miembro firmado, PDF recuperable a mano desde DocuSign) no puede
 * depender de que un upload a un bucket externo salga bien.
 *
 * @returns {Promise<{ key: string, url: string } | null>} null si el
 *   storage no está configurado, o si el upload falló (se loguea el error).
 */
async function uploadSignedPdf({ memberId, envelopeId, pdfBytes }) {
  if (!isConfigured()) return null;

  const bucket = process.env.STORAGE_S3_BUCKET;
  const key = `acuerdos-firmados/${memberId}/${envelopeId}.pdf`;

  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: pdfBytes,
        ContentType: "application/pdf",
        // Privado a propósito: es un documento con datos personales (DNI,
        // email, monto del Aporte) y la firma de un inversor real. Si se
        // necesita que alguien lo vea, generar una URL firmada temporal
        // (GetObjectCommand + getSignedUrl) en el momento, no dejarlo
        // público de forma permanente.
        ACL: "private",
      })
    );
    const url = process.env.STORAGE_S3_ENDPOINT
      ? `${process.env.STORAGE_S3_ENDPOINT.replace(/\/+$/, "")}/${bucket}/${key}`
      : `https://${bucket}.s3.${process.env.STORAGE_S3_REGION || "us-east-1"}.amazonaws.com/${key}`;
    return { key, url };
  } catch (err) {
    console.error(`⚠️  No se pudo subir el PDF firmado del Miembro ${memberId} al storage:`, err.message || err);
    return null;
  }
}

module.exports = { uploadSignedPdf, isConfigured };
