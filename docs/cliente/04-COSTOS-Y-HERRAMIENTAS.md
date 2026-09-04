# Herramientas necesarias y cuánto cuestan

**Actualizado:** agosto 2026. Los precios de los proveedores cambian; los de
Mercado Pago, en particular, se mueven seguido. Antes de cerrar un presupuesto,
conviene confirmarlos en la página de cada uno (los enlaces están al final).

---

## Resumen

| | Costo mensual estimado |
|---|---|
| **Mínimo para operar** | **USD 55 – 75 / mes** |
| Más las comisiones por cobro | ~6,49 % + IVA de cada pago con tarjeta |

Sobre una ronda de USD 500.000 cobrada íntegramente con tarjeta, las comisiones
serían del orden de **USD 39.000**. Esto es lo más relevante de todo el
documento: **el costo de las herramientas es casi despreciable al lado de las
comisiones de cobro.** Es un buen argumento para empujar la transferencia
bancaria como método preferido.

---

## Costos fijos mensuales

### 1 · DocuSign — firma electrónica · **USD 50/mes o más** ⚠️

**Por qué se necesita:** es lo que le da validez legal al Acuerdo de
Participación. Genera el documento, registra la firma, y guarda el certificado
que prueba quién firmó, cuándo y desde dónde. Ese certificado es lo que sirve
ante un reclamo.

**Cuánto cuesta:** el plan **Starter para desarrolladores** arranca en **USD 50
por mes** (o USD 600 al año), con unos 40 documentos mensuales incluidos.

> ⚠️ **Acá hay un punto a verificar antes de contratar, y puede ser caro.**
>
> Este sistema usa *firma embebida*: el inversor firma dentro de la página de
> Ditelli, sin salir a DocuSign ni recibir un mail. Es lo que hace que el proceso
> se sienta de una sola pieza.
>
> La página oficial de precios de DocuSign lista "embedded signing" como una
> función del plan **Advanced (USD 480/mes)**. Pero en el foro oficial, un
> moderador de DocuSign afirma que la firma embebida **por API sí está
> disponible en todos los planes**, y que la restricción aplica a otra
> modalidad (PowerForms / Web Forms).
>
> **Son dos fuentes oficiales que se contradicen, y la diferencia es de USD 50 a
> USD 480 por mes.** Antes de contratar: escribirle a ventas de DocuSign
> preguntando textualmente si el plan Starter permite *embedded signing vía API
> con `clientUserId` y `recipientView`*, y **pedir la respuesta por escrito**.
>
> Si la respuesta fuera que hace falta el plan Advanced, hay alternativas más
> baratas con validez legal equivalente en Argentina que conviene evaluar antes
> de aceptar ese salto de precio.

**Alternativas si el precio no cierra:** existen otros proveedores de firma
electrónica con API, bastante más económicos por documento. Cambiar de proveedor
implicaría trabajo de desarrollo, pero si el número fuera USD 480/mes, se paga
solo en el primer mes.

---

### 2 · Railway — servidor · **USD 5 a 20/mes**

**Por qué se necesita:** es donde vive el programa que coordina todo. Sin esto,
la página sería solo un folleto: no podría guardar nada ni cobrar.

**Cuánto cuesta:**
- Plan **Hobby: USD 5/mes** (incluye USD 5 de consumo)
- Plan **Pro: USD 20/mes** (incluye USD 20 de consumo, y compromiso de
  disponibilidad del 99,99 %)

**Cuál conviene:** para arrancar, Hobby alcanza de sobra. **Para una ronda con
inversores reales, recomendamos Pro**: la diferencia son USD 15 al mes y lo que
se compra es el compromiso de disponibilidad y el soporte. Si el servidor se cae
un sábado a la noche en plena ronda, esos USD 15 se justifican solos.

---

### 3 · Neon — base de datos · **USD 0 a 25/mes**

**Por qué se necesita:** es donde queda guardado quién invirtió, cuánto y en qué
estado está. Es el libro de socios del proyecto.

**Cuánto cuesta:**
- **Plan gratuito: USD 0** — 0,5 GB de almacenamiento. Para unos pocos cientos de
  inversores esto sobra: son datos de texto, ocupan muy poco.
- **Plan Launch:** pago por uso, del orden de **USD 5 a 25/mes** según consumo.

**Cuál conviene:** el gratuito alcanza técnicamente. Pero el plan pago da
**backups automáticos programados**, y el gratuito solo permite una copia manual.

> Nuestra recomendación: **pasar al plan pago apenas entre el primer aporte
> real.** Estamos hablando del registro de quién puso plata. Ahorrar USD 20 al
> mes en el respaldo de esa información no es un buen negocio.

---

### 4 · Alojamiento de la página · **USD 0 a 30/mes**

**Por qué se necesita:** es donde vive la página que ve el inversor.

**Cuánto cuesta:** hoy está en **Surge.sh**, que es **gratis** con dominio propio
y certificado de seguridad básico. El plan pago (USD 30/mes) agrega funciones que
este proyecto no necesita.

**Alternativas gratuitas equivalentes:** Netlify, Vercel o Cloudflare Pages, con
planes gratuitos más completos. Si en algún momento hace falta migrar, es un
cambio de una hora.

---

### 5 · Dominio · **USD 10 a 25 al año**

- **`.com.ar`**: se registra en `nic.ar` con Clave Fiscal de AFIP. Cuesta unos
  pocos miles de pesos por año.
- **`.com`**: entre USD 10 y 15 al año.

Es un costo anual, no mensual, y es el más barato de la lista.

---

## Comisiones por cobro (lo verdaderamente caro)

Esto no es un costo fijo: se descuenta de cada pago.

### Mercado Pago — Argentina

| Método | Comisión aproximada |
|---|---|
| Tarjeta de crédito, acreditación inmediata | **6,49 % + IVA** |
| Tarjeta de débito, acreditación inmediata | **3,49 % + IVA** |
| Tarjeta de crédito, acreditación a 14 días | **~3,49 % + IVA** |

**Qué significa en plata:** un Aporte de USD 5.000 con tarjeta de crédito y
acreditación inmediata deja una comisión del orden de **USD 325 más IVA**.

> 💡 **Dos formas de bajar esto muchísimo:**
>
> **1. Priorizar la transferencia bancaria.** No tiene comisión de pasarela. Hoy
> está en el sistema como una de las tres opciones; se podría destacar como la
> recomendada. El costo es operativo: alguien tiene que confirmarlas a mano.
>
> **2. Aceptar la acreditación a 14 días** en vez de inmediata. Baja la comisión
> casi a la mitad. Para aportes de capital —que no son compras impulsivas— esperar
> dos semanas rara vez es un problema. Es una decisión de negocio que vale la pena
> conversar con el contador: en una ronda de USD 500.000 la diferencia entre 6,49 %
> y 3,49 % ronda los **USD 15.000**.

### Stripe ⚠️

**Stripe no está disponible oficialmente para empresas argentinas.** Para usarlo
haría falta constituir una sociedad en Estados Unidos (LLC) con cuenta bancaria
allá, lo que agrega costos de constitución y mantenimiento, y complejidad
impositiva.

**El sistema funciona perfectamente sin Stripe**, con Mercado Pago y transferencia.
La integración ya está construida y queda disponible por si en algún momento
Ditelli tiene una estructura en el exterior.

### Transferencia bancaria

**Sin comisión de pasarela.** Solo los costos que cobre el banco de Ditelli por
recibir transferencias, que suelen ser mínimos o nulos.

---

## Tabla completa

| Herramienta | Para qué | Costo | ¿Se puede evitar? |
|---|---|---|---|
| **DocuSign** | Validez legal de la firma | USD 50/mes ⚠️ *(verificar)* | No, pero se puede cambiar de proveedor |
| **Railway** | Servidor | USD 5–20/mes | No |
| **Neon** | Base de datos | USD 0–25/mes | No |
| **Surge / Netlify** | Página web | USD 0 | No |
| **Dominio** | Dirección propia | USD 10–25/año | Sí, con una dirección provisoria |
| **Mercado Pago** | Cobro con tarjeta | 6,49 % + IVA por operación | Sí, con transferencia |
| **Stripe** | Tarjeta internacional | 0 fijo — no disponible en AR | Sí |

**Total fijo mensual: entre USD 55 y USD 75.**

---

## Tres escenarios

### Arranque — **USD 55/mes**
DocuSign Starter + Railway Hobby + Neon gratuito + Surge gratuito.
Para las primeras pruebas y la apertura limitada.

### Operación — **USD 75/mes** ← *el que recomendamos*
DocuSign Starter + Railway Pro + Neon Launch + Surge gratuito.
Se compran dos cosas: disponibilidad del servidor y backups automáticos de la
base. Son USD 20 más por mes.

### Si DocuSign exige el plan Advanced — **USD 505/mes**
Antes de aceptar esto, evaluar cambiar de proveedor de firma. La diferencia anual
es de aproximadamente **USD 5.100**.

---

## Cosas que no cuestan plata pero cuestan tiempo

Para que el presupuesto sea honesto, esto también hay que contarlo:

| Tarea | Cuánto tiempo | Cada cuánto |
|---|---|---|
| Confirmar transferencias contra el extracto | 10 min | Todos los días |
| Llamar a los que firmaron y no pagaron | 20 min | Todos los días |
| Conciliar base vs Mercado Pago vs banco | 30 min | Semanal |
| Bajar y archivar los Acuerdos firmados | 20 min | Mensual |

Aproximadamente **media hora diaria** de una persona de administración. Un panel
propio (ver el final del documento de Cobros) reduciría bastante esto.

---

## Pendientes que van a sumar costo más adelante

No son necesarios para lanzar, pero conviene tenerlos en el radar:

| Qué | Costo estimado | Para qué |
|---|---|---|
| **Envío de correos** | USD 0–20/mes | Confirmación de firma, bienvenida, copia del Acuerdo. Hoy el sistema no manda ningún mail |
| **Guardado del PDF firmado** | USD 1–5/mes | Tener copia propia de los Acuerdos, sin depender de DocuSign |
| **Panel de administración** | 3–5 días de desarrollo | Reemplaza las consultas manuales |
| **Monitoreo y alertas** | USD 0–10/mes | Que avise si el servidor se cae, en vez de enterarse por un inversor |

---

## Dónde verificar cada precio

- DocuSign: [ecom.docusign.com/plans-and-pricing/developer](https://ecom.docusign.com/plans-and-pricing/developer)
- Railway: [railway.com/pricing](https://railway.com/pricing)
- Neon: [neon.com/pricing](https://neon.com/pricing)
- Surge: [surge.sh/pricing](https://surge.sh/pricing)
- Mercado Pago: [mercadopago.com.ar/ayuda/costo-vender-cobrar](https://www.mercadopago.com.ar/ayuda/costo-vender-cobrar)
- Dominios `.ar`: [nic.ar](https://nic.ar)
