#!/usr/bin/env bash
# Builds crt-service (release, riscv64imac-unknown-none-elf) into service/build/crt-service.elf and prints its
# data hash (blake2b-256, personalization `ckb-default-hash`): CRT_CODE_HASH.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi
if command -v rustup >/dev/null 2>&1; then
  rustup target add riscv64imac-unknown-none-elf >/dev/null
fi
TARGET=riscv64imac-unknown-none-elf
LOCKED=""
[ -f "$ROOT/service/Cargo.lock" ] && LOCKED="--locked"
OUT="$ROOT/service/build"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/service/target}"
mkdir -p "$OUT"

cargo build --manifest-path "$ROOT/service/Cargo.toml" --release --target $TARGET -j 2 $LOCKED -p crt-service \
  --config "target.$TARGET.rustflags=['-C','link-arg=-s']"
cp "$TARGET_DIR/$TARGET/release/crt-service" "$OUT/crt-service.elf"
echo "crt-service.elf: $(stat -c %s "$OUT/crt-service.elf") bytes"
if command -v python3 >/dev/null 2>&1; then
  H=$(python3 -I -c 'import hashlib, sys
h = hashlib.blake2b(digest_size=32, person=b"ckb-default-hash")
h.update(open(sys.argv[1], "rb").read())
print("0x" + h.hexdigest())' "$OUT/crt-service.elf")
  echo "CRT_CODE_HASH=$H"
else
  echo "(python3 not found: CRT_CODE_HASH not computed)"
fi
