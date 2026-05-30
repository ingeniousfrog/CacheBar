# Homebrew cask for CacheBar (Apple Silicon).
# Publish this file in a separate repo: github.com/ingeniousfrog/homebrew-tap
# After each release, update version, url, and sha256 (see homebrew-tap/README.md).

cask "cachebar" do
  version "0.1.0"
  sha256 "16337ce75930054d7b945e9faa73decc11350fd16ddfd2d93e8db00f7090b67d"

  url "https://github.com/ingeniousfrog/CacheBar/releases/download/v#{version}/CacheBar_#{version}_aarch64.dmg"
  name "CacheBar"
  desc "macOS menu bar system monitor and safe cache cleanup"
  homepage "https://github.com/ingeniousfrog/CacheBar"

  depends_on macos: ">= :big_sur"
  depends_on arch: :arm64

  app "CacheBar.app"

  zap trash: [
    "~/Library/Application Support/com.cachebar.app",
  ]
end
