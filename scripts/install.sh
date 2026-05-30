#!/usr/bin/env bash
# Install CacheBar from a GitHub Release DMG into /Applications.
set -euo pipefail

VERSION="${CACHEBAR_VERSION:-0.1.0}"
REPO="${CACHEBAR_REPO:-ingeniousfrog/CacheBar}"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
APP_NAME="CacheBar"

arch="$(uname -m)"
case "$arch" in
  arm64) suffix="aarch64" ;;
  x86_64) suffix="x86_64" ;;
  *)
    echo "Unsupported architecture: ${arch}" >&2
    exit 1
    ;;
esac

DMG_NAME="CacheBar_${VERSION}_${suffix}.dmg"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${DMG_NAME}"

tmpdir="$(mktemp -d)"
cleanup() {
  if [[ -n "${mount_point:-}" ]] && [[ -d "${mount_point}" ]]; then
    hdiutil detach "${mount_point}" -quiet 2>/dev/null || true
  fi
  rm -rf "${tmpdir}"
}
trap cleanup EXIT

echo "→ CacheBar ${VERSION} (${suffix})"
echo "→ Downloading ${URL}"

if ! curl -fsSL "${URL}" -o "${tmpdir}/${DMG_NAME}"; then
  echo "Download failed." >&2
  echo "Ensure a GitHub Release exists with asset: ${DMG_NAME}" >&2
  echo "See: https://github.com/${REPO}/releases/tag/v${VERSION}" >&2
  exit 1
fi

echo "→ Mounting DMG…"
mount_output="$(hdiutil attach "${tmpdir}/${DMG_NAME}" -nobrowse -quiet)"
mount_point="$(echo "${mount_output}" | tail -1 | awk '{print $NF}')"

app_src="${mount_point}/${APP_NAME}.app"
if [[ ! -d "${app_src}" ]]; then
  echo "${APP_NAME}.app not found inside the DMG." >&2
  exit 1
fi

dest="${INSTALL_DIR}/${APP_NAME}.app"
if [[ -d "${dest}" ]]; then
  echo "→ Replacing existing ${dest}"
  rm -rf "${dest}"
fi

echo "→ Installing to ${dest}"
cp -R "${app_src}" "${dest}"

hdiutil detach "${mount_point}" -quiet
mount_point=""

echo ""
echo "Installed. Launch with:"
echo "  open -a ${APP_NAME}"
echo ""
echo "If macOS blocks the app (unsigned build), use System Settings → Privacy & Security → Open Anyway,"
