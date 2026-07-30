#!/usr/bin/env bash
set -Eeuo pipefail

: "${OPENAI_BASE_URL:?Set OPENAI_BASE_URL, including /v1}"
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY}"

curl \
  --silent \
  --show-error \
  --fail-with-body \
  --request POST \
  --url "${OPENAI_BASE_URL%/}/chat/completions" \
  --header "Authorization: Bearer ${OPENAI_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "deepseek-v4-flash",
    "messages": [
      {"role": "user", "content": "Reply with exactly HELLO."}
    ],
    "stream": false
  }'
