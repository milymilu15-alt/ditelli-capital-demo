-- ============================================================
-- Ditelli Capital — Consultas para el equipo de administración
--
-- Cómo usarlas: entrar a neon.com → proyecto ditelli-capital → SQL Editor,
-- copiar UNA consulta (desde el SELECT hasta el punto y coma) y apretar Run.
--
-- Todas son de SOLO LECTURA: no modifican ni borran nada. Podés correrlas
-- todas las veces que quieras sin riesgo.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. ¿QUIÉNES YA PAGARON?  (los Miembros confirmados)
-- ════════════════════════════════════════════════════════════
SELECT
  name                         AS "Miembro",
  doc_id                       AS "DNI / CUIT",
  email                        AS "Correo",
  phone                        AS "Teléfono",
  amount_usd                   AS "Aporte USD",
  proportional_pct             AS "Participación %",
  CASE
    WHEN mp_payment_id     IS NOT NULL THEN 'Tarjeta (Mercado Pago)'
    WHEN stripe_payment_id IS NOT NULL THEN 'Tarjeta internacional (Stripe)'
    ELSE 'Transferencia bancaria'
  END                          AS "Cómo pagó",
  amount_ars                   AS "Cobrado en ARS",
  fx_rate_ars_per_usd          AS "Cotización usada",
  to_char(updated_at AT TIME ZONE 'America/Argentina/Buenos_Aires',
          'DD/MM/YYYY HH24:MI') AS "Fecha del pago"
FROM members
WHERE status = 'activo'
ORDER BY updated_at DESC;


-- ════════════════════════════════════════════════════════════
-- 2. ¿A QUIÉN HAY QUE LLAMAR HOY?  (firmaron y no pagaron)
--    Es la lista más importante: ya se comprometieron.
-- ════════════════════════════════════════════════════════════
SELECT
  name                         AS "Miembro",
  phone                        AS "Teléfono",
  email                        AS "Correo",
  amount_usd                   AS "Aporte USD",
  to_char(updated_at AT TIME ZONE 'America/Argentina/Buenos_Aires',
          'DD/MM/YYYY HH24:MI') AS "Firmó el",
  date_part('day', now() - updated_at) AS "Días esperando"
FROM members
WHERE status = 'firmado_pendiente_pago'
ORDER BY updated_at;


-- ════════════════════════════════════════════════════════════
-- 3. TRANSFERENCIAS A VERIFICAR CONTRA EL EXTRACTO
--    Correr esta TODOS LOS DÍAS.
-- ════════════════════════════════════════════════════════════
SELECT
  name                         AS "Miembro",
  doc_id                       AS "DNI / CUIT",
  amount_usd                   AS "Aporte USD",
  phone                        AS "Teléfono",
  to_char(updated_at AT TIME ZONE 'America/Argentina/Buenos_Aires',
          'DD/MM/YYYY HH24:MI') AS "Avisó el",
  public_token                 AS "Código del Miembro"
FROM members
WHERE status = 'transferencia_pendiente_confirmacion'
ORDER BY updated_at;


-- ════════════════════════════════════════════════════════════
-- 4. LOS QUE SE QUEDARON A MITAD DE CAMINO
--    Contactos reales que no completaron. Se pueden recuperar.
-- ════════════════════════════════════════════════════════════
SELECT
  name                         AS "Persona",
  phone                        AS "Teléfono",
  email                        AS "Correo",
  amount_usd                   AS "Quería invertir USD",
  CASE status
    WHEN 'nuevo'           THEN 'Cargó los datos y no siguió'
    WHEN 'firma_pendiente' THEN 'Empezó a firmar y no terminó'
  END                          AS "Hasta dónde llegó",
  to_char(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires',
          'DD/MM/YYYY')        AS "Entró el"
FROM members
WHERE status IN ('nuevo', 'firma_pendiente')
ORDER BY created_at DESC;


-- ════════════════════════════════════════════════════════════
-- 5. RESUMEN DE LA RONDA  (el número que te van a pedir)
-- ════════════════════════════════════════════════════════════
SELECT
  count(*) FILTER (WHERE status = 'activo')                      AS "Miembros confirmados",
  coalesce(sum(amount_usd) FILTER (WHERE status = 'activo'), 0)  AS "USD captado",
  round(coalesce(sum(amount_usd) FILTER (WHERE status = 'activo'), 0)
        / 500000.0 * 100, 2)                                     AS "% de la ronda",
  count(*) FILTER (WHERE status = 'firmado_pendiente_pago')       AS "Firmaron sin pagar",
  coalesce(sum(amount_usd) FILTER (WHERE status = 'firmado_pendiente_pago'), 0)
                                                                 AS "USD por cobrar",
  count(*) FILTER (WHERE status = 'transferencia_pendiente_confirmacion')
                                                                 AS "Transferencias a verificar"
FROM members;


-- ════════════════════════════════════════════════════════════
-- 6. TODO EL PADRÓN  (para exportar a Excel con el botón Download)
-- ════════════════════════════════════════════════════════════
SELECT
  name                         AS "Nombre",
  doc_id                       AS "DNI / CUIT",
  email                        AS "Correo",
  phone                        AS "Teléfono",
  amount_usd                   AS "Aporte USD",
  proportional_pct             AS "Participación %",
  CASE status
    WHEN 'nuevo'                                 THEN '1. Solo cargó datos'
    WHEN 'firma_pendiente'                       THEN '2. Firmando'
    WHEN 'firmado_pendiente_pago'                THEN '3. Firmó, falta pagar'
    WHEN 'transferencia_pendiente_confirmacion'  THEN '4. Transfirió, a verificar'
    WHEN 'activo'                                THEN '5. MIEMBRO CONFIRMADO'
  END                          AS "Estado",
  amount_ars                   AS "Cobrado ARS",
  fx_rate_ars_per_usd          AS "Cotización",
  coalesce(mp_payment_id, stripe_payment_id) AS "N° de operación",
  to_char(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires',
          'DD/MM/YYYY')        AS "Entró el",
  to_char(updated_at AT TIME ZONE 'America/Argentina/Buenos_Aires',
          'DD/MM/YYYY')        AS "Última novedad"
FROM members
ORDER BY created_at DESC;


-- ════════════════════════════════════════════════════════════
-- 7. BUSCAR UNA PERSONA
--    Cambiá el texto entre comillas por el nombre, correo o DNI.
-- ════════════════════════════════════════════════════════════
SELECT
  name AS "Nombre", doc_id AS "DNI / CUIT", email AS "Correo", phone AS "Teléfono",
  amount_usd AS "Aporte USD", proportional_pct AS "Participación %",
  status AS "Estado",
  coalesce(mp_payment_id, stripe_payment_id) AS "N° de operación",
  amount_ars AS "Cobrado ARS",
  public_token AS "Código del Miembro"
FROM members
WHERE name  ILIKE '%perez%'      -- ← cambiá acá
   OR email ILIKE '%perez%'      -- ← y acá
   OR doc_id ILIKE '%perez%';    -- ← y acá
