# Ditelli Capital — Guía de uso

**Para:** cualquier persona del equipo de Ditelli, sin conocimientos técnicos.
**Qué es:** cómo funciona el sistema por dentro, qué ve el inversor, qué tenés
que hacer vos, y qué hacer cuando algo no sale como esperabas.

No hace falta leerlo entero de una. Las secciones que más se usan en el día a día
son la **4** (qué tenés que hacer) y la **6** (problemas frecuentes).

---

## 1 · El recorrido del inversor, paso a paso

El inversor entra a la página, lee la propuesta, y hace clic en **"Invertir
ahora"**. A partir de ahí se abre una ventana con cuatro pasos.

### Paso 1 — Ficha de Adhesión
Carga nombre, DNI o CUIT, teléfono, correo y cuánto quiere invertir (mínimo
USD 1.000). Cuando aprieta "Continuar", **queda guardado en la base de datos**
aunque no siga.

> Esto es útil: si alguien abandona acá, ya tenés su nombre y su teléfono. Es
> un contacto que se puede recuperar llamándolo.

### Paso 2 — Firma del Acuerdo
El sistema arma el Acuerdo de Participación con sus datos ya completos (nombre,
monto, porcentaje, fecha) y lo manda a DocuSign. El inversor firma en pantalla,
sin imprimir nada.

**El Acuerdo se firma antes de pagar, siempre.** Es a propósito: nadie transfiere
plata sin tener antes el contrato firmado. Si alguien pregunta por qué, esa es la
respuesta.

### Paso 3 — Pago
Elige entre tres formas:

| Forma | Cómo funciona | Cuándo queda confirmado |
|---|---|---|
| **Tarjeta por Mercado Pago** | Se va a la pantalla de Mercado Pago y vuelve | En el momento |
| **Tarjeta internacional (Stripe)** | Igual, pero cobra en dólares | En el momento |
| **Transferencia bancaria** | Le mostramos el CBU y él transfiere por su banco | **Cuando ustedes lo confirman a mano** |

### Paso 4 — Confirmación
Ve un resumen con su nombre, el monto, su porcentaje de participación y el método
de pago. En ese momento ya es Miembro.

---

## 2 · Los cinco estados de un inversor

Todo inversor está siempre en **uno** de estos cinco estados. Entender esto es la
mitad de entender el sistema.

| Estado | En castellano | ¿Ya pagó? | ¿Qué hacer? |
|---|---|---|---|
| `nuevo` | Cargó sus datos y no siguió | No | Llamarlo: es un interesado real que se frenó |
| `firma_pendiente` | Está firmando o dejó la firma a medias | No | Si lleva días así, llamarlo |
| `firmado_pendiente_pago` | **Firmó el Acuerdo, falta que pague** | No | El más importante: llamalo, ya se comprometió |
| `activo` | **Pagó. Es Miembro.** | Sí ✅ | Nada |
| `transferencia_pendiente_confirmacion` | Avisó que transfirió, falta que ustedes verifiquen | Dice que sí | **Revisar el extracto bancario** |

> **El estado que más plata representa es `firmado_pendiente_pago`.** Esa persona
> ya leyó el Acuerdo, lo firmó, y por algo no completó el pago. Es la lista de
> llamados más rentable que vas a tener.

El recorrido normal es:

```
nuevo → firma_pendiente → firmado_pendiente_pago → activo
```

---

## 3 · Qué hace el sistema solo (y qué no)

**Lo hace solo:**

- Manda los correos: el enlace para retomar una solicitud, la copia del Acuerdo
  firmado en PDF, la confirmación del pago y el acuse de transferencia
- Guarda los datos del inversor
- Arma el Acuerdo con los datos correctos y lo manda a firmar
- Consulta el valor del dólar y convierte el monto a pesos
- Cobra con tarjeta
- Marca al inversor como **activo** cuando el pago se acredita
- Si el aviso de pago se pierde, **vuelve a preguntarle al banco por su cuenta**
- Evita que alguien pague dos veces por error

**No lo hace (lo tenés que hacer vos):**

- ❌ **Confirmar transferencias bancarias.** Alguien tiene que mirar el extracto.
- ❌ **Guardar el PDF firmado en un lugar propio.** El Acuerdo firmado existe, es
  válido y se le manda por correo al Miembro — pero el archivo vive dentro de
  DocuSign. Si mañana hubiera un problema con esa cuenta, habría que
  recuperarlo desde ahí.
- ❌ **Llamar a los que quedaron a mitad de camino.**

---

## 4 · Tu rutina

### Todos los días (10 minutos)

1. **Revisar transferencias pendientes.** Buscá quién está en
   `transferencia_pendiente_confirmacion` (cómo, en el documento de Cobros),
   comparalo contra el extracto bancario, y si la plata está, pedile al equipo
   técnico que lo pase a `activo`.
2. **Mirar quién firmó y no pagó.** Si alguien lleva más de un día en
   `firmado_pendiente_pago`, llamalo.

### Una vez por semana

3. **Cerrar los números.** Comparar el total de la base contra el resumen de
   Mercado Pago y el extracto bancario. Tienen que dar lo mismo. Si no dan, algo
   pasó y conviene revisarlo esa semana, no tres meses después.
4. **Revisar los abandonos.** Los `nuevo` y `firma_pendiente` de la semana.

### Una vez por mes

5. **Bajar los Acuerdos firmados** de DocuSign y guardarlos donde Ditelli
   archive sus contratos. Hasta que el sistema los guarde solo, esto es manual.

---

## 5 · Cosas que conviene saber antes de que pasen

**El inversor puede cerrar el navegador y volver.** El sistema recuerda dónde
quedó. Y si cambia de dispositivo —empezó en el celular y sigue en la compu— o
borra la caché, **ya no queda trabado**: vuelve a cargar su correo y DNI y el
sistema le manda un enlace para retomar donde estaba. El enlace dura 30 minutos
y sirve una sola vez.

Por seguridad, ese enlace siempre va al **correo registrado en la Ficha**, no al
que se escriba en el momento. Así, si alguien intenta hacerse pasar por un
inversor, el enlace le llega al titular y el impostor no se entera de nada.

**El porcentaje de participación se calcula una sola vez**, cuando se genera el
Acuerdo, sobre el capital objetivo de la ronda (USD 500.000). Un aporte de
USD 5.000 es siempre 1,00%, sin importar cuántos inversores haya antes o después.
Es el mismo número que le muestra el simulador de la página antes de decidir.

**El pago con tarjeta se cobra en pesos**, convertido al dólar oficial del día.
La cotización usada queda guardada junto a cada operación, así que siempre se
puede explicar por qué a dos inversores con el mismo aporte en dólares se les
cobró distinto en pesos.

**Si el sistema no puede saber la cotización, no cobra.** Muestra "reintentá en
unos minutos". Es a propósito.

---

## 6 · Problemas frecuentes

### "Un inversor dice que pagó pero figura como que no"

1. Buscalo en el panel de Mercado Pago por su nombre o correo.
2. Si el pago **está y figura aprobado**: pedile que abra la página de nuevo. El
   sistema reconsulta solo y se corrige. Si en 10 minutos no se corrige, avisá al
   equipo técnico.
3. Si el pago **no está**: no pagó, o el pago fue rechazado por su banco. Pedile
   el comprobante.

### "Firmó pero el sistema dice que no"

Suele ser demora del aviso de DocuSign. El sistema reintenta solo durante unos
minutos. Si pasa de ahí, revisá en DocuSign si el sobre figura como *completed*.
Si figura completado y el sistema sigue sin reconocerlo, es para el equipo técnico.

### "No puede volver a empezar, le dice que ya existe un proceso"

Es lo esperado, y ya se resuelve solo: al reenviar la Ficha con el mismo correo
y DNI, el sistema le manda un **enlace para retomar** a su casilla. Decile que
revise el correo (y la carpeta de spam la primera vez).

Si dice que no le llegó: verificá que el correo de la Ficha esté bien escrito, y
revisá en el panel de Resend si el envío salió.

### "El Acuerdo salió con los campos vacíos"

Los nombres de los campos en la plantilla de DocuSign no coinciden con los que
espera el sistema. Es el error clásico de instalación. **No se arregla desde el
sistema: se corrige en la plantilla de DocuSign.** Ver el Paso 1.2 del manual de
instalación.

### "Alguien pagó dos veces"

El sistema lo detecta y **no pisa** el primer pago: deja un aviso marcado como
`COBRO DUPLICADO` en el registro técnico. Hay que devolverle la diferencia desde
el panel de Mercado Pago. Si pasa seguido, avisá: significa que algo está
haciendo dudar a la gente en el momento del pago.

### "Quiero cambiar el monto mínimo o el capital objetivo"

Es un cambio de configuración, no de programa: se hace en minutos. Pero **el
capital objetivo hay que cambiarlo en dos lugares a la vez** (el servidor y el
simulador de la página). Si se cambia en uno solo, el inversor va a ver un
porcentaje en la pantalla y firmar otro distinto. Pedilo siempre al equipo
técnico, nunca lo cambies por tu cuenta en un solo lado.

---

## 7 · Qué NO hacer

| No hagas esto | Por qué |
|---|---|
| Cambiar datos directamente en la base de datos | Podés dejar a un inversor en un estado imposible y romper la coherencia con lo que ya firmó |
| Compartir las claves de acceso por WhatsApp o mail | Es la forma más común de filtrar credenciales. Se cargan directo en el panel |
| Borrar un inversor de la base | Si ya firmó, ese registro es el respaldo del Acuerdo. Marcalo, no lo borres |
| Confirmar un pago mirando solo el correo del inversor | El comprobante que vale es el panel de Mercado Pago o el extracto |
| Confirmar una transferencia sin ver el extracto | Es el único control que hay sobre ese método de pago |
