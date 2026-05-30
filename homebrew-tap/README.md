# Homebrew Tap for CacheBar

This folder is meant to live in a **separate** GitHub repository:

**https://github.com/ingeniousfrog/homebrew-tap** (currently empty until you push `Casks/cachebar.rb`)

## One-time setup

1. Create an empty repo named **`homebrew-tap`** under the `ingeniousfrog` account.
2. Copy `Casks/cachebar.rb` from this directory into that repo (same path: `Casks/cachebar.rb`).
3. Commit and push to `main`.

Users can then install with:

```bash
brew tap ingeniousfrog/tap
brew install --cask cachebar
```

## After each CacheBar release

1. Upload `CacheBar_<version>_aarch64.dmg` to [GitHub Releases](https://github.com/ingeniousfrog/CacheBar/releases) on tag `v<version>`.
2. Compute the checksum:

   ```bash
   shasum -a 256 CacheBar_0.1.0_aarch64.dmg
   ```

3. Edit `Casks/cachebar.rb` in **homebrew-tap**: set `version`, `url` (if needed), and `sha256`.
4. Commit and push the tap repo.

From the main CacheBar repo you can print the sha256 line:

```bash
./scripts/print-dmg-sha256.sh path/to/CacheBar_0.1.0_aarch64.dmg
```

## Notes

- This tap is **not** submitted to homebrew-core; you maintain it yourself.
- Only **Apple Silicon** (`aarch64`) DMG is defined here; add another cask or arch block if you ship Intel builds.
- Unsigned apps may still require **Open Anyway** on first launch (same as manual DMG install).
