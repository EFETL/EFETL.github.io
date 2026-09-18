# -*- coding: utf-8 -*-
"""依 sentences.json 產生句子類頁面的微軟語音 mp3。

檔名用內容 md5 前 10 碼（沿用站上 tongce-cloze-vocab 的慣例；句子太長，
不適合像單字那樣拿文字當檔名）。同一批頁面共用一個目錄，內容相同的句子
只會存一份。

    python3 make_sentence_audio.py --list
    python3 make_sentence_audio.py
"""
import argparse, json, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE.parent
TOOL = pathlib.Path.home() / ".local" / "share" / "efetl-tts"
if str(TOOL) not in sys.path:
    sys.path.insert(0, str(TOOL))
import efetl_tts as T

VOICE = "N"          # en-US-AriaNeural
WPM = 159
LEAD, TRAIL = 0.2, 0.6   # 句子比單字長，尾巴不用留那麼久

# 頁面 → 音檔目錄；40 回統測解析共用一個目錄，重複的句子只存一份
def dest_dir(page):
    if page.startswith("tongce-analysis-"):
        return SITE / "tongce-analysis-audio"
    return SITE / (page[:-5] + "-audio")


def load():
    data = json.loads((HERE / "sentences.json").read_text(encoding="utf-8"))
    groups = {}   # 目錄 -> {id: text}
    for page, items in data.items():
        groups.setdefault(dest_dir(page), {}).update(items)
    return groups


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()

    groups = load()
    for d, items in groups.items():
        print(f"  {d.name:<26} {len(items)} 個")
    total = sum(len(v) for v in groups.values())
    print(f"合計 {total} 個音檔")
    if a.list:
        return

    todo = []
    for d, items in groups.items():
        d.mkdir(exist_ok=True)
        for i, t in items.items():
            if not (d / f"{i}.mp3").exists():
                todo.append((d, i, t))
    if a.limit:
        todo = todo[:a.limit]
    print(f"還沒有的 {len(todo)} 個", flush=True)

    T.synth_many([(t, VOICE) for _, _, t in todo], WPM,
                 progress=lambda n, tot: print(f"  合成 {n}/{tot}", flush=True))

    lead, trail = T.silence(LEAD), T.silence(TRAIL)
    tmp = T.CACHE / "_sent_tmp.wav"
    for n, (d, i, t) in enumerate(todo, 1):
        T.concat([lead, T.synth(t, VOICE, WPM), trail], tmp)
        T.encode(tmp, d / f"{i}.mp3", "48k")
        if n % 300 == 0:
            print(f"  編碼 {n}/{len(todo)}", flush=True)

    for d in groups:
        n = len(list(d.glob("*.mp3")))
        mb = sum(p.stat().st_size for p in d.glob("*.mp3")) / 1024 / 1024
        print(f"完成 {d.name}/ {n} 個檔，{mb:.1f} MB")


if __name__ == "__main__":
    main()
