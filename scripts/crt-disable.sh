#!/usr/bin/env bash
# Disables and revokes the CRT service on this CSR runner.
# Usage: crt-disable.sh [--dry-run] [--csr PATH] [--service-hash 0x...]
set -euo pipefail
DRY=0; CSR=""; HASH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --csr) CSR="$2"; shift ;;
    --service-hash) HASH="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$CSR" ]; then
  CSR=$(command -v csr || true)
  [ -z "$CSR" ] && [ -x /usr/local/bin/csr ] && CSR=/usr/local/bin/csr
fi
[ -n "$CSR" ] || { echo "csr not found (PATH or /usr/local/bin)" >&2; exit 1; }
STATE="${CRT_STATE_DIR:-$HOME/.crt-service}"
[ -z "$HASH" ] && [ -f "$STATE/code_hash" ] && HASH=$(cat "$STATE/code_hash")
[ -n "$HASH" ] || { echo "pass --service-hash 0x<code hash> (printed by crt-enable.sh)" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
run "$CSR" service disable "$HASH"
run "$CSR" service revoke "$HASH"
[ "$DRY" = 1 ] || rm -f "$STATE/code_hash"
cat <<MSG
CRT service disabled and revoked.
Stored switch keys are NOT deleted: the host deletes each one when its Alive Cell is consumed (delete_on_consume).
Until then they stay in the CSR storage of this service. If you insist on deleting them by hand, stop csr, remove
the service's storage directory (see 'csr storage --help' and your data root, <data-root>/<network>/storage/<code hash>)
and accept that switches that still name you can no longer be released by you.
MSG
