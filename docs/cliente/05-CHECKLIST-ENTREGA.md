# Checklist de entrega — Ditelli Capital

**Punto de partida:** el sistema ya está probado, con credenciales reales cargadas
y webhooks funcionando. Lo que sigue es el traspaso.

**Entrega:** Nexture → Ditelli Capital
**Fecha:** ____ / ____ / ______

---

## Cómo usar este documento

El orden no es arbitrario. Dos reglas que explican por qué está armado así:

**Primero se traspasa, después se rota.** Al terminar, las credenciales que
están vivas en producción tienen que ser unas que vos nunca viste. Es la única
forma de hacer un corte limpio: Ditelli deja de depender de tu buena fe, y vos
dejás de tener responsabilidad sobre plata que no es tuya. Importa especialmente
acá, porque durante el desarrollo hubo credenciales que salieron del entorno.

**El dominio se define antes que nada.** Cambiar el dominio después toca siete
lugares distintos, y si se olvida uno el flujo se rompe en silencio.

---

# BLOQUE 0 · Verificación previa

Antes de convocar al cliente. Si algo de acá falla, no hay entrega.

- [ ] `npm test` → las tres suites en verde (cotización, doble cobro, correo)
- [ ] `node scripts/verify-deploy.js <backend> <landing>` → **Gate F1 SUPERADO**
- [ ] `GET /api/members/1/status` sin token → **401** (no datos)
- [ ] `GET /health` → `{"ok":true,"db":"up"}`
- [ ] Prueba end-to-end con plata real propia, completada y reembolsada
- [ ] El PDF firmado **no** tiene marca de agua de DocuSign demo
- [ ] El porcentaje del Acuerdo coincide con el del simulador
- [ ] Llegaron los cuatro correos: enlace de acceso, Acuerdo con PDF, pago confirmado, acuse de transferencia
- [ ] `psql "$DATABASE_URL" -f scripts/check-estado.sql` → sin sorpresas en la consulta 1
- [ ] Borrar de la base los registros de prueba (los que dicen "Test")

> ⚠️ Si en la consulta 1 aparece una fila con nombre real y porcentaje alto, **frená
> la entrega**: hay un Acuerdo firmado con un porcentaje incorrecto y eso se
> resuelve con la asesoría legal, no con un deploy.

---

# BLOQUE 1 · Dominio

- [ ] Definir el dominio definitivo: `______________________________`
- [ ] Registrado y pago, con vencimiento anotado: ____ / ____ / ______
- [ ] La landing abre por HTTPS con certificado válido
- [ ] `http://` redirige a `https://`
- [ ] Con y sin `www` llevan al mismo lugar

**Registros DNS que tienen que estar cargados:**

- [ ] El de la landing (CNAME o A, según dónde esté publicada)
- [ ] **SPF** — para que Resend pueda enviar
- [ ] **DKIM** — firma de los correos
- [ ] *(recomendado)* **DMARC** — evita que los correos caigan en spam
- [ ] En Resend, el dominio figura **Verified** ✅

**Si el dominio cambió respecto de las pruebas, revisar los 7 lugares:**

- [ ] `FRONTEND_URL` en Railway
- [ ] `APP_BASE_URL` en Railway
- [ ] `API_BASE` en `public/index.html`
- [ ] URL del webhook en el panel de Mercado Pago
- [ ] URL del webhook en Stripe
- [ ] URL de DocuSign Connect
- [ ] `MAIL_FROM` (el dominio del remitente tiene que ser el verificado)

> Es el error más común de toda la puesta en producción. Si falta uno, el
> síntoma no es un error visible: es un pago que no se registra o un correo
> que no llega.

---

# BLOQUE 2 · Base de datos

- [ ] `schema.sql` corrido contra la base de producción, sin errores
- [ ] Las tablas existen: `members`, `member_envelopes`, `magic_links`
- [ ] Están las columnas nuevas: `public_token`, `mp_preference_id`, `stripe_session_id`, `amount_ars`, `fx_rate_ars_per_usd`
- [ ] La base está en el **plan pago** de Neon → habilita backups automáticos programados
- [ ] Backup manual tomado **antes** del traspaso, y descargado fuera de Neon
- [ ] Probada la restauración de ese backup (un backup que nunca se restauró no es un backup)
- [ ] Connection string usando el host **pooled**
- [ ] `sslmode=require` en la URL

**Accesos a la base:**

- [ ] Una persona de administración de Ditelli con usuario propio en Neon
- [ ] Verificado que puede entrar al SQL Editor y correr las consultas
- [ ] Verificado que puede exportar a CSV con el botón *Download*

---

# BLOQUE 3 · Traspaso de titularidad

**Todo a nombre de Ditelli, con un correo institucional** (`sistemas@ditelligroup.com.ar`),
nunca el correo personal de una persona. Si esa persona se va, se pierde el acceso.

### 3.1 · Neon (base de datos)

Neon tiene traspaso directo y **conserva las credenciales y el connection string**,
así que la aplicación no se desconecta durante la operación.

- [ ] Ditelli crea su cuenta y su organización en Neon
- [ ] La organización destino está en un plan **igual o superior** al de origen *(requisito de Neon)*
- [ ] Desconectar las integraciones del proyecto antes de transferir *(lo pide Neon)*
- [ ] En el proyecto → *Settings* → *Transfer* → generar **claim link**
- [ ] Enviar el link a Ditelli (**vence a las 24 horas**)
- [ ] Ditelli lo acepta y elige su organización
- [ ] Verificar que la app sigue respondiendo: `GET /health` → `db: up`
- [ ] Nexture queda como colaborador, no como dueño

### 3.2 · Railway (servidor)

- [ ] Ditelli crea su cuenta con plan **Hobby o Pro activo** *(requisito para recibir)*
- [ ] Agregar a Ditelli como miembro del proyecto
- [ ] Tres puntos junto a su nombre → **Transfer Ownership**
- [ ] Ditelli acepta desde el correo (**tiene 24 horas**)
- [ ] Verificar que el servicio sigue desplegado y respondiendo
- [ ] Confirmar que las variables de entorno siguen cargadas

### 3.3 · Dominio `.com.ar`

- [ ] Ditelli tiene CUIT con **Clave Fiscal nivel 2 o superior**
- [ ] Titular actual: entrar a nic.ar → lista de dominios → **Transferir** → CUIT del nuevo titular
- [ ] Ditelli: **Trámites a Distancia** → *Mis Trámites* → *Tareas pendientes* → aceptar
- [ ] Ditelli confirma el trámite, carga facturación y paga
- [ ] Esperar la acreditación: **24 h** con tarjeta o PagoMisCuentas, **72 h hábiles** con Rapipago
- [ ] **Después de la transferencia, verificar que los registros DNS sigan cargados** (landing, SPF, DKIM)
- [ ] Confirmar que la landing sigue abriendo y que Resend sigue **Verified**

### 3.4 · Mercado Pago

- [ ] La cuenta está a nombre de Ditelli y **validada como empresa** (con CUIT)
- [ ] La aplicación de desarrollador figura en esa cuenta
- [ ] Ditelli tiene acceso al panel y puede ver Actividad y devolver un cobro
- [ ] Confirmado a qué cuenta bancaria se liquida el dinero

### 3.5 · DocuSign

- [ ] Cuenta a nombre de Ditelli, con plan de API activo
- [ ] La plantilla del Acuerdo está cargada en la cuenta de producción
- [ ] Integración en estado **Go-Live** aprobado
- [ ] Ditelli puede entrar y descargar un Acuerdo firmado

### 3.6 · Resend (correo)

- [ ] Cuenta a nombre de Ditelli
- [ ] Dominio verificado dentro de esa cuenta
- [ ] Ditelli puede ver el registro de envíos

### 3.7 · Stripe *(si aplica)*

- [ ] Ver el documento de costos: **no está disponible para empresas argentinas**
- [ ] Si no se usa, dejarlo documentado y **quitar la opción de la landing**, para no ofrecer un método que no funciona

### 3.8 · Alojamiento de la landing

- [ ] Ditelli tiene acceso a la cuenta donde está publicada
- [ ] Verificado que puede publicar una actualización

---

# BLOQUE 4 · Código y archivos

- [ ] Repositorio Git con **todo commiteado** — nada sin trackear
- [ ] Verificado que `.env` y `keys/` **no** están en el repositorio ni en su historial
- [ ] Repositorio transferido a una cuenta de Ditelli, o entregado como copia completa con historial
- [ ] Entregada la carpeta del proyecto con: `server.js`, `src/`, `scripts/`, `schema.sql`, `docs/`, `package.json`, `.env.example`
- [ ] Entregada la carpeta `public/` con la landing y las imágenes
- [ ] Confirmado por escrito que **el código es propiedad de Ditelli**
- [ ] Ditelli guardó una copia en su propio almacenamiento, fuera de la computadora de Nexture

> Verificación rápida antes de entregar el repo:
> ```
> git status                    # tiene que estar limpio
> git log --all --name-only | grep -E "^\.env$|keys/"    # no debe devolver nada
> ```

---

# BLOQUE 5 · Credenciales — el corte limpio

Este es el bloque que no hay que apurar.

- [ ] **Ditelli genera credenciales nuevas desde sus propias cuentas**, ya transferidas:
  - [ ] Access Token de Mercado Pago
  - [ ] Firma secreta del webhook de MP
  - [ ] Clave y `whsec_` de Stripe *(si aplica)*
  - [ ] Par RSA nuevo en DocuSign, borrando el anterior
  - [ ] API key nueva de Resend
  - [ ] Password nueva de Postgres
  - [ ] `SESSION_JWT_SECRET` nuevo (`openssl rand -base64 48`)
- [ ] Las nuevas se cargan **directamente en el panel de Railway**, nunca por WhatsApp, mail ni un documento compartido
- [ ] Las credenciales viejas quedan revocadas y verificado que ya no funcionan
- [ ] Ditelli las guarda en un gestor de contraseñas, no en un Excel
- [ ] Nexture confirma por escrito que no conserva ninguna copia

> Rotar el `SESSION_JWT_SECRET` cierra las sesiones abiertas de los inversores.
> Hacelo en un horario de baja actividad, y si hay alguien a mitad del proceso,
> avisale que va a tener que pedir el enlace de acceso por correo otra vez.

**Después de rotar, repetir la verificación:**

- [ ] `node scripts/verify-deploy.js` → Gate F1 en verde otra vez
- [ ] Una inversión completa de prueba, de punta a punta
- [ ] Llegó el correo con el Acuerdo adjunto

---

# BLOQUE 6 · Documentación

- [ ] `01-INSTALACION.md`
- [ ] `02-GUIA-DE-USO.md`
- [ ] `03-COBROS-Y-BASE-DE-DATOS.md`
- [ ] `04-COSTOS-Y-HERRAMIENTAS.md`
- [ ] `05-CHECKLIST-ENTREGA.md` (este documento, firmado)
- [ ] `docs/RUNBOOK.md` y `docs/ROADMAP.md` para el equipo técnico
- [ ] Planilla con las fechas de vencimiento: dominio, planes, tarjeta de pago de cada servicio

---

# BLOQUE 7 · Sesión de entrega

Unos 90 minutos, con la persona que va a administrar el sistema presente.

- [ ] Recorrer una inversión completa en vivo, de punta a punta
- [ ] Mostrar los tres lugares donde se mira: Neon, Mercado Pago, extracto bancario
- [ ] **Que la persona de administración corra las consultas ella misma**, no Nexture
- [ ] Mostrar cómo exportar a Excel
- [ ] Mostrar cómo se ve una transferencia pendiente y cómo se confirma
- [ ] Mostrar dónde se descarga un Acuerdo firmado desde DocuSign
- [ ] Explicar los cinco estados de un inversor
- [ ] Explicar qué hacer si alguien dice "pagué y no figura"
- [ ] Dejar el teléfono y el horario de soporte por escrito

---

# BLOQUE 8 · Operación

- [ ] Responsable de revisar transferencias: `______________________________`
- [ ] Frecuencia acordada: `______________________________`
- [ ] Responsable de llamar a los que firmaron y no pagaron: `______________________`
- [ ] Quién recibe los avisos de `MAIL_ADMIN`: `______________________________`
- [ ] Monitor de uptime configurado sobre `/health`, con aviso a: `____________________`
- [ ] Acordado qué se hace ante un cobro duplicado y quién autoriza la devolución

---

# BLOQUE 9 · Cierre

- [ ] Lista escrita de lo que **no** está incluido: storage propio del PDF, panel de administración, alertas automáticas
- [ ] Presupuesto y plazo estimado de cada uno de esos pendientes
- [ ] Alcance del soporte post-entrega: qué incluye, por cuánto tiempo, tiempo de respuesta
- [ ] Qué pasa después de ese período
- [ ] Fecha de la primera revisión conjunta: ____ / ____ / ______

---

# Acta de entrega

Ditelli Capital recibe el sistema de Adhesión en funcionamiento, con la
titularidad de todas las cuentas de servicio a su nombre, las credenciales de
producción bajo su control exclusivo, el código fuente y su documentación.

Se deja constancia de los pendientes listados en el Bloque 9, que quedan fuera
del alcance de esta entrega.

<br>

| | Por Nexture | Por Ditelli Capital |
|---|---|---|
| Nombre | ______________________ | ______________________ |
| Firma | ______________________ | ______________________ |
| Fecha | ____ / ____ / ______ | ____ / ____ / ______ |

<br>

**Observaciones**

_______________________________________________________________________

_______________________________________________________________________

_______________________________________________________________________
