// ============================================================
// STEP 2: QStash yahan call karta hai
// Kaam: Twilio se recording download karo + Whisper se transcribe karo
// Phir result QStash ke zariye summarize.js ko bhejo
// ============================================================

import fetch from 'node-fetch';
import FormData from 'form-data';
import { Receiver, Client } from '@upstash/qstash';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

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

  try {
    const isValid = await receiver.verify({
      signature: req.headers['upstash-signature'],
      body: rawBody,
    });
    if (!isValid) return res.status(401).send('Invalid signature');
  } catch (err) {
    console.error('Signature verification failed:', err);
    return res.status(401).send('Invalid signature');
  }

  const { RecordingUrl, CallSid, messageId } = JSON.parse(rawBody);

  if (!CallSid) {
    console.warn('No CallSid in payload — cannot process');
    return res.status(400).json({ error: 'Missing CallSid' });
  }

  if (!RecordingUrl) {
    console.warn('No RecordingUrl in payload — cannot process');
    return res.status(400).json({ error: 'Missing RecordingUrl' });
  }

  try {
    // ---------- 1. Twilio recording download ----------
    const twilioAuth = Buffer.from(
      `${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    const audioRes = await fetch(`${RecordingUrl}.mp3`, {
      headers: { Authorization: `Basic ${twilioAuth}` },
    });

    if (!audioRes.ok) {
      throw new Error(`Twilio download failed: ${audioRes.status}`);
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // ---------- 2. Whisper transcription ----------
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'call.mp3' });
    form.append('model', 'whisper-1');

    const whisperRes = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        body: form,
      }
    );

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      throw new Error(`Whisper failed: ${errText}`);
    }

    const { text: transcript } = await whisperRes.json();
    console.log(`Transcription done for CallSid: ${CallSid}, length: ${transcript.length} chars`);

    // ---------- 3. Pass transcript to summarize.js via QStash ----------
    await qstash.publishJSON({
      url: `${process.env.PUBLIC_APP_URL}/api/summarize`,
      body: { transcript, CallSid, messageId },
      retries: 3,
      deduplicationId: `summarize-${CallSid}`,
    });

    console.log(`Queued summarize job for CallSid: ${CallSid}`);
    return res.status(200).json({ status: 'transcribed, queued for summary' });

  } catch (err) {
    console.error('process-call error:', err);
    return res.status(500).json({ error: err.message });
  }
}
