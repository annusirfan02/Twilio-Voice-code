// ============================================================
// STEP 2: QStash yahan call karta hai (transcribe.js ke baad)
// 2 minute delay ke baad aata hai — recording ready hoti hai
// Kaam: RecordingSid se audio URL banao, whisper.js ko queue karo
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

  const { RecordingSid, CallSid, messageId } = JSON.parse(rawBody);

  console.log(`process-call: RecordingSid=${RecordingSid}, CallSid=${CallSid}, MessageId=${messageId}`);

  if (!RecordingSid) {
    console.warn('process-call: No RecordingSid in payload — cannot process');
    return res.status(400).json({ error: 'Missing RecordingSid' });
  }

  try {
    // RecordingSid se seedha audio URL banao — Twilio API call ki zaroorat nahi
    // Recording SID (RE_xxx) se directly MP3 download hota hai
    const audioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Recordings/${RecordingSid}.mp3`;

    console.log(`process-call: audioUrl=${audioUrl}`);

    // From aur To Twilio API se fetch karo agar CallSid available ho
    let From = null;
    let To   = null;

    if (CallSid) {
      try {
        const twilioAuth = Buffer.from(
          `${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64');

        const callRes = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Calls/${CallSid}.json`,
          { headers: { Authorization: `Basic ${twilioAuth}` } }
        );

        if (callRes.ok) {
          const callData = await callRes.json();
          From = callData?.from || null;
          To   = callData?.to   || null;
          console.log(`process-call: From=${From}, To=${To}`);
        } else {
          console.warn(`process-call: Call fetch failed (${callRes.status}) — From/To will be null`);
        }
      } catch (err) {
        console.warn(`process-call: Could not fetch call details: ${err.message}`);
      }
    }

    // whisper.js ko queue karo
    const callId = CallSid || RecordingSid;
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

    console.log(`process-call: Queued whisper job — callId=${callId}`);
    return res.status(200).json({ status: 'queued for whisper transcription' });

  } catch (err) {
    console.error('process-call error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
