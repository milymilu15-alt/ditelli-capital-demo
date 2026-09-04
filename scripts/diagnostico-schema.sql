-- ===================================================================
-- Ditelli Capital — diagnostico y reparacion del esquema de `members`
-- Pegar en la consola SQL de Neon (la base que usa Railway).
--
-- PARTE 1 solo LEE. Correla sola primero.
-- PARTE 2 modifica, pero es idempotente: todo es IF NOT EXISTS, no borra
-- ni pisa datos, y correrla dos veces no cambia nada.
-- ===================================================================


-- -------------------------------------------------------------------
-- PARTE 1 — DIAGNOSTICO (no modifica nada)
--
-- Lista las columnas que el codigo (MEMBER_COLUMN_NAMES en src/db.js)
-- le pide a la tabla y la base NO tiene. Si devuelve 0 filas, el
-- esquema esta bien y el error 500 del alta es otra cosa.
-- -------------------------------------------------------------------
SELECT esperada.col AS columna_que_falta
FROM (VALUES
    ('id'),
    ('public_token'),
    ('name'),
    ('doc_id'),
    ('email'),
    ('phone'),
    ('amount_usd'),
    ('status'),
    ('proportional_pct'),
    ('envelope_id'),
    ('mp_payment_id'),
    ('stripe_payment_id'),
    ('mp_preference_id'),
    ('stripe_session_id'),
    ('amount_ars'),
    ('fx_rate_ars_per_usd'),
    ('signed_pdf_size_bytes'),
    ('signed_pdf_url'),
    ('transfer_receipt_data'),
    ('transfer_receipt_content_type'),
    ('transfer_receipt_filename'),
    ('transfer_receipt_uploaded_at'),
    ('transfer_confirmed_by'),
    ('transfer_confirmed_at'),
    ('is_test'),
    ('created_at'),
    ('updated_at')
) AS esperada(col)
LEFT JOIN information_schema.columns ic
       ON ic.table_schema = 'public'
      AND ic.table_name   = 'members'
      AND ic.column_name  = esperada.col
WHERE ic.column_name IS NULL
ORDER BY 1;


-- -------------------------------------------------------------------
-- PARTE 2 — REPARACION
--
-- Correr SOLO si la Parte 1 devolvio filas. Agrega las columnas que
-- falten, sin tocar las que ya estan ni los datos existentes.
-- -------------------------------------------------------------------
ALTER TABLE members ADD COLUMN IF NOT EXISTS proportional_pct               NUMERIC(9, 4);
ALTER TABLE members ADD COLUMN IF NOT EXISTS mp_preference_id               TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS stripe_session_id              TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS amount_ars                     NUMERIC(16, 2);
ALTER TABLE members ADD COLUMN IF NOT EXISTS fx_rate_ars_per_usd            NUMERIC(14, 4);
ALTER TABLE members ADD COLUMN IF NOT EXISTS signed_pdf_url                 TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS signed_pdf_size_bytes          INTEGER;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_receipt_data          BYTEA;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_receipt_content_type  TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_receipt_filename      TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_receipt_uploaded_at   TIMESTAMPTZ;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_confirmed_by          TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS transfer_confirmed_at          TIMESTAMPTZ;
ALTER TABLE members ADD COLUMN IF NOT EXISTS public_token                   UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE members ADD COLUMN IF NOT EXISTS is_test                        BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE membership_requests ADD COLUMN IF NOT EXISTS is_test            BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_members_public_token ON members(public_token);
CREATE INDEX        IF NOT EXISTS idx_members_is_test     ON members(is_test) WHERE is_test = true;


-- -------------------------------------------------------------------
-- PARTE 3 — VERIFICACION (volver a correr la Parte 1)
-- Tiene que devolver 0 filas.
-- -------------------------------------------------------------------
