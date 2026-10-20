// ============================================================
// STEP 2: QStash yahan call karta hai (transcribe.js ke baad)
// 2 minute delay ke baad aata hai — recording ready hoti hai
// Kaam: Twilio API se recording fetch karo, whisper.js ko queue karo
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

// Twilio API se CallSid ki recording fetch karo
async function fetchRecordingForCall(callSid) {
  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Calls/${callSid}/Recordings.json`;

  console.log(`process-call: Fetching recordings — url=${url}`);

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Basic ${twilioAuth}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twilio Recordings API failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const recordings = data?.recordings || [];

  console.log(`process-call: Found ${recordings.length} recording(s) for CallSid=${callSid}`);

  if (recordings.length === 0) {
    throw new Error(`No recordings found for CallSid: ${callSid}`);
  }

  // Pehli recording lo
  const recording = recordings[0];
  const recordingSid = recording.sid;

  // RecordingUrl — .mp3 extension ke saath
  const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Recordings/${recordingSid}.mp3`;

  console.log(`process-call: RecordingSid=${recordingSid}, From=${recording.from}, To=${recording.to}`);

  return {
    recordingUrl,
    from: recording.from || null,
    to:   recording.to   || null,
  };
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

  const { CallSid, messageId } = JSON.parse(rawBody);

  if (!CallSid) {
    console.warn('process-call: No CallSid in payload — cannot process');
    return res.status(400).json({ error: 'Missing CallSid' });
  }

  console.log(`process-call: Processing — CallSid=${CallSid}, MessageId=${messageId}`);

  try {
    // Twilio API se recording fetch karo
    // Ab 2 min baad aa rahe hain — recording ready hogi
    const recordingData = await fetchRecordingForCall(CallSid);

    const audioUrl = recordingData.recordingUrl;
    const From     = recordingData.from;
    const To       = recordingData.to;

    const callId = CallSid;

    // whisper.js ko queue karo
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

    console.log(`process-call: Queued whisper job — callId=${callId}, audioUrl=${audioUrl}`);
    return res.status(200).json({ status: 'queued for whisper transcription' });

  } catch (err) {
    console.error('process-call error:', err.message);
    // 500 = QStash retry karega
    return res.status(500).json({ error: err.message });
  }
}
