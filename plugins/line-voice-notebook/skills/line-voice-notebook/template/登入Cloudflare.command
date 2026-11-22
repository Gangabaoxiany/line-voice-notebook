#!/bin/bash
# 登入 Cloudflare（只要一次）：會打開瀏覽器，按「Allow」就好
cd "$(dirname "$0")"
export PATH="$HOME/.local/node/bin:$PATH"
echo "🌐 等一下瀏覽器會打開 Cloudflare，請按「Allow（允許）」"
wrangler login
echo
echo "✅ 好了，可以關掉這個視窗，回 Claude 說「登入好了」"
read -n1 -s -p "（按任意鍵關閉）"
