#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

: "${CHAT2API_COMPOSE_PROJECT:?CHAT2API_COMPOSE_PROJECT is required}"

readonly BACKUP_DIR="${CHAT2API_BACKUP_DIR:-${HOME}/.local/share/chat2api-web-gateway/backups}"
readonly STATE_DIR="${CHAT2API_STATE_DIR:-${HOME}/.local/state/chat2api-web-gateway}"
readonly RETENTION_DAYS="${CHAT2API_BACKUP_RETENTION_DAYS:-30}"
readonly LOCK_FILE="${STATE_DIR}/backup.lock"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Chat2API backup failed: required command is unavailable: %s\n' "$1" >&2
    exit 1
  }
}

for command_name in docker flock sha256sum; do
  require_command "${command_name}"
done

[[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]] || {
  printf 'Chat2API backup failed: retention days must be a non-negative integer\n' >&2
  exit 1
}

install -d -m 0700 "${BACKUP_DIR}" "${STATE_DIR}"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  printf 'Chat2API backup skipped: another backup is already running\n'
  exit 0
fi

mapfile -t container_ids < <(
  docker ps \
    --filter "label=com.docker.compose.project=${CHAT2API_COMPOSE_PROJECT}" \
    --filter status=running \
    --format '{{.ID}}'
)

if [[ "${#container_ids[@]}" -ne 1 ]]; then
  printf 'Chat2API backup failed: expected one running application container, found %s\n' \
    "${#container_ids[@]}" >&2
  exit 1
fi

readonly CONTAINER_ID="${container_ids[0]}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly TIMESTAMP
readonly CONTAINER_BACKUP="/data/.chat2api-ops-backup-${TIMESTAMP}-${RANDOM}.sqlite"
readonly DESTINATION="${BACKUP_DIR}/chat2api-${TIMESTAMP}.sqlite"
readonly STAGING="${DESTINATION}.partial"

cleanup() {
  rm -f -- "${STAGING}"
  docker exec "${CONTAINER_ID}" rm -f -- "${CONTAINER_BACKUP}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ -e "${DESTINATION}" || -e "${STAGING}" ]]; then
  printf 'Chat2API backup failed: destination already exists\n' >&2
  exit 1
fi

docker exec \
  -e CHAT2API_DATABASE_PATH=/data/chat2api.sqlite \
  -e "CHAT2API_BACKUP_PATH=${CONTAINER_BACKUP}" \
  "${CONTAINER_ID}" \
  node /app/scripts/backup-sqlite.mjs >/dev/null

container_checksum="$(
  docker exec "${CONTAINER_ID}" sha256sum "${CONTAINER_BACKUP}" | awk '{print $1}'
)"
[[ "${container_checksum}" =~ ^[a-f0-9]{64}$ ]] || {
  printf 'Chat2API backup failed: container checksum is invalid\n' >&2
  exit 1
}

docker cp "${CONTAINER_ID}:${CONTAINER_BACKUP}" "${STAGING}" >/dev/null
chmod 0600 "${STAGING}"

host_checksum="$(sha256sum "${STAGING}" | awk '{print $1}')"
if [[ "${host_checksum}" != "${container_checksum}" ]]; then
  printf 'Chat2API backup failed: copied backup checksum mismatch\n' >&2
  exit 1
fi

mv -- "${STAGING}" "${DESTINATION}"
docker exec "${CONTAINER_ID}" rm -f -- "${CONTAINER_BACKUP}" >/dev/null
trap - EXIT

last_success_staging="${STATE_DIR}/backup.last-success.partial"
printf '%s\t%s\t%s\n' "${TIMESTAMP}" "${DESTINATION}" "${host_checksum}" \
  > "${last_success_staging}"
chmod 0600 "${last_success_staging}"
mv -- "${last_success_staging}" "${STATE_DIR}/backup.last-success"

find "${BACKUP_DIR}" \
  -maxdepth 1 \
  -type f \
  -name 'chat2api-????????T??????Z.sqlite' \
  -mtime "+${RETENTION_DAYS}" \
  -delete

printf 'Chat2API backup succeeded: %s\n' "${DESTINATION}"
