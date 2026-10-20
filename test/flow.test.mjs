// End-to-end test of the call flow with mocked Twilio / OpenAI / GHL / QStash — run: npm test
import { register } from 'node:module';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'node-fetch') return { url: 'data:text/javascript,export default (...a)=>globalThis.fetch(...a)', shortCircuit: true };
  return next(spec, ctx);
}`));

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
Object.assign(process.env, {
  QSTASH_TOKEN: 'qtok', QSTASH_CURRENT_SIGNING_KEY: 'sigkey1', QSTASH_NEXT_SIGNING_KEY: 'sigkey2',
  PUBLIC_APP_URL: 'https://app.example.com', TWILIO_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tw',
  OPENAI_API_KEY: 'sk', GHL_API_KEY: 'ghl', GHL_LOCATION_ID: 'loc1',
});

let calls = [];
let S = {};
const reset = () => { S = { recStatus: 'completed', ghlMsg: { contactId: 'CONTACT_42' }, notes: [] }; };
globalThis.fetch = async (url, opts = {}) => {
  url = String(url); const method = opts.method || 'GET';
  calls.push({ url, method, headers: new Headers(opts.headers), body: typeof opts.body === 'string' ? opts.body : '[form]' });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('qstash')) return json({ messageId: 'm' });
  if (/\/Recordings\/RE\w+\.json$/.test(url)) return S.recStatus ? json({ status: S.recStatus, duration: '61' }) : json({}, 404);
  if (/\/Recordings\/RE\w+\.mp3$/.test(url)) return new Response(Buffer.alloc(1000, 1));
  if (url.includes('audio/transcriptions')) return json({ text: 'Customer wants a quote by Friday.' });
  if (url.includes('chat/completions')) return json({ choices: [{ message: { content: '- Quote by Friday' } }] });
  if (url.includes('conversations/messages')) return S.ghlMsg ? json({ message: S.ghlMsg }) : json({ msg: 'nf' }, 404);
  if (url.includes('/notes') && method === 'GET') return json({ notes: S.notes });
  if (url.includes('/notes') && method === 'POST') { S.notes.push(JSON.parse(opts.body)); return json({ note: {} }); }
  return json({ error: 'unmocked ' + url }, 500);
};

const b64u = (b) => Buffer.from(b).toString('base64url');
function sign(body) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const pay = b64u(JSON.stringify({ iss: 'Upstash', sub: 'x', exp: now + 300, nbf: now - 5, iat: now, jti: 'j',
    body: crypto.createHash('sha256').update(body).digest('base64url') }));
  return `${head}.${pay}.${crypto.createHmac('sha256', 'sigkey1').update(`${head}.${pay}`).digest('base64url')}`;
}
async function invoke(file, body, { signed = true, url = '/api/' + file } = {}) {
  const mod = await import(pathToFileURL(path.join(APP, 'api', file)).href);
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]);
  Object.assign(req, { method: 'POST', url, headers: signed ? { 'upstash-signature': sign(raw) } : {} });
  const out = { status: 200, body: null };
  const res = { status(s) { out.status = s; return this; }, send(b) { out.body = b; return this; }, json(b) { out.body = b; return this; } };
  calls = [];
  try { await mod.default(req, res); } catch (e) { out.status = 'UNCAUGHT'; out.body = e.message; }
  const pub = calls.filter(c => c.url.includes('qstash')).map(c => JSON.parse(c.body));
  return { ...out, calls: calls.slice(), pub };
}
const q = console.log; const mute = () => { console.log = console.warn = console.error = () => {}; }; const unmute = () => { console.log = console.warn = console.error = q; };
let fails = 0;
async function test(name, fn) {
  reset(); mute(); let err = null;
  try { await fn(); } catch (e) { err = e; } finally { unmute(); }
  if (err) { fails++; q(`FAIL  ${name}\n      ${err.message}`); } else q(`PASS  ${name}`);
}
const expect = (c, m) => { if (!c) throw new Error(m); };

const src = 'https://services.leadconnectorhq.com/hooks?messageId=GHLMSG1&phoneCallId=ghl-call-abc';
const ev = (type, sid, source = src) => ({ type: `com.twilio.voice.status-callback.${type}`, source, data: { sid } });

await test('happy path: webhook -> delay -> ready check -> whisper -> summary -> note on GHL contact', async () => {
  const t = await invoke('transcribe.js', [ev('recording.processed', 'RE1111')], { signed: false });
  expect(t.status === 200 && t.pub.length === 1, 'transcribe should queue 1 job');
  expect(t.pub[0].RecordingSid === 'RE1111' && t.pub[0].messageId === 'GHLMSG1', 'wrong ids queued');
  const p = await invoke('process-call.js', t.pub[0]);
  expect(p.status === 200 && p.pub[0].audioUrl.endsWith('/Recordings/RE1111.mp3'), 'process-call should queue whisper');
  const w = await invoke('whisper.js', p.pub[0]);
  expect(w.status === 200 && w.pub[0].transcript.includes('quote'), 'whisper should queue summarize');
  const s = await invoke('summarize.js', w.pub[0]);
  expect(s.status === 200, 'summarize failed: ' + JSON.stringify(s.body));
  expect(s.calls.some(c => c.method === 'POST' && c.url.endsWith('/contacts/CONTACT_42/notes')), 'note not posted to CONTACT_42');
  expect(S.notes[0].body.includes('Quote by Friday') && S.notes[0].body.includes('Recording: RE1111'), 'note content wrong');
});

await test('webhook delay is applied (120s)', async () => {
  const t = await invoke('transcribe.js', [ev('recording.processed', 'RE1111')], { signed: false });
  const qs = t.calls.find(c => c.url.includes('qstash'));
  expect(qs?.headers.get('upstash-delay') === '120s', 'delay header: ' + qs?.headers.get('upstash-delay'));
});

await test('batched webhook: every recording event is queued', async () => {
  const t = await invoke('transcribe.js', [ev('recording.processed', 'RE1111'), ev('recording.processed', 'RE2222')], { signed: false });
  expect(t.pub.length === 2, `expected 2 jobs, got ${t.pub.length}`);
});

await test('call.completed / untyped / non-RE events are ignored', async () => {
  const t = await invoke('transcribe.js', [ev('call.completed', 'CA9999'), { data: { sid: 'RE1' } }, ev('recording.processed', 'CA1')], { signed: false });
  expect(t.status === 200 && t.pub.length === 0, `expected 0 jobs, got ${t.pub.length}`);
});

await test('recording event without GHL messageId is ignored', async () => {
  const t = await invoke('transcribe.js', [ev('recording.processed', 'RE1111', 'https://x.com/no-params')], { signed: false });
  expect(t.pub.length === 0, 'should not queue');
});

await test('WEBHOOK_SECRET enforced when set', async () => {
  process.env.WEBHOOK_SECRET = 's3cret';
  try {
    const bad = await invoke('transcribe.js', [ev('recording.processed', 'RE1111')], { signed: false });
    const good = await invoke('transcribe.js', [ev('recording.processed', 'RE1111')], { signed: false, url: '/api/transcribe?secret=s3cret' });
    expect(bad.status === 401 && bad.pub.length === 0, 'unauth request accepted');
    expect(good.status === 200 && good.pub.length === 1, 'auth request rejected');
  } finally { delete process.env.WEBHOOK_SECRET; }
});

await test('recording not ready yet -> 500 (QStash retries), nothing queued', async () => {
  S.recStatus = 'processing';
  const p = await invoke('process-call.js', { RecordingSid: 'RE1111', messageId: 'GHLMSG1' });
  expect(p.status === 500 && p.pub.length === 0, 'should fail and not queue');
  S.recStatus = null; // 404 from Twilio
  const p2 = await invoke('process-call.js', { RecordingSid: 'RE1111', messageId: 'GHLMSG1' });
  expect(p2.status === 500 && p2.pub.length === 0, '404 should fail and not queue');
});

await test('GHL message not found -> 500, GPT NOT called, no note', async () => {
  S.ghlMsg = null;
  const s = await invoke('summarize.js', { transcript: 'x', RecordingSid: 'RE1111', messageId: 'BAD' });
  expect(s.status === 500, 'should 500');
  expect(!s.calls.some(c => c.url.includes('openai')), 'GPT called anyway');
  expect(S.notes.length === 0, 'note written');
});

await test('QStash retry after success does not create a duplicate note', async () => {
  const body = { transcript: 'x', RecordingSid: 'RE1111', messageId: 'GHLMSG1' };
  await invoke('summarize.js', body); const r = await invoke('summarize.js', body);
  expect(r.status === 200 && S.notes.length === 1, `notes written: ${S.notes.length}`);
});

await test('malformed JSON returns 400 instead of crashing', async () => {
  for (const f of ['process-call.js', 'whisper.js', 'summarize.js']) {
    const r = await invoke(f, 'not json');
    expect(r.status === 400, `${f} -> ${r.status}`);
  }
});

q(fails ? `\n${fails} failing` : '\nall passed');
process.exit(fails ? 1 : 0);
