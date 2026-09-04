#!/bin/sh
set -eu

: "${WORKER_URL:?Set WORKER_URL}"
: "${API_TOKEN:?Set API_TOKEN}"

echo "== healthz =="
curl -fsS "$WORKER_URL/healthz"
echo
echo "== latest activity =="
curl -fsS "$WORKER_URL/v1/activities/latest" \
  -H "Authorization: Bearer $API_TOKEN"
echo
echo "== coach context =="
curl -fsS "$WORKER_URL/v1/coach/context" \
  -H "Authorization: Bearer $API_TOKEN"
echo
