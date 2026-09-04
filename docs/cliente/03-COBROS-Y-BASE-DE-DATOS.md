# Cómo ver quién pagó, cómo pagó, y cómo entrar a la base de datos

**Para:** el equipo de administración de Ditelli Capital.
**Qué es:** el documento del día a día. Cómo saber en cualquier momento quién es
Miembro, quién debe plata, cómo pagó cada uno, y cómo sacar todo eso a un Excel.

---

## Primero, lo importante: hay tres lugares distintos

Esto confunde al principio, así que conviene tenerlo claro desde el arranque.

| Lugar | Qué te dice | Cuándo usarlo |
|---|---|---|
| **Neon** (la base de datos) | **Quiénes son tus Miembros** y en qué estado está cada uno | Es tu libro de socios. La fuente de verdad del negocio |
| **Mercado Pago** | **Dónde está la plata** en pesos, y los movimientos reales | Para conciliar y para devolver un cobro |
| **El extracto del banco** | Las transferencias bancarias | Para confirmar los que eligieron transferencia |

**Los tres tienen que cerrar entre sí.** Si Neon dice que hay 12 Miembros activos
y Mercado Pago muestra 11 pagos, hay algo que revisar. Por eso la conciliación
semanal de la guía de uso no es burocracia: es el control.

> Una aclaración que evita malentendidos: el sistema **no toca la plata**. La
> plata va directo de la tarjeta del inversor a la cuenta de Mercado Pago de
> Ditelli. El sistema solo registra que eso pasó.

---

## Parte 1 · Entrar a la base de datos (Neon)

### La primera vez

1. Andá a **neon.com** y entrá con la cuenta de Ditelli.
2. En el panel vas a ver el proyecto **`ditelli-capital`**. Hacé clic.
3. En el menú de la izquierda, buscá **SQL Editor**.

Eso es todo. No hace falta instalar nada: funciona en el navegador.

### Cómo usar el SQL Editor

Es una caja de texto grande con un botón **Run**. Vos pegás una consulta, apretás
Run, y abajo aparece una tabla con el resultado.

**No hace falta saber programar.** Te dejamos las consultas escritas: solo tenés
que copiar y pegar. Están en el archivo `scripts/consultas-cliente.sql` y también
más abajo en este documento.

> 🔒 **Todas las consultas de este documento son de solo lectura.** No modifican
> ni borran nada. Podés correrlas las veces que quieras sin ningún riesgo. Las
> únicas palabras peligrosas son `DELETE`, `UPDATE` y `DROP` — si una consulta
> que te pasan tiene alguna de esas, preguntá antes de correrla.

### Sacar los datos a Excel

Después de correr una consulta, arriba de la tabla de resultados hay un botón
**Download** (o el ícono de descarga). Elegí **CSV** y se baja un archivo que
abrís con Excel directamente.

Esta es la forma de armar cualquier reporte: corrés la consulta, descargás,
y ya lo tenés en una planilla.

---

## Parte 2 · Las consultas que vas a usar

Copiá desde el `SELECT` hasta el punto y coma, pegá en el SQL Editor, Run.

### 🔵 ¿Quiénes ya pagaron?

Es el padrón de Miembros confirmados. Te muestra **cómo pagó cada uno** en la
columna "Cómo pagó", y también cuánto se le cobró en pesos y a qué cotización.

```sql
SELECT
  name AS "Miembro", doc_id AS "DNI / CUIT", email AS "Correo", phone AS "Teléfono",
  amount_usd AS "Aporte USD", proportional_pct AS "Participación %",
  CASE
    WHEN mp_payment_id     IS NOT NULL THEN 'Tarjeta (Mercado Pago)'
    WHEN stripe_payment_id IS NOT NULL THEN 'Tarjeta internacional (Stripe)'
    ELSE 'Transferencia bancaria'
  END AS "Cómo pagó",
  amount_ars AS "Cobrado en ARS", fx_rate_ars_per_usd AS "Cotización usada",
  to_char(updated_at AT TIME ZONE 'America/Argentina/Buenos_Aires',
          'DD/MM/YYYY HH24:MI') AS "Fecha del pago"
FROM members
WHERE status = 'activo'
ORDER BY updated_at DESC;
```

### 🟠 ¿A quién hay que llamar hoy?

Los que **firmaron el Acuerdo y no pagaron**. Ordenados por antigüedad: los de
arriba son los que hace más tiempo que esperan.

Esta es la consulta que más plata te puede traer. Esa persona ya leyó el
Acuerdo, lo firmó con validez legal, y por algún motivo no completó el pago.

```sql
SELECT
  name AS "Miembro", phone AS "Teléfono", email AS "Correo",
  amount_usd AS "Aporte USD",
  to_char(updated_at AT TIME ZONE 'America/Argentina/Buenos_Aires',
          'DD/MM/YYYY HH24:MI') AS "Firmó el",
  date_part('day', now() - updated_at) AS "Días esperando"
FROM members
WHERE status = 'firmado_pendiente_pago'
ORDER BY updated_at;
```

### 🟡 Transferencias a verificar — **correr todos los días**

Los que avisaron que transfirieron. **El sistema no puede confirmarlos solo**:
alguien tiene que mirar el extracto bancario.

```sql
SELECT
  name AS "Miembro", doc_id AS "DNI / CUIT", amount_usd AS "Aporte USD",
  phone AS "Teléfono",
  to_char(updated_at AT TIME ZONE 'America/Argentina/Buenos_Aires',
          'DD/MM/YYYY HH24:MI') AS "Avisó el",
  public_token AS "Código del Miembro"
FROM members
WHERE status = 'transferencia_pendiente_confirmacion'
ORDER BY updated_at;
```

**Qué hacer con el resultado:**

1. Buscá en el extracto una transferencia por el monto en pesos equivalente.
2. Verificá que el titular coincida con el nombre o el DNI/CUIT.
3. Si está: pedile al equipo técnico que lo marque como **activo**, pasándole el
   "Código del Miembro" de la última columna.
4. Si no está después de 48 horas hábiles: llamalo.

> **Nunca marques a alguien como activo sin ver la plata en el extracto.** Es el
> único control que existe sobre este método de pago.

### 🟣 Los que se quedaron a mitad de camino

Gente que dejó su nombre y teléfono y no completó. Son contactos reales.

```sql
SELECT
  name AS "Persona", phone AS "Teléfono", email AS "Correo",
  amount_usd AS "Quería invertir USD",
  CASE status
    WHEN 'nuevo'           THEN 'Cargó los datos y no siguió'
    WHEN 'firma_pendiente' THEN 'Empezó a firmar y no terminó'
  END AS "Hasta dónde llegó",
  to_char(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires',
          'DD/MM/YYYY') AS "Entró el"
FROM members
WHERE status IN ('nuevo', 'firma_pendiente')
ORDER BY created_at DESC;
```

### 🟢 El resumen de la ronda

Un solo renglón con todos los números que te van a pedir en una reunión.

```sql
SELECT
  count(*) FILTER (WHERE status = 'activo')                     AS "Miembros confirmados",
  coalesce(sum(amount_usd) FILTER (WHERE status = 'activo'), 0) AS "USD captado",
  round(coalesce(sum(amount_usd) FILTER (WHERE status = 'activo'), 0)
        / 500000.0 * 100, 2)                                    AS "% de la ronda",
  count(*) FILTER (WHERE status = 'firmado_pendiente_pago')      AS "Firmaron sin pagar",
  coalesce(sum(amount_usd) FILTER (WHERE status = 'firmado_pendiente_pago'), 0)
                                                                AS "USD por cobrar",
  count(*) FILTER (WHERE status = 'transferencia_pendiente_confirmacion')
                                                                AS "Transferencias a verificar"
FROM members;
```

Ejemplo de resultado:

| Miembros confirmados | USD captado | % de la ronda | Firmaron sin pagar | USD por cobrar | Transferencias a verificar |
|---|---|---|---|---|---|
| 12 | 78.000 | 15,60 | 3 | 14.000 | 1 |

### ⚪ Buscar una persona

Cambiá `perez` por lo que quieras buscar. Sirve nombre, correo o DNI, y no hace
falta escribirlo completo.

```sql
SELECT
  name AS "Nombre", doc_id AS "DNI / CUIT", email AS "Correo", phone AS "Teléfono",
  amount_usd AS "Aporte USD", proportional_pct AS "Participación %",
  status AS "Estado",
  coalesce(mp_payment_id, stripe_payment_id) AS "N° de operación",
  amount_ars AS "Cobrado ARS", public_token AS "Código del Miembro"
FROM members
WHERE name  ILIKE '%perez%'
   OR email ILIKE '%perez%'
   OR doc_id ILIKE '%perez%';
```

### ⚫ Todo el padrón, para exportar

Está en `scripts/consultas-cliente.sql`, consulta número 6. Trae a todos con el
estado escrito en castellano, listo para bajar a Excel.

---

## Parte 3 · Ver la plata en Mercado Pago

### Dónde mirar

1. Entrá a `mercadopago.com.ar` con la cuenta de Ditelli.
2. **Actividad** → ahí está cada movimiento.
3. **Informes → Liberaciones de dinero** → cuándo se acredita cada cobro en la
   cuenta bancaria.

### Encontrar el pago de una persona

Cada operación en Mercado Pago tiene un **número de operación**. Ese mismo número
está guardado en la base, en la columna "N° de operación" de las consultas de
arriba. Así se cruzan los dos sistemas:

- **De la base a Mercado Pago:** copiás el N° de operación y lo buscás en el
  buscador de Actividad.
- **De Mercado Pago a la base:** cada pago tiene una "referencia externa"
  (*external reference*), que es el Código del Miembro. Lo buscás con la consulta
  de "Buscar una persona".

### Sobre el monto: por qué no coincide con el Aporte

El Acuerdo está en **dólares** y Mercado Pago cobra en **pesos**. Cuando el
inversor va a pagar, el sistema consulta la cotización del dólar oficial y
convierte.

Por eso dos inversores con el mismo Aporte de USD 5.000 pueden haber pagado
montos distintos en pesos: pagaron en días distintos. **La cotización que se usó
queda guardada** en cada registro (columna "Cotización usada"), así que siempre
se puede explicar y justificar la diferencia.

### Devolver un cobro

Se hace desde Mercado Pago: **Actividad → la operación → Devolver**. Después
avisale al equipo técnico para que corrija el estado en la base, porque **eso no
se actualiza solo**.

---

## Parte 4 · Stripe (si se usa)

Mismo criterio: `dashboard.stripe.com` → **Payments**. Cobra en dólares, así que
el monto coincide directo con el Aporte.

> Ver el documento de costos: **Stripe no está disponible oficialmente para
> empresas argentinas.** Puede que este método no esté habilitado.

---

## Parte 5 · Preguntas que van a surgir

**¿Puedo modificar algo desde Neon?**
Técnicamente sí, pero **no lo hagas**. Cambiar un estado a mano puede dejar a un
inversor en una situación que no coincide con lo que ya firmó. Cualquier cambio,
pedilo al equipo técnico.

**¿Y si borro algo sin querer?**
Las consultas de este documento no borran nada. Si por error corriste algo con
`DELETE` o `UPDATE`, avisá **enseguida**: Neon guarda un historial que permite
recuperar el estado anterior, pero es más fácil cuanto antes se pida.

**¿Cuántas personas pueden entrar a Neon?**
Las que quieras, cada una con su usuario. **Cada persona con su cuenta, nunca una
compartida**: así queda registro de quién hizo qué.

**¿Los datos están seguros?**
La base está cifrada y solo se accede con usuario y contraseña. El sistema
además no expone los datos de un inversor a otro: cada uno solo puede consultar
su propio estado.

**¿Puedo ver el Acuerdo firmado de alguien?**
Sí, desde el panel de DocuSign, buscando por el nombre o el correo del inversor.
Hoy el sistema **no guarda una copia propia** del PDF: está previsto para la
próxima etapa.

---

## Lo que hoy falta, dicho claramente

**No hay un panel de administración.** Todo lo de este documento se hace entrando
a Neon y copiando consultas. Funciona y es seguro, pero no es cómodo, y para una
persona no técnica siempre va a dar algo de impresión.

La solución es una pantalla propia, con usuario y contraseña, que muestre todo
esto con botones: el listado de Miembros, el buscador, el botón de "confirmar
transferencia" y la descarga a Excel — sin escribir una sola consulta.

**Es lo primero que recomendamos hacer después del lanzamiento.** No bloquea la
salida a producción, pero es lo que más va a cambiar el día a día de quien
administre esto. Estimado: entre 3 y 5 días de trabajo.

Mientras tanto, con este documento y el archivo de consultas, el equipo de
administración tiene todo lo que necesita para operar.
