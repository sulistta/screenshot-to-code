#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POETRY_BIN="${PROJECT_DIR}/../.tools/bin/poetry"

if [[ ! -x "${POETRY_BIN}" ]]; then
  echo "Poetry was not found at ${POETRY_BIN}."
  exit 1
fi

cleanup() {
  kill "${BACKEND_PID:-}" "${FRONTEND_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(
  cd "${PROJECT_DIR}/backend"
  POETRY_CACHE_DIR="${PROJECT_DIR}/../.tools/poetry-cache" \
    "${POETRY_BIN}" run uvicorn main:app --host 127.0.0.1 --port 7001
) &
BACKEND_PID=$!

pnpm -C "${PROJECT_DIR}/frontend" dev --host 127.0.0.1 &
FRONTEND_PID=$!

echo "Screenshot to Code: http://127.0.0.1:5173"
echo "Press Ctrl+C to stop both services."

wait -n "${BACKEND_PID}" "${FRONTEND_PID}"
