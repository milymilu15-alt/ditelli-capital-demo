# Auditoría de producción — Ditelli Capital backend

**Fecha:** 2026-08-20 · **Alcance:** backend (`ditelli-backend-actualizado/`), esquema de base de datos, frontend estático (`Ditelli Capital/public/index.html` y `docusign-return.html`).

**Método:** lectura completa del código actual (no de un audit viejo), verificación contra la documentación oficial de Mercado Pago, Stripe y DocuSign donde el código hace una afirmación sobre su comportamiento, e inspección directa del código fuente de los SDKs instalados (`node_modules/mercadopago`, `node_modules/docusign-esign`) cuando la doc pública no alcanzaba. Todo lo que se dice "corregido" abajo se corrió — `npm test`, `npm run smoke`, y tests de concurrencia reales contra Postgres (no simulados) — antes de darlo por bueno. El detalle de cada corrida está en la sección 2.

---

## 1. Qué encontré

Esta auditoría es la tercera sobre este proyecto. La mayoría de los puntos del checklist original ya estaban resueltos por las dos rondas anteriores — lo marco explícitamente para no hacerte leer como si fuera la primera vez.

### 1.1 Ya resueltos por sesiones anteriores (verificado leyendo el código, no tocado)

| # | Punto | Dónde | Verificación |
|---|---|---|---|
| 1 | IDOR en `/status` y rutas de pago/DocuSign | `src/auth.js`, todas las rutas en `server.js` | JWT de sesión (`requireMemberSession`) exigido en las 5 rutas sensibles. Confirmado con `scripts/test-idor.sh` corriendo de verdad. |
| 2 | Secuestro de Ficha por email/DNI (antes `OR`, ahora `AND`) | `src/db.js:findActiveOrPendingMember` | Confirmado en el mismo test — repetir el email+DNI de otro Miembro devuelve `202` neutro, sin `memberId`. |
| 3 | Sobres duplicados por doble pestaña (C-6) | `src/db.js:withMemberLock`, `server.js:273` | Reproducido con dos `POST /api/docusign/envelope` en paralelo de verdad (`scripts/test-race-envelope.js`) — queda **una sola** fila en `member_envelopes`. |
| 4 | Campos del sobre de DocuSign bloqueados para el firmante | `src/docusign.js:121-124` (`locked: "true"`) | Verificado el tipo correcto contra el modelo real del SDK instalado (`node_modules/docusign-esign/src/model/Text.js:751-754`: el campo es `{String}`, no boolean — `"true"` es el valor correcto). |
| 5 | Rate limiting en endpoints públicos | `server.js` (`apiLimiter`, `strictLimiter`) | Confirmado con `scripts/verify-deploy.js` — `POST /api/members` corta con `429`. |
| 6 | `UNIQUE` en `envelope_id`/`mp_payment_id`/`stripe_payment_id` | `schema.sql:82-84` | — |
| 7 | Fail-fast de variables de entorno | `server.js:validateEnv()` | — |
| 8 | CORS multi-origen | `server.js` (`ALLOWED_ORIGINS` separado por comas) | Confirmado con preflight real (`verify-deploy.js`, sección 3). |
| 9 | `paymentId` inexistente en MP no rompe con 500 | `src/mercadopago.js:handleWebhook` (catch alrededor de `payment.get`) | — |
| 10 | Stripe: `payment_status === "paid"` antes de activar | `src/stripe.js:69` | Verificado contra la documentación oficial de Stripe (Fulfill orders / How Checkout works) — es exactamente el campo que recomiendan chequear. |
| 11 | MP: re-consulta a la API real antes de confiar en el webhook | `src/mercadopago.js:handleWebhook` (`payment.get({id: paymentId})`) | — |
| 12 | Cotización USD→ARS real, con caché y falla cerrada | `src/fx.js` | — |
| 13 | Reconciliación activa en `/status` contra DocuSign/MP/Stripe | `server.js` (ruta `/status`) | — |
| 14 | Frontend sanitiza el nombre antes de `innerHTML` | `index.html:1573` (`escapeHtml`) | Es el único dato que llega por `innerHTML` sin pasar por el formulario (puede venir directo de la API). El resto de los `innerHTML` son strings fijos del código. |
| 15 | Frontend: errores de red visibles al usuario en las acciones que dispara (Ficha, Firmar, Pagar) | `index.html` (`showError` en cada `catch`) | Los únicos `catch` silenciosos (`console.error` sin UI) son chequeos de fondo no bloqueantes (líneas 924/987) — degradan bien: el botón normal sigue disponible. No los toqué. |

### 1.2 Encontrados en esta auditoría y corregidos

| # | Severidad | Hallazgo | Archivo:línea |
|---|---|---|---|
| A | **Alto** | `markPaid` (activación por pago) tenía el MISMO bug de condición de carrera que C-6 resolvió para los sobres — pero nunca se corrigió del lado de los pagos. Es un read-then-write sin lock: dos pagos **distintos** aprobados casi al mismo tiempo para el mismo Miembro podían leer ambos "sin pago todavía", y el segundo `UPDATE` pisaba al primero sin que la guarda de "COBRO DUPLICADO" llegara a dispararse — exactamente el escenario que ese log dice prevenir. | `server.js` webhooks de MP (línea 453 ahora) y Stripe (línea 496), y la reconciliación en `/status` |
| B | **Alto** | `GET /api/config` no existía. El frontend (`index.html`, `applyPublicConfig`) ya estaba escrito para pedirlo al cargar y sincronizar `CAPITAL_OBJETIVO_USD`/`APORTE_MINIMO_USD` con el backend — la ruta nunca se implementó del lado del servidor. El `fetch` fallaba en silencio (`if(!res.ok) return`) y el simulador quedaba solo con sus valores por defecto (500.000 / 1.000), que hoy **coinciden por casualidad** con los del backend. El día que cambies `CAPITAL_OBJETIVO_USD` en Railway sin agregar código, el simulador le muestra al inversor un % y el Acuerdo firmado imprime otro. | `index.html:1621` (llamada) vs. backend (ruta faltante) |
| C | **Medio-Alto** | El manejador de errores centralizado era fail-**abierto**: mostraba `err.message` a menos que `NODE_ENV` fuera exactamente `"production"`. Railway no setea `NODE_ENV` por defecto (a diferencia de otros PaaS) — si nadie lo carga a mano en el panel, cualquier error no controlado filtraba su mensaje interno a cualquier cliente. | `server.js:708` (antes ~617) |
| D | **Medio** | `markPaid` no verificaba explícitamente que el Miembro ya hubiera firmado antes de activarlo por pago. No es explotable HOY (las rutas que generan la preferencia/sesión de pago ya exigen `firmado_pendiente_pago` antes de arrancar), pero era una dependencia implícita — un caller futuro (o una respuesta inesperada de un proveedor) podía activar a alguien sin Acuerdo firmado sin que nada lo impidiera. | `server.js:562-563` |
| E | **Medio** | Validación de firma de Mercado Pago hecha a mano (parseo de header + HMAC). El propio SDK instalado (`mercadopago@3.4.0`) trae un validador oficial (`WebhookSignatureValidator`) — confirmado leyendo `node_modules/mercadopago/dist/utils/webhook/index.js`. Encontré además una discrepancia sutil entre la implementación manual y la oficial: el manifest a mano siempre incluía `id:...;` aunque `dataId` viniera vacío, mientras que la oficial omite ese segmento — en la práctica no afecta a los webhooks de tópico `"payment"` (siempre traen `data.id`), pero es el tipo exacto de detalle que conviene delegarle a MP en vez de mantenerlo nosotros. | `src/mercadopago.js:112` |
| F | **Bajo-Medio** | Stripe: solo se escuchaba `checkout.session.completed`. Verificado contra la documentación oficial de Stripe: para métodos de pago asincrónicos hace falta escuchar también `checkout.session.async_payment_succeeded` (la sesión puede completarse en pantalla con `payment_status="unpaid"` y confirmarse recién después). Hoy es inerte — el propio comentario del código dice que solo tarjeta está habilitada en el dashboard, y con tarjeta el pago siempre confirma al instante — pero si el día de mañana se habilita otro método sin tocar código, esos pagos quedarían sin webhook de activación (la reconciliación de `/status` los rescataría, pero solo si el Miembro vuelve a abrir la página). | `src/stripe.js:73-79` |
| G | **Bajo** | `src/fx.js`: el campo `source` que devuelve `usdToArs` podía reportar mal de dónde salió la cotización REALMENTE usada. Caso: dolarapi respondió bien una vez (queda cacheada), después empieza a fallar, y se carga `FX_FIXED_RATE_ARS_PER_USD` como respaldo — la cotización usada es la fija, pero como `cache.rate` nunca se limpia, la condición vieja seguía reportando `"dolarapi.com"`. No afecta el monto cobrado ni la columna `fx_rate_ars_per_usd` (ambos correctos en todos los casos) — solo el rótulo de auditoría de dónde salió el número. | `src/fx.js:83` (`getRate`) |
| H | **Alto — regresión de otra sesión** | `.env.example` había sido borrado del repo por el commit `8c1db98`, cuyo mensaje dice tratarse solo de "bloquear campos prellenados del sobre de DocuSign" (probablemente un `git add -A` de más). Sin él, el paso P.2 del roadmap (`cp .env.example .env`) no tiene de dónde copiar — cualquiera que clone el repo desde cero no sabe qué variables existen. | — (archivo faltante) |
| I | **Bajo** | `scripts/test-idor.sh` y `scripts/test-markpaid.js` (escritos por mí en auditorías anteriores) habían quedado desactualizados: el primero usaba un monto (999.999) que ahora excede `CAPITAL_OBJETIVO_USD` (validación agregada después) y emails/DNIs fijos que chocan entre corridas contra la misma base persistente de Neon; el segundo tenía una regex que dejó de matchear al agregarle el parámetro `client` a `markPaid`. | `scripts/test-idor.sh`, `scripts/test-markpaid.js` |

### 1.3 Señalados, sin corregir (a propósito — ver sección 3)

- **Modelo de `proportionalPct`.** Una sesión anterior a la mía cambió el cálculo de "capital ya captado" a `CAPITAL_OBJETIVO_USD` fijo, con una justificación técnica sólida en el propio código (el modelo dinámico anterior nunca sumaba 100% entre todos los Miembros y dependía del orden de llegada). Sigue siendo, en el fondo, una decisión de negocio — qué base usar para un número que se imprime en documentos con validez legal — y como tal necesita tu confirmación explícita, no solo la de un modelo de lenguaje. Como efecto secundario, `getCapitalCaptadoTotal()` (`src/db.js:251`) quedó sin ningún caller — código muerto que dejé por si lo querés para un reporte/dashboard futuro.
- **Rotación de clave HMAC de DocuSign Connect.** Confirmé (búsqueda web) que DocuSign permite hasta 100 claves activas simultáneas durante una rotación, mandando `X-DocuSign-Signature-1`, `-2`, etc. — basta con que UNA matchee. El código de `isValidDocuSignSignature` solo revisa la posición `-1`. Es inerte mientras la cuenta tenga una sola clave activa (el caso normal hoy), pero si alguna vez rotás `DOCUSIGN_CONNECT_HMAC_KEY` dejando la vieja activa un tiempo (la forma segura de rotar sin cortar webhooks en tránsito), esto podría no reconocer la firma si queda en una posición distinta a la 1. No lo implementé por prioridad — es una función chica de agregar si la vas a necesitar.
- **Tolerancia de replay en la firma de MP.** A propósito NO le agregué una ventana de tiempo (`toleranceSeconds`) al nuevo validador oficial. La documentación de MP confirma que reintenta notificaciones fallidas cada 15 minutos, extendiéndose más después del tercer intento, y **no aclara** si cada reintento resigna el timestamp o reenvía el original. Agregar una ventana corta sin confirmar eso arriesgaba rechazar reintentos legítimos — el mismo tipo de suposición sin verificar que este proyecto ya pagó caro una vez.

---

## 2. Qué modifiqué

Todo sin commitear (`git status` al final de esta sección). Nada de esto tocó Railway, DNS, ni credenciales de producción.

**`server.js`**
- Agregada `GET /api/config` (expone `capitalObjetivoUsd`/`aporteMinimoUsd`) y la constante `APORTE_MINIMO_USD` (antes hardcodeada como `1000` dentro del `if` de validación).
- Los tres puntos donde se llama a `markPaid` (webhook de MP, webhook de Stripe, reconciliación en `/status`) ahora corren dentro de `db.withMemberLock`.
- `markPaid` recibe un cuarto parámetro `client` (se lo pasa a `db.updateMember`) y un guard nuevo: rechaza activar a un Miembro fuera de `firmado_pendiente_pago` / `transferencia_pendiente_confirmacion` / `activo`.
- Manejador de errores centralizado: invertido de fail-abierto a fail-cerrado (solo muestra `err.message` con `NODE_ENV=development` o `test`).
- `onDocumentDownloaded` (webhook de DocuSign) y la sincronización activa en `/status` ahora llaman a `storage.uploadSignedPdf` antes de `db.saveSignedDocument`.

**`src/db.js`**
- `saveSignedDocument` acepta un tercer parámetro opcional `signedPdfUrl`.
- `rowToMember` expone `signedPdfUrl`.

**`src/fx.js`**
- `getRate()` devuelve `{ rate, source }` en vez de solo `rate`, con el `source` decidido en el momento exacto en que se elige qué cotización usar (no reconstruido después a partir de estado que pudo cambiar).

**`src/mercadopago.js`**
- `isValidMpSignature` reemplazada: usa `WebhookSignatureValidator` del SDK oficial en vez de HMAC hecho a mano. Se sacó el `require("crypto")` que quedó sin uso.

**`src/stripe.js`**
- `handleWebhook` ahora también escucha `checkout.session.async_payment_succeeded` (activa igual que `completed`) y `checkout.session.async_payment_failed` (solo loguea, sin cambio de estado).

**`src/storage.js`** (nuevo)
- Integración de storage S3-compatible para el PDF firmado, desactivada por defecto (sin `STORAGE_S3_BUCKET`, no hace nada — el comportamiento actual, tamaño en bytes nada más, sigue igual). Ver sección 3 para lo que falta para activarla de verdad.

**`schema.sql`**
- Nueva columna `members.signed_pdf_url TEXT`, con su migración `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` para bases ya existentes. **Corrida contra la base real** (`DATABASE_URL` del `.env`) para confirmar que aplica sin errores — no me quedé con "debería andar".

**`.env.example`** (nuevo — estaba borrado, ver hallazgo H)
- Reconstruido con la lista completa de variables que hoy lee el código, incluidas las que agregué (`APORTE_MINIMO_USD`, `NODE_ENV`, `STORAGE_S3_*`). Sin ningún valor real.

**`README.md`**
- Tabla de variables de entorno actualizada (`APORTE_MINIMO_USD`, `NODE_ENV`).
- Corregido un párrafo que describía el problema de sincronización del simulador como si siguiera sin resolver (ahora lo resuelve `/api/config`).
- Agregada una nota sobre el lock de `markPaid`.

**`scripts/test-idor.sh`** y **`scripts/test-markpaid.js`**
- Actualizados para que sigan pasando contra el código actual (ver hallazgo I). `test-markpaid.js` suma un sexto caso: pago sobre un Miembro que no firmó no lo activa.

**`scripts/test-race-payment.js`** (nuevo)
- Test de regresión para el hallazgo A: extrae el `markPaid` real de `server.js` (misma técnica que `test-markpaid.js`) pero lo corre contra la base de datos REAL dentro de `db.withMemberLock`, disparando dos pagos distintos en paralelo de verdad para el mismo Miembro.

**Dependencias**
- `@aws-sdk/client-s3` agregada (para `src/storage.js`).

### Verificación — todo corrido, no asumido

```
npm test                              → 13/13 OK (5 fx + 8 markPaid, incluye el caso nuevo)
npm run smoke                          → 9/9 OK (boot con credenciales falsas, rutas protegidas)
node scripts/verify-deploy.js (local)  → Gate F1 SUPERADO (headers, CORS preflight con Authorization, rate limit)
npm audit --omit=dev                   → 0 vulnerabilidades
schema.sql aplicado contra la base real → sin errores

scripts/test-idor.sh                   → todo OK (IDOR sigue cerrado tras los cambios)
scripts/test-race-envelope.js          → 5/5 OK (C-6 sigue funcionando: 1 sobre en 2 requests paralelos reales)
scripts/test-race-payment.js           → 3/3 OK (hallazgo A corregido: 2 pagos paralelos reales para el
                                          mismo Miembro → uno se activa, el otro queda como COBRO DUPLICADO,
                                          nada se pierde ni se pisa)
```

Los últimos tres corren HTTP real contra un `node server.js` local (mismo `DATABASE_URL` de Neon que usa tu `.env`, y para el sobre de DocuSign, la cuenta demo/sandbox real) — no son simulaciones ni mocks. Quedaron algunas filas de prueba en `members` (emails `race-test-*`, `race-payment-*`, `idor-test-*@example.com`) — no las borré, están identificadas por esos prefijos si las querés limpiar.

**No corrí** nada contra Mercado Pago o Stripe reales (ni siquiera sandbox): `markPaid` y el fix del hallazgo A no llaman a esos proveedores, así que se pudieron probar sin tocarlos. El servidor local que usé para las pruebas quedó **detenido** al terminar.

---

## 3. Qué tenés que hacer vos (Matías)

### Decisiones de negocio pendientes de tu confirmación

1. **Modelo de `proportionalPct`.** Hoy se calcula como `amountUsd / CAPITAL_OBJETIVO_USD` (fijo en 500.000 por defecto). El código lo justifica técnicamente (evita que el % dependa del orden de llegada), pero es un número con validez legal — confirmá con el cliente/asesoría que ESE es el modelo correcto antes de que se firme un Acuerdo más. Si en algún momento decidís volver al modelo dinámico (dividir por capital ya captado), `getCapitalCaptadoTotal()` en `src/db.js:251` sigue ahí, sin usar.
2. **La consulta de `proportional_pct` en Acuerdos ya firmados** (`scripts/check-estado.sql` / `consultas-cliente.sql`, ya señalado por una sesión anterior) — seguí pendiente de correrla y, si aparece algo, es conversación con abogado.

### Credenciales / cuentas reales que faltan (no las toqué, como pediste)

1. **Storage del PDF firmado (`src/storage.js`).** Implementado y con los tests de sintaxis/boot en verde, pero **nunca probado contra un bucket real** — no generé credenciales a propósito. Para activarlo: elegir proveedor (AWS S3, Cloudflare R2, Backblaze B2 — el código es S3-compatible, andan los tres), crear el bucket **privado**, generar credenciales de escritura, cargar `STORAGE_S3_BUCKET`/`STORAGE_S3_REGION`/`STORAGE_S3_ENDPOINT`/`STORAGE_S3_ACCESS_KEY_ID`/`STORAGE_S3_SECRET_ACCESS_KEY`. Antes de confiar en esto en producción: subí un PDF de prueba y confirmá que la URL guardada en `members.signed_pdf_url` realmente abre el documento correcto.
2. **Proveedor de email** — sigue sin elegir. Bloquea dos cosas: los emails transaccionales (bienvenida, copia del Acuerdo) y el flujo de magic link (ver abajo).
3. **NODE_ENV en Railway** — no lo toqué (es config de Railway, fuera de mi alcance) pero ahora el código ya no depende de que esté bien puesto: si no lo cargás, el comportamiento por defecto es el seguro (oculta el detalle del error). No hace falta que hagas nada acá salvo que quieras ver mensajes de error detallados en un ambiente de staging — en ese caso, `NODE_ENV=development`.
4. **F0 del roadmap sigue pendiente** (rotar credenciales de MP/Stripe/DocuSign/Postgres/`SESSION_JWT_SECRET`) — no lo hice ni lo voy a hacer, es explícitamente tuyo.

### Señalado, no resuelto — tu decisión si vale la pena ahora

1. **Magic link** (ya señalado por auditorías anteriores, sigue siendo lo más urgente de la lista de "fuera de alcance"): un Miembro que pierde su token/localStorage y ya tiene un registro existente no puede retomarlo solo — el `TODO(magic-link)` en `server.js` sigue documentado y sin resolver porque depende del punto 2 de arriba (proveedor de email).
2. **Rotación de clave HMAC de DocuSign Connect** — el código solo revisa `X-DocuSign-Signature-1`. Si vas a rotar `DOCUSIGN_CONNECT_HMAC_KEY` en algún momento manteniendo la vieja temporalmente activa, avisame y agrego el chequeo de las posiciones siguientes antes de que lo necesites.
3. **Tolerancia de replay en la firma de MP** — quedó sin agregar por la razón explicada en 1.3. Si te interesa cerrarlo, la vía más segura es preguntarle a soporte de MP si cada reintento de webhook resigna el timestamp; con esa confirmación es un cambio de una línea.

### Para que puedas relanzar el flujo completo vos

```bash
cd "/c/Users/Matías Orozco/Desktop/ditelli-backend-actualizado"
psql "$DATABASE_URL" -f schema.sql     # agrega signed_pdf_url — ya lo corrí yo, pero es idempotente
npm start
```
