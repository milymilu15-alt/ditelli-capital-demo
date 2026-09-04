# Ditelli Capital — Roadmap de publicación

**Fecha:** 19/08/2026 · **Objetivo:** ronda SELON II abierta y tomando Aportes reales.

---

## Dato nuevo que acorta el plan

El roadmap anterior asumía que el *Go-Live* de DocuSign era el cuello de botella
—20 llamadas exitosas en demo más una revisión manual de días—. **Eso ya no es
así.** DocuSign eliminó el requisito de las 20 llamadas: hoy se completa desde
*Apps & Keys* con validación automática, y el resultado es aprobación
instantánea, revisión (típicamente **≤48 h**), o rechazo.

Consecuencia práctica: **DocuSign deja de ser el camino crítico.** El plan pasa
de "2-3 semanas" a **3 a 5 días hábiles** hasta apertura pública, con un soft
launch en el medio. Corregí este dato en el README y en el runbook que te pasé.

---

## Estado verificado hoy

Sondeo de solo lectura contra producción, hace minutos:

```
GET /health                     → 404      ← el endpoint no existe: sigue el backend viejo
GET /api/members/1/status       → 200 + datos de un inversor, sin token
```

**Todo el trabajo de seguridad, FX, reconciliación y sobres está en tu disco, no
en Railway.** El IDOR sigue explotable en producción. Ese es el punto de partida
y define la Fase 1.

---

## Camino crítico

Lo que manda el calendario es una sola cadena. Todo lo demás se paraleliza:

```
Rotar credenciales → Deploy + migración → Credenciales de producción
   → Prueba E2E con plata real → Soft launch (48-72 h) → Apertura pública
```

| Se puede hacer en paralelo desde el día 0 | Por qué |
|---|---|
| Go-Live de DocuSign | Puede quedar en revisión ≤48 h; arrancalo ya aunque no lo uses todavía |
| Conseguir el CBU/alias reales | Depende de administración, no de código |
| Decisión contable sobre la cotización | Define si queda dolarapi o una fija |
| Revisar los `proportional_pct` ya firmados | Puede escalar a algo legal; mejor saberlo temprano |

---

## Fase P · Preparar el entorno de pruebas (antes de todo)

Se hace **entera con credenciales de sandbox**: no hace falta nada de
producción todavía. Está detallada en `docs/RUNBOOK.md`, Parte A.

| # | Acción | Verificación |
|---|---|---|
| P.1 | `npm install` + `npm audit` | 0 vulnerabilidades |
| P.2 | `cp .env.example .env` y completar con sandbox | `npm start` arranca sin errores |
| P.3 | `psql "$DATABASE_URL" -f schema.sql` | Sin errores; es idempotente |
| P.4 | `npm test` y `npm run smoke` | Todo en verde |
| P.5 | Túnel público y webhooks de sandbox apuntando ahí | El simulador de MP valida la firma en el log |
| P.6 | Flujo completo en sandbox, incluidas las pruebas de doble pestaña y webhook perdido | Un solo sobre; el Miembro se activa igual |
| P.7 | `psql "$DATABASE_URL" -f scripts/check-estado.sql` | Ninguna sorpresa en la consulta 1 |

> **Gate P:** el flujo cierra de punta a punta en sandbox y las dos pruebas de
> estrés (P.6) pasan. Recién ahí tiene sentido tocar credenciales reales.

---

## Fases y gates

Cada fase tiene un **gate**: un criterio verificable, no una sensación. Si el
gate no pasa, no se avanza.

### F0 · Contención (día 0 · ~1 h) — *bloqueante*

| # | Acción | Quién |
|---|---|---|
| 0.1 | Rotar Access Token de Mercado Pago | vos |
| 0.2 | Rotar Secret Key de Stripe (`sk_live_`) y su `whsec_` | vos |
| 0.3 | Nuevo par RSA de DocuSign y borrar el anterior | vos |
| 0.4 | Nueva password de Postgres → actualizar `DATABASE_URL` | vos |
| 0.5 | Nuevo `SESSION_JWT_SECRET` (`openssl rand -base64 48`) | vos |
| 0.6 | **En paralelo:** iniciar el Go-Live de DocuSign | vos |

> **Gate F0:** ninguna credencial vieja sigue siendo válida. Probalo: una
> llamada con el token anterior de MP tiene que fallar.

---

### F1 · Deploy y migración (día 0-1 · ~2 h) — *cierra la vulnerabilidad viva*

| # | Acción |
|---|---|
| 1.1 | `npm install` + `npm audit` + correr `test-fx.js` y `test-markpaid.js` |
| 1.2 | **Primer arranque local del server** — yo no pude hacerlo (npm bloqueado en mi entorno). Si algo rompe, va a ser un `require` de helmet o express-rate-limit |
| 1.3 | `psql "$DATABASE_URL" -f schema.sql` |
| 1.4 | Cargar variables nuevas en Railway (`CAPITAL_OBJETIVO_USD`, `DOLARAPI_URL`) |
| 1.5 | Deploy |

> **Gate F1** — las cuatro tienen que pasar:
> ```
> curl -i  $API/api/members/1/status   → 401   (hoy devuelve datos)
> curl -s  $API/health                 → {"ok":true,"db":"up"}
> curl -i -X OPTIONS ... -H "Access-Control-Request-Headers: authorization"
>                                      → 204 + authorization permitido
> curl -sI $API/health | grep -i strict-transport → presente
> ```
> El preflight CORS es el que más subestima la gente: si falla, **ninguna**
> llamada protegida funciona desde el navegador, aunque curl ande perfecto.

---

### F2 · Credenciales de producción (día 1-2 · ~1 h)

Depende del Go-Live iniciado en F0.

| # | Acción |
|---|---|
| 2.1 | `DOCUSIGN_BASE_PATH=https://www.docusign.net/restapi` + credenciales reales |
| 2.2 | Subir la plantilla del Acuerdo a la cuenta de producción y actualizar `DOCUSIGN_TEMPLATE_ID` (el ID de demo no existe en prod) |
| 2.3 | `STRIPE_SECRET_KEY=sk_live_...` + `whsec_` del endpoint de producción |
| 2.4 | Verificar en el panel de MP que la URL del webhook y la firma secreta coincidan; probar con el simulador y mirar los logs |
| 2.5 | DocuSign Connect apuntando a `/api/docusign/webhook` con su HMAC |
| 2.6 | Borrar `DOCUSIGN_RETURN_URL` si sigue apuntando a `127.0.0.1` |

> **Gate F2:** el simulador de webhooks de MP produce un `200` **y** el log dice
> que la firma validó. Si aparece *"Firma de Mercado Pago inválida"*, frená acá:
> el código responde 200 igual, así que un webhook rechazado **no se nota desde
> afuera** — se nota cuando un inversor pagó y no figura.

---

### F3 · Datos que faltan (paralelo a F1-F2 · ~30 min)

| # | Acción | Por qué bloquea |
|---|---|---|
| 3.1 | Cargar CBU y alias **reales** en la landing | Hoy es `0000003100000000000000`: una transferencia ahí no llega a ningún lado |
| 3.2 | Corregir el texto del Paso 4 que promete *"te enviamos copia del Acuerdo a tu correo"* | Ese mail no existe todavía. Prometer por escrito algo que no pasa es la peor primera impresión post-pago |
| 3.3 | Confirmar con el contador qué cotización se usa | Define si queda dolarapi (oficial) o `FX_FIXED_RATE_ARS_PER_USD` |
| 3.4 | Correr la consulta de `proportional_pct` y evaluar con asesoría legal si hay Acuerdos firmados con % incorrecto | Es el único daño que no revierte un deploy |
| 3.5 | Deploy de la landing (`npm run deploy`) y verificar que `/ditelli-backend-actualizado/.env` dé **404** | Si da 200, rotar todo de nuevo |

> **Gate F3:** el CBU es real y verificado contra el extracto bancario, y ningún
> texto de la landing promete algo que el sistema no hace.

---

### F4 · Prueba end-to-end con plata real (día 2-3 · ~1 h)

Con tu propia tarjeta y el Aporte mínimo (USD 1.000).

| # | Verificación |
|---|---|
| 4.1 | El `memberId` es un UUID, no un número |
| 4.2 | El PDF firmado **no** tiene marca de agua de demo |
| 4.3 | El % del Acuerdo dice **0,20%** (1.000 / 500.000), y coincide con el simulador |
| 4.4 | En los logs: `💱 Aporte USD 1000 → ARS ... (cotización ...)` — y esa cotización es la real del día |
| 4.5 | Tras pagar: `status='activo'`, `mp_payment_id`, `amount_ars` y `fx_rate_ars_per_usd` cargados |
| 4.6 | **Prueba de estrés:** "Pagar y continuar" desde dos pestañas → un solo cobro; si llegara un segundo, el log dice `🚨 COBRO DUPLICADO` |
| 4.7 | **Prueba de reconciliación:** pagá y, antes de que llegue el webhook, recargá → `/status` tiene que activarlo igual consultando a MP |
| 4.8 | Reembolsarte desde el panel |

> **Gate F4:** el flujo completo cierra correcto **y** las pruebas 4.6 y 4.7
> pasan. Esas dos son las que separan "anduvo una vez" de "aguanta un usuario
> real con mala conexión".

---

### F5 · Soft launch (día 3 al 8 · 3-5 días)

**3 a 5 inversores conocidos**, invitados a mano, avisados de que son los
primeros. Esto no es ceremonia: es la única forma de ver el sistema con gente
que no sos vos.

- Mirá los logs todos los días buscando: `COBRO DUPLICADO`, `Firma de Mercado
  Pago inválida`, `no se pudo descargar el PDF`, `No se encontró ningún Miembro
  para envelopeId`.
- Anotá cada vez que alguien te escriba preguntando algo: cada pregunta es un
  agujero de UX que en apertura pública se multiplica.
- Tené a mano el `SELECT` de estados para revisar que nadie quede trabado en
  `firma_pendiente` o `firmado_pendiente_pago`.

> **Gate F5:** 3 Aportes completados de punta a punta sin intervención manual,
> y cero eventos críticos en los logs durante 72 h.

---

### F6 · Apertura pública (día 8+)

Recién acá se difunde. Con monitor de uptime sobre `/health` ya configurado y
alguien mirando los logs la primera semana.

---

## Riesgos y plan B

| Riesgo | Probabilidad | Impacto | Plan B |
|---|---|---|---|
| DocuSign queda "flagged for review" | Media | Frena F2 | Arrancarlo en F0. Si tarda, el resto avanza igual: sin DocuSign en prod no se lanza, pero todo lo demás queda listo |
| El preflight CORS falla con `Authorization` | **Media-alta** | Nada funciona en el navegador | Es config de `cors()` en el backend; se arregla en minutos. Por eso está en el Gate F1 y no se descubre en producción |
| El webhook de MP no valida la firma | Media | Los pagos no activan al Miembro | La reconciliación activa en `/status` ya lo cubre parcialmente. Igual hay que arreglarlo: es plata que entra y no se registra |
| dolarapi caído al momento de un pago | Baja | El pago no arranca (a propósito) | `FX_FIXED_RATE_ARS_PER_USD` con la cotización del día. Está documentado en el README |
| Hay Acuerdos ya firmados con % incorrecto | **Desconocida** | Legal | Correr la consulta **hoy**. Si aparecen, es conversación con abogado, no con nosotros |
| `npm install` rompe algo que no pude probar | Baja | Frena F1 | Solo se agregaron helmet y express-rate-limit, dos paquetes muy estables. El fallo sería inmediato y evidente al arrancar |

---

## Fuera de alcance (y por qué es aceptable)

| Pendiente | Por qué se puede lanzar sin esto | Cuándo duele |
|---|---|---|
| Storage del PDF firmado | El Acuerdo existe y es válido dentro de DocuSign; se puede descargar a mano | Cuando alguien pida su copia y haya que buscarla en el panel |
| Emails transaccionales | Nada del flujo depende de ellos | Ya duele: hay que corregir el texto que los promete (3.2) |
| **Magic link** | Con pocos usuarios, destrabar a alguien a mano es viable | Apenas haya volumen: hoy, si alguien pierde el token, queda bloqueado hasta que borres la fila |
| Panel de transferencias | Se confirma a mano contra el extracto | Con más de ~10 transferencias por semana |
| Alertas a Slack/mail | Los eventos quedan en el log de Railway | Cuando dejes de mirar los logs a diario — o sea, en la semana 2 |

**El más urgente de los cinco es el magic link.** Es el único que puede dejar a
un inversor real sin poder terminar su Aporte, y la UI todavía le ofrece un
botón que no lo destraba.

---

## Cronograma

| Día | Fase | Termina con |
|---|---|---|
| −1 | **P** | Flujo validado en sandbox |
| 0 | F0 + inicio Go-Live + F3 en paralelo | Credenciales rotadas |
| 0-1 | F1 | **IDOR cerrado en producción** |
| 1-2 | F2 | Proveedores en modo producción |
| 2-3 | F4 | Un Aporte real completado y reembolsado |
| 3-8 | F5 | 3 Aportes de terceros sin intervención |
| 8+ | F6 | Ronda abierta |

**3 a 5 días hábiles de trabajo, más 3-5 días de soft launch.** Si DocuSign
queda en revisión, sumá hasta 48 h — pero solo si no arrancaste el Go-Live en
el día 0.

---

## Lo único que haría distinto si tuvieras que lanzar mañana

No recortaría el soft launch: recortaría el alcance de la ronda. Abrir con un
cupo de 5 Aportes y cerrar hasta validar es mucho más seguro que abrir a todos
con menos verificación. El riesgo no se elimina apurando el checklist, se
acota limitando cuánta plata puede entrar antes de saber que el circuito cierra.
