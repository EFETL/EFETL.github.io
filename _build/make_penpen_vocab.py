# -*- coding: utf-8 -*-
"""產生 penpen-vocab.json：彭彭企鵝每場對話的「目標單字」來源。

A = 國小 1200（elementary-1200.html）
B = 國中 2000 扣掉 A（junior-2000.html）
C = 全民英檢初級 扣掉 A、B（gept-elementary-vocab.html）
D = 全民英檢中級（單字檔在 intermediate.efetl.com，不在這個 repo，之後補進 penpen-vocab-d.txt，一行一個字）

只收單一英文單字（不含空格、括號的片語），全部轉小寫、去重。
    python3 _build/make_penpen_vocab.py
"""
import json, pathlib, re

SITE = pathlib.Path(__file__).resolve().parent.parent
WORD = re.compile(r"^[a-z][a-z'-]{2,}$")


def load(fname, name):
    s = (SITE / fname).read_text(encoding='utf-8')
    m = re.search(r'const ' + name + r'\s*=\s*\[', s)
    i, d = m.end() - 1, 0
    for j in range(i, len(s)):
        d += (s[j] == '[') - (s[j] == ']')
        if d == 0:
            return json.loads(s[i:j + 1])


def words(items, key):
    out, seen = [], set()
    for x in items:
        raw = str(x[key]).strip()
        w = raw.lower()
        if raw[:1].isupper():          # 專有名詞（國名、人名、星期）不當目標單字
            continue
        if WORD.match(w) and w not in seen:
            seen.add(w); out.append(w)
    return out


A = words(load('elementary-1200.html', 'DATA'), 'en')
sa = set(A)
B = [w for w in words(load('junior-2000.html', 'WORDS'), 'w') if w not in sa]
sb = sa | set(B)
C = [w for w in words(load('gept-elementary-vocab.html', 'WORDS'), 'w') if w not in sb]
sc = sb | set(C)
dfile = SITE / '_build' / 'penpen-vocab-d.txt'
D = []
if dfile.exists():
    D = [w for w in words([{'w': l} for l in dfile.read_text(encoding='utf-8').splitlines()], 'w') if w not in sc]

out = {'A': A, 'B': B, 'C': C, 'D': D}
(SITE / 'penpen-vocab.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print({k: len(v) for k, v in out.items()})
