#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/.env"

[[ -f "${ENV_FILE}" ]] || {
  printf 'No .env file found. Run the installer first.\n' >&2
  exit 1
}

TOKEN="$(sed -n 's/^CHAT2API_ADMIN_TOKEN=//p' "${ENV_FILE}" | head -n 1)"
[[ -n "${TOKEN}" ]] || {
  printf 'CHAT2API_ADMIN_TOKEN is missing from .env.\n' >&2
  exit 1
}

printf '%s\n' "${TOKEN}"
