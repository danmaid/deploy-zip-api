#!/usr/bin/env bash
set -euo pipefail
BASE_URL=${BASE_URL:-http://localhost:8080}
ZIP=${1:?"usage: upload.sh path.zip"}
curl -sS -X POST --data-binary @"$ZIP" "$BASE_URL/content" | jq .
