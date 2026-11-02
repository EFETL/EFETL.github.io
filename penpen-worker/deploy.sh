#!/bin/bash
# 彭彭企鵝新版 Worker：一鍵部署到 Cloudflare（Mac / Linux）
#
# 打開「終端機」，貼上這一行，按 Enter：
#   bash <(curl -fsSL https://raw.githubusercontent.com/EFETL/EFETL.github.io/main/penpen-worker/deploy.sh)
#
# 過程中你只要做三件事：在跳出的瀏覽器按「Allow」、貼上 Claude 金鑰、自己訂一組統計頁密碼。
set -e
RAW="https://raw.githubusercontent.com/EFETL/EFETL.github.io/main/penpen-worker"
DIR="$HOME/penpen2-worker"
W="npx --yes wrangler@4"
say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

say "1/6 檢查電腦有沒有 Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "這台電腦還沒有 Node.js。請到 https://nodejs.org 下載「LTS」版安裝，裝好後重新貼上同一行指令。"
  exit 1
fi
node -v

say "2/6 下載程式到 $DIR"
mkdir -p "$DIR" && cd "$DIR"
curl -fsSL "$RAW/worker.js" -o worker.js
[ -f wrangler.toml ] || curl -fsSL "$RAW/wrangler.toml" -o wrangler.toml

say "3/6 登入 Cloudflare（會跳出瀏覽器，請按 Allow）"
if ! $W whoami 2>&1 | grep -qi "logged in"; then $W login; fi

say "4/6 建立資料庫 penpen2（已經有就沿用）"
if grep -q "把 D1 的 database_id" wrangler.toml; then
  OUT=$($W d1 create penpen2 2>&1 || true)
  ID=$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ -z "$ID" ]; then
    ID=$($W d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const d=a.find(x=>x.name==="penpen2");if(d)console.log(d.uuid||d.database_id||"")}catch(e){}})')
  fi
  if [ -z "$ID" ]; then echo "找不到資料庫的 ID，訊息如下："; echo "$OUT"; exit 1; fi
  perl -pi -e "s/把 D1 的 database_id 貼在這裡/$ID/" wrangler.toml
  echo "資料庫 ID：$ID"
else
  echo "已經設定過資料庫，沿用。"
fi

say "5/6 上傳 Worker"
DEPLOY=$($W deploy 2>&1) || { echo "$DEPLOY"; exit 1; }
echo "$DEPLOY" | tail -5
URL=$(printf '%s' "$DEPLOY" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)

say "6/6 設定金鑰（輸入時畫面不會顯示文字，這是正常的）"
echo "→ 請貼上 Claude 金鑰（sk-ant- 開頭），按 Enter："
$W secret put ANTHROPIC_API_KEY
echo "→ 請自己訂一組統計頁密碼，按 Enter："
$W secret put STATS_PASSWORD
read -r -p "有微軟語音（Azure Speech）金鑰嗎？沒有就直接按 Enter 跳過 [y/N] " AZ || AZ=""
if [ "$AZ" = "y" ] || [ "$AZ" = "Y" ]; then
  echo "→ 請貼上微軟語音金鑰，按 Enter："
  $W secret put AZURE_SPEECH_KEY
  read -r -p "微軟語音的區域（例如 eastasia）：" REGION || REGION=""
  printf '%s' "${REGION:-eastasia}" | $W secret put AZURE_SPEECH_REGION
fi

say "完成！"
if [ -n "$URL" ]; then
  echo "檢查設定：$URL/health"
  sleep 3
  curl -fsS "$URL/health" || true
  echo
  echo
  echo "全部 ✅ 之後，用這個網址讓彭彭企鵝改用新的 Worker："
  echo "https://quiz.efetl.com/penpen-door.html?worker=$URL"
else
  echo "請到 Cloudflare 後台找 penpen2 的網址，打開「網址/health」檢查。"
fi
