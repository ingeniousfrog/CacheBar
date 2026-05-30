#!/usr/bin/env bash
# Push homebrew-tap/ from this repo to github.com/ingeniousfrog/homebrew-tap
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAP_REPO="${TAP_REPO:-https://github.com/ingeniousfrog/homebrew-tap.git}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

echo "→ Cloning ${TAP_REPO}"
git clone --depth 1 "${TAP_REPO}" "${WORKDIR}/homebrew-tap"

mkdir -p "${WORKDIR}/homebrew-tap/Casks"
cp "${ROOT}/homebrew-tap/Casks/cachebar.rb" "${WORKDIR}/homebrew-tap/Casks/cachebar.rb"
if [[ -f "${ROOT}/homebrew-tap/README.md" ]]; then
  cp "${ROOT}/homebrew-tap/README.md" "${WORKDIR}/homebrew-tap/README.md"
fi

cd "${WORKDIR}/homebrew-tap"
git add Casks/cachebar.rb README.md 2>/dev/null || git add Casks/cachebar.rb
if git diff --staged --quiet; then
  echo "No changes to push."
  exit 0
fi

git commit -m "Update cachebar cask for CacheBar"
git push origin main

echo ""
echo "Users can install with:"
echo "  brew tap ingeniousfrog/tap"
echo "  brew install --cask cachebar"
