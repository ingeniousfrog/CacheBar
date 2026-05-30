# Release checklist

Use this when publishing a new version (e.g. `0.1.0` → `0.1.1`).

## 1. Bump version

- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `version`

## 2. Build DMG

```bash
npm ci
npm run tauri build -- --bundles dmg
```

Artifact: `src-tauri/target/release/bundle/dmg/CacheBar_<version>_aarch64.dmg`

## 3. GitHub Release (where the DMG actually lives)

**Do not** create folders like `release/download/v0.1.0/` in the git repo.  
GitHub builds the download URL for you when you attach the DMG to a **Release**.

| What | Purpose |
| --- | --- |
| `release/CacheBar_0.1.0_aarch64.dmg` (local, gitignored) | Staging copy on your Mac only |
| [GitHub Releases](https://github.com/ingeniousfrog/CacheBar/releases) | Public download for users, install script, and Homebrew |

**Option A — script (needs `gh auth login`):**

```bash
# After building, copy DMG into release/ if needed:
cp src-tauri/target/release/bundle/dmg/CacheBar_0.1.0_aarch64.dmg release/

./scripts/github-release.sh 0.1.0
```

**Option B — GitHub website:**

1. Open **Releases → Draft a new release**
2. Tag: `v0.1.0` (create new tag)
3. Attach file: `CacheBar_0.1.0_aarch64.dmg`
4. Publish release

Public URL (automatic):

`https://github.com/ingeniousfrog/CacheBar/releases/download/v0.1.0/CacheBar_0.1.0_aarch64.dmg`

## 4. Update Homebrew tap

Repo: [ingeniousfrog/homebrew-tap](https://github.com/ingeniousfrog/homebrew-tap)

```bash
./scripts/print-dmg-sha256.sh release/CacheBar_<version>_aarch64.dmg
# Update homebrew-tap/Casks/cachebar.rb, then:
./scripts/push-homebrew-tap.sh
```

Requires git push access to `homebrew-tap` (and `gh auth login` if using HTTPS with gh).

## 5. Optional mirrors

- Baidu Netdisk (README) for users in China.
- Update README if the share link or filename changes.

## 6. Verify install paths

```bash
# Script
curl -fsSL https://raw.githubusercontent.com/ingeniousfrog/CacheBar/main/scripts/install.sh | bash

# Homebrew
brew tap ingeniousfrog/tap
brew install --cask cachebar
```
