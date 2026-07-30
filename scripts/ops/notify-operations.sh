#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly OPERATIONS_ENV="${CHAT2API_OPERATIONS_ENV:-${HOME}/.config/chat2api-web-gateway/operations.env}"
if [[ -e "${OPERATIONS_ENV}" ]]; then
  [[ -f "${OPERATIONS_ENV}" && ! -L "${OPERATIONS_ENV}" ]] || {
    printf 'Chat2API notification rejected: operations environment is not a regular file\n' >&2
    exit 2
  }
  [[ "$(stat -c '%u' "${OPERATIONS_ENV}")" == "$(id -u)" ]] || {
    printf 'Chat2API notification rejected: operations environment owner is invalid\n' >&2
    exit 2
  }
  [[ "$(stat -c '%a' "${OPERATIONS_ENV}")" == "600" ]] || {
    printf 'Chat2API notification rejected: operations environment must have mode 0600\n' >&2
    exit 2
  }
  set -a
  # shellcheck disable=SC1090
  source "${OPERATIONS_ENV}"
  set +a
fi

readonly EVENT="${1:-}"
readonly STATUS="${2:-}"

[[ "${EVENT}" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || {
  printf 'Chat2API notification rejected: invalid event\n' >&2
  exit 2
}
[[ "${STATUS}" == "failed" || "${STATUS}" == "recovered" || "${STATUS}" == "succeeded" ]] || {
  printf 'Chat2API notification rejected: invalid status\n' >&2
  exit 2
}

if [[ -z "${CHAT2API_ALERT_WEBHOOK_URL:-}" ]]; then
  exit 0
fi
[[ "${CHAT2API_ALERT_WEBHOOK_URL}" =~ ^https://[^[:space:]\"\']+$ ]] || {
  printf 'Chat2API notification rejected: webhook URL must be HTTPS\n' >&2
  exit 2
}
command -v curl >/dev/null 2>&1 || {
  printf 'Chat2API notification failed: curl is unavailable\n' >&2
  exit 1
}

payload="$(
  printf '{"service":"chat2api-web-gateway","event":"%s","status":"%s","host":"%s","timestamp":"%s"}' \
    "${EVENT}" \
    "${STATUS}" \
    "$(hostname -s | tr -cd '[:alnum:]._-')" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
)"

curl \
  --silent \
  --show-error \
  --fail-with-body \
  --connect-timeout 5 \
  --max-time 10 \
  --request POST \
  --header 'Content-Type: application/json' \
  --data-binary "${payload}" \
  --config - >/dev/null <<EOF
url = "${CHAT2API_ALERT_WEBHOOK_URL}"
EOF
