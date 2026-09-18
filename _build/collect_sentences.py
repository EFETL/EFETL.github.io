# -*- coding: utf-8 -*-
"""盤點還在用瀏覽器語音的「句子類」頁面，列出每頁要出聲的英文內容。

輸出 sentences.json： {頁面: {音檔id: 要唸的文字}}
音檔 id 用 md5 前 10 碼，沿用站上 tongce-cloze-vocab 既有的命名慣例
（句子太長，不適合像單字那樣用 slug 當檔名）。
"""
import hashlib, html as H, json, pathlib, re, sys

SITE = pathlib.Path(__file__).resolve().parent.parent


def aid(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:10]


def js_unescape(s):
    return s.replace("\\'", "'").replace('\\"', '"').replace("\\\\", "\\")


def tongce_analysis():
    """語音文字放在 data-say 屬性裡，40 頁共用一個音檔目錄。"""
    out = {}
    for f in sorted(SITE.glob("tongce-analysis-*.html")):
        h = f.read_text(encoding="utf-8")
        out[f.name] = {aid(t): t for t in
                       (H.unescape(x) for x in re.findall(r'data-say="([^"]*)"', h))
                       if t.strip()}
    return out


def gsat_vocab():
    """唸的是選項裡的英文字：opts 形如 "seasonal 季節性的"，只取前面的英文。"""
    f = SITE / "gsat-vocab.html"
    h = f.read_text(encoding="utf-8")
    words = set()
    for m in re.finditer(r'opts\s*:\s*\[([^\]]*)\]', h):
        for o in re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1)):
            w = js_unescape(o).split(" ")[0].strip()
            if w:
                words.add(w)
    return {f.name: {aid(w): w for w in sorted(words)}}


def tongce_vocab():
    """唸的是：每個選項，以及把空格填上正確答案後的完整句子。"""
    f = SITE / "tongce-vocab.html"
    h = f.read_text(encoding="utf-8")
    texts = set()
    for m in re.finditer(
            r"\{\s*q\s*:\s*'((?:[^'\\]|\\.)*)'.*?opts\s*:\s*\[([^\]]*)\].*?ans\s*:\s*(\d+)",
            h, re.S):
        q = js_unescape(m.group(1))
        opts = [js_unescape(o) for o in re.findall(r"'((?:[^'\\]|\\.)*)'", m.group(2))]
        ans = int(m.group(3))
        texts.update(o for o in opts if o.strip())
        if 0 <= ans < len(opts):
            texts.add(q.replace("_______", opts[ans]))
    return {f.name: {aid(t): t for t in sorted(texts)}}


def speaking_gaps():
    """speaking 頁絕大多數已經有音檔，只補 AUDIO_MAP / MODEL_MAP 沒涵蓋到的。"""
    def jmap(h, name):
        m = re.search(name + r'\s*=\s*(\{.*?\})\s*;', h, re.S)
        if not m:
            return {}
        try:
            return json.loads(m.group(1))
        except Exception:
            return {}

    out = {}
    for f in sorted(SITE.glob("speaking*.html")):
        h = f.read_text(encoding="utf-8")
        if "SpeechSynthesisUtterance" not in h:
            continue
        covered = set(jmap(h, "AUDIO_MAP")) | set(jmap(h, "MODEL_MAP"))
        gaps = {}
        for raw in re.findall(r'\bmodel\s*:\s*"((?:[^"\\]|\\.)*)"', h):
            t = js_unescape(raw)
            if t not in covered and raw not in covered:
                gaps[aid(t)] = t
        if gaps:
            out[f.name] = gaps
    return out


def main():
    all_ = {}
    for fn in (tongce_analysis, gsat_vocab, tongce_vocab, speaking_gaps):
        part = fn()
        for k, v in part.items():
            if v:
                all_[k] = v
        n = sum(len(v) for v in part.values())
        print(f"  {fn.__name__:<18} {len(part)} 頁，{n} 段語音")

    uniq = {}
    for page in all_.values():
        uniq.update(page)
    print(f"\n合計 {len(all_)} 頁；去重後要產 {len(uniq)} 個音檔")
    (SITE / "_build" / "sentences.json").write_text(
        json.dumps(all_, ensure_ascii=False, indent=1), encoding="utf-8")
    print("清單已寫到 _build/sentences.json")


if __name__ == "__main__":
    main()
