# Runbook — de entorno de pruebas a producción

Guía operativa paso a paso. **No contiene ninguna credencial**: todos los
valores van en `.env` (local) o en el panel de Variables de Railway, y los
cargás vos. Este documento solo dice *qué* cargar y *cómo verificar* que quedó
bien.

Para el orden general, los gates y el soft launch, ver `docs/ROADMAP.md`.

---

## Parte A · Dejar el entorno listo para pruebas

Se puede hacer entero con credenciales de **sandbox** (DocuSign demo, Stripe
`sk_test_`, Mercado Pago de prueba). No hace falta nada de producción todavía.

### A1 · Dependencias

```bash
cd ditelli-backend-actualizado
npm install
npm audit          # esperado: 0 vulnerabilidades
```

### A2 · Variables de entorno

```bash
cp .env.example .env
```

Completá el `.env` con tus valores de sandbox. El archivo tiene un comentario
por variable explicando de dónde sale cada una. Tres que suelen dar problema:

- **`SESSION_JWT_SECRET`** — generalo, no lo inventes: `openssl rand -base64 48`
- **`DOCUSIGN_ACCOUNT_ID`** — es el **API Account ID** (un GUID) de *Apps and
  Keys*, no el número corto que se ve arriba a la derecha en la cuenta.
- **`CAPITAL_OBJETIVO_USD`** — tiene que coincidir con el simulador de la
  landing. Si cambia uno y no el otro, el inversor firma un porcentaje
  distinto del que se le mostró en pantalla.

`validateEnv()` corta el arranque si falta alguna obligatoria, con el nombre
exacto en el log. Si el server no levanta, ahí está la respuesta.

### A3 · Base de datos

```bash
psql "$DATABASE_URL" -f schema.sql
```

Crea las columnas nuevas (`mp_preference_id`, `stripe_session_id`,
`amount_ars`, `fx_rate_ars_per_usd`) y la tabla `member_envelopes`. Es seguro
correrlo más de una vez.

### A4 · Verificar que todo arranca

```bash
npm test     # lógica de cotización y guarda anti-doble-cobro (no necesita base ni red)
npm run smoke # levanta el server con variables falsas y comprueba el cableado
npm start    # arranque real contra tu .env
```

`npm run smoke` es el que conviene correr después de cada cambio: en ~10
segundos te dice si rompiste el boot o alguna ruta protegida.

### A4-bis · Correo (Resend)

Sin esto, el sistema arranca y funciona igual, pero **no manda ningún correo**:
ni el enlace para retomar una solicitud, ni la copia del Acuerdo firmado. Queda
avisado en el log de cada envío que no salió.

1. **Verificar un dominio** en Resend → *Domains* → *Add Domain*. Resend te da
   unos registros DNS (SPF y DKIM) para cargar donde tengas el dominio.
   **Esto es obligatorio**: sin dominio verificado, Resend solo deja mandar
   correos a la casilla de tu propia cuenta, así que ningún inversor recibiría
   nada.
2. Cargar en el `.env`:
   ```
   RESEND_API_KEY=re_...
   MAIL_FROM=Ditelli Capital <no-reply@tudominio.com>
   MAIL_REPLY_TO=hola@tudominio.com     # opcional
   MAIL_ADMIN=admin@tudominio.com       # opcional, avisos internos
   ```
   El dominio de `MAIL_FROM` tiene que ser el que verificaste.
3. Probar sin mandar nada real: `node scripts/test-email.js`
4. Probar de verdad: completá una Ficha con un email tuyo y volvé a enviarla
   con los mismos datos. Tenés que recibir el enlace para retomar.

**Qué correos manda el sistema**

| Cuándo | Qué recibe el Miembro |
|---|---|
| Reenvía una Ficha ya existente, o pide recuperar el acceso | Enlace de un solo uso, válido 30 minutos |
| Termina de firmar en DocuSign | El Acuerdo firmado, en PDF adjunto |
| Se acredita el pago | Confirmación de que ya es Miembro |
| Avisa una transferencia | Acuse, con el plazo de verificación |

Y si cargaste `MAIL_ADMIN`, el equipo recibe un aviso por cada transferencia a
verificar — que es el único estado que no avanza solo.

### A5 · Webhooks apuntando a tu máquina

Los tres proveedores necesitan una URL pública. Con el server local:

```bash
npx localtunnel --port 3000        # o ngrok http 3000
```

Y en cada panel (sandbox), apuntá:

| Proveedor | Ruta |
|---|---|
| Mercado Pago | `<URL_PUBLICA>/api/payments/mp/webhook` |
| Stripe | `<URL_PUBLICA>/api/payments/stripe/webhook` |
| DocuSign Connect | `<URL_PUBLICA>/api/docusign/webhook` |

Poné también esa URL en `APP_BASE_URL` y reiniciá.

> **El detalle que más tiempo hace perder:** cada proveedor tiene su propio
> secreto de firma, y el de sandbox es **distinto** del de producción. Si no
> coinciden, el backend descarta la notificación y responde 200 igual — así
> que desde afuera parece que todo anduvo. La única forma de darse cuenta es
> mirar el log: `Firma de Mercado Pago inválida`.

### A6 · Prueba end-to-end en sandbox

Recorré el flujo completo con la landing apuntando a tu backend local
(en `public/index.html`, la constante `API_BASE`):

1. Ficha → el `memberId` tiene que ser un **UUID**, no un número.
2. Firma en DocuSign demo (el PDF va a tener marca de agua: es lo esperado).
3. Antes de pagar, mirá el log: `💱 Aporte USD ... → ARS ... (cotización ...)`.
   Verificá que esa cotización sea la real del día.
4. Pagá con una tarjeta de prueba del proveedor.
5. En la base: `status='activo'`, el `*_payment_id` cargado, y `amount_ars` /
   `fx_rate_ars_per_usd` con los valores del cobro.

**Y estas dos, que son las que valen:**

- **Doble pestaña.** Abrí el flujo en dos pestañas y apretá "Firmar" en las
  dos. Tiene que crearse **un solo sobre**: la segunda reutiliza el primero
  (`♻️ Reutilizando el sobre ...` en el log).
- **Webhook perdido.** Pagá y, antes de que llegue la notificación, recargá la
  landing. `/status` tiene que activar al Miembro igual, consultando al
  proveedor por su cuenta.

### A7 · Revisar el estado de la base

```bash
psql "$DATABASE_URL" -f scripts/check-estado.sql
```

Siete consultas de solo lectura: Acuerdos con porcentaje sospechoso, Miembros
trabados, cobros duplicados, cobros sin trazabilidad de cotización, sobres
huérfanos, resumen por estado y capital captado.

**La primera es la importante.** Si devuelve filas con estado distinto de
`nuevo`/`firma_pendiente`, hay un Acuerdo **ya firmado** con un porcentaje
incorrecto. Eso no lo arregla ningún deploy: es una conversación con la
asesoría legal.

---

## Parte B · Pasar a producción

Todo lo de acá son cuentas y datos de Ditelli. **Nada de esto lo puede hacer el
código por vos.**

### B1 · Rotar credenciales

El `.env` y la clave privada de DocuSign salieron del entorno en un `.zip`.
Nunca llegaron a GitHub, pero eso ya no importa: salieron.

- [ ] Mercado Pago → nuevo Access Token de producción
- [ ] Stripe → nueva Secret Key `sk_live_` y su `whsec_` de producción
- [ ] DocuSign → nuevo par RSA en *Apps and Keys*, y borrar el anterior
- [ ] Postgres → nueva password, actualizar `DATABASE_URL`
- [ ] Nuevo `SESSION_JWT_SECRET`

> Rotar el `SESSION_JWT_SECRET` invalida las sesiones activas. En pruebas no
> importa; con inversores reales, hacelo en una ventana de baja actividad.

### B2 · DocuSign a producción

- [ ] Iniciar el **Go-Live** desde *Apps and Keys*. Ya no hace falta el viejo
      requisito de 20 llamadas: valida solo y aprueba al instante, o deja la
      integración en revisión (típicamente ≤48 h). **Arrancalo el primer día**,
      por si cae en revisión.
- [ ] Subir la plantilla del Acuerdo a la cuenta de producción y actualizar
      `DOCUSIGN_TEMPLATE_ID`: el ID de demo **no existe** en producción.
- [ ] `DOCUSIGN_BASE_PATH=https://www.docusign.net/restapi`
- [ ] Borrar `DOCUSIGN_RETURN_URL` si quedó apuntando a `127.0.0.1`.

### B3 · Pasarelas a producción

- [ ] `STRIPE_SECRET_KEY=sk_live_...` y el `whsec_` del endpoint de producción
- [ ] Access Token de producción de Mercado Pago
- [ ] Reapuntar los tres webhooks a `APP_BASE_URL` real
- [ ] Probar el webhook de MP con el simulador del panel y confirmar en el log
      que la firma validó

### B4 · Datos de la landing

- [ ] **CBU y alias reales.** Hoy dice `0000003100000000000000`, que es un
      placeholder: una transferencia ahí no llega a ningún lado. Bloqueante.
- [ ] Corregir el texto del Paso 4 que promete *"te enviamos copia del Acuerdo
      a tu correo"* — ese mail todavía no existe.
- [ ] Deploy: `npm run deploy` (publica `public/`, no la raíz del proyecto).
- [ ] Verificar que `<landing>/ditelli-backend-actualizado/.env` devuelva
      **404**. Si devuelve 200, el `.env` está publicado: rotar todo otra vez.

### B5 · Deploy del backend y verificación

Cargá las variables en Railway, desplegá, y corré:

```bash
node scripts/verify-deploy.js https://tu-backend.up.railway.app https://tu-landing
```

Comprueba, sin credenciales, los cinco controles del Gate F1:

1. Las 6 rutas protegidas devuelven **401** sin token
2. `/health` responde `{"ok":true,"db":"up"}`
3. El preflight CORS acepta el header `Authorization`
4. Las cabeceras de helmet están presentes
5. El rate limiter corta con 429

Sale con código 1 si algo crítico falla, así que se puede encadenar en CI.

> El control 3 es el que más se subestima. Si el preflight no acepta
> `Authorization`, **ninguna** llamada protegida funciona desde el navegador,
> aunque `curl` ande perfecto.

- [ ] Configurar el monitor de uptime de Railway apuntando a `/health`.

### B6 · Prueba con dinero real

Con tu propia tarjeta y el Aporte mínimo (USD 1.000), repetí A6 completo contra
producción. Verificá además:

- El PDF firmado **no** tiene marca de agua de demo.
- El % del Acuerdo dice **0,20%** (1.000 / 500.000) y coincide con el simulador.
- Reembolsate desde el panel del proveedor.

---

## Operación diaria durante el soft launch

```bash
psql "$DATABASE_URL" -f scripts/check-estado.sql
```

Y en los logs de Railway, buscar estas cuatro líneas:

| Línea | Qué significa |
|---|---|
| `🚨 COBRO DUPLICADO` | Alguien pagó dos veces. Revisar y devolver. |
| `Firma de Mercado Pago inválida` | El secreto del webhook no coincide. **Hay pagos entrando que no se registran.** |
| `No se pudo descargar el PDF del sobre` | El Miembro avanzó igual, pero el PDF hay que bajarlo a mano. |
| `No se encontró ningún Miembro para envelopeId` | Un sobre sin dueño. No debería pasar más desde el historial de sobres. |

Hoy ninguna de esas cuatro genera una alerta: solo quedan en el log. Montar
esas alertas es el primer pendiente de la fase de mejoras.
