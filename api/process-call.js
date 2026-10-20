// ============================================================
// STEP 2: QStash yahan call karta hai (transcribe.js ke baad)
// Delay ke baad aata hai — Twilio se check karo recording ready hai ya nahi
// Ready nahi → 500 return karo, QStash thodi der baad retry karega
// Ready → audio URL banao, whisper.js ko queue karo
// ============================================================

import { Receiver, Client } from '@upstash/qstash';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

const qstash = new Client({
  token: process.env.QSTASH_TOKEN,
  baseUrl: process.env.QSTASH_URL?.trim() || 'https://qstash.upstash.io',
});

export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const rawBody = await getRawBody(req);

  // QStash signature verify karo
  try {
    const isValid = await receiver.verify({
      signature: req.headers['upstash-signature'],
      body: rawBody,
    });
    if (!isValid) return res.status(401).send('Invalid signature');
  } catch (err) {
    console.error('process-call: Signature verification failed:', err);
    return res.status(401).send('Invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { RecordingSid, messageId } = payload;

  console.log(`process-call: RecordingSid=${RecordingSid}, MessageId=${messageId}`);

  if (!RecordingSid || !messageId) {
    console.warn('process-call: Missing RecordingSid or messageId — cannot process');
    return res.status(400).json({ error: 'Missing RecordingSid or messageId' });
  }

  const recordingBase = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Recordings/${RecordingSid}`;
  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  try {
    // ---------- 1. Recording ready hai ya nahi ----------
    const recRes = await fetch(`${recordingBase}.json`, {
      headers: { Authorization: `Basic ${twilioAuth}` },
    });

    if (!recRes.ok) {
      // 404 = abhi Twilio pe nahi mili — retry karo
      throw new Error(`Recording lookup failed (${recRes.status}) — RecordingSid=${RecordingSid}`);
    }

    const recording = await recRes.json();
    if (recording?.status !== 'completed') {
      throw new Error(`Recording not ready yet (status=${recording?.status}) — RecordingSid=${RecordingSid}`);
    }

    console.log(`process-call: Recording ready — duration=${recording?.duration}s`);

    // ---------- 2. whisper.js ko queue karo ----------
    await qstash.publishJSON({
      url: `${process.env.PUBLIC_APP_URL}/api/whisper`,
      body: {
        audioUrl: `${recordingBase}.mp3`,
        RecordingSid,
        messageId,
      },
      retries: 3,
      deduplicationId: `whisper-${RecordingSid}`,
    });

    console.log(`process-call: Queued whisper job — RecordingSid=${RecordingSid}`);
    return res.status(200).json({ status: 'queued for whisper transcription' });

  } catch (err) {
    // 500 taake QStash retry kare — recording thodi der mein ready ho jayegi
    console.error('process-call error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
