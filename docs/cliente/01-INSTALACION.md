# Ditelli Capital — Plan de instalación

**Para:** Ditelli Capital
**Qué es este documento:** la lista completa de todo lo que hay que crear, contratar
y configurar para que el sistema de Adhesión funcione. Está escrito para que lo
pueda seguir alguien sin conocimientos técnicos, con la ayuda del equipo de
desarrollo en los pasos marcados como 🔧.

---

## Antes de empezar: qué es cada pieza

El sistema tiene cinco partes. Sirve entenderlas antes de instalar nada, porque
después todo el resto de la guía las va a nombrar.

| Pieza | Qué hace | Comparación |
|---|---|---|
| **La página web** (landing) | Lo que ve el inversor: la información del proyecto y el formulario para invertir | El local a la calle |
| **El servidor** (backend) | El programa que coordina todo: guarda los datos, pide la firma, inicia el cobro | El empleado administrativo que nadie ve |
| **La base de datos** | Donde queda guardado quién es quién, cuánto puso y en qué estado está | El libro de socios |
| **DocuSign** | Servicio que hace que la firma electrónica tenga validez legal | La escribanía |
| **Mercado Pago / Stripe** | Los que cobran la plata con tarjeta | La terminal de cobro |

Ninguna de estas piezas es reemplazable por otra. Si una se cae, esa parte del
proceso se detiene — más adelante se explica qué pasa en cada caso.

---

## Paso 1 · Crear las cuentas

Todas las cuentas tienen que estar **a nombre de Ditelli Capital**, no a nombre
personal de nadie del equipo ni de la empresa que desarrolla. Esto es importante:
si mañana cambian de proveedor de desarrollo, las cuentas y la plata siguen
siendo de Ditelli.

**Usá un correo de la empresa para todas** (por ejemplo `sistemas@ditelligroup.com.ar`),
no el correo personal de una persona. Si esa persona se va, se pierde el acceso.

### 1.1 · Mercado Pago

1. Entrar a `mercadopago.com.ar` con la cuenta de la empresa (o crearla).
2. Ir a **Tu negocio → Configuración → Gestión y administración**.
3. Verificar que la cuenta esté **validada como empresa** (con CUIT). Sin esto,
   hay límites de cobro.
4. Ir a **Desarrolladores → Tus integraciones → Crear aplicación**.
   - Nombre: `Ditelli Capital — Adhesión`
   - Tipo: pagos online
5. Anotar dónde está la sección **Credenciales de producción**. 🔧 El equipo
   técnico va a necesitar dos valores de ahí. **No los mandes por WhatsApp ni
   por mail**: se cargan directamente en el panel del servidor.

### 1.2 · DocuSign

1. Entrar a `docusign.com` y crear una cuenta **con plan de API** (ver el
   documento de costos: el plan gratuito no sirve para esto).
2. Cargar el **Acuerdo de Participación** como plantilla:
   **Templates → New → Upload**.
3. En la plantilla, marcar dónde va cada dato con estos nombres exactos:
   - `nombre_miembro`
   - `monto_aporte`
   - `porcentaje_asignado`
   - `fecha_aceptacion`
   - y el campo de firma del rol **"Miembro"**
   > ⚠️ Estos nombres tienen que escribirse **exactamente así**, en minúscula y
   > con guiones bajos. Si están distintos, el Acuerdo va a salir con los campos
   > vacíos. Es el error más común de esta instalación.
4. 🔧 El equipo técnico genera las claves de acceso en **Apps and Keys**.

### 1.3 · Base de datos (Neon)

1. Entrar a `neon.com` y crear una cuenta.
2. Crear un proyecto llamado `ditelli-capital`.
3. Elegir la región **más cercana a Argentina** (normalmente `us-east`).
4. 🔧 El equipo técnico corre el archivo que crea las tablas.

### 1.4 · Servidor (Railway)

1. Entrar a `railway.com` y crear una cuenta.
2. 🔧 El equipo técnico conecta el código y carga la configuración.

### 1.5 · Stripe *(opcional — leer la advertencia)*

> ⚠️ **Stripe no está disponible oficialmente para empresas argentinas.** Para
> usarlo hace falta una sociedad en Estados Unidos (una LLC) con cuenta bancaria
> allá. El sistema está preparado para usarlo si algún día se da esa condición,
> pero **se puede lanzar perfectamente sin Stripe**, solo con Mercado Pago y
> transferencia bancaria. Ver el documento de costos.

### 1.6 · Dominio

Si la página va a estar en `ditellicapital.com.ar` (en vez de una dirección
provisoria), hay que registrar el dominio. Los `.com.ar` se sacan en
`nic.ar` con Clave Fiscal de AFIP.

---

## Paso 2 · Datos que tiene que preparar Ditelli

Esto **no lo puede hacer el equipo técnico**: son decisiones y datos del negocio.
Sin esto, el sistema no puede salir a producción.

| # | Dato | Por qué se necesita | Estado |
|---|---|---|---|
| 1 | **CBU y alias bancarios reales** | Hoy el sistema muestra un número de ejemplo. Un inversor que transfiera ahí, pierde la transferencia. | ⛔ Pendiente |
| 2 | **Capital objetivo de la ronda** | Es el número contra el que se calcula el porcentaje de participación de cada inversor. Hoy está en USD 500.000. | ✅ Definido |
| 3 | **Qué cotización del dólar se usa** | El Acuerdo está en dólares y Mercado Pago cobra en pesos. Hay que decidir con el contador: ¿dólar oficial? ¿MEP? Hoy está configurado el **oficial**. | ⚠️ Confirmar con el contador |
| 4 | **Acuerdo de Participación final** | El documento que se firma, revisado por el abogado. | Confirmar |
| 5 | **Quién revisa las transferencias** | Las transferencias bancarias **no se confirman solas**: alguien tiene que mirar el extracto y marcar al inversor como activo. Hay que definir quién y con qué frecuencia. | ⛔ Pendiente |
| 6 | **Correo y teléfono de contacto** | Es lo que ve el inversor si algo falla. | ✅ Definido |

---

## Paso 3 · Instalación técnica

🔧 Todo este paso lo hace el equipo de desarrollo. Se detalla acá para que
Ditelli sepa qué se está haciendo y pueda pedir la constancia de cada punto.

| # | Qué se hace | Cómo se comprueba que salió bien |
|---|---|---|
| 3.1 | Se instala el programa en el servidor | El servidor responde en su dirección web |
| 3.2 | Se crean las tablas en la base de datos | Aparece la tabla `members` en el panel de Neon |
| 3.3 | Se cargan las claves de los servicios | El servidor arranca sin errores |
| 3.4 | Se conectan los avisos de pago (*webhooks*) | Una prueba de pago cambia el estado del inversor automáticamente |
| 3.5 | Se publica la página web | La dirección abre en el navegador |
| 3.6 | Se corre la verificación de seguridad | El informe da "Gate F1 SUPERADO" |

> **Pedí siempre el resultado del punto 3.6.** Es un chequeo automático que
> confirma, entre otras cosas, que **los datos de un inversor no se pueden ver
> sin autorización**. Es una línea de resultado que dice `✅ Gate F1 SUPERADO`.
> Si dice otra cosa, el sistema no está listo, por más que la página se vea bien.

---

## Paso 4 · Pruebas antes de recibir plata real

**No saltear este paso.** Se hace con cuentas de prueba de los proveedores: se
simulan pagos con tarjetas falsas, sin que se mueva plata de verdad.

Qué se prueba, y qué tiene que pasar:

| Prueba | Resultado esperado |
|---|---|
| Un inversor completa todo el proceso | Llega a la pantalla de "¡Listo, sos Miembro!" y queda como **activo** en la base |
| El Acuerdo firmado | El PDF tiene el nombre, el monto y el porcentaje correctos |
| El porcentaje | Coincide con el que la página le mostró en el simulador |
| Se corta internet a mitad del pago | El inversor puede retomar donde estaba |
| Abre el proceso en dos pestañas | Se genera **un solo** Acuerdo, no dos |
| Paga y cierra el navegador enseguida | Igual queda registrado como pagado |

Las últimas tres son las importantes. Un sistema que funciona cuando todo sale
bien es fácil; lo que se prueba acá es qué pasa cuando algo sale mal, que es lo
que va a pasar tarde o temprano con un inversor real.

---

## Paso 5 · Salida a producción

1. Se reemplazan las cuentas de prueba por las reales.
2. **Prueba con plata de verdad:** alguien de Ditelli invierte el mínimo
   (USD 1.000) con su propia tarjeta, verifica que todo quede bien registrado, y
   después se devuelve el dinero desde el panel.
3. **Apertura limitada:** 3 a 5 inversores conocidos, avisados de que son los
   primeros. Se los acompaña de cerca durante 3 a 5 días.
4. **Apertura pública:** recién cuando esos primeros aportes hayan entrado sin
   que nadie del equipo tenga que intervenir a mano.

> **Por qué la apertura limitada no es un trámite.** Es la única forma de ver el
> sistema funcionando con gente que no lo construyó y no sabe qué esperar. Cada
> pregunta que haga uno de esos cinco es un problema que, en apertura pública,
> se multiplica por cien.

---

## Qué pasa si algo se cae

| Si se cae… | Qué pasa | Qué hacer |
|---|---|---|
| **La página web** | Nadie puede empezar una inversión. Los que ya empezaron no pierden nada. | Avisar al equipo técnico |
| **El servidor** | El proceso se frena en el paso en el que esté cada uno. No se pierde nada de lo ya guardado. | Avisar al equipo técnico |
| **La base de datos** | El servidor sigue vivo pero no puede guardar. Se frena todo. | Urgente: avisar al equipo técnico |
| **DocuSign** | No se pueden firmar Acuerdos nuevos. Los ya firmados están a salvo. | Esperar; el sistema reintenta solo |
| **Mercado Pago** | No se puede pagar con tarjeta. **La transferencia bancaria sigue funcionando.** | Ofrecer transferencia mientras tanto |
| **La cotización del dólar** | El pago con tarjeta no arranca, a propósito | Ver documento de costos: se puede cargar la cotización a mano |

> Sobre el último caso: si el sistema no puede saber a cuánto está el dólar,
> **no cobra**. Es una decisión deliberada. Es preferible que un inversor vea un
> mensaje de "reintentá en unos minutos" a que se le cobre un monto equivocado y
> haya que devolverle la diferencia.
