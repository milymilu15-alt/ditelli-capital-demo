-- ============================================================
-- Ditelli Capital — consultas de control de la base
--
--   psql "$DATABASE_URL" -f scripts/check-estado.sql
--
-- Todas son SELECT: no modifican nada. Sirven antes de publicar y
-- después, como revisión periódica durante el soft launch.
-- ============================================================

\echo '\n=== 1) Acuerdos con Participación sospechosa =================='
\echo 'Con el cálculo viejo, el primer Miembro firmaba 100%. Si acá aparece'
\echo 'alguna fila con estado distinto de nuevo/firma_pendiente, hay un'
\echo 'Acuerdo YA FIRMADO con un porcentaje incorrecto: es un tema legal,'
\echo 'no lo arregla ningún deploy.'
SELECT public_token, name, email, amount_usd, proportional_pct, status, created_at
  FROM members
 WHERE proportional_pct IS NOT NULL
   AND proportional_pct > (amount_usd / 500000.0 * 100) * 1.01   -- 1% de tolerancia
 ORDER BY proportional_pct DESC;

\echo '\n=== 2) Miembros trabados ======================================'
\echo 'Firmaron o empezaron a firmar hace rato y no avanzaron. Si alguno'
\echo 'lleva días en firmado_pendiente_pago, puede haber pagado y no'
\echo 'haberse registrado (webhook perdido).'
SELECT public_token, name, email, status, amount_usd,
       age(now(), updated_at) AS hace_cuanto,
       (envelope_id IS NOT NULL) AS tiene_sobre,
       (mp_preference_id IS NOT NULL OR stripe_session_id IS NOT NULL) AS intento_pago
  FROM members
 WHERE status IN ('nuevo','firma_pendiente','firmado_pendiente_pago','transferencia_pendiente_confirmacion')
   AND updated_at < now() - interval '2 hours'
 ORDER BY updated_at;

\echo '\n=== 3) Posibles cobros duplicados ============================='
\echo 'Un Miembro no debería tener pago de Mercado Pago Y de Stripe.'
SELECT public_token, name, email, mp_payment_id, stripe_payment_id, amount_usd, amount_ars
  FROM members
 WHERE mp_payment_id IS NOT NULL AND stripe_payment_id IS NOT NULL;

\echo '\n=== 4) Cobros sin trazabilidad de cotización =================='
\echo 'Un pago por Mercado Pago sin amount_ars/fx_rate no se puede conciliar'
\echo 'contra el resumen. Si aparecen filas viejas es normal (son previas al'
\echo 'cambio); si aparece una nueva, hay algo mal.'
SELECT public_token, name, status, amount_usd, amount_ars, fx_rate_ars_per_usd, updated_at
  FROM members
 WHERE mp_payment_id IS NOT NULL
   AND (amount_ars IS NULL OR fx_rate_ars_per_usd IS NULL)
 ORDER BY updated_at DESC;

\echo '\n=== 5) Sobres huérfanos ======================================='
\echo 'Sobres en el historial que ya no son el vigente del Miembro. Que'
\echo 'existan no es un problema (por eso guardamos el historial), pero si'
\echo 'un Miembro tiene muchos, alguien estuvo reintentando bastante.'
SELECT m.public_token, m.name, m.status, count(e.id) AS sobres, m.envelope_id AS vigente
  FROM members m
  JOIN member_envelopes e ON e.member_public_token = m.public_token
 GROUP BY m.public_token, m.name, m.status, m.envelope_id
HAVING count(e.id) > 1
 ORDER BY count(e.id) DESC;

\echo '\n=== 6) Resumen general ========================================'
SELECT status, count(*) AS miembros, sum(amount_usd) AS usd_comprometido
  FROM members GROUP BY status ORDER BY 2 DESC;

\echo '\n=== 7) Capital captado (solo activos) ========================='
SELECT coalesce(sum(amount_usd),0) AS usd_captado,
       round(coalesce(sum(amount_usd),0) / 500000.0 * 100, 2) AS pct_de_la_ronda
  FROM members WHERE status = 'activo';

\echo '\n=== 8) Transferencias pendientes de confirmar =================='
\echo 'El comprobante NO se ve acá (es un BYTEA) — bajalo con'
\echo '  node scripts/export-transfer-receipt.js <public_token>'
\echo 'Si "tiene_comprobante" da false, algo anduvo mal (el comprobante es'
\echo 'obligatorio para llegar a este estado) — no confirmar sin revisar.'
SELECT public_token, name, email, amount_usd, amount_ars, fx_rate_ars_per_usd,
       (transfer_receipt_data IS NOT NULL) AS tiene_comprobante,
       transfer_receipt_filename, transfer_receipt_uploaded_at
  FROM members
 WHERE status = 'transferencia_pendiente_confirmacion'
 ORDER BY transfer_receipt_uploaded_at;
