#!/usr/bin/env bash
# Builds the CRT contracts (release, riscv64imac-unknown-none-elf) into contracts/build/release/<name> and
# prints each binary's size and data hash (blake2b-256, personalization `ckb-default-hash`): the `code_hash`
# that clients pin with `hash_type data2`.
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
[ -f "$ROOT/contracts/Cargo.lock" ] && LOCKED="--locked"
OUT="$ROOT/contracts/build/release"
# CARGO_TARGET_DIR: e.g. the contract tests' build.rs builds into its own directory (no lock on contracts/target)
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/contracts/target}"
mkdir -p "$OUT"

# blake2b-256 with the CKB personalization; the same function as ckb_hash::blake2b_256.
data_hash() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import hashlib, sys
h = hashlib.blake2b(digest_size=32, person=b"ckb-default-hash")
with open(sys.argv[1], "rb") as f:
    h.update(f.read())
print("0x" + h.hexdigest())' "$1"
  else
    echo "(python3 not found: data hash not computed)"
  fi
}

build() {
  local args=""
  for c in "$@"; do args="$args -p $c"; done
  # shellcheck disable=SC2086
  cargo build --manifest-path "$ROOT/contracts/Cargo.toml" --release --target $TARGET -j 2 $LOCKED $args \
    --config "target.$TARGET.rustflags=['-C','link-arg=-s']"
  for c in "$@"; do
    cp "$TARGET_DIR/$TARGET/release/$c" "$OUT/$c"
    echo "  $c: $(stat -c %s "$OUT/$c") bytes"
    echo "  $c data hash: $(data_hash "$OUT/$c")"
  done
}
echo "== CRT contracts =="
# crt-node-lock hand-parses its data (no ckb-types / bytes, so no atomics) and is referenced with hash type
# data2 (SPEC.md §4).
build crt-node-lock
