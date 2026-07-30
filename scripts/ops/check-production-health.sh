#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly OPERATIONS_ENV="${CHAT2API_OPERATIONS_ENV:-${HOME}/.config/chat2api-web-gateway/operations.env}"

if [[ -e "${OPERATIONS_ENV}" ]]; then
  [[ -f "${OPERATIONS_ENV}" && ! -L "${OPERATIONS_ENV}" ]] || {
    printf 'Chat2API health check failed: operations environment is not a regular file\n' >&2
    exit 1
  }
  [[ "$(stat -c '%u' "${OPERATIONS_ENV}")" == "$(id -u)" ]] || {
    printf 'Chat2API health check failed: operations environment owner is invalid\n' >&2
    exit 1
  }
  [[ "$(stat -c '%a' "${OPERATIONS_ENV}")" == "600" ]] || {
    printf 'Chat2API health check failed: operations environment must have mode 0600\n' >&2
    exit 1
  }
  set -a
  # shellcheck disable=SC1090
  source "${OPERATIONS_ENV}"
  set +a
fi

: "${CHAT2API_COMPOSE_PROJECT:?CHAT2API_COMPOSE_PROJECT is required}"

readonly REMOTE_ENV="${CHAT2API_REMOTE_ENV:-${HOME}/.config/chat2api-web-gateway/remote-client.env}"
readonly BACKUP_DIR="${CHAT2API_BACKUP_DIR:-${HOME}/.local/share/chat2api-web-gateway/backups}"
readonly STATE_DIR="${CHAT2API_STATE_DIR:-${HOME}/.local/state/chat2api-web-gateway}"
readonly MAX_BACKUP_AGE_SECONDS="${CHAT2API_MAX_BACKUP_AGE_SECONDS:-93600}"
readonly LOCK_FILE="${STATE_DIR}/health.lock"
readonly STATUS_FILE="${STATE_DIR}/health.status"

install -d -m 0700 "${STATE_DIR}"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  exit 0
fi

previous_status="$(awk 'NR == 1 {print $1}' "${STATUS_FILE}" 2>/dev/null || true)"

record_status() {
  local status="$1"
  local message="$2"
  local staging="${STATUS_FILE}.partial"
  printf '%s\t%s\t%s\n' "${status}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${message}" \
    > "${staging}"
  chmod 0600 "${staging}"
  mv -- "${staging}" "${STATUS_FILE}"
}

fail() {
  local message="$1"
  record_status failed "${message}"
  if [[ "${previous_status}" != "failed" ]]; then
    logger --tag chat2api-health --priority user.err -- "${message}" || true
    if [[ -x "${SCRIPT_DIR}/notify-operations.sh" ]]; then
      "${SCRIPT_DIR}/notify-operations.sh" health failed >/dev/null 2>&1 || true
    fi
  fi
  printf 'Chat2API health check failed: %s\n' "${message}" >&2
  exit 1
}

for command_name in curl docker flock jq logger stat; do
  command -v "${command_name}" >/dev/null 2>&1 \
    || fail "required command is unavailable: ${command_name}"
done

[[ "${MAX_BACKUP_AGE_SECONDS}" =~ ^[0-9]+$ ]] \
  || fail 'maximum backup age must be a non-negative integer'
[[ -f "${REMOTE_ENV}" && ! -L "${REMOTE_ENV}" ]] \
  || fail 'remote client environment file is missing or is a symlink'
[[ "$(stat -c '%u' "${REMOTE_ENV}")" == "$(id -u)" ]] \
  || fail 'remote client environment file has an unexpected owner'
[[ "$(stat -c '%a' "${REMOTE_ENV}")" == "600" ]] \
  || fail 'remote client environment file must have mode 0600'

set -a
# shellcheck disable=SC1090
source "${REMOTE_ENV}"
set +a

: "${CHAT2API_BASE_URL:?CHAT2API_BASE_URL is required in the remote client environment}"
: "${CHAT2API_API_KEY:?CHAT2API_API_KEY is required in the remote client environment}"

base_url="${CHAT2API_BASE_URL%/}"
[[ "${base_url}" =~ ^https://[^/?#]+(/v1)?$ ]] \
  || fail 'remote base URL must be an HTTPS origin with an optional /v1 suffix'

if [[ "${base_url}" == */v1 ]]; then
  service_url="${base_url%/v1}"
  api_url="${base_url}"
else
  service_url="${base_url}"
  api_url="${base_url}/v1"
fi

mapfile -t container_ids < <(
  docker ps \
    --filter "label=com.docker.compose.project=${CHAT2API_COMPOSE_PROJECT}" \
    --filter status=running \
    --format '{{.ID}}'
)
[[ "${#container_ids[@]}" -eq 1 ]] \
  || fail "expected one running application container, found ${#container_ids[@]}"

container_summary="$(
  docker inspect \
    --format '{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
    "${container_ids[0]}"
)"
IFS='|' read -r container_user read_only cap_drop security_options container_health \
  <<< "${container_summary}"

[[ "${container_user}" == "10001:10001" ]] || fail 'application container is not running as the expected non-root user'
[[ "${read_only}" == "true" ]] || fail 'application container root filesystem is writable'
[[ "${cap_drop}" == *'"ALL"'* ]] || fail 'application container capabilities are not fully dropped'
[[ "${security_options}" == *'"no-new-privileges:true"'* ]] \
  || fail 'application container is missing no-new-privileges'
[[ "${container_health}" == "healthy" ]] || fail "application container health is ${container_health:-unknown}"

http_status() {
  curl \
    --silent \
    --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --connect-timeout 5 \
    --max-time 20 \
    "$1"
}

[[ "$(http_status "${service_url}/health/live")" == "200" ]] \
  || fail 'liveness endpoint is unavailable'
[[ "$(http_status "${service_url}/health/ready")" == "200" ]] \
  || fail 'readiness endpoint is unavailable'
[[ "$(http_status "${api_url}/models")" == "401" ]] \
  || fail 'models endpoint does not reject unauthenticated access'
[[ "$(http_status "${api_url}/models?api_key=invalid")" == "401" ]] \
  || fail 'models endpoint accepted a query-string credential'

models_response="$(mktemp)"
trap 'rm -f -- "${models_response}"' EXIT
authenticated_status="$(
  curl \
    --silent \
    --show-error \
    --output "${models_response}" \
    --write-out '%{http_code}' \
    --connect-timeout 5 \
    --max-time 20 \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "${CHAT2API_API_KEY}") \
    "${api_url}/models"
)"
[[ "${authenticated_status}" == "200" ]] || fail 'authenticated models request failed'
jq -e '.object == "list" and (.data | type == "array")' "${models_response}" >/dev/null \
  || fail 'authenticated models response is not OpenAI-compatible'
rm -f -- "${models_response}"
trap - EXIT

latest_backup="$(
  find "${BACKUP_DIR}" \
    -maxdepth 1 \
    -type f \
    -name 'chat2api-????????T??????Z.sqlite' \
    -printf '%T@\t%p\n' 2>/dev/null \
    | sort -nr \
    | head -n 1 \
    | cut -f 2-
)"
[[ -n "${latest_backup}" ]] || fail 'no verified production backup was found'
[[ "$(stat -c '%a' "${latest_backup}")" == "600" ]] \
  || fail 'latest production backup must have mode 0600'

backup_age="$(( $(date +%s) - $(stat -c '%Y' "${latest_backup}") ))"
(( backup_age <= MAX_BACKUP_AGE_SECONDS )) \
  || fail "latest production backup is ${backup_age} seconds old"

record_status healthy 'all checks passed'
if [[ "${previous_status}" == "failed" ]]; then
  logger --tag chat2api-health --priority user.notice -- 'Chat2API production health recovered' || true
  if [[ -x "${SCRIPT_DIR}/notify-operations.sh" ]]; then
    "${SCRIPT_DIR}/notify-operations.sh" health recovered >/dev/null 2>&1 || true
  fi
fi
if [[ "${CHAT2API_HEALTH_QUIET:-0}" != "1" ]]; then
  printf 'Chat2API health check passed\n'
fi
