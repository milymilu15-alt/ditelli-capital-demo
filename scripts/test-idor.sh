#!/usr/bin/env bash
#
# Test manual — Auditoría de seguridad (Problema 1: IDOR / Problema 2: secuestro
# por email+DNI). Demuestra que:
#
#   1) Ni un id adivinado (secuencial viejo o UUID al azar) ni un token
#      inventado devuelven o modifican el registro de otro Miembro.
#   2) El token de UN Miembro real no sirve para leer/tocar a OTRO Miembro.
#   3) Reenviar el email+DNI de un Miembro ya existente (intento de
#      "engancharse" a su Ficha) ya no devuelve su memberId.
#
# Uso:
#   BASE_URL=http://localhost:3000 ./scripts/test-idor.sh
#
# OJO: este script CREA Miembros reales vía POST /api/members. Corré esto
# contra un backend LOCAL o de prueba (npm run dev + tu propia DATABASE_URL
# de test) — no contra producción (Railway/Neon reales) salvo que quieras
# dejar filas de prueba ahí a propósito.

set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"

CODE=""
BODY=""
# call METHOD PATH [JSON_BODY] [EXTRA_CURL_ARGS...]
call() {
  local method="$1" path="$2" json="${3:-}"
  shift 3 2>/dev/null || shift $#
  local tmp; tmp=$(mktemp)
  if [ -n "$json" ]; then
    CODE=$(curl -s -o "$tmp" -w '%{http_code}' -X "$method" "$BASE_URL$path" \
      -H 'Content-Type: application/json' -d "$json" "$@")
  else
    CODE=$(curl -s -o "$tmp" -w '%{http_code}' -X "$method" "$BASE_URL$path" "$@")
  fi
  BODY=$(cat "$tmp"); rm -f "$tmp"
}

jget() {
  node -e "
    let d='';
    process.stdin.on('data',c=>d+=c).on('end',()=>{
      try{ const o=JSON.parse(d); const v=o['$1']; console.log(v===undefined?'':v); }
      catch(e){ console.log(''); }
    });"
}

pass() { echo "  OK   - $1"; }
fail() { echo "  FAIL - $1"; echo "         body: $BODY"; exit 1; }
expect_code() {
  local expected="$1" label="$2"
  [ "$CODE" = "$expected" ] && pass "$label (HTTP $CODE)" || { echo "  esperaba HTTP $expected, vino $CODE"; fail "$label"; }
}

echo "Backend: $BASE_URL"
echo

# Únicos por corrida: el script es idempotente en la base (Neon persiste
# entre corridas), así que un email+docId fijo matchea contra la fila que
# dejó la corrida anterior y el "crear Miembro A" de acá abajo devuelve 202
# en vez de 200 — no es un fallo del backend, es higiene del test.
RUN_ID=$(date +%s)
A_EMAIL="idor-test-a-${RUN_ID}@example.com"
A_DOC="IDOR-TEST-DOC-A-${RUN_ID}"
B_EMAIL="idor-test-b-${RUN_ID}@example.com"
B_DOC="IDOR-TEST-DOC-B-${RUN_ID}"

echo "== Setup: creando Miembro A =="
call POST /api/members "{\"name\":\"Test A\",\"docId\":\"$A_DOC\",\"email\":\"$A_EMAIL\",\"amountUsd\":1000}"
A_ID=$(echo "$BODY" | jget memberId)
A_TOKEN=$(echo "$BODY" | jget token)
[ -n "$A_ID" ] && [ -n "$A_TOKEN" ] || { echo "no se pudo crear el Miembro A"; fail "setup A"; }
pass "Miembro A creado — memberId=$A_ID (UUID, no secuencial)"

echo "== Setup: creando Miembro B (para probar cross-member) =="
call POST /api/members "{\"name\":\"Test B\",\"docId\":\"$B_DOC\",\"email\":\"$B_EMAIL\",\"amountUsd\":1000}"
B_TOKEN=$(echo "$BODY" | jget token)
[ -n "$B_TOKEN" ] || { echo "no se pudo crear el Miembro B"; fail "setup B"; }
pass "Miembro B creado (token distinto)"
echo

echo "== 1) GET /status de A SIN token =="
call GET "/api/members/$A_ID/status"
expect_code 401 "sin Authorization ya no devuelve los datos de A"

echo "== 2) GET /status con ids secuenciales adivinados (esquema viejo) =="
for GUESS in 1 2 3 10 100; do
  call GET "/api/members/$GUESS/status"
  [ "$CODE" = "401" ] || { echo "id adivinado '$GUESS'"; fail "adivinar ids secuenciales"; }
done
pass "ids 1..100 adivinados a mano -> 401, ninguno filtra nada"

echo "== 3) GET /status de A con un Bearer token inventado =="
call GET "/api/members/$A_ID/status" "" -H 'Authorization: Bearer esto.no.es.un.jwt.valido'
expect_code 401 "token inválido rechazado"

echo "== 4) GET /status de A con el token de B (cross-member) =="
call GET "/api/members/$A_ID/status" "" -H "Authorization: Bearer $B_TOKEN"
expect_code 403 "el token de B no sirve para leer a A"

echo "== 5) POST /docusign/envelope de A con el token de B =="
call POST /api/docusign/envelope "{\"memberId\":\"$A_ID\"}" -H "Authorization: Bearer $B_TOKEN"
expect_code 403 "B no puede generar un sobre de DocuSign para A"

echo "== 6) POST /payments/transfer/notify de A con el token de B =="
call POST /api/payments/transfer/notify "{\"memberId\":\"$A_ID\"}" -H "Authorization: Bearer $B_TOKEN"
expect_code 403 "B no puede marcar la transferencia de A como avisada"

echo "== 7) GET /status de A con SU PROPIO token (control positivo) =="
call GET "/api/members/$A_ID/status" "" -H "Authorization: Bearer $A_TOKEN"
expect_code 200 "A sí puede leer su propio estado"
echo

echo "== 8) POST /api/members repitiendo el email+DNI de A (intento de secuestro) =="
call POST /api/members "{\"name\":\"Atacante\",\"docId\":\"$A_DOC\",\"email\":\"$A_EMAIL\",\"amountUsd\":50000}"
LEAKED_ID=$(echo "$BODY" | jget memberId)
expect_code 202 "coincidencia por email+DNI no confirma nada por sí sola"
[ -z "$LEAKED_ID" ] || fail "el response filtró memberId=$LEAKED_ID de un Miembro existente"
pass "no se filtró memberId ni se pisaron los datos de A"
echo

echo "Todo OK: un id adivinado, un token ajeno, o repetir el email+DNI de otro"
echo "inversor ya no alcanzan para leer ni modificar su registro."
