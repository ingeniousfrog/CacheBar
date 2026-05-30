#!/usr/bin/env bash
# Print sha256 for updating homebrew-tap/Casks/cachebar.rb
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 path/to/CacheBar_<version>_aarch64.dmg" >&2
  exit 1
fi

dmg="$1"
if [[ ! -f "${dmg}" ]]; then
  echo "File not found: ${dmg}" >&2
  exit 1
fi

hash="$(shasum -a 256 "${dmg}" | awk '{print $1}')"
echo "sha256 \"${hash}\""
