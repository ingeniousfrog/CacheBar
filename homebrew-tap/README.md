# ingeniousfrog/homebrew-tap

Personal [Homebrew tap](https://docs.brew.sh/Taps) for macOS apps published under the [ingeniousfrog](https://github.com/ingeniousfrog) GitHub account.

**Live repo:** https://github.com/ingeniousfrog/homebrew-tap

## Install (users)

```bash
brew tap ingeniousfrog/tap
brew install --cask cachebar
```

Upgrade later:

```bash
brew update
brew upgrade --cask cachebar
```

Uninstall:

```bash
brew uninstall --cask cachebar
brew untap ingeniousfrog/tap   # optional, if no other casks from this tap are installed
```

## What is in this tap?

Each app is one file under `Casks/`:

```text
homebrew-tap/
  Casks/
    cachebar.rb      # CacheBar
    other-app.rb     # future apps
  README.md
```

**Yes — you can reuse this same tap for other apps.** Add another `Casks/<name>.rb`, push, and users install with:

```bash
brew install --cask <name>
```

No need to create a new tap per app. One tap (`ingeniousfrog/tap`) can host many casks.

Naming rules:

- File: `Casks/myapp.rb` → cask token `myapp`
- User command: `brew install --cask myapp`
- Use lowercase and hyphens in the cask name (Homebrew convention)

## Maintainer: update CacheBar after a release

1. Upload `CacheBar_<version>_aarch64.dmg` to [CacheBar GitHub Releases](https://github.com/ingeniousfrog/CacheBar/releases) (tag `v<version>`).
2. From the **CacheBar** repo, print the checksum:

   ```bash
   ./scripts/print-dmg-sha256.sh release/CacheBar_<version>_aarch64.dmg
   ```

3. Edit `Casks/cachebar.rb`: `version`, `sha256` (and `url` if the pattern changes).
4. Push to **homebrew-tap**:

   ```bash
   # from CacheBar repo — copies homebrew-tap/ and pushes
   ./scripts/push-homebrew-tap.sh
   ```

   Or commit directly in the `homebrew-tap` repository.

## Maintainer: add a new app to this tap

1. Create `Casks/<app-token>.rb` (see `cachebar.rb` as a template).
2. Point `url` at a stable GitHub Release (or other HTTPS) asset; set `sha256`.
3. Set `app "<Name>.app"` to match the bundle inside the DMG.
4. Commit and push to `homebrew-tap`.
5. Document in that app’s README:

   ```bash
   brew tap ingeniousfrog/tap
   brew install --cask <app-token>
   ```

CLI tools use `Formula/` instead of `Casks/`; GUI `.app` bundles use **Casks** (as here).

## Notes

- This tap is **not** [homebrew-core](https://github.com/Homebrew/homebrew-cask); you maintain it yourself.
- `cachebar` cask is **Apple Silicon only** (`depends_on arch: :arm64`).
- Unsigned builds may still need **Open Anyway** on first launch (same as manual DMG install).

## Sync from CacheBar repo

The `homebrew-tap/` folder in [ingeniousfrog/CacheBar](https://github.com/ingeniousfrog/CacheBar) is the **source template** for this tap. After editing casks there, run `./scripts/push-homebrew-tap.sh` to publish.
