# -*- coding: utf-8 -*-
"""替 quiz.efetl.com 上還在用瀏覽器語音的頁面產生微軟語音 mp3。

原本這些頁面用 Web Speech API，聲音取決於使用者的裝置（Mac 是 Siri、
Android 是 Google），同一份教材在不同裝置聽起來不一樣。改成預先用
edge-tts（en-US-AriaNeural）產生音檔，跟單字卡、聽力測驗同一個聲音。

所有頁面共用站根的 tts-audio/ 一個資料夾——同一個字在不同本單字表裡
發音一樣，沒必要各存一份。檔名規則與既有的單字卡一致：小寫、非英數字
轉底線，前後補靜音。

    python3 make_tts_audio.py --list          # 只列出要產幾個檔
    python3 make_tts_audio.py                 # 產檔
"""
import argparse, json, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE.parent
TOOL = pathlib.Path.home() / ".local" / "share" / "efetl-tts"
if str(TOOL) not in sys.path:
    sys.path.insert(0, str(TOOL))
import efetl_tts as T

OUT = SITE / "tts-audio"
VOICE = "N"          # en-US-AriaNeural
WPM = 159            # 與單字卡、聽力測驗同一個語速
LEAD, TRAIL = 0.2, 0.9

# 每本單字表：(檔名, 陣列變數名, 單字欄位)
VOCAB_BOOKS = [
    ("senior-7000.html",     "WORDS", "w"),
    ("junior-2000.html",     "WORDS", "w"),
    ("elementary-1200.html", "DATA",  "en"),
    ("g9-vocab-unit1.html",  "WORDS", "w"),
]


def slug(text):
    return re.sub(r'[^a-z0-9]+', '_', str(text).lower()).strip('_')


def say_text(w):
    """g9-vocab-unit1 原本的 sayText()：a.m. 要唸成 A M，a/b 唸成 a or b。
    其他頁面沒有這層轉換，但套用在一般單字上不會改變結果。"""
    key = w.lower().replace(".", "").replace(" ", "")
    if key in ("am", "pm"):
        return key.upper()[0] + " " + key.upper()[1]
    return re.sub(r'\s*/\s*', ' or ', w)


def collect():
    """回傳 {slug: 要合成的文字}。"""
    items = {}
    for fname, arr, key in VOCAB_BOOKS:
        h = (SITE / fname).read_text(encoding="utf-8")
        m = re.search(r'(?:const|let|var)\s+' + arr + r'\s*=\s*(\[.*?\])\s*;', h, re.S)
        if not m:
            print(f"!! {fname} 找不到 {arr}", file=sys.stderr)
            continue
        for d in json.loads(m.group(1)):
            w = d[key]
            s = slug(w)
            if s and s not in items:
                items[s] = say_text(w)
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()

    items = sorted(collect().items())
    if a.limit:
        items = items[:a.limit]
    print(f"要產 {len(items)} 個音檔")
    if a.list:
        return

    OUT.mkdir(exist_ok=True)
    todo = [(s, t) for s, t in items if not (OUT / f"{s}.mp3").exists()]
    print(f"其中 {len(todo)} 個還沒有（已存在的略過）", flush=True)

    T.synth_many([(t, VOICE) for _, t in todo], WPM,
                 progress=lambda n, tot: print(f"  合成 {n}/{tot}", flush=True))

    lead, trail = T.silence(LEAD), T.silence(TRAIL)
    tmp = T.CACHE / "_tts_tmp.wav"
    for i, (s, t) in enumerate(todo, 1):
        T.concat([lead, T.synth(t, VOICE, WPM), trail], tmp)
        T.encode(tmp, OUT / f"{s}.mp3", "48k")
        if i % 300 == 0:
            print(f"  編碼 {i}/{len(todo)}", flush=True)

    unlock = OUT / "unlock-silence.mp3"
    if not unlock.exists():
        T.concat([T.silence(0.15)], tmp)
        T.encode(tmp, unlock, "48k")

    n = len(list(OUT.glob("*.mp3")))
    total = sum(p.stat().st_size for p in OUT.glob("*.mp3"))
    print(f"完成：{OUT.name}/ 共 {n} 個檔，{total/1024/1024:.1f} MB")


if __name__ == "__main__":
    main()
