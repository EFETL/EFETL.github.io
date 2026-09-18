# -*- coding: utf-8 -*-
"""把四本單字表的 speak() 換成「先播微軟音檔、找不到才退回瀏覽器語音」。

四頁的 speak() 寫法不完全一樣，所以逐頁處理，但共用同一套播放邏輯與
同一個音檔目錄 tts-audio/。每頁的既有行為都保留：
  - elementary-1200 原本會把括號換成空白再唸（slug 已經會去掉括號，效果相同）
  - g9-vocab-unit1 原本的 sayText()（a.m. → A M、a/b → a or b）保留給退路用，
    音檔本身也是照 sayText() 的結果合成的
"""
import pathlib, re, sys

SITE = pathlib.Path(__file__).resolve().parent.parent

PLAYER = '''/* ---------- speech：微軟 Edge TTS（en-US-AriaNeural）預錄音檔，找不到才退回瀏覽器語音 ---------- */
const AUDIO_BASE='tts-audio/';
function audioSlug(t){return String(t).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');}
let VOICE=null;
function pickVoice(){
  if(!('speechSynthesis' in window))return;
  const vs=speechSynthesis.getVoices();
  VOICE = vs.find(v=>/^en/i.test(v.lang)&&/Microsoft/i.test(v.name)&&/Natural|Online|Aria|Jenny/i.test(v.name))
       || vs.find(v=>/^en/i.test(v.lang)&&/Microsoft/i.test(v.name))
       || vs.find(v=>/en-US/i.test(v.lang)&&/female|Samantha|Google US/i.test(v.name))
       || vs.find(v=>/en-US/i.test(v.lang))
       || vs.find(v=>/^en/i.test(v.lang)) || null;
}
if('speechSynthesis' in window){ pickVoice(); speechSynthesis.onvoiceschanged=pickVoice; }
/* iOS/Safari 需要在使用者手勢中先「解鎖」音訊，之後 setTimeout 內的播放才會有聲音 */
let __player=null, __voiceUnlocked=false, __sq=0;
function ensurePlayer(){ if(!__player){ __player=new Audio(); __player.preload='auto'; } return __player; }
function unlockVoice(){
  if(__voiceUnlocked) return;
  __voiceUnlocked=true;
  try{ const p=ensurePlayer(); p.src=AUDIO_BASE+'unlock-silence.mp3'; const r=p.play(); if(r&&r.catch)r.catch(function(){}); }catch(e){}
  try{ if('speechSynthesis' in window){ if(!VOICE)pickVoice(); const u=new SpeechSynthesisUtterance(' '); u.volume=0; speechSynthesis.speak(u); } }catch(e){}
}
document.addEventListener('pointerdown', unlockVoice, true);
document.addEventListener('touchstart', unlockVoice, {capture:true, passive:true});
document.addEventListener('click', unlockVoice, true);
function speakTTS(text){
  if(!('speechSynthesis' in window))return;
  try{ if(speechSynthesis.paused)speechSynthesis.resume(); }catch(e){}
  speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(__sayText(text));
  u.lang='en-US'; u.rate=__RATE; if(VOICE)u.voice=VOICE;
  speechSynthesis.speak(u);
}
function stopSpeak(){ __sq++; try{ if(__player)__player.pause(); }catch(e){} try{ if('speechSynthesis' in window)speechSynthesis.cancel(); }catch(e){} }
function speak(text){
  const slug=audioSlug(text); if(!slug)return;
  const my=++__sq; let fell=false;
  function fallback(){ if(!fell && my===__sq){ fell=true; speakTTS(text); } }
  try{ if('speechSynthesis' in window)speechSynthesis.cancel(); }catch(e){}
  const p=ensurePlayer();
  try{ p.pause(); }catch(e){}
  p.onerror=fallback;
  p.src=AUDIO_BASE+slug+'.mp3';
  const r=p.play();
  if(r&&r.catch)r.catch(function(err){ if(!(err&&err.name==='AbortError')) fallback(); });
}
'''

# 每頁：(舊 speak 區塊的起點, 終點, 退路語速, 退路的文字轉換函式)
PAGES = {
    "senior-7000.html": dict(
        start="/* ---------- speech ---------- */",
        end="/* ---------- helpers ---------- */",
        rate=".9", saytext="function __sayText(t){return t;}"),
    "junior-2000.html": dict(
        start="/* ---------- speech ---------- */",
        end="/* ---------- helpers ---------- */",
        rate=".9", saytext="function __sayText(t){return t;}"),
    "g9-vocab-unit1.html": dict(
        # 這頁沒有區塊註解，用實際的程式碼當界線
        start="let VOICE=null;",
        end="function toast(msg)",
        rate=".85",
        saytext=("function __sayText(w){const key=String(w).toLowerCase().replace(/[.\\s]/g,'');"
                 "const map={'am':'A M','pm':'P M'};if(map[key])return map[key];"
                 "return String(w).replace(/\\s*\\/\\s*/g,' or ');}")),
}


def patch_standard(name, cfg):
    p = SITE / name
    h = p.read_text(encoding="utf-8")
    if "AUDIO_BASE" in h:
        return f"{name}: 已經改過，略過"
    a, b = h.index(cfg["start"]), h.index(cfg["end"])
    block = (cfg["saytext"] + "\nconst __RATE=" + cfg["rate"] + ";\n" + PLAYER)
    h = h[:a] + block + "\n" + h[b:]
    p.write_text(h, encoding="utf-8")
    return f"{name}: 已套用"


def patch_elementary():
    """elementary-1200 的語音區塊是第 190-196 行「// ---- speech ----」到
    「// ---- helpers ----」之間，用行界線替換（這頁的函式都寫成一行，
    用正則抓 `}` 會誤吃到後面的程式）。"""
    p = SITE / "elementary-1200.html"
    lines = p.read_text(encoding="utf-8").split("\n")
    if any("AUDIO_BASE" in l for l in lines):
        return "elementary-1200.html: 已經改過，略過"
    try:
        a = next(i for i, l in enumerate(lines) if l.strip() == "// ---- speech ----")
        b = next(i for i, l in enumerate(lines) if l.strip() == "// ---- helpers ----")
    except StopIteration:
        return "elementary-1200.html: !! 找不到語音區塊界線，沒有改"

    # 原本點一下會把畫面上的語音提示淡出，這個行為要留著
    hint = ("var vh=document.getElementById('voicehint');"
            "if(vh){vh.style.transition='opacity .4s,transform .4s';vh.style.opacity='0';"
            "vh.style.transform='scale(.9)';setTimeout(function(){vh.style.display='none';},400);}")
    block = ("// ---- speech ----\n"
             "function __sayText(t){return String(t).replace(/[()]/g,' ');}\n"
             "const __RATE=.85;\n"
             + PLAYER.replace("function unlockVoice(){\n  if(__voiceUnlocked) return;",
                              "function unlockVoice(){\n  " + hint + "\n  if(__voiceUnlocked) return;"))
    lines[a:b] = block.split("\n") + [""]
    p.write_text("\n".join(lines), encoding="utf-8")
    return "elementary-1200.html: 已套用"


def main():
    for name, cfg in PAGES.items():
        print(" ", patch_standard(name, cfg))
    print(" ", patch_elementary())


if __name__ == "__main__":
    main()
