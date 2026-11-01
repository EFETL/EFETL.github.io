// 在電腦上直接跑：node penpen-worker/test/worker.test.mjs   （不需要安裝任何東西，Node 22 以上）
// 用 Node 內建的 SQLite 假裝 D1，並把 Claude / Azure / Workers AI 換成假的，檢查 Worker 的邏輯。
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import worker from '../worker.js';

function fakeD1() {
  const sql = new DatabaseSync(':memory:');
  // 跟真的 D1 一樣：到執行的時候才檢查資料表在不在
  const stmt = q => { let args = []; const o = {
    bind(...a) { args = a; return o; },
    async run() { sql.prepare(q).run(...args); return { success: true }; },
    async first() { return sql.prepare(q).get(...args) ?? null; },
    async all() { return { results: sql.prepare(q).all(...args) }; },
    _run() { return sql.prepare(q).run(...args); }
  }; return o; };
  return { sql, prepare: stmt, async batch(list) { return list.map(x => x._run()); } };
}

const ORIGIN = 'https://quiz.efetl.com';
const ctx = { waits: [], waitUntil(p) { this.waits.push(p); }, async flush() { await Promise.all(this.waits); this.waits = []; } };
let claudeCalls = [], aiCalls = [], azureCalls = [];
const realFetch = globalThis.fetch;
let claudeReply = '{"en":"I like dogs too! Do you have a dog?","zh":"我也喜歡狗！你有養狗嗎？","mood":"happy"}';
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    claudeCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ content: [{ type: 'text', text: claudeReply }] }), { status: 200 });
  }
  if (String(url).includes('tts.speech.microsoft.com')) {
    azureCalls.push({ url: String(url), headers: init.headers, body: init.body });
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200 });
  }
  return realFetch(url, init);
};
const call = (env, path, body, { origin = ORIGIN, method = 'POST', ip = '1.1.1.1' } = {}) =>
  worker.fetch(new Request('https://penpen.example.workers.dev' + path, { method, headers: Object.assign({ 'content-type': 'application/json', 'CF-Connecting-IP': ip }, origin ? { Origin: origin } : {}), body: method === 'GET' ? undefined : JSON.stringify(body) }), env, ctx);
const mkEnv = (extra = {}) => Object.assign({ ANTHROPIC_API_KEY: 'k', STATS_PASSWORD: 'pw', DB: fakeD1(), AI: { async run(model, input) { aiCalls.push({ model, input }); return { text: 'hello there', transcription_info: { language: 'en' } }; } } }, extra);
let passed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n   ', e.message); process.exitCode = 1; } };
const reset = () => { claudeCalls = []; aiCalls = []; azureCalls = []; };

console.log('CORS / 基本');
await t('health 顯示設定狀態', async () => {
  const r = await call(mkEnv(), '/health', null, { method: 'GET' }); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.claude_key, '✅'); assert.equal(j.d1_binding_DB, '✅'); assert.match(j.voice, /MeloTTS/);
  const r2 = await call({}, '/health', null, { method: 'GET' }); const j2 = await r2.json(); assert.equal(j2.claude_key, '❌');
});
await t('允許的網域通過、其他網域與沒有 Origin 的被擋', async () => {
  const env = mkEnv();
  assert.equal((await call(env, '/chat', { turns: [{ role: 'user', content: 'hi' }] })).status, 200);
  assert.equal((await call(env, '/chat', { turns: [] }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(env, '/chat', { turns: [] }, { origin: '' })).status, 403);
  const pre = await call(env, '/chat', null, { method: 'OPTIONS' });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
});

console.log('/chat');
await t('歷史整理成 Claude 看得懂的樣子，單字帶進指示，回傳格式與舊版相同', async () => {
  reset(); const env = mkEnv();
  const turns = [{ role: 'assistant', content: JSON.stringify({ en: 'Hi! I am Pen-Pen. What is your name?', zh: '嗨', mood: 'excited' }) }, { role: 'user', content: 'I like dogs very much today' }];
  const r = await call(env, '/chat', { turns, level: 1, meta: { sid: 'abc', n: 1, src: 'voice', conf: 0.9, lang: 'en', words: ['puppy', 'bone', 'BAD WORD!!', 'x'.repeat(40)] } });
  const j = await r.json(); await ctx.flush();
  assert.equal(r.status, 200);
  const reply = JSON.parse(j.text); assert.equal(reply.mood, 'happy'); assert.match(reply.en, /dog/);
  const c = claudeCalls[0];
  assert.equal(c.messages[0].role, 'user', '第一則必須是 user');
  assert.equal(c.messages.length, 1);
  assert.match(c.system, /puppy, bone/); assert.doesNotMatch(c.system, /BAD WORD/); assert.match(c.system, /What is your name/);
  assert.equal(c.model, 'claude-haiku-5-5');
});
await t('對話與統計寫進資料庫（含企鵝回答、信心 0–100、語音統計）', async () => {
  reset(); const env = mkEnv();
  await call(env, '/chat', { turns: [{ role: 'user', content: 'I like dogs very much today' }], level: 2, meta: { sid: 's1', n: 1, src: 'voice', conf: 0.9, lang: 'en' } });
  await call(env, '/chat', { turns: [{ role: 'user', content: '我喜歡小狗' }], level: 2, meta: { sid: 's1', n: 2, src: 'voice', lang: 'zh' } });
  await ctx.flush();
  const m = env.DB.sql.prepare('SELECT * FROM msgs ORDER BY id').all();
  assert.equal(m.length, 2); assert.equal(m[0].conf, 90); assert.equal(m[0].reply.startsWith('I like dogs too'), true); assert.equal(m[0].level, 2);
  const d = env.DB.sql.prepare('SELECT * FROM daily').get();
  assert.equal(d.sessions, 1); assert.equal(d.turns, 2); assert.equal(d.voice_n, 2); assert.equal(d.voice_long_n, 1); assert.equal(d.voice_en_n, 1); assert.equal(d.conf_sum, 90); assert.equal(d.conf_n, 1);
});
await t('Claude 回得亂七八糟時：去掉表情符號與標記，仍回合法格式', async () => {
  reset(); const env = mkEnv();
  claudeReply = 'Sure! {"en":"**Wow** 🐧 that is great!","zh":"哇","mood":"super"}';
  let j = await (await call(env, '/chat', { turns: [{ role: 'user', content: 'hi' }] })).json(); let r = JSON.parse(j.text);
  assert.equal(r.en, 'Wow that is great!'); assert.equal(r.mood, 'happy');
  claudeReply = 'totally not json';
  j = await (await call(env, '/chat', { turns: [{ role: 'user', content: 'hi' }] })).json(); r = JSON.parse(j.text);
  assert.equal(r.mood, 'oops'); assert.ok(r.en.length > 0);
  claudeReply = '{"en":"I like dogs too! Do you have a dog?","zh":"我也喜歡狗！你有養狗嗎？","mood":"happy"}';
});
await t('壞請求、沒有金鑰、結尾不是 user 都會被擋', async () => {
  const env = mkEnv();
  assert.equal((await call(env, '/chat', { turns: 'x' })).status, 400);
  assert.equal((await call(env, '/chat', { turns: [{ role: 'assistant', content: 'hi' }] })).status, 400);
  assert.equal((await call(mkEnv({ ANTHROPIC_API_KEY: '' }), '/chat', { turns: [{ role: 'user', content: 'hi' }] })).status, 503);
});
await t('每日上限：超過就回 429（保護帳單）', async () => {
  const env = mkEnv({ CHAT_DAILY_CAP: '2' });
  const s = [];
  for (let i = 0; i < 3; i++) s.push((await call(env, '/chat', { turns: [{ role: 'user', content: 'hi' }] }, { ip: '9.9.9.' + i })).status);
  assert.deepEqual(s, [200, 200, 429]);
});

console.log('/stt');
const WAV = Buffer.alloc(3000, 1).toString('base64');
await t('中文自動辨識：一次就好', async () => {
  reset(); const env = mkEnv(); env.AI.run = async (m, i) => { aiCalls.push({ m, i }); return { text: '我喜歡小狗', transcription_info: { language: 'zh' } }; };
  const j = await (await call(env, '/stt', { audio: WAV, lang: 'auto' })).json();
  assert.equal(j.text, '我喜歡小狗'); assert.equal(j.language, 'zh'); assert.equal(aiCalls.length, 1); assert.equal(aiCalls[0].i.language, undefined);
  assert.match(aiCalls[0].i.initial_prompt, /你好/);
});
await t('被誤判成別的語言時，改用英文再辨識一次', async () => {
  reset(); const env = mkEnv(); let n = 0;
  env.AI.run = async (m, i) => { aiCalls.push({ m, i }); n++; return n === 1 ? { text: 'ハロー', transcription_info: { language: 'ja' } } : { text: 'hello', transcription_info: { language: 'en' } }; };
  const j = await (await call(env, '/stt', { audio: WAV, lang: 'auto' })).json();
  assert.equal(j.text, 'hello'); assert.equal(aiCalls.length, 2); assert.equal(aiCalls[1].i.language, 'en');
});
await t('指定語言時直接照辦，不重跑', async () => {
  reset(); const env = mkEnv();
  await call(env, '/stt', { audio: WAV, language: 'zh', lang: 'zh' });
  assert.equal(aiCalls.length, 1); assert.equal(aiCalls[0].input.language, 'zh');
});
await t('新模型出錯會退回舊模型；太短的聲音直接拒絕', async () => {
  reset(); const env = mkEnv(); env.AI.run = async (m, i) => { aiCalls.push({ m }); if (m.includes('turbo')) throw new Error('boom'); return { text: 'ok old' }; };
  const j = await (await call(env, '/stt', { audio: WAV, lang: 'en' })).json();
  assert.equal(j.text, 'ok old'); assert.ok(aiCalls.some(c => c.m === '@cf/openai/whisper'));
  assert.equal((await call(env, '/stt', { audio: 'abc' })).status, 400);
});

console.log('/tts');
await t('有微軟金鑰：用 Aria，並把特殊字元處理好', async () => {
  reset(); const env = mkEnv({ AZURE_SPEECH_KEY: 'az', AZURE_SPEECH_REGION: 'eastasia' });
  const r = await call(env, '/tts', { text: "Tom & Jerry <3 'fish'" });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/mpeg'); assert.equal(r.headers.get('x-penpen-voice'), 'en-US-AriaNeural');
  assert.match(azureCalls[0].body, /en-US-AriaNeural/); assert.match(azureCalls[0].body, /Tom &amp; Jerry/); assert.equal(azureCalls[0].headers['Ocp-Apim-Subscription-Key'], 'az');
  assert.match(azureCalls[0].url, /^https:\/\/eastasia\.tts\.speech\.microsoft\.com/);
});
await t('中文句子改用台灣中文聲音', async () => {
  reset(); const env = mkEnv({ AZURE_SPEECH_KEY: 'az' });
  await call(env, '/tts', { text: '你好嗎' });
  assert.match(azureCalls[0].body, /zh-TW-HsiaoChenNeural/);
});
await t('沒有微軟金鑰：用 Workers AI 的內建語音；微軟壞掉時自動退回', async () => {
  reset(); const env = mkEnv(); env.AI.run = async (m, i) => { aiCalls.push({ m, i }); return { audio: Buffer.from([0x49, 0x44, 0x33, 9]).toString('base64') }; };
  let r = await call(env, '/tts', { text: 'Hello' });
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-penpen-voice'), 'melo'); assert.equal(aiCalls[0].m, '@cf/myshell-ai/melotts');
  const saved = globalThis.fetch; globalThis.fetch = async () => new Response('x', { status: 500 });
  r = await call(mkEnv({ AZURE_SPEECH_KEY: 'az', AI: env.AI }), '/tts', { text: 'Hello again' });
  globalThis.fetch = saved; assert.equal(r.headers.get('x-penpen-voice'), 'melo');
  assert.equal((await call(mkEnv({ AI: undefined }), '/tts', { text: 'Hi' })).status, 503);
});

console.log('/stats');
await t('密碼對才給資料；錯 5 次鎖 10 分鐘；格式與統計頁相容', async () => {
  const env = mkEnv();
  await call(env, '/chat', { turns: [{ role: 'user', content: 'I like dogs very much today' }], meta: { sid: 'a', n: 1, src: 'voice', conf: 0.8 } }); await ctx.flush();
  assert.equal((await call(env, '/stats', { password: 'nope' }, { ip: '5.5.5.5' })).status, 401);
  const ok = await call(env, '/stats', { password: 'pw' }, { ip: '5.5.5.5' }); const j = await ok.json();
  assert.equal(ok.status, 200); assert.ok(j.now > 0); assert.equal(j.keep, 90);
  for (const k of ['day', 'sessions', 'turns', 'voice_n', 'voice_words', 'voice_en_n', 'voice_long_n', 'oops_n', 'conf_sum', 'conf_n']) assert.ok(k in j.daily[0], 'daily 缺 ' + k);
  for (const k of ['day', 'ts', 'n', 'level', 'src', 'conf', 'text', 'reply', 'mood']) assert.ok(k in j.rows[0], 'rows 缺 ' + k);
  const s = []; for (let i = 0; i < 6; i++) s.push((await call(env, '/stats', { password: 'bad' }, { ip: '6.6.6.6' })).status);
  assert.deepEqual(s, [401, 401, 401, 401, 429, 429]);
  assert.equal((await call(env, '/stats', { password: 'pw' }, { ip: '6.6.6.6' })).status, 429);
  assert.equal((await call(mkEnv({ STATS_PASSWORD: '' }), '/stats', { password: 'x' })).status, 503);
});

console.log('保留天數');
await t('排程清掉過期的對話，但每日總數留得更久', async () => {
  const env = mkEnv({ KEEP_DAYS: '30' });
  await call(env, '/chat', { turns: [{ role: 'user', content: 'hi' }], meta: { sid: 'n', n: 1 } }); await ctx.flush();
  const old = Date.now() - 40 * 86400000, oldDay = new Date(old + 8 * 3600000).toISOString().slice(0, 10);
  env.DB.sql.prepare('INSERT INTO msgs(ts,day,text,reply) VALUES(?,?,?,?)').run(old, oldDay, 'old', 'old');
  env.DB.sql.prepare('INSERT INTO daily(day,sessions) VALUES(?,1)').run(oldDay);
  await worker.scheduled({}, env, ctx); await ctx.flush();
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) c FROM msgs').get().c, 1);
  assert.equal(env.DB.sql.prepare("SELECT COUNT(*) c FROM daily WHERE day=?").get(oldDay).c, 1);
});

console.log(`\n${passed} 項通過${process.exitCode ? '，有失敗' : ''}`);
