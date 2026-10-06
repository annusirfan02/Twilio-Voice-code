// ============================================================
// STEP 2: QStash yahan call karta hai (transcribe.js ke baad)
// Kaam: QStash signature verify karo aur whisper.js ko queue karo
// Audio download + Whisper ab whisper.js mein hoga (alag function)
// Taake Vercel ka timeout hit na ho
// ============================================================

import { Receiver, Client } from '@upstash/qstash';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

const qstash = new Client({
  token: process.env.QSTASH_TOKEN,
  // EU region ke liye baseUrl explicitly set karo
  ...(process.env.QSTASH_URL && { baseUrl: process.env.QSTASH_URL }),
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

  // QStash signature verify karo — fake requests block honge
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

  const { RecordingUrl, CallSid, messageId, From, To } = JSON.parse(rawBody);

  if (!RecordingUrl) {
    console.warn('process-call: No RecordingUrl in payload — cannot process');
    return res.status(400).json({ error: 'Missing RecordingUrl' });
  }

  const callId = CallSid || messageId;
  if (!callId) {
    console.warn('process-call: No CallSid or messageId — deduplication not possible');
  }

  // Twilio kabhi kabhi URL mein already .mp3 extension deta hai
  // Double extension (.mp3.mp3) avoid karo
  const audioUrl = RecordingUrl.endsWith('.mp3')
    ? RecordingUrl
    : `${RecordingUrl}.mp3`;

  console.log(`process-call: audioUrl=${audioUrl}, callId=${callId ?? 'unknown'}`);

  try {
    const whisperOptions = {
      url: `${process.env.PUBLIC_APP_URL}/api/whisper`,
      body: {
        audioUrl,
        callId,
        messageId,
        From,
        To,
      },
      retries: 3,
    };
    if (callId) whisperOptions.deduplicationId = `whisper-${callId}`;

    await qstash.publishJSON(whisperOptions);

    console.log(`process-call: Queued whisper job — callId=${callId ?? 'unknown'}`);
    return res.status(200).json({ status: 'queued for whisper transcription' });

  } catch (err) {
    console.error('process-call error:', err);
    return res.status(500).json({ error: err.message });
  }
}
