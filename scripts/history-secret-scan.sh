#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git "${ROOT}" --redact --no-banner
  exec gitleaks dir "${ROOT}" --redact --no-banner
fi

if command -v docker >/dev/null 2>&1; then
  docker run \
    --rm \
    --volume "${ROOT}:/repo:ro" \
    --workdir /repo \
    zricethezav/gitleaks:v8.24.3 \
    git /repo \
    --redact \
    --no-banner
  exec docker run \
    --rm \
    --volume "${ROOT}:/repo:ro" \
    --workdir /repo \
    zricethezav/gitleaks:v8.24.3 \
    dir /repo \
    --redact \
    --no-banner
fi

printf 'Git history secret scan failed: install gitleaks or Docker.\n' >&2
exit 1
