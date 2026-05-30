#!/usr/bin/env bash
# Upload a local DMG to GitHub Releases (does NOT commit DMG into the git repo).
set -euo pipefail

VERSION="${1:-0.1.0}"
REPO="${CACHEBAR_REPO:-ingeniousfrog/CacheBar}"
TAG="v${VERSION}"
DMG="release/CacheBar_${VERSION}_aarch64.dmg"

if [[ ! -f "${DMG}" ]]; then
  echo "Missing: ${DMG}" >&2
  echo "Build first: npm run tauri build -- --bundles dmg" >&2
  echo "Then copy: cp src-tauri/target/release/bundle/dmg/CacheBar_${VERSION}_aarch64.dmg release/" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI: brew install gh && gh auth login" >&2
  exit 1
fi

echo "→ Creating release ${TAG} on ${REPO}"
echo "→ Asset: ${DMG}"
echo ""
echo "Download URL after upload:"
echo "  https://github.com/${REPO}/releases/download/${TAG}/CacheBar_${VERSION}_aarch64.dmg"
echo ""

gh release create "${TAG}" "${DMG}" \
  --repo "${REPO}" \
  --title "${TAG}" \
  --notes "CacheBar ${VERSION} for Apple Silicon (aarch64)."

echo ""
echo "Done. Verify: https://github.com/${REPO}/releases/tag/${TAG}"
