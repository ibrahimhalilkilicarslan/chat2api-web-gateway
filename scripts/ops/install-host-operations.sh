#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

: "${CHAT2API_COMPOSE_PROJECT:?CHAT2API_COMPOSE_PROJECT is required}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly LIBEXEC_DIR="${CHAT2API_LIBEXEC_DIR:-${HOME}/.local/libexec/chat2api-web-gateway}"
readonly BACKUP_DIR="${CHAT2API_BACKUP_DIR:-${HOME}/.local/share/chat2api-web-gateway/backups}"
readonly STATE_DIR="${CHAT2API_STATE_DIR:-${HOME}/.local/state/chat2api-web-gateway}"
readonly REMOTE_ENV="${CHAT2API_REMOTE_ENV:-${HOME}/.config/chat2api-web-gateway/remote-client.env}"
readonly CRON_BEGIN='# BEGIN CHAT2API_WEB_GATEWAY_OPERATIONS'
readonly CRON_END='# END CHAT2API_WEB_GATEWAY_OPERATIONS'

for command_name in awk chmod crontab install mktemp stat touch; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    printf 'Chat2API operations install failed: required command is unavailable: %s\n' \
      "${command_name}" >&2
    exit 1
  }
done

[[ -f "${REMOTE_ENV}" && ! -L "${REMOTE_ENV}" ]] || {
  printf 'Chat2API operations install failed: remote client environment file is unavailable\n' >&2
  exit 1
}
[[ "$(stat -c '%u' "${REMOTE_ENV}")" == "$(id -u)" ]] || {
  printf 'Chat2API operations install failed: remote client environment owner is invalid\n' >&2
  exit 1
}
[[ "$(stat -c '%a' "${REMOTE_ENV}")" == "600" ]] || {
  printf 'Chat2API operations install failed: remote client environment must have mode 0600\n' >&2
  exit 1
}

install -d -m 0700 "${LIBEXEC_DIR}" "${BACKUP_DIR}" "${STATE_DIR}"
install -m 0700 \
  "${SCRIPT_DIR}/run-production-backup.sh" \
  "${LIBEXEC_DIR}/run-production-backup.sh"
install -m 0700 \
  "${SCRIPT_DIR}/check-production-health.sh" \
  "${LIBEXEC_DIR}/check-production-health.sh"

touch "${STATE_DIR}/backup.log" "${STATE_DIR}/health-errors.log"
chmod 0600 "${STATE_DIR}/backup.log" "${STATE_DIR}/health-errors.log"

current_crontab="$(crontab -l 2>/dev/null || true)"
filtered_crontab="$(
  awk -v begin="${CRON_BEGIN}" -v end="${CRON_END}" '
    $0 == begin { skipping = 1; next }
    $0 == end { skipping = 0; next }
    !skipping { print }
  ' <<< "${current_crontab}"
)"

cron_staging="$(mktemp)"
trap 'rm -f -- "${cron_staging}"' EXIT
{
  printf '%s\n' "${filtered_crontab}"
  printf '%s\n' "${CRON_BEGIN}"
  printf '43 2 * * * env CHAT2API_COMPOSE_PROJECT=%q CHAT2API_BACKUP_DIR=%q CHAT2API_STATE_DIR=%q %q >> %q 2>&1\n' \
    "${CHAT2API_COMPOSE_PROJECT}" \
    "${BACKUP_DIR}" \
    "${STATE_DIR}" \
    "${LIBEXEC_DIR}/run-production-backup.sh" \
    "${STATE_DIR}/backup.log"
  printf '*/5 * * * * env CHAT2API_COMPOSE_PROJECT=%q CHAT2API_BACKUP_DIR=%q CHAT2API_STATE_DIR=%q CHAT2API_REMOTE_ENV=%q CHAT2API_HEALTH_QUIET=1 %q > /dev/null 2>> %q\n' \
    "${CHAT2API_COMPOSE_PROJECT}" \
    "${BACKUP_DIR}" \
    "${STATE_DIR}" \
    "${REMOTE_ENV}" \
    "${LIBEXEC_DIR}/check-production-health.sh" \
    "${STATE_DIR}/health-errors.log"
  printf '%s\n' "${CRON_END}"
} > "${cron_staging}"

crontab "${cron_staging}"
trap - EXIT
rm -f -- "${cron_staging}"

printf 'Chat2API host operations installed:\n'
printf '  backup runner: %s\n' "${LIBEXEC_DIR}/run-production-backup.sh"
printf '  health monitor: %s\n' "${LIBEXEC_DIR}/check-production-health.sh"
printf '  backup directory: %s\n' "${BACKUP_DIR}"
printf '  state directory: %s\n' "${STATE_DIR}"
