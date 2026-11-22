#!/bin/bash
# 安裝 Node.js＋wrangler（Cloudflare 的上線工具）到 ~/.local/node
# 不用管理員密碼、不動系統；從 nodejs.org 官方下載，核對官方 SHA256 才解壓。
set -euo pipefail
D="$HOME/.local/node"
if [ -x "$D/bin/node" ] && [ -x "$D/bin/wrangler" ]; then
  echo "✅ 已經裝好了：node $("$D/bin/node" -v)、wrangler $(PATH="$D/bin:$PATH" "$D/bin/wrangler" --version | tail -1)"
  exit 0
fi
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH=x64
URL="https://nodejs.org/dist/latest-v24.x"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if [ ! -x "$D/bin/node" ]; then
  echo "⬇️  下載 Node.js（約 50MB）…"
  curl -fsSL "$URL/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE=$(grep -o "node-v[0-9.]*-darwin-$ARCH.tar.gz" "$TMP/SHASUMS256.txt" | head -1)
  curl -fSL --progress-bar "$URL/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || { echo "❌ 下載的檔案核對不過，停下來"; exit 1; }
  mkdir -p "$D"
  tar -xzf "$TMP/$FILE" -C "$D" --strip-components=1
fi
echo "⬇️  安裝 wrangler…"
PATH="$D/bin:$PATH" "$D/bin/npm" install -g wrangler@4 --no-fund --no-audit --loglevel=error
echo "✅ 裝好了：node $("$D/bin/node" -v)、wrangler $(PATH="$D/bin:$PATH" "$D/bin/wrangler" --version | tail -1)"
echo "   位置：$D/bin（之後指令用 ~/.local/node/bin/node、~/.local/node/bin/wrangler）"
