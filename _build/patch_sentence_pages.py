# -*- coding: utf-8 -*-
"""把句子類頁面的發音改成「先播微軟音檔、找不到才退回瀏覽器語音」。

三種頁面的取字方式不同，分開處理：
  tongce-analysis-*.html  文字在 data-say 屬性 → 直接在同一個元素補上 data-aid，
                          不必在頁面裡塞一張大表
  gsat-vocab.html         文字是執行時從選項算出來的 → 加一張 AUDIO_MAP
  tongce-vocab.html       同上，鍵是 ST[idx]

每頁原有的行為都保留（按鈕高亮、女聲偏好、語速）。
"""
import html as H, json, pathlib, re, sys

SITE = pathlib.Path(__file__).resolve().parent.parent
SENT = json.loads((SITE / "_build" / "sentences.json").read_text(encoding="utf-8"))


def aid_of(page):
    """回傳 {文字: 音檔id}。"""
    return {t: i for i, t in SENT.get(page, {}).items()}


# ── 統測解析 ───────────────────────────────────────────────
ANALYSIS_SPEAK = '''function speak(text,btn,ev){
  if(ev){ev.stopPropagation();}
  var aid = btn && btn.getAttribute ? btn.getAttribute('data-aid') : null;
  if(window.__au){ try{window.__au.pause();}catch(e){} window.__au=null; }
  if(window.speechSynthesis) window.speechSynthesis.cancel();
  function flash(){ if(btn && btn.textContent==='\\ud83d\\udd0a'){btn.textContent='\\ud83d\\udd09';setTimeout(function(){btn.textContent='\\ud83d\\udd0a';},700);} }
  function fallback(){
    if(!('speechSynthesis' in window)){alert('此瀏覽器不支援語音發音，建議使用 Chrome / Safari / Edge。');return;}
    var u=new SpeechSynthesisUtterance(text);
    u.lang='en-US'; u.rate=0.85; u.pitch=1;
    window.speechSynthesis.speak(u); flash();
  }
  if(!aid){ fallback(); return; }
  var a=new Audio('tongce-analysis-audio/'+aid+'.mp3');
  window.__au=a;
  a.onerror=fallback;
  var p=a.play();
  if(p&&p.catch)p.catch(function(err){ if(!(err&&err.name==='AbortError')) fallback(); });
  flash();
}'''


def patch_analysis():
    ids_all = {}
    for page in SENT:
        if page.startswith("tongce-analysis-"):
            ids_all.update(aid_of(page))
    done = 0
    for f in sorted(SITE.glob("tongce-analysis-*.html")):
        h = f.read_text(encoding="utf-8")
        if "data-aid=" in h:
            continue

        def add_aid(m):
            raw = m.group(1)
            t = H.unescape(raw)
            i = ids_all.get(t)
            return m.group(0) if not i else f'data-say="{raw}" data-aid="{i}"'

        h2 = re.sub(r'data-say="([^"]*)"', add_aid, h)
        old = re.search(r'function speak\(text,btn,ev\)\{.*?\n\}', h2, re.S)
        if not old:
            print(f"  !! {f.name} 找不到原本的 speak()，跳過")
            continue
        h2 = h2[:old.start()] + ANALYSIS_SPEAK + h2[old.end():]
        f.write_text(h2, encoding="utf-8")
        done += 1
    print(f"  統測解析：改好 {done} 頁")


# ── gsat-vocab ────────────────────────────────────────────
GSAT_SPEAK = '''function speak(word) {
  if(window.__au){ try{window.__au.pause();}catch(e){} window.__au=null; }
  if(window.speechSynthesis) window.speechSynthesis.cancel();
  var id = AUDIO_MAP[word];
  if(id){
    var a=new Audio('gsat-vocab-audio/'+id+'.mp3');
    window.__au=a;
    a.onerror=function(){ speakSynth(word); };
    var p=a.play();
    if(p&&p.catch)p.catch(function(err){ if(!(err&&err.name==='AbortError')) speakSynth(word); });
    return;
  }
  speakSynth(word);
}
function speakSynth(word) {'''


def patch_gsat():
    f = SITE / "gsat-vocab.html"
    h = f.read_text(encoding="utf-8")
    if "AUDIO_MAP" in h:
        print("  gsat-vocab：已經改過")
        return
    ids = aid_of("gsat-vocab.html")
    old = re.search(r'function speak\(word\) \{', h)
    if not old:
        print("  !! gsat-vocab 找不到 speak()")
        return
    mapjs = "const AUDIO_MAP = " + json.dumps(ids, ensure_ascii=False) + ";\n"
    h = h[:old.start()] + mapjs + GSAT_SPEAK + h[old.end():]
    f.write_text(h, encoding="utf-8")
    print(f"  gsat-vocab：改好，對應 {len(ids)} 個字")


# ── tongce-vocab ──────────────────────────────────────────
TONGCE_SPEAK = '''function speak(idx){
  try{
    if(window.__au){ try{window.__au.pause();}catch(e){} window.__au=null; }
    if(window.speechSynthesis) speechSynthesis.cancel();
    document.querySelectorAll('.spk.on,.rnd.on').forEach(b=>b.classList.remove('on'));
    const btn = document.querySelector(`[data-si="${idx}"]`);
    const text = ST[idx];
    const off = ()=>{ if(btn) btn.classList.remove('on'); };
    if(btn) btn.classList.add('on');
    function fallback(){
      try{
        if(!window.speechSynthesis){ off(); return; }
        const u = new SpeechSynthesisUtterance(text);
        u.lang='en-US'; u.rate=0.85; u.pitch=1.1; u.volume=1;
        if(fVoice) u.voice=fVoice;
        u.onend=u.onerror=off;
        speechSynthesis.speak(u);
      }catch(e){ off(); }
    }
    const id = AUDIO_MAP[text];
    if(!id){ fallback(); return; }
    const a = new Audio('tongce-vocab-audio/'+id+'.mp3');
    window.__au = a;
    a.onended = off;
    a.onerror = fallback;
    const p = a.play();
    if(p&&p.catch)p.catch(function(err){ if(!(err&&err.name==='AbortError')) fallback(); });
  }catch(e){}
}'''


def patch_tongce_vocab():
    f = SITE / "tongce-vocab.html"
    h = f.read_text(encoding="utf-8")
    if "AUDIO_MAP" in h:
        print("  tongce-vocab：已經改過")
        return
    ids = aid_of("tongce-vocab.html")
    old = re.search(r'function speak\(idx\)\{.*?\n\}', h, re.S)
    if not old:
        print("  !! tongce-vocab 找不到 speak()")
        return
    mapjs = "const AUDIO_MAP = " + json.dumps(ids, ensure_ascii=False) + ";\n"
    h = h[:old.start()] + mapjs + TONGCE_SPEAK + h[old.end():]
    f.write_text(h, encoding="utf-8")
    print(f"  tongce-vocab：改好，對應 {len(ids)} 段")


if __name__ == "__main__":
    patch_analysis()
    patch_gsat()
    patch_tongce_vocab()
