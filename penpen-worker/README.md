# 彭彭企鵝 Worker（新版）

網頁呼叫這支程式，這支程式再去呼叫 Claude（對話）、Whisper（聽你說話，自動分中英文）、語音合成（企鵝說話），
並把對話存進資料庫給統計頁看。**金鑰都放在 Cloudflare，不會出現在網頁。**

舊的 `penpen` Worker 不用動。新的用新名字 `penpen2`，確認可以用再切換，出問題隨時切回去。

## 最快的方法：一行指令（Mac / Linux）

打開「終端機」，貼上這一行，按 Enter：

```
bash <(curl -fsSL https://raw.githubusercontent.com/EFETL/EFETL.github.io/main/penpen-worker/deploy.sh)
```

它會自動：下載程式、登入 Cloudflare、建立資料庫、上傳 Worker、設定金鑰，最後顯示檢查網址。
你只要做三件事：在跳出的瀏覽器按 **Allow**、貼上 Claude 金鑰、自己訂一組統計頁密碼。
（電腦要先裝 Node.js：https://nodejs.org 下載 LTS 版。）

不想用終端機的話，照下面在 Cloudflare 網頁上點選也可以。

## 一、先準備

1. **Cloudflare 帳號**（舊 Worker 用的那個）。
2. **Claude 金鑰**：到 https://console.anthropic.com → API Keys → Create Key，複製下來（`sk-ant-` 開頭）。
3. （選用）**微軟語音金鑰**：Azure 入口網站 → 建立「語音服務（Speech）」資源 → 到「金鑰與端點」複製「金鑰 1」和「區域」。
   不設定也可以，會用 Cloudflare 內建的語音；設定後企鵝會用 `en-US-AriaNeural`，和你題庫站的聲音一樣。

## 二、在 Cloudflare 網頁上設定（約 15 分鐘）

1. 登入 https://dash.cloudflare.com → 左邊 **Workers & Pages** → **Create** → **Create Worker**。
   名稱填 `penpen2` → **Deploy**。
2. 按 **Edit code**，把裡面原本的程式**全部刪掉**，貼上這個資料夾的 `worker.js` 全部內容 → 右上 **Deploy**。
3. 建立資料庫：左邊 **Storage & Databases** → **D1 SQL database** → **Create** → 名稱 `penpen2` → Create。
   （資料表程式會自動建立，不用打任何 SQL。）
4. 回到 `penpen2` → **Settings** → **Bindings** → **Add**：
   - 選 **Workers AI**，名稱填 `AI`。
   - 選 **D1 database**，名稱填 `DB`，資料庫選 `penpen2`。
5. **Settings** → **Variables and Secrets** → **Add**，類型選 **Secret**：
   - `ANTHROPIC_API_KEY`：貼 Claude 金鑰。
   - `STATS_PASSWORD`：自己訂一組統計頁的密碼。
   - （選用）`AZURE_SPEECH_KEY`：貼微軟金鑰；再新增一個類型 **Text** 的變數 `AZURE_SPEECH_REGION`，填區域（例如 `eastasia`）。
6. （選用）**Settings** → **Triggers** → **Cron Triggers** → Add → `17 19 * * *`（每天自動清掉過期對話）。

## 三、檢查有沒有設定好

用瀏覽器打開 `https://penpen2.<你的帳號>.workers.dev/health`（網址在 Worker 頁面右上角），會看到：

```
claude_key: ✅   workers_ai_binding_AI: ✅   d1_binding_DB: ✅   stats_password: ✅
voice: Azure en-US-AriaNeural   （沒設微軟就會寫 Workers AI MeloTTS）
```

有 ❌ 的項目就是還沒設定好。

## 四、讓彭彭企鵝改用新的 Worker

用瀏覽器打開（把網址換成你的）：

```
https://quiz.efetl.com/penpen-door.html?worker=https://penpen2.<你的帳號>.workers.dev
```

這個設定會記在那個瀏覽器裡，之後直接開 `penpen-door.html` 就會用新的。要切回舊的：網址加 `?worker=reset`。
統計頁（`penpen-stats.html`）會跟著用同一個 Worker，密碼就是上面的 `STATS_PASSWORD`。

## 它做了什麼

| 路徑 | 說明 |
|---|---|
| `/chat` | 把對話交給 Claude（預設 `claude-haiku-5-5`，快）；企鵝的個性、難度、安全規則都寫在 `buildSystem()`；網頁傳來的「目標單字」會自然帶進對話 |
| `/stt` | Whisper large-v3-turbo；`lang: auto` 自動分中文與英文，被誤判成別國語言時改用英文重辨一次；提示詞偏向繁體中文 |
| `/tts` | 有微軟金鑰用 Aria（中文句子用 `zh-TW-HsiaoChenNeural`），沒有就用內建語音；同一句話只合成一次（快取）；微軟壞掉自動退回內建語音 |
| `/stats` | 統計頁的資料；密碼錯 5 次鎖 10 分鐘 |
| `/health` | 檢查設定 |

保護機制：只接受 `quiz.efetl.com`、`efetl.github.io`（可用變數 `ALLOWED_ORIGINS` 改）；每個 IP 每分鐘有次數限制；
每天總量有上限（`CHAT_DAILY_CAP` 預設 4000、`STT_DAILY_CAP` 4000、`TTS_DAILY_CAP` 6000），超過會暫停，避免帳單失控。

## 可以調整的變數（Settings → Variables，全部選用）

| 名稱 | 預設 | 說明 |
|---|---|---|
| `CLAUDE_MODEL` | `claude-haiku-5-5` | 想要更聰明可換成 `claude-sonnet-5-5`（比較慢也比較貴） |
| `KEEP_DAYS` | `90` | 對話原文保留幾天 |
| `KEEP_DAILY_DAYS` | `730` | 每日統計保留幾天（只有數字，沒有句子） |
| `AZURE_VOICE` | `en-US-AriaNeural` | 英文聲音 |
| `AZURE_VOICE_ZH` | `zh-TW-HsiaoChenNeural` | 中文聲音 |
| `AZURE_RATE`、`AZURE_PITCH` | `-4%`、`+2%` | 語速、音調 |
| `ALLOWED_ORIGINS` | 兩個站台 | 以逗號分隔 |

## 隱私

只存文字（孩子說的話、企鵝的回答、第幾輪、辨識信心），不存聲音、姓名、網路位址。聲音只會送去辨識，不會保存。
保留天數到了會自動刪除。頁面上的隱私說明如果寫「7 天」，請記得跟 `KEEP_DAYS` 一致。

## 在電腦上測試程式邏輯

```
node --no-warnings penpen-worker/test/worker.test.mjs
```

用 Node 內建的資料庫和假的 Claude／語音服務測試，不會連到任何真實服務，也不會花錢。
