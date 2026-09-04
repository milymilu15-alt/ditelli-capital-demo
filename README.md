# Ditelli Capital — Backend

Backend de pago (Mercado Pago / Stripe) y firma electrónica (DocuSign) para el
flujo de Adhesión.

**Orden del flujo:** Ficha → Firma del Acuerdo → Pago → Miembro activo.
El Miembro nunca transfiere dinero antes de tener el Acuerdo firmado.

```
0) GET  /api/config                  → { capitalObjetivoUsd, aporteMinimoUsd } — lo pide la landing al cargar
1) POST /api/members                 → guarda la Ficha, devuelve { memberId, token }
2) POST /api/docusign/envelope       → genera el sobre y la URL de firma      [auth]
3) DocuSign Connect → /api/docusign/webhook → marca "firmado_pendiente_pago"
4) POST /api/payments/mp/preference  → habilita el pago                        [auth]
   POST /api/payments/stripe/checkout                                          [auth]
   POST /api/payments/transfer/notify                                          [auth]
5) MP/Stripe → su webhook → marca "activo"
   GET  /api/members/:id/status      → estado + sincronización activa          [auth]
   GET  /health                      → healthcheck (proceso + base)
```

`[auth]` = requiere `Authorization: Bearer <token>` cuyo `sub` coincida con el
`memberId` de la request (ver `src/auth.js`).

---

## Puesta en marcha

```bash
npm install
psql "$DATABASE_URL" -f schema.sql     # seguro de correr más de una vez
npm start
```

### Variables de entorno

Obligatorias (el server no arranca sin ellas, ver `validateEnv()`):

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Postgres. Usar el connection string **pooled**. |
| `FRONTEND_URL` | Origen de la landing. Acepta lista separada por comas. Sirve para CORS y para los redirects. |
| `APP_BASE_URL` | URL pública de este backend (se usa para armar el `notification_url` de MP). |
| `SESSION_JWT_SECRET` | Firma de los JWT de sesión. |
| `DOCUSIGN_*` | `ACCOUNT_ID`, `INTEGRATION_KEY`, `USER_ID`, `BASE_PATH`, `TEMPLATE_ID`, `CONNECT_HMAC_KEY`. |
| `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` | Mercado Pago. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe. |

Más una de las dos: `DOCUSIGN_PRIVATE_KEY_PATH` (local) o
`DOCUSIGN_PRIVATE_KEY_CONTENT` (Railway).

Opcionales:

| Variable | Default | Para qué |
|---|---|---|
| `CAPITAL_OBJETIVO_USD` | `500000` | Denominador de la Participación Proporcional. La landing lo pide solo vía `GET /api/config` — no hace falta tocar el HTML. |
| `APORTE_MINIMO_USD` | `1000` | Aporte mínimo por Miembro. Mismo mecanismo: expuesto en `GET /api/config`. |
| `DOLARAPI_URL` | `https://dolarapi.com/v1/dolares/oficial` | Fuente de la cotización USD→ARS. |
| `FX_FIXED_RATE_ARS_PER_USD` | — | Cotización fija de emergencia si la API se cae. Ver abajo. |
| `PGSSL` | — | Forzar SSL contra Postgres. |
| `NODE_ENV` | — | Dejar SIN setear en producción. Solo `development`/`test` habilitan mensajes de error detallados (ver más abajo). |

---

## Decisiones que conviene conocer antes de tocar el código

**La cotización falla cerrada.** Si no se puede obtener un tipo de cambio
confiable, `src/fx.js` lanza y el pago **no se inicia** (el endpoint responde
503 con un mensaje claro). Es a propósito: antes había un `1250` hardcodeado y
con cualquier cotización real por encima de ese valor se cobraba de menos, en
silencio y en cada operación. Si la API está caída y hay que cobrar igual, se
setea `FX_FIXED_RATE_ARS_PER_USD` con la cotización del día acordada con el
contador — explícito y auditable, no un número escondido en el código.

**El % del Acuerdo se calcula sobre `CAPITAL_OBJETIVO_USD`**, no sobre el
capital ya captado. Con el cálculo anterior el número dependía del orden de
llegada y el primer Miembro firmaba 100%. Si cambia el tamaño de la ronda,
alcanza con cambiar esta env var: la landing lee el mismo valor de
`GET /api/config` al cargar, así que los dos lados no pueden desincronizarse
(antes sí podían — quedaba en vos acordarte de tocar el HTML a mano).

**Los webhooks no tienen rate limit, a propósito.** Los proveedores reintentan
en ráfagas legítimas y ya se autentican por HMAC. Limitarlos por IP solo
lograría descartar notificaciones de pago reales.

**No dependemos solo del webhook.** `GET /status` reconsulta a DocuSign, a
Mercado Pago y a Stripe cuando el estado quedó atrás. Es la red de seguridad
para cuando la notificación se pierde.

**El cobro duplicado nunca se pisa.** Si llega un pago distinto para un Miembro
que ya pagó, `markPaid()` no sobrescribe: loguea `🚨 COBRO DUPLICADO` para que
alguien lo revise y devuelva el importe de más. Esto corre bajo el mismo lock
de fila (`db.withMemberLock`) que usa la generación del sobre de DocuSign —
sin eso, dos webhooks de pagos DISTINTOS llegando casi juntos podían leer
ambos "sin pago todavía" y el segundo pisaba al primero sin que la guarda
llegara a dispararse (ver `scripts/test-race-payment.js`).

---

## Documentación

| Archivo | Para qué |
|---|---|
| `docs/ROADMAP.md` | Fases, gates y soft launch hasta la apertura pública |
| `docs/RUNBOOK.md` | Paso a paso operativo: preparar pruebas (Parte A) y pasar a producción (Parte B) |
| `.env.example` | Plantilla de variables, con un comentario por cada una |

## Scripts

```bash
npm test          # lógica de cotización + guarda anti-doble-cobro (sin base ni red)
npm run smoke     # levanta el server con variables falsas y verifica el cableado (~10 s)
npm run verify -- https://tu-backend https://tu-landing   # controles del Gate F1 sobre un deploy
bash scripts/test-idor.sh                                 # requiere el server levantado
psql "$DATABASE_URL" -f scripts/check-estado.sql           # 7 consultas de control (solo lectura)
```

Ninguno necesita credenciales reales. `verify-deploy.js` sale con código 1 si
un control crítico falla, así que se puede encadenar en CI.

---

## ✅ Checklist antes de publicar

Nada de esto lo resuelve el código: son cuentas y datos de Ditelli.

- [ ] **Rotar todas las credenciales.** El `.env` y la clave privada de
      DocuSign salieron del entorno en un `.zip`. Nuevo Access Token de MP,
      nueva Secret Key de Stripe, nuevo par RSA de DocuSign, nuevo
      `SESSION_JWT_SECRET`, nueva password de Postgres.
- [ ] **Pasar DocuSign a producción**: `DOCUSIGN_BASE_PATH=https://www.docusign.net/restapi`,
      credenciales de la cuenta real y plantilla cargada ahí (el
      `DOCUSIGN_TEMPLATE_ID` de demo no existe en producción). El trámite de
      *Go-Live* se hace desde *Apps & Keys*: DocuSign eliminó el viejo
      requisito de 20 llamadas exitosas, ahora valida solo y aprueba al
      instante o deja la integración en revisión (típicamente ≤48 h).
      Conviene iniciarlo igual el primer día, por si cae en revisión.
- [ ] **Pasar Stripe a producción**: clave `sk_live_` y el `whsec_` del
      endpoint de webhook de producción (el de test no sirve).
- [ ] **Cargar el CBU y el alias reales** en la landing. Hoy son placeholders
      (`0000003100000000000000`).
- [ ] **Verificar el preflight CORS** con el header `Authorization`:
      ```bash
      curl -i -X OPTIONS "$APP_BASE_URL/api/members/x/status" \
        -H "Origin: $FRONTEND_URL" \
        -H "Access-Control-Request-Method: GET" \
        -H "Access-Control-Request-Headers: authorization"
      ```
      Tiene que responder 204 e incluir `authorization` en
      `Access-Control-Allow-Headers`. Si no, ninguna llamada protegida
      funciona desde el navegador.
- [ ] **Confirmar la URL del webhook en el panel de Mercado Pago** y que la
      firma secreta coincida con `MP_WEBHOOK_SECRET`. Probarlo con el
      simulador del panel y mirar los logs: si aparece "Firma de Mercado Pago
      inválida", hay que arreglarlo **antes** de que empiece a rechazar pagos
      reales.
- [ ] **Revisar los `proportional_pct` ya guardados**:
      ```sql
      SELECT public_token, name, amount_usd, proportional_pct, status
      FROM members WHERE proportional_pct IS NOT NULL ORDER BY proportional_pct DESC;
      ```
      Si hay filas con un % alto y estado distinto de `nuevo`/`firma_pendiente`,
      hay un Acuerdo firmado con un porcentaje incorrecto. Eso es un problema
      contractual, no técnico: resolverlo con la asesoría legal.
- [ ] **Correr `schema.sql`** contra la base de producción (agrega las columnas
      nuevas y la tabla `member_envelopes`).
- [ ] **Configurar el monitor de uptime** de Railway apuntando a `/health`.

## Pendiente para la fase de mejoras

- Storage real del PDF firmado (hoy solo se guarda el tamaño en bytes).
- Emails transaccionales: confirmación de firma, bienvenida, y el **magic
  link** para retomar una Ficha (ver el `TODO(magic-link)` en `server.js` —
  hoy, si alguien pierde su token, queda bloqueado hasta que se borre la fila
  a mano).
- Panel interno para confirmar las transferencias bancarias.
- Alertas a Slack/mail en los eventos que hoy solo quedan en el log: firma de
  webhook inválida, cobro duplicado, PDF que no se pudo descargar.
