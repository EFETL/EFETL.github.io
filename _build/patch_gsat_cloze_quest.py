# -*- coding: utf-8 -*-
"""改寫 build_app.py 產出的闖關 App：
1) ROUNDS 改成原本克漏字的 30 回邊界（不用平均切），並帶上每回主題。
2) 回數卡／回次標題顯示主題，而不是「首字—末字」。
3) speak() 換成站上共用的微軟 Edge TTS 預錄音檔（tts-audio/），沿用
   _build/patch_vocab_pages.py 同一套播放邏輯，找不到音檔才退回瀏覽器語音。
"""
import json, pathlib, re, sys

SP = pathlib.Path(__file__).resolve().parent
SITE = pathlib.Path.home() / "Downloads" / "efetl-deploy"
BUILD = SITE / "_build"
sys.path.insert(0, str(BUILD))
from patch_vocab_pages import PLAYER  # 站上既有的播放器程式碼

APP = SP / "gsat-cloze-quest.html"


def themes():
    html = (SITE / "gsat-cloze-vocab.html").read_text(encoding="utf-8")
    out = re.findall(r'<div class="rtheme">主題：(.*?)</div>', html)
    if len(out) != 30:
        raise SystemExit(f"!! 預期 30 個主題，實際 {len(out)}")
    return out


def main():
    h = APP.read_text(encoding="utf-8")
    rounds = json.load(open(SP / "rounds.json", encoding="utf-8"))
    ths = themes()

    # --- 1) ROUNDS：改成克漏字原本的回次邊界，加上主題 t ---
    new_rounds = json.dumps(
        [{"s": r["start"], "e": r["end"], "t": t} for r, t in zip(rounds, ths)],
        ensure_ascii=False, separators=(",", ":"),
    )
    h, n = re.subn(r'const ROUNDS = \[.*?\];', f'const ROUNDS = {new_rounds};', h, count=1, flags=re.S)
    if n != 1:
        raise SystemExit("!! 找不到 ROUNDS 陣列")

    # --- 2) 回數卡與回次標題改顯示主題 ---
    old_card = '      <div class="rng">${first} — ${last}</div>'
    if old_card not in h:
        raise SystemExit("!! 找不到回數卡的字範圍列")
    h = h.replace(old_card, '      <div class="rng">${r.t}</div>')

    old_range = ("document.getElementById('roundRange').textContent="
                 "`${WORDS[r.s].w} … ${WORDS[r.e-1].w}　共 ${r.e-r.s} 字`;")
    if old_range not in h:
        raise SystemExit("!! 找不到 roundRange")
    h = h.replace(old_range,
                  "document.getElementById('roundRange').textContent="
                  "`${r.t}　共 ${r.e-r.s} 字`;")

    # first/last 已無人使用，移掉避免誤導
    h = h.replace('    const first=WORDS[r.s].w, last=WORDS[r.e-1].w;\n', '')

    # 主題是整句英文，不能像原本單字那樣 break-all（會把 Bilingualism 拆成兩截）
    h = h.replace('.rc .rng{font-size:18px;font-weight:700;margin:3px 0 2px;'
                  'color:var(--primary-d);word-break:break-all}',
                  '.rc .rng{font-size:18px;font-weight:700;margin:3px 0 2px;'
                  'color:var(--primary-d);overflow-wrap:break-word;line-height:1.35}')

    # --- 3) 發音改用微軟預錄音檔 ---
    if "AUDIO_BASE" in h:
        print("已經有 AUDIO_BASE，略過發音改寫")
    else:
        a = h.index("/* ---------- speech ---------- */")
        b = h.index("/* ---------- helpers ---------- */")
        block = "function __sayText(t){return t;}\nconst __RATE=.9;\n" + PLAYER
        h = h[:a] + block + "\n" + h[b:]

    # 原本 backToRound 只 cancel 瀏覽器語音，改成一併停掉音檔
    h = h.replace("function backToRound(){speechSynthesis&&speechSynthesis.cancel();openRound(curRound);}",
                  "function backToRound(){stopSpeak();openRound(curRound);}")

    APP.write_text(h, encoding="utf-8")
    print("已改寫", APP)
    print("回次邊界：", [(r["start"], r["end"]) for r in rounds][:3], "...")


if __name__ == "__main__":
    main()
