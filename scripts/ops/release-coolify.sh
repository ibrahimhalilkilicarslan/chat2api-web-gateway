#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ROOT
readonly REMOTE_ENV="${CHAT2API_REMOTE_ENV:-${HOME}/.config/chat2api-web-gateway/remote-client.env}"
readonly STATE_DIR="${CHAT2API_STATE_DIR:-${HOME}/.local/state/chat2api-web-gateway}"
readonly RELEASE_TIMEOUT_SECONDS="${CHAT2API_RELEASE_TIMEOUT_SECONDS:-900}"

: "${COOLIFY_URL:?COOLIFY_URL is required}"
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN is required}"
: "${COOLIFY_RESOURCE_UUID:?COOLIFY_RESOURCE_UUID is required}"
: "${CHAT2API_COMPOSE_PROJECT:?CHAT2API_COMPOSE_PROJECT is required}"

fail() {
  printf 'Chat2API release failed: %s\n' "$1" >&2
  if [[ -x "${ROOT}/scripts/ops/notify-operations.sh" ]]; then
    "${ROOT}/scripts/ops/notify-operations.sh" release failed >/dev/null 2>&1 || true
  fi
  exit 1
}

for command_name in curl docker git jq pnpm; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command is unavailable: ${command_name}"
done

if [[ ! "${COOLIFY_URL}" =~ ^https://[^/?#]+$ ]] \
  && [[ ! "${COOLIFY_URL}" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]]; then
  fail 'COOLIFY_URL must be an HTTPS origin or an HTTP loopback origin'
fi
[[ "${COOLIFY_RESOURCE_UUID}" =~ ^[A-Za-z0-9_-]+$ ]] || fail 'Coolify resource UUID is invalid'
[[ "${RELEASE_TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]] || fail 'release timeout must be an integer'
[[ -f "${REMOTE_ENV}" && ! -L "${REMOTE_ENV}" ]] || fail 'remote client environment is missing'
[[ "$(stat -c '%u' "${REMOTE_ENV}")" == "$(id -u)" ]] || fail 'remote client environment owner is invalid'
[[ "$(stat -c '%a' "${REMOTE_ENV}")" == "600" ]] || fail 'remote client environment must have mode 0600'

cd -- "${ROOT}"
[[ -z "$(git status --porcelain)" ]] || fail 'working tree is not clean'
git fetch --quiet origin main
readonly HEAD_SHA="$(git rev-parse HEAD)"
readonly ORIGIN_MAIN_SHA="$(git rev-parse origin/main)"
[[ "${HEAD_SHA}" == "${ORIGIN_MAIN_SHA}" ]] || fail 'HEAD is not the commit currently published at origin/main'

install -d -m 0700 "${STATE_DIR}"
mapfile -t current_containers < <(
  docker ps \
    --filter "label=com.docker.compose.project=${CHAT2API_COMPOSE_PROJECT}" \
    --filter status=running \
    --format '{{.ID}}'
)
[[ "${#current_containers[@]}" -eq 1 ]] || fail 'expected exactly one running production container'
readonly PREVIOUS_CONTAINER="${current_containers[0]}"
readonly PREVIOUS_IMAGE="$(
  docker inspect --format '{{.Image}}' "${PREVIOUS_CONTAINER}"
)"
printf '%s\t%s\t%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "${HEAD_SHA}" \
  "${PREVIOUS_IMAGE}" \
  > "${STATE_DIR}/release.previous-image"
chmod 0600 "${STATE_DIR}/release.previous-image"

pnpm check
readonly RELEASE_IMAGE="chat2api-web-gateway:${HEAD_SHA}"
docker build --tag "${RELEASE_IMAGE}" .
CHAT2API_SMOKE_IMAGE="${RELEASE_IMAGE}" pnpm smoke:container

CHAT2API_COMPOSE_PROJECT="${CHAT2API_COMPOSE_PROJECT}" \
CHAT2API_STATE_DIR="${STATE_DIR}" \
"${ROOT}/scripts/ops/run-production-backup.sh"

http_status="$(
  curl \
    --silent \
    --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --connect-timeout 10 \
    --max-time 30 \
    --request POST \
    --config - <<EOF
url = "${COOLIFY_URL}/api/v1/deploy?uuid=${COOLIFY_RESOURCE_UUID}&force=false"
header = "Authorization: Bearer ${COOLIFY_TOKEN}"
header = "Accept: application/json"
EOF
)"
[[ "${http_status}" == "200" || "${http_status}" == "201" || "${http_status}" == "202" ]] \
  || fail "Coolify rejected the deployment with HTTP ${http_status}"

deadline="$(( $(date +%s) + RELEASE_TIMEOUT_SECONDS ))"
new_container=""
while (( $(date +%s) < deadline )); do
  mapfile -t candidate_containers < <(
    docker ps \
      --filter "label=com.docker.compose.project=${CHAT2API_COMPOSE_PROJECT}" \
      --filter status=running \
      --format '{{.ID}}'
  )
  if [[ "${#candidate_containers[@]}" -eq 1 && "${candidate_containers[0]}" != "${PREVIOUS_CONTAINER}" ]]; then
    candidate_health="$(
      docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
        "${candidate_containers[0]}"
    )"
    if [[ "${candidate_health}" == "healthy" ]]; then
      new_container="${candidate_containers[0]}"
      break
    fi
  fi
  sleep 5
done
[[ -n "${new_container}" ]] || fail 'new production container did not become healthy before timeout'

set -a
# shellcheck disable=SC1090
source "${REMOTE_ENV}"
set +a
pnpm smoke:remote
"${ROOT}/scripts/ops/check-production-health.sh"

printf '%s\t%s\t%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "${HEAD_SHA}" \
  "${new_container}" \
  > "${STATE_DIR}/release.last-success"
chmod 0600 "${STATE_DIR}/release.last-success"

if [[ -x "${ROOT}/scripts/ops/notify-operations.sh" ]]; then
  "${ROOT}/scripts/ops/notify-operations.sh" release succeeded >/dev/null 2>&1 || true
fi
printf 'Chat2API release succeeded for commit %s\n' "${HEAD_SHA}"
