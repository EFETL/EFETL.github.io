# -*- coding: utf-8 -*-
"""從 gsat-cloze-vocab.html 抽出 30 回單字 → words.json（保留原本的回次分組）。

同一回的兩篇課文合併並去重；跨回重複出現的字保留（等於自然的間隔複習）。
另輸出 rounds.json 記錄每回字數，供之後改寫 App 的 ROUNDS 用。
"""
import json, pathlib, re

SITE = pathlib.Path.home() / "Downloads" / "efetl-deploy"
SP = pathlib.Path(__file__).resolve().parent

POS_MAP = {
    "n": "n", "v": "v", "adj": "adj", "adv": "adv", "prep": "prep",
    "conj": "conj", "pron": "pron", "aux": "aux", "int": "int", "art": "art",
    "det": "adj", "prop": "pron",
}


def norm_pos(vp):
    """'adj.' -> 'adj'；'n./v.' -> 'n'；'v./n.' -> 'v'。"""
    first = vp.split("/")[0].strip().rstrip(".").lower()
    return POS_MAP.get(first, "n")


def strip_tags(s):
    return re.sub(r"<[^>]+>", "", s).strip()


def main():
    html = (SITE / "gsat-cloze-vocab.html").read_text(encoding="utf-8")

    sections = re.findall(
        r'<section class="round[^"]*" data-no="(\d+)">(.*?)</section>', html, re.S
    )
    if len(sections) != 30:
        raise SystemExit(f"!! 預期 30 個 section，實際 {len(sections)}")

    # 單字項目（不含 class="vi ph" 片語），vw 前可能夾著播放鈕
    item_re = re.compile(
        r'<div class="vi">(?:(?!<div).)*?<span class="vw">(.*?)</span>'
        r'<span class="vp">(.*?)</span><span class="vz">(.*?)</span>',
        re.S,
    )

    words, rounds = [], []
    for no, body in sections:
        seen, n_before = set(), len(words)
        for vw, vp, vz in item_re.findall(body):
            w, pos, zh = strip_tags(vw), strip_tags(vp), strip_tags(vz)
            key = w.lower()
            if not w or key in seen:
                continue
            seen.add(key)
            words.append({"w": w, "pos": norm_pos(pos), "zh": zh})
        rounds.append({"no": int(no), "start": n_before, "end": len(words)})

    json.dump(words, open(SP / "words.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=0)
    json.dump(rounds, open(SP / "rounds.json", "w", encoding="utf-8"), indent=0)

    sizes = [r["end"] - r["start"] for r in rounds]
    print(f"共 {len(words)} 筆（含跨回重複），30 回")
    print("每回字數：", sizes)
    print(f"最少 {min(sizes)} 字、最多 {max(sizes)} 字")
    uniq = len({w['w'].lower() for w in words})
    print(f"不重複單字：{uniq}")


if __name__ == "__main__":
    main()
