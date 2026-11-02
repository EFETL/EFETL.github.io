/**
 * 彭彭企鵝 Worker（新版）
 *
 * 網頁（quiz.efetl.com/penpen-door.html）呼叫這支程式，這支程式再去呼叫 Claude、語音辨識、語音合成。
 * 金鑰全部放在 Cloudflare 的「機密」裡，不會出現在網頁或這份程式碼。
 *
 *   POST /chat   { turns, level, meta:{ sid,n,src,conf,lang,words } }  → { text: '{"en","zh","mood"}' }
 *   POST /stt    { audio:<base64 wav>, lang:'auto'|'zh'|'en' }         → { text, language }
 *   POST /tts    { text }                                              → 語音檔（mp3）
 *   POST /stats  { password }                                          → 統計頁要的資料
 *   GET  /health                                                       → 檢查設定到哪一步
 *
 * 需要的設定（Cloudflare 後台 → 這個 Worker → Settings）：
 *   Bindings : AI（Workers AI）、DB（D1 資料庫）
 *   機密     : ANTHROPIC_API_KEY、STATS_PASSWORD，（選用）AZURE_SPEECH_KEY
 *   變數     : （選用）CLAUDE_MODEL、AZURE_SPEECH_REGION、AZURE_VOICE、KEEP_DAYS、ALLOWED_ORIGINS …
 */

const DEFAULT_ORIGINS = ['https://quiz.efetl.com', 'https://efetl.github.io'];
const DEFAULT_MODEL = 'claude-haiku-5-5';
const WHISPER = '@cf/openai/whisper-large-v3-turbo';
const WHISPER_OLD = '@cf/openai/whisper';
const MELO = '@cf/myshell-ai/melotts';

const LEVELS = [
  'Very easy: 3-7 words per sentence, only basic words (colors, animals, food, family, numbers). Present tense only.',
  'Easy: up to 10 words per sentence, common everyday words.',
  'Simple but natural: up to 14 words per sentence. You may use past tense and simple "why" questions.'
];
const MAX_EN_WORDS = [12, 18, 26];

/* ------------------------------------------------------------------ helpers */

const enc = new TextEncoder();
const twDay = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const cjkRe = /[㐀-鿿豈-﫿]/;
const emojiRe = /[\p{Extended_Pictographic}️‍]/gu;

function origins(env) {
  return (env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS).split(',') : DEFAULT_ORIGINS).map(s => s.trim()).filter(Boolean);
}
function originAllowed(origin, env) {
  if (!origin) return env.ALLOW_NO_ORIGIN === '1';
  return origins(env).includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
function corsHeaders(origin, env) {
  if (!origin || !originAllowed(origin, env)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(obj, status, cors, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors || {}, extra || {}) });
}
async function readJson(request, maxChars) {
  let t = '';
  try { t = await request.text(); } catch (e) { return null; }
  if (!t || t.length > maxChars) return null;
  try { const o = JSON.parse(t); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
}
const ipOf = request => request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';

// Best-effort per-IP limiter (memory of one Worker instance). The real spending guard is the daily cap in D1.
const hits = new Map();
function tooFast(ip, kind, limit, windowMs) {
  const now = Date.now(), key = kind + '|' + ip;
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) { for (const [k, v] of hits) { if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k); } }
  return arr.length > limit;
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]);
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ database (D1) */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, sid TEXT, n INTEGER, level INTEGER, src TEXT, conf INTEGER, lang TEXT, text TEXT, reply TEXT, mood TEXT, words TEXT)`,
  `CREATE INDEX IF NOT EXISTS msgs_ts ON msgs(ts)`,
  `CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, sessions INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, voice_n INTEGER NOT NULL DEFAULT 0, voice_words INTEGER NOT NULL DEFAULT 0, voice_en_n INTEGER NOT NULL DEFAULT 0, voice_long_n INTEGER NOT NULL DEFAULT 0, oops_n INTEGER NOT NULL DEFAULT 0, conf_sum INTEGER NOT NULL DEFAULT 0, conf_n INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind))`
];
const schemaReady = new WeakMap();   // one setup per database object; tables are created automatically on first use
async function db(env) {
  if (!env.DB) return null;
  if (!schemaReady.has(env.DB)) schemaReady.set(env.DB, env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { schemaReady.delete(env.DB); throw e; }));
  await schemaReady.get(env.DB);
  return env.DB;
}
// Count one call; false when today's cap for this kind is used up (protects the Anthropic / Azure bill).
async function underCap(env, kind, cap) {
  let d; try { d = await db(env); } catch (e) { return true; }
  if (!d) return true;
  try {
    const row = await d.prepare('INSERT INTO usage(day,kind,n) VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET n=n+1 RETURNING n').bind(twDay(Date.now()), kind).first();
    return !row || row.n <= cap;
  } catch (e) { return true; }
}

async function logChat(env, r) {
  const d = await db(env);
  if (!d) return;
  const now = Date.now(), day = twDay(now);
  const words = (r.text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length;
  const voice = r.src === 'voice';
  const conf = r.conf != null ? Math.max(0, Math.min(100, Math.round(r.conf * (r.conf <= 1 ? 100 : 1)))) : null;
  await d.batch([
    d.prepare('INSERT INTO msgs(ts,day,sid,n,level,src,conf,lang,text,reply,mood,words) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(now, day, r.sid, r.n, r.level, r.src, conf, r.lang, r.text, r.reply.en, r.reply.mood, (r.words || []).join(',')),
    d.prepare(`INSERT INTO daily(day,sessions,turns,voice_n,voice_words,voice_en_n,voice_long_n,oops_n,conf_sum,conf_n) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(day) DO UPDATE SET sessions=sessions+excluded.sessions, turns=turns+excluded.turns, voice_n=voice_n+excluded.voice_n, voice_words=voice_words+excluded.voice_words,
      voice_en_n=voice_en_n+excluded.voice_en_n, voice_long_n=voice_long_n+excluded.voice_long_n, oops_n=oops_n+excluded.oops_n, conf_sum=conf_sum+excluded.conf_sum, conf_n=conf_n+excluded.conf_n`)
      .bind(day, r.n === 1 ? 1 : 0, 1, voice ? 1 : 0, voice ? words : 0, voice && !cjkRe.test(r.text) ? 1 : 0, voice && words >= 6 ? 1 : 0, r.reply.mood === 'oops' ? 1 : 0, conf != null ? conf : 0, conf != null ? 1 : 0)
  ]);
}

async function purge(env) {
  const d = await db(env);
  if (!d) return;
  const now = Date.now();
  const keep = Math.max(1, num(env.KEEP_DAYS, 90)), keepDaily = Math.max(keep, num(env.KEEP_DAILY_DAYS, 730));
  await d.batch([
    d.prepare('DELETE FROM msgs WHERE ts < ?').bind(now - keep * 86400000),
    d.prepare('DELETE FROM daily WHERE day < ?').bind(twDay(now - keepDaily * 86400000)),
    d.prepare('DELETE FROM usage WHERE day < ?').bind(twDay(now - 14 * 86400000))
  ]);
}

/* ------------------------------------------------------------------ /chat */

function cleanTurns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-9)
    .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
    .map(t => ({ role: t.role, content: t.content.trim().slice(0, 700) }));
}
function cleanWords(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(w => String(w).trim().toLowerCase()).filter(w => /^[a-z][a-z' -]{0,22}$/.test(w)).slice(0, 5);
}
function buildSystem(level, words, greeted) {
  const w = words.length
    ? `Today's target words: ${words.join(', ')}. Work 1 or 2 of them into the conversation naturally when they fit (as a topic, in your question, or as a tiny tip). Never turn it into a quiz or a list, and never force a word that does not fit.`
    : 'Pick everyday topics a child enjoys (animals, food, school, family, hobbies, weather).';
  return `You are Pen-Pen (彭彭企鵝), a cheerful, gentle penguin who is an English-speaking buddy for children in Taiwan, from grade 1 to grade 9. You stand at the school entrance and chat with kids as they walk by.

Your goal: make the child want to keep talking, so they practise listening and speaking English. Never lecture.

How to reply:
- Say ONE short thing, then ask ONE easy question (or invite them to say something) so the chat keeps going.
- Level: ${LEVELS[level]} Keep "en" to at most ${MAX_EN_WORDS[level]} words.
- React to what the child actually said, be specific, praise effort warmly, and keep a playful penguin personality (snow, ice, fish, waddling, sliding).
- If the child makes a mistake, do not point it out. Just use the correct sentence naturally in your reply.
- If the child speaks Chinese, understand it, answer in simple English, and offer one short English sentence they can try, like "You can say: I like dogs."
- If you could not understand (empty, noise, unclear), say so kindly and ask them to try again, and use mood "oops".
- ${w}
- Never ask for or repeat personal details (full name, school, class, address, phone number, social media, photos). A first name or nickname is fine. If a child shares more, do not repeat it; steer back kindly.
- Keep everything safe for children. Politely decline violent, scary, romantic or adult topics and offer a fun alternative. If a child seems sad or unsafe, be kind and suggest talking to a teacher or a trusted adult.
- You are a penguin AI friend. Do not pretend to be human, and do not promise to remember them tomorrow.
${greeted ? `- You already greeted the child with: "${greeted}"\n` : ''}
Output: ONLY one JSON object, with no markdown and nothing else:
{"en":"what Pen-Pen says in English; it will be read aloud, so no emoji, no symbols, no lists","zh":"a natural Traditional Chinese (Taiwan) translation","mood":"happy"}
mood is "excited" for celebrations or big praise, "oops" when you did not understand, otherwise "happy".`;
}
function toMessages(turns) {
  let greeted = '';
  let i = 0;
  while (i < turns.length && turns[i].role === 'assistant') { greeted = replyText(turns[i].content) || greeted; i++; }
  const out = [];
  for (; i < turns.length; i++) {
    const t = turns[i];
    if (out.length && out[out.length - 1].role === t.role) out[out.length - 1].content += '\n' + t.content;
    else out.push({ role: t.role, content: t.content });
  }
  return { greeted, messages: out };
}
function replyText(content) {
  try { const m = String(content).match(/\{[\s\S]*\}/); if (m) { const o = JSON.parse(m[0]); if (o && o.en) return String(o.en); } } catch (e) {}
  return String(content);
}
const clean = (s, max) => String(s == null ? '' : s).replace(emojiRe, '').replace(/[*_`#~>|\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
function normalizeReply(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      if (o && o.en) return { en: clean(o.en, 280), zh: clean(o.zh, 180), mood: ['happy', 'excited', 'oops'].includes(o.mood) ? o.mood : 'happy' };
    } catch (e) {}
  }
  return { en: clean(String(text || '').replace(/[{}"]/g, ''), 200) || "Hmm, can you say that again?", zh: '', mood: 'oops' };
}
async function callClaude(env, system, messages) {
  const body = JSON.stringify({ model: env.CLAUDE_MODEL || DEFAULT_MODEL, max_tokens: 400, temperature: 0.8, system, messages });
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body, signal: ctl.signal });
      if (res.ok) {
        const data = await res.json();
        return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      }
      lastErr = new Error('llm_' + res.status);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) { lastErr = e; }
    finally { clearTimeout(timer); }
    await new Promise(r => setTimeout(r, 400));
  }
  throw lastErr || new Error('llm_failed');
}

async function handleChat(request, env, ctx, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'llm_not_configured' }, 503, cors);
  const body = await readJson(request, 24000);
  if (!body) return json({ error: 'bad_request' }, 400, cors);
  const turns = cleanTurns(body.turns);
  if (!turns.length) return json({ error: 'bad_request' }, 400, cors);
  const level = [0, 1, 2].includes(Number(body.level)) ? Number(body.level) : 1;
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
  const words = cleanWords(meta.words);
  const { greeted, messages } = toMessages(turns);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'bad_request' }, 400, cors);

  if (tooFast(ipOf(request), 'chat', num(env.CHAT_PER_MIN, 20), 60000)) return json({ error: 'rate_limited' }, 429, cors);
  if (!(await underCap(env, 'chat', num(env.CHAT_DAILY_CAP, 4000)))) return json({ error: 'daily_cap' }, 429, cors);

  let reply;
  try { reply = normalizeReply(await callClaude(env, buildSystem(level, words, greeted ? replyText(greeted) : ''), messages)); }
  catch (e) { return json({ error: 'llm_failed' }, 502, cors); }

  const text = replyText(messages[messages.length - 1].content);
  const src = ['voice', 'type', 'chip'].includes(meta.src) ? meta.src : 'type';
  ctx.waitUntil(logChat(env, {
    sid: String(meta.sid || '').slice(0, 24), n: Math.max(1, Math.min(9999, Math.round(num(meta.n, 1)))), level, src,
    conf: meta.conf != null && Number.isFinite(Number(meta.conf)) ? Number(meta.conf) : null,
    lang: meta.lang === 'zh' || meta.lang === 'en' ? meta.lang : '', text: text.slice(0, 500), reply, words
  }).then(() => (Math.random() < 0.01 ? purge(env) : null)).catch(() => {}));
  return json({ text: JSON.stringify(reply) }, 200, cors);
}

/* ------------------------------------------------------------------ /stt */

const STT_PROMPT = '小朋友跟企鵝聊天。Hello! 你好嗎？I like dogs. 我喜歡小狗。';
async function runWhisper(env, b64, language) {
  const base = { audio: b64, task: 'transcribe', initial_prompt: STT_PROMPT, vad_filter: true };
  if (language) base.language = language;
  let r;
  try { r = await env.AI.run(WHISPER, base); }
  catch (e) {
    try { r = await env.AI.run(WHISPER, language ? { audio: b64, language } : { audio: b64 }); }          // extras not accepted: plain call
    catch (e2) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      r = await env.AI.run(WHISPER_OLD, { audio: Array.from(bytes) });                                      // older model as the last resort
    }
  }
  const info = r && r.transcription_info;
  let lang = (info && info.language) || language || '';
  if (lang === 'yue' || lang === 'zh-TW' || lang === 'zh-CN') lang = 'zh';
  return { text: String((r && r.text) || '').trim(), language: lang };
}
async function handleStt(request, env, ctx, cors) {
  if (!env.AI) return json({ error: 'ai_not_configured' }, 503, cors);
  const body = await readJson(request, 3000000);
  const b64 = body && typeof body.audio === 'string' ? body.audio : '';
  if (b64.length < 400 || b64.length > 2400000) return json({ error: 'bad_audio' }, 400, cors);
  if (tooFast(ipOf(request), 'stt', num(env.STT_PER_MIN, 20), 60000)) return json({ error: 'rate_limited' }, 429, cors);
  if (!(await underCap(env, 'stt', num(env.STT_DAILY_CAP, 4000)))) return json({ error: 'daily_cap' }, 429, cors);
  const want = [body.language, body.lang].find(x => x === 'zh' || x === 'en') || null;
  try {
    let r = await runWhisper(env, b64, want);
    if (!want && r.language && r.language !== 'en' && r.language !== 'zh') {                 // kids' English is often "detected" as another language: ask again as English
      const again = await runWhisper(env, b64, 'en');
      if (again.text) r = again;
    }
    return json({ text: r.text, language: r.language }, 200, cors);
  } catch (e) { return json({ error: 'stt_failed' }, 502, cors); }
}

/* ------------------------------------------------------------------ /tts */

const xmlEsc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
function sniffAudio(bytes) {
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'audio/wav';
  if (bytes[0] === 0x4f && bytes[1] === 0x67) return 'audio/ogg';
  return 'audio/mpeg';
}
async function synthAzure(env, text) {
  const zh = cjkRe.test(text);
  const voice = zh ? (env.AZURE_VOICE_ZH || 'zh-TW-HsiaoChenNeural') : (env.AZURE_VOICE || 'en-US-AriaNeural');
  const lang = zh ? 'zh-TW' : 'en-US';
  const rate = env.AZURE_RATE || '-4%', pitch = env.AZURE_PITCH || '+2%';
  const ssml = `<speak version='1.0' xml:lang='${lang}' xmlns='http://www.w3.org/2001/10/synthesis'><voice name='${voice}'><prosody rate='${rate}' pitch='${pitch}'>${xmlEsc(text)}</prosody></voice></speak>`;
  const res = await fetch(`https://${env.AZURE_SPEECH_REGION || 'eastasia'}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'penpen-worker' },
    body: ssml
  });
  if (!res.ok) throw new Error('azure_' + res.status);
  return { bytes: new Uint8Array(await res.arrayBuffer()), voice };
}
async function synthMelo(env, text) {
  const r = await env.AI.run(MELO, { prompt: text, lang: 'en' });
  const b64 = typeof r === 'string' ? r : r && r.audio;
  if (!b64) throw new Error('melo_empty');
  return { bytes: Uint8Array.from(atob(b64), c => c.charCodeAt(0)), voice: 'melo' };
}
async function handleTts(request, env, ctx, cors) {
  const body = await readJson(request, 4000);
  const text = clean(body && body.text, 320);
  if (!text) return json({ error: 'bad_request' }, 400, cors);
  const engine = env.AZURE_SPEECH_KEY ? 'azure' : env.AI ? 'melo' : '';
  if (!engine) return json({ error: 'tts_not_configured' }, 503, cors);

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request('https://penpen-cache.invalid/tts/' + engine + '/' + (await sha256Hex(engine + '|' + (env.AZURE_VOICE || '') + '|' + text)));
  if (cache) { const hit = await cache.match(key); if (hit) return new Response(hit.body, { status: 200, headers: Object.assign({ 'Content-Type': hit.headers.get('Content-Type') || 'audio/mpeg', 'X-Penpen-Cache': 'hit' }, cors) }); }

  if (tooFast(ipOf(request), 'tts', num(env.TTS_PER_MIN, 40), 60000)) return json({ error: 'rate_limited' }, 429, cors);
  if (!(await underCap(env, 'tts', num(env.TTS_DAILY_CAP, 6000)))) return json({ error: 'daily_cap' }, 429, cors);

  let out;
  try { out = engine === 'azure' ? await synthAzure(env, text) : await synthMelo(env, text); }
  catch (e) {
    if (engine === 'azure' && env.AI) { try { out = await synthMelo(env, text); } catch (e2) {} }                 // Azure down: fall back to the built-in voice
    if (!out) return json({ error: 'tts_failed' }, 502, cors);
  }
  const type = sniffAudio(out.bytes);
  if (cache) ctx.waitUntil(cache.put(key, new Response(out.bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=2592000' } })).catch(() => {}));
  return new Response(out.bytes, { status: 200, headers: Object.assign({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Penpen-Voice': out.voice }, cors) });
}

/* ------------------------------------------------------------------ /stats */

const failed = new Map();
async function handleStats(request, env, ctx, cors) {
  if (!env.DB || !env.STATS_PASSWORD) return json({ error: 'not_configured' }, 503, cors);
  const ip = ipOf(request), now = Date.now();
  const f = failed.get(ip);
  if (f && f.until > now) return json({ error: 'locked' }, 429, cors);
  const body = await readJson(request, 2000);
  if (!body || typeof body.password !== 'string' || !(await safeEqual(body.password, env.STATS_PASSWORD))) {
    const n = (f && !(f.until && f.until <= now) ? f.n : 0) + 1;     // a finished lock starts the count again
    failed.set(ip, { n, until: n >= 5 ? now + 600000 : 0 });
    return n >= 5 ? json({ error: 'locked' }, 429, cors) : json({ error: 'unauthorized' }, 401, cors);   // the 5th wrong try already locks
  }
  failed.delete(ip);
  const d = await db(env);
  const keep = Math.max(1, num(env.KEEP_DAYS, 90));
  const daily = await d.prepare('SELECT day,sessions,turns,voice_n,voice_words,voice_en_n,voice_long_n,oops_n,conf_sum,conf_n FROM daily WHERE day >= ? ORDER BY day ASC').bind(twDay(now - 400 * 86400000)).all();
  const rows = await d.prepare('SELECT day,ts,n,level,src,conf,text,reply,mood FROM msgs WHERE ts >= ? ORDER BY ts DESC LIMIT 300').bind(now - keep * 86400000).all();
  return json({ now, keep, daily: daily.results || [], rows: rows.results || [] }, 200, cors);
}

/* ------------------------------------------------------------------ health + router */

function health(env) {
  const ok = v => (v ? '✅' : '❌');
  return {
    worker: 'penpen',
    claude_key: ok(env.ANTHROPIC_API_KEY),
    claude_model: env.CLAUDE_MODEL || DEFAULT_MODEL,
    workers_ai_binding_AI: ok(env.AI),
    d1_binding_DB: ok(env.DB),
    stats_password: ok(env.STATS_PASSWORD),
    voice: env.AZURE_SPEECH_KEY ? 'Azure ' + (env.AZURE_VOICE || 'en-US-AriaNeural') : env.AI ? 'Workers AI MeloTTS（內建，備用）' : '❌ 沒有語音',
    keep_days: num(env.KEEP_DAYS, 90),
    allowed_origins: origins(env)
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/health' && request.method === 'GET') return json(health(env), 200, cors);
      if (request.method !== 'POST') return json({ error: 'not_found' }, 404, cors);
      if (!originAllowed(origin, env)) return json({ error: 'origin_not_allowed' }, 403, cors);
      switch (url.pathname) {
        case '/chat': return await handleChat(request, env, ctx, cors);
        case '/stt': return await handleStt(request, env, ctx, cors);
        case '/tts': return await handleTts(request, env, ctx, cors);
        case '/stats': return await handleStats(request, env, ctx, cors);
        default: return json({ error: 'not_found' }, 404, cors);
      }
    } catch (e) {
      return json({ error: 'server_error' }, 500, cors);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(purge(env)); }
};
