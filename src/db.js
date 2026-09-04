/**
 * Capa de base de datos — Postgres real, reemplaza el stub en memoria original.
 *
 * Mantiene EXACTAMENTE la misma interfaz (mismos nombres de función, mismos
 * parámetros, mismos objetos de retorno) que el stub que reemplaza, así que
 * server.js, mercadopago.js, stripe.js y docusign.js no necesitan tocarse.
 *
 * Requiere:
 *   - Haber corrido schema.sql una vez contra la base (ver ese archivo).
 *   - La variable de entorno DATABASE_URL (formato:
 *     postgres://usuario:password@host:puerto/nombre_db).
 *     Railway, Render, Neon y Supabase te la dan armada al crear la base.
 *   - Si el proveedor exige SSL (Render, Neon y Supabase lo exigen por
 *     defecto; Railway a veces no), este módulo lo detecta solo por el
 *     connection string o podés forzarlo con PGSSL=true en el .env.
 */

const { Pool } = require("pg");

const useSSL =
  process.env.PGSSL === "true" ||
  (process.env.DATABASE_URL || "").includes("sslmode=require") ||
  /render\.com|neon\.tech|supabase\.co/.test(process.env.DATABASE_URL || "");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  // Tuning del pool — importante en Neon (Postgres serverless): Express
  // puede abrir varias conexiones si llegan webhooks de MP/Stripe/DocuSign
  // casi al mismo tiempo. Estos límites evitan agotar las conexiones del
  // lado de Neon y cortan rápido una conexión que se cuelga en vez de
  // dejar el request colgado indefinidamente.
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const MEMBER_COLUMN_NAMES = [
  "id", "public_token", "name", "doc_id", "email", "phone", "amount_usd", "status",
  "proportional_pct", "envelope_id", "mp_payment_id", "stripe_payment_id",
  "mp_preference_id", "stripe_session_id", "amount_ars", "fx_rate_ars_per_usd",
  "signed_pdf_size_bytes", "signed_pdf_url",
  "transfer_receipt_content_type", "transfer_receipt_filename", "transfer_receipt_uploaded_at",
  "transfer_confirmed_by", "transfer_confirmed_at",
  "is_test",
  "created_at", "updated_at",
];

/**
 * Lista de columnas para SELECT/RETURNING, con prefijo de tabla opcional
 * (lo necesita getMemberByEnvelopeId, que hace JOIN con member_envelopes —
 * sin prefijo, "id" y "created_at" quedan ambiguos entre las dos tablas).
 *
 * transfer_receipt_data (BYTEA — el comprobante de transferencia completo,
 * puede pesar varios MB) queda AFUERA a propósito: antes esto era
 * "SELECT *", y eso traería ese blob en CADA consulta de un Miembro
 * —prácticamente todas las rutas— aunque nadie lo vaya a usar. Acá se
 * expone solo como booleano (`hasTransferReceipt`, ver rowToMember) y el
 * contenido real se pide aparte con getTransferReceipt().
 */
function memberColumns(prefix = "") {
  const p = prefix ? `${prefix}.` : "";
  return `${MEMBER_COLUMN_NAMES.map((c) => `${p}${c}`).join(", ")}, (${p}transfer_receipt_data IS NOT NULL) AS has_transfer_receipt`;
}

// pg devuelve las columnas NUMERIC como string (para no perder precisión
// en JS por defecto). Acá sí nos conviene Number: los montos son en miles
// de USD, no hay riesgo real de precisión, y el resto del código
// (proportionalPct, etc.) hace aritmética directa sobre amountUsd.
function rowToMember(row) {
  if (!row) return undefined;
  return {
    // Auditoría de seguridad (IDOR): "id" acá es public_token (UUID), no el
    // SERIAL interno — es el único identificador que sale de este módulo
    // hacia server.js, el frontend, DocuSign, Mercado Pago y Stripe.
    id: row.public_token,
    name: row.name,
    docId: row.doc_id,
    email: row.email,
    phone: row.phone,
    amountUsd: Number(row.amount_usd),
    status: row.status,
    proportionalPct: row.proportional_pct != null ? Number(row.proportional_pct) : undefined,
    envelopeId: row.envelope_id || undefined,
    mpPaymentId: row.mp_payment_id || undefined,
    stripePaymentId: row.stripe_payment_id || undefined,
    mpPreferenceId: row.mp_preference_id || undefined,
    stripeSessionId: row.stripe_session_id || undefined,
    amountArs: row.amount_ars != null ? Number(row.amount_ars) : undefined,
    fxRateArsPerUsd: row.fx_rate_ars_per_usd != null ? Number(row.fx_rate_ars_per_usd) : undefined,
    signedPdfSizeBytes: row.signed_pdf_size_bytes || undefined,
    signedPdfUrl: row.signed_pdf_url || undefined,
    hasTransferReceipt: !!row.has_transfer_receipt,
    transferReceiptContentType: row.transfer_receipt_content_type || undefined,
    transferReceiptFilename: row.transfer_receipt_filename || undefined,
    // Rama demo: true si la fila nació del circuito de demostración.
    isTest: !!row.is_test,
    transferReceiptUploadedAt: row.transfer_receipt_uploaded_at || undefined,
    transferConfirmedBy: row.transfer_confirmed_by || undefined,
    transferConfirmedAt: row.transfer_confirmed_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createMember({ name, docId, email, phone, amountUsd, isTest = false }) {
  const { rows } = await pool.query(
    `INSERT INTO members (name, doc_id, email, phone, amount_usd, status, is_test)
     VALUES ($1, $2, $3, $4, $5, 'nuevo', $6)
     RETURNING ${memberColumns()}`,
    [name, docId, email, phone || null, amountUsd, Boolean(isTest)]
  );
  return rowToMember(rows[0]);
}

// Busca un Miembro que ya haya arrancado el proceso (MISMO email Y MISMO
// DNI/CUIT a la vez) y todavía no haya pagado. Se usa para no crear un
// registro duplicado — con su propio sobre de DocuSign duplicado — si
// alguien pierde el localStorage a mitad de camino (cerró el navegador,
// cambió de dispositivo, etc.) y vuelve a completar la Ficha desde cero.
//
// Auditoría de seguridad: antes era "email = $1 OR doc_id = $2" — con OR,
// alcanzaba con saber el email de un inversor real (un dato mucho menos
// secreto que su DNI/CUIT) para que el backend devolviera "coincidencia"
// contra su Ficha. Con AND, hace falta acertar los DOS datos a la vez.
async function findActiveOrPendingMember(email, docId) {
  const { rows } = await pool.query(
    `SELECT ${memberColumns()} FROM members
     WHERE email = $1 AND doc_id = $2
       AND status IN ('nuevo', 'firma_pendiente', 'firmado_pendiente_pago')
     ORDER BY id DESC LIMIT 1`,
    [email, docId]
  );
  return rowToMember(rows[0]);
}

// "id" acá es SIEMPRE public_token (UUID) — ver nota en rowToMember. Nunca
// se consulta por el SERIAL interno desde fuera de este módulo.
async function getMember(id) {
  const { rows } = await pool.query(`SELECT ${memberColumns()} FROM members WHERE public_token = $1`, [id]);
  return rowToMember(rows[0]);
}

/**
 * Toma el Miembro y BLOQUEA la fila hasta el fin de la transacción.
 *
 * Es lo que evita los sobres de DocuSign duplicados: dos pestañas del mismo
 * Miembro apretando "Firmar" casi a la vez leían ambas status='nuevo',
 * ambas pasaban el guard, y se creaban DOS sobres. El segundo pisaba el
 * envelope_id del primero, así que si el Miembro firmaba en la pestaña
 * vieja, el webhook llegaba con un envelopeId que la base ya no conocía y
 * la firma se perdía en silencio.
 *
 * El callback recibe el cliente de la transacción; lo que devuelva se
 * commitea. Si lanza, se hace rollback.
 */
async function withMemberLock(publicToken, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT ${memberColumns()} FROM members WHERE public_token = $1 FOR UPDATE`,
      [publicToken]
    );
    const member = rowToMember(rows[0]);
    const result = await fn(member, client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Registra un sobre en el historial del Miembro. envelope_id en members
 * sigue siendo "el sobre vigente", pero member_envelopes guarda TODOS —
 * así, si llega el webhook de un sobre viejo, se puede resolver igual a qué
 * Miembro pertenece en vez de descartarlo.
 */
async function recordEnvelope(publicToken, envelopeId, client) {
  const q = client || pool;
  await q.query(
    `INSERT INTO member_envelopes (member_public_token, envelope_id)
     VALUES ($1, $2) ON CONFLICT (envelope_id) DO NOTHING`,
    [publicToken, envelopeId]
  );
}

async function getMemberByEnvelopeId(envelopeId) {
  // Se busca primero por el sobre vigente y, si no matchea, por el historial
  // completo: un webhook de un sobre anterior tiene que poder resolverse al
  // Miembro correcto igual, en vez de descartarse con un warning.
  const cols = memberColumns("m");
  const { rows } = await pool.query(
    `SELECT ${cols} FROM members m WHERE m.envelope_id = $1
     UNION
     SELECT ${cols} FROM members m
       JOIN member_envelopes e ON e.member_public_token = m.public_token
      WHERE e.envelope_id = $1
     LIMIT 1`,
    [envelopeId]
  );
  return rowToMember(rows[0]);
}

/**
 * updateMember hace un UPDATE explícito por campo (solo los campos que
 * vienen en `patch`), en vez de leer-modificar-guardar el registro entero.
 * Esto evita pisar cambios concurrentes si dos webhooks llegan casi al
 * mismo tiempo (ver Fase 2 de la guía — riesgo de condición de carrera).
 */
const UPDATABLE_FIELDS = {
  status: "status",
  envelopeId: "envelope_id",
  proportionalPct: "proportional_pct",
  mpPaymentId: "mp_payment_id",
  stripePaymentId: "stripe_payment_id",
  mpPreferenceId: "mp_preference_id",
  stripeSessionId: "stripe_session_id",
  amountArs: "amount_ars",
  fxRateArsPerUsd: "fx_rate_ars_per_usd",
  // Ninguna ruta actual pasa amountUsd acá (ver server.js) — se deja
  // actualizable a propósito para el futuro flujo de "retomar Ficha" por
  // magic link, pero SIEMPRE pasa primero por el guard de abajo.
  amountUsd: "amount_usd",
};

/**
 * Auditoría de seguridad — Problema 5: una vez que un Miembro tiene
 * envelope_id (ya se generó y, probablemente, ya se firmó un Acuerdo con
 * un monto impreso), el Aporte no puede volver a cambiar por ninguna vía.
 * El guard vive ACÁ (capa de datos), no solo en la ruta que lo llama, para
 * que ningún caller futuro pueda saltárselo por accidente.
 */
async function assertAmountChangeAllowed(id, patch) {
  if (!Object.prototype.hasOwnProperty.call(patch, "amountUsd")) return;
  const current = await getMember(id);
  if (current && current.envelopeId) {
    throw new Error(
      "No se puede modificar el Aporte de un Miembro que ya tiene un sobre de DocuSign generado."
    );
  }
}

// "id" acá es SIEMPRE public_token (UUID) — ver nota en rowToMember.
// El parámetro `client` es lo que permite que este UPDATE corra DENTRO de la
// transacción abierta por withMemberLock. Sin él, la actualización saldría
// por OTRA conexión del pool y quedaría bloqueada esperando el FOR UPDATE
// que tiene la primera — un deadlock contra nosotros mismos.
async function updateMember(id, patch, client) {
  await assertAmountChangeAllowed(id, patch);

  const setClauses = [];
  const values = [];
  let i = 1;

  for (const [jsKey, column] of Object.entries(UPDATABLE_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(patch, jsKey)) {
      setClauses.push(`${column} = $${i++}`);
      values.push(patch[jsKey]);
    }
  }

  if (setClauses.length === 0) return getMember(id);

  setClauses.push(`updated_at = now()`);
  values.push(id);

  const { rows } = await (client || pool).query(
    `UPDATE members SET ${setClauses.join(", ")} WHERE public_token = $${i} RETURNING ${memberColumns()}`,
    values
  );
  return rowToMember(rows[0]);
}

// `signedPdfUrl` es opcional a propósito: si src/storage.js no está
// configurado (sin credenciales reales de un bucket), uploadSignedPdf()
// devuelve null y acá se sigue guardando el tamaño igual que antes — el PDF
// en sí queda recuperable a mano desde el panel de DocuSign mientras tanto.
async function saveSignedDocument(id, pdfBytes, signedPdfUrl) {
  await pool.query(
    `UPDATE members SET signed_pdf_size_bytes = $1, signed_pdf_url = $2, updated_at = now() WHERE public_token = $3`,
    [pdfBytes.length, signedPdfUrl || null, id]
  );
}

/**
 * Guarda el comprobante de transferencia — el archivo completo, no solo el
 * tamaño (a diferencia de saveSignedDocument): a diferencia del Acuerdo
 * firmado, que sigue existiendo en DocuSign si algo falla acá, el
 * comprobante que sube el Miembro NO existe en ningún otro lado. Es
 * justamente la evidencia que el equipo de Ditelli revisa a mano antes de
 * pasar el status a "activo".
 */
async function saveTransferReceipt(id, { data, contentType, filename }) {
  await pool.query(
    `UPDATE members SET transfer_receipt_data = $1, transfer_receipt_content_type = $2,
       transfer_receipt_filename = $3, transfer_receipt_uploaded_at = now(), updated_at = now()
     WHERE public_token = $4`,
    [data, contentType, filename, id]
  );
}

/**
 * Trae el comprobante COMPLETO — a propósito separado de getMember (ver
 * memberColumns), para no cargar este BYTEA en cada consulta normal de un
 * Miembro. Pensado para el equipo de Ditelli, desde un script de operación
 * manual (scripts/export-transfer-receipt.js) — este proyecto no tiene
 * panel de administración, así que no hay una ruta HTTP para esto.
 */
async function getTransferReceipt(id) {
  const { rows } = await pool.query(
    `SELECT transfer_receipt_data, transfer_receipt_content_type, transfer_receipt_filename
     FROM members WHERE public_token = $1`,
    [id]
  );
  const row = rows[0];
  if (!row || !row.transfer_receipt_data) return null;
  return {
    data: row.transfer_receipt_data,
    contentType: row.transfer_receipt_content_type || "application/octet-stream",
    filename: row.transfer_receipt_filename || "comprobante",
  };
}

async function getCapitalCaptadoTotal() {
  // Suma real de los Aportes de miembros ya activos (pago confirmado).
  // Si Ditelli quiere contar también a los que están "firmado_pendiente_pago"
  // (firmaron pero no pagaron todavía) en este total, avisame y cambio el
  // WHERE — es una decisión de negocio, no técnica.
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM members WHERE status = 'activo'`
  );
  return Number(rows[0].total);
}

/**
 * Guarda un enlace de acceso de un solo uso. Recibe el HASH del token, no el
 * token: el valor en claro solo existe en el correo que recibe el Miembro.
 */
async function createMagicLink(memberPublicToken, tokenHash, expiresAt) {
  await pool.query(
    `INSERT INTO magic_links (member_public_token, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [memberPublicToken, tokenHash, expiresAt]
  );
}

/**
 * Canjea un enlace: lo marca usado y devuelve a qué Miembro pertenece.
 *
 * El UPDATE ... WHERE used_at IS NULL ... RETURNING hace las dos cosas en una
 * sola sentencia atómica. Eso es lo que garantiza el "un solo uso" de verdad:
 * si llegan dos requests con el mismo token casi al mismo tiempo (el usuario
 * tocó dos veces, o el escáner de links del cliente de correo lo abrió antes
 * que él), solo una puede ganar. Chequear y después actualizar por separado
 * dejaría una ventana en la que las dos pasan.
 */
async function consumeMagicLink(tokenHash) {
  const { rows } = await pool.query(
    `UPDATE magic_links
        SET used_at = now()
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING member_public_token`,
    [tokenHash]
  );
  return rows[0] ? rows[0].member_public_token : null;
}

/** Invalida los enlaces sin usar de un Miembro (se llama al emitir uno nuevo). */
async function invalidateMagicLinks(memberPublicToken) {
  await pool.query(
    `UPDATE magic_links SET used_at = now()
      WHERE member_public_token = $1 AND used_at IS NULL`,
    [memberPublicToken]
  );
}

/**
 * Revisión legal pre-lanzamiento (punto C): alta de un interesado en la
 * tabla `membership_requests`, completamente separada de `members`. Nace
 * (y se queda) en status='solicitud_recibida' — sin KYC ni aprobación, eso
 * todavía no existe.
 */
async function createMembershipRequest({ name, whatsapp, email, cityProvince, activity, interest, privacyAccepted, isTest = false }) {
  const { rows } = await pool.query(
    `INSERT INTO membership_requests (name, whatsapp, email, city_province, activity, interest, privacy_accepted, is_test)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, whatsapp, email, city_province, activity, interest, status, created_at`,
    [name, whatsapp, email, cityProvince || null, activity || null, interest || null, Boolean(privacyAccepted), Boolean(isTest)]
  );
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    whatsapp: row.whatsapp,
    email: row.email,
    cityProvince: row.city_province || undefined,
    activity: row.activity || undefined,
    interest: row.interest || undefined,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function ping() {
  await pool.query("SELECT 1");
}

// ---------------------------------------------------------------------------
// Panel de administración (Fase 2 post-Beta)
// ---------------------------------------------------------------------------

/** Listado de Miembros para el panel admin, más reciente primero. Sin el BYTEA del comprobante (ver memberColumns). */
async function listMembers({ status } = {}) {
  const params = [];
  let where = "";
  if (status) {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT ${memberColumns()} FROM members ${where} ORDER BY updated_at DESC`,
    params
  );
  return rows.map(rowToMember);
}

/**
 * Confirma una transferencia bancaria y activa al Miembro, dejando
 * constancia de quién y cuándo (mismo estándar de evidencia que el resto
 * del proyecto exige para cualquier aprobación).
 *
 * El WHERE status = 'transferencia_pendiente_confirmacion' hace de guarda
 * atómica: mismo patrón que consumeMagicLink (UPDATE ... WHERE ...
 * RETURNING en una sola sentencia) — si dos operadores confirman casi al
 * mismo tiempo, o si alguien reintenta sobre un Miembro que ya está
 * "activo", el segundo UPDATE no encuentra fila que tocar y esta función
 * devuelve undefined en vez de pisar nada.
 */
async function confirmTransfer(id, confirmedBy) {
  const { rows } = await pool.query(
    `UPDATE members
        SET status = 'activo', transfer_confirmed_by = $1, transfer_confirmed_at = now(), updated_at = now()
      WHERE public_token = $2 AND status = 'transferencia_pendiente_confirmacion'
      RETURNING ${memberColumns()}`,
    [confirmedBy, id]
  );
  return rowToMember(rows[0]);
}

/** Alta manual (Miembro que entró por reunión, no por la web). El estado inicial lo decide quien llama — ver server.js. */
async function createMemberManual({ name, docId, email, phone, amountUsd, status, proportionalPct, isTest = false }) {
  const { rows } = await pool.query(
    `INSERT INTO members (name, doc_id, email, phone, amount_usd, status, proportional_pct, is_test)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${memberColumns()}`,
    [name, docId, email, phone || null, amountUsd, status, proportionalPct ?? null, Boolean(isTest)]
  );
  return rowToMember(rows[0]);
}

async function findAdminByUsername(username) {
  const { rows } = await pool.query(
    `SELECT id, username, password_hash, created_at FROM admin_users WHERE username = $1`,
    [username]
  );
  return rows[0] || undefined;
}

/**
 * Crea un admin o, si el username ya existe, le resetea la contraseña
 * (ON CONFLICT DO UPDATE) — así scripts/create-admin.js sirve tanto para el
 * bootstrap inicial como para restablecer una clave más adelante, sin
 * necesitar un segundo script.
 */
async function createAdminUser({ username, passwordHash }) {
  const { rows } = await pool.query(
    `INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, username, created_at`,
    [username, passwordHash]
  );
  return rows[0];
}

module.exports = {
  ping,
  createMembershipRequest,
  createMagicLink,
  consumeMagicLink,
  invalidateMagicLinks,
  createMember,
  withMemberLock,
  recordEnvelope,
  getMember,
  findActiveOrPendingMember,
  getMemberByEnvelopeId,
  updateMember,
  saveSignedDocument,
  saveTransferReceipt,
  getTransferReceipt,
  getCapitalCaptadoTotal,
  listMembers,
  confirmTransfer,
  createMemberManual,
  findAdminByUsername,
  createAdminUser,
};

// Listener para capturar errores inesperados en conexiones inactivas del pool
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});