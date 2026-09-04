-- Ditelli Capital — esquema de base de datos real (reemplaza el stub en memoria de src/db.js)
-- Correr una sola vez contra la base de datos elegida (Railway/Render/Neon/Supabase, todos dan Postgres):
--
--   psql "$DATABASE_URL" -f schema.sql
--
-- o pegando el contenido en la consola SQL que traiga el panel del hosting.

-- Necesaria para gen_random_uuid() en Postgres < 13 (Neon/Railway/Render
-- actuales ya la traen incluida en core, pero declararla es inofensivo y
-- cubre el caso de correr esto contra un Postgres más viejo).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS members (
  id                 SERIAL PRIMARY KEY,
  -- Identificador PÚBLICO (auditoría de seguridad — IDOR): id es un SERIAL
  -- secuencial y adivinable (1, 2, 3...) — nunca debe salir del backend.
  -- public_token es lo que ve el frontend, DocuSign, Mercado Pago y Stripe
  -- como "memberId". id sigue existiendo como PK interna, sin exponerse.
  public_token       UUID NOT NULL DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  doc_id             TEXT NOT NULL,
  email              TEXT NOT NULL,
  phone              TEXT,
  amount_usd         NUMERIC(14, 2) NOT NULL,
  status             TEXT NOT NULL DEFAULT 'nuevo',
  -- % de participación calculado UNA vez, al generar el sobre de DocuSign,
  -- contra el capital captado en ese momento. Se guarda (no se recalcula
  -- después) para que el % que ve el Miembro en pantalla sea siempre el
  -- mismo que quedó impreso en el Acuerdo que firmó, aunque después se
  -- sumen más Miembros y el capital total crezca.
  proportional_pct   NUMERIC(9, 4),
  envelope_id        TEXT,
  mp_payment_id      TEXT,
  stripe_payment_id  TEXT,
  signed_pdf_size_bytes INTEGER,
  -- Key/URL del PDF firmado en el bucket S3-compatible (ver src/storage.js).
  -- Queda NULL mientras esa integración no esté activada con credenciales
  -- reales — el PDF sigue existiendo en DocuSign de todos modos.
  signed_pdf_url     TEXT,
  -- Auditoría contable del cobro en pesos: sin registrar a qué cotización se
  -- convirtió cada Aporte, no hay forma de conciliar después contra el
  -- resumen de Mercado Pago ni de explicar por qué dos Miembros con el mismo
  -- Aporte en USD pagaron montos distintos en ARS.
  -- Referencias del intento de pago, guardadas ANTES de mandar al Miembro al
  -- checkout. Sin esto no hay forma de preguntarle despues a Mercado Pago o
  -- a Stripe "¿este Miembro pago?": si el webhook no llega, el pago queda
  -- invisible y la conciliacion hay que hacerla a ojo cruzando nombres.
  mp_preference_id      TEXT,
  stripe_session_id     TEXT,
  amount_ars            NUMERIC(16, 2),
  fx_rate_ars_per_usd   NUMERIC(14, 4),
  -- Comprobante de transferencia bancaria — se guarda el archivo COMPLETO acá
  -- adentro (no solo el tamaño, a diferencia del PDF de DocuSign): a
  -- diferencia del Acuerdo firmado, que sigue existiendo en DocuSign si algo
  -- falla, el comprobante que sube el Miembro NO existe en ningún otro lado.
  -- Es justamente la evidencia que el equipo de Ditelli mira a mano antes de
  -- pasar el status a "activo" — perderlo significa activar a alguien sin
  -- poder corroborar que transfirió. BYTEA en vez de un bucket externo (ver
  -- src/storage.js) porque funciona hoy mismo, sin credenciales de terceros
  -- que todavía no existen.
  transfer_receipt_data          BYTEA,
  transfer_receipt_content_type  TEXT,
  transfer_receipt_filename      TEXT,
  transfer_receipt_uploaded_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Si ya habías corrido este schema.sql antes (ya tenés la tabla `members`
-- creada en Neon), el CREATE TABLE de arriba no la toca — hace falta esta
-- línea aparte para agregarle la columna nueva a una tabla que ya existe.
-- Es segura de correr más de una vez (no rompe si la columna ya está).
ALTER TABLE members ADD COLUMN IF NOT EXISTS proportional_pct NUMERIC(9, 4);

-- Migración para bases que YA existen (el CREATE TABLE de arriba no toca una
-- tabla creada antes). Todas son seguras de correr más de una vez.
ALTER TABLE members ADD COLUMN IF NOT EXISTS mp_preference_id    TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS stripe_session_id   TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS amount_ars          NUMERIC(16, 2);
ALTER TABLE members ADD COLUMN IF NOT EXISTS fx_rate_ars_per_usd NUMERIC(14, 4);
ALTER TABLE members ADD COLUMN IF NOT EXISTS signed_pdf_url      TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_receipt_data          BYTEA;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_receipt_content_type  TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_receipt_filename      TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_receipt_uploaded_at   TIMESTAMPTZ;

-- Mismo caso que proportional_pct arriba: agrega public_token a una tabla
-- `members` ya existente. El DEFAULT gen_random_uuid() se calcula por fila
-- (no es un valor constante), así que esto rellena también las filas viejas
-- con un token nuevo — no van a quedar en NULL ni repetidos.
ALTER TABLE members ADD COLUMN IF NOT EXISTS public_token UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_public_token ON members(public_token);

-- Usado en cada webhook de DocuSign (getMemberByEnvelopeId) — sin este índice,
-- esa consulta escanea toda la tabla en cada firma completada.
-- Es UNIQUE (no un índice común) a propósito: un envelopeId, un
-- mp_payment_id o un stripe_payment_id no deberían poder repetirse entre
-- dos Miembros distintos — si Mercado Pago, Stripe o DocuSign reintentan
-- el mismo webhook (algo que hacen todo el tiempo si tardás en
-- responder), esto evita que un pago o una firma queden pegados por
-- error a dos registros. El "WHERE ... IS NOT NULL" es necesario porque,
-- si no, todos los Miembros que todavía no tienen ese dato (NULL) chocarían
-- entre sí como si fueran duplicados.
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_envelope_id ON members(envelope_id) WHERE envelope_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_mp_payment_id ON members(mp_payment_id) WHERE mp_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_stripe_payment_id ON members(stripe_payment_id) WHERE stripe_payment_id IS NOT NULL;

-- Útil para el polling de estado desde el frontend y para futuros reportes.
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);

-- Usados por findActiveOrPendingMember (POST /api/members) para detectar
-- si esta persona ya había arrancado el proceso, antes de crear un
-- registro duplicado.
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_doc_id ON members(doc_id);

-- status recorre: nuevo → firma_pendiente → firmado_pendiente_pago →
--                 activo | transferencia_pendiente_confirmacion

-- Historial de sobres de DocuSign por Miembro.
--
-- members.envelope_id guarda "el sobre vigente" y se pisa cada vez que se
-- genera uno nuevo. Eso hacía que un webhook de un sobre anterior no
-- resolviera a ningún Miembro y se descartara con un warning — o sea, una
-- firma con validez legal que se perdía en silencio. Esta tabla conserva
-- TODOS los sobres, así getMemberByEnvelopeId siempre encuentra al dueño.
CREATE TABLE IF NOT EXISTS member_envelopes (
  id                  SERIAL PRIMARY KEY,
  member_public_token UUID NOT NULL REFERENCES members(public_token) ON DELETE CASCADE,
  envelope_id         TEXT NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_member_envelopes_member ON member_envelopes(member_public_token);

-- Enlaces de acceso de un solo uso (magic link).
--
-- Resuelven el peor bloqueo operativo que tenía el sistema: si el Miembro
-- perdía el localStorage —cambió de dispositivo, borró la caché, entró en
-- navegación privada— quedaba trabado, porque POST /api/members responde 202
-- ante un email+DNI existente y a propósito NO devuelve credenciales a una
-- request sin autenticar. La única salida era borrarle la fila a mano.
--
-- Se guarda el HASH del token, nunca el token en claro: si alguien llegara a
-- leer esta tabla, no podría usar ninguno de los enlaces.
CREATE TABLE IF NOT EXISTS magic_links (
  id                  SERIAL PRIMARY KEY,
  member_public_token UUID NOT NULL REFERENCES members(public_token) ON DELETE CASCADE,
  token_hash          TEXT NOT NULL UNIQUE,
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_magic_links_member ON magic_links(member_public_token);
CREATE INDEX IF NOT EXISTS idx_magic_links_expira ON magic_links(expires_at) WHERE used_at IS NULL;

-- Revisión legal pre-lanzamiento (punto C): captación pública de interesados,
-- separada a propósito de `members`. `members` es el registro real de la
-- Ficha de Adhesión (exige doc_id y amount_usd, tiene validez legal); esto
-- es apenas un lead — no pide DNI ni monto, y no tiene ninguna relación con
-- DocuSign, Mercado Pago, Stripe ni con `members`. Sin KYC ni aprobación:
-- status nace y se queda en 'solicitud_recibida' hasta que ese flujo exista.
CREATE TABLE IF NOT EXISTS membership_requests (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  whatsapp            TEXT NOT NULL,
  email               TEXT NOT NULL,
  city_province       TEXT,
  activity            TEXT,
  interest            TEXT,
  privacy_accepted    BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL DEFAULT 'solicitud_recibida',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_membership_requests_status ON membership_requests(status);
CREATE INDEX IF NOT EXISTS idx_membership_requests_created ON membership_requests(created_at);

-- Panel de administración (Fase 2 post-Beta).
--
-- Quién confirmó una transferencia y cuándo — mismo estándar de evidencia
-- que el resto del proyecto exige para cualquier aprobación (ver
-- transfer_receipt_* arriba). Sin esto, "activo" no dice si alguien lo
-- revisó o si fue un error de un clic.
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_confirmed_by TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_confirmed_at TIMESTAMPTZ;

-- Un solo rol por ahora (ver src/adminAuth.js) — no hace falta una tabla de
-- roles/permisos hasta que Ditelli necesite más de un tipo de operador.
-- Se guarda el HASH de la contraseña (bcrypt), nunca la contraseña en claro.
-- Sin endpoint de registro a propósito: el primer admin (y cualquier otro)
-- se crea con scripts/create-admin.js, nunca desde una ruta HTTP pública.
CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ======================================================================
-- Rama demo-visual-pablo — aislamiento de datos de prueba
-- ======================================================================
-- Marca las filas nacidas del circuito de demostración. El backend la pone
-- en true automáticamente cuando MODO_DEMO=true (ver server.js); en
-- producción MODO_DEMO no existe y todas las filas nacen en false.
--
-- Es un cinturón ADEMÁS del tirante: la demo debería correr contra una base
-- separada (una branch de Neon). Esta columna existe para que, si alguna vez
-- las dos bases se unen, no haya forma de confundir un Miembro de prueba con
-- uno real — ni a ojo en el panel, ni por consulta SQL.
ALTER TABLE members             ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE membership_requests ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_members_is_test ON members(is_test) WHERE is_test = true;
