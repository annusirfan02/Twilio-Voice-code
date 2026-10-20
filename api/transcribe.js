// ============================================================
// STEP 1: Twilio Events webhook yahan hit karta hai
// Event type: com.twilio.voice.status-callback.recording.processed
// Payload ek ARRAY hai [{...}] — object nahi
// CallSid aur messageId source URL mein hote hain
// ============================================================

import { Client } from '@upstash/qstash';

const qstash = new Client({
  token: process.env.QSTASH_TOKEN,
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

// Twilio API se CallSid ki recording fetch karo
async function fetchRecordingForCall(callSid) {
  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Calls/${callSid}/Recordings.json`;

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

  if (recordings.length === 0) {
    throw new Error(`No recordings found for CallSid: ${callSid}`);
  }

  // Pehli recording lo
  const recording = recordings[0];
  const recordingSid = recording.sid;

  const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Recordings/${recordingSid}`;

  console.log(`transcribe: Recording found — RecordingSid=${recordingSid}`);

  return {
    recordingUrl,
    from: recording.from || null,
    to:   recording.to   || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const rawBody = await getRawBody(req);
    console.log('transcribe: RAW BODY (first 500):', rawBody.substring(0, 500));

    // -------------------------------------------------------
    // Parse — payload ek JSON array hai [{...}]
    // -------------------------------------------------------
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch (e) {
      console.error('transcribe: JSON parse failed:', e.message);
      return res.status(200).send('Invalid JSON, ignoring');
    }

    // Array ho ya object — normalize karo
    const event = Array.isArray(parsed) ? parsed[0] : parsed;

    if (!event) {
      console.error('transcribe: Empty event');
      return res.status(200).send('Empty event, ignoring');
    }

    const eventType = event?.type || '';
    const source    = event?.source || '';

    console.log(`transcribe: Event type: ${eventType}`);
    console.log(`transcribe: Source: ${source}`);

    // Sirf recording.processed aur call.completed handle karo
    if (
      eventType &&
      !eventType.includes('recording.processed') &&
      !eventType.includes('call.completed')
    ) {
      console.log(`transcribe: Skipping — event type: ${eventType}`);
      return res.status(200).send('Event not relevant, ignoring');
    }

    // -------------------------------------------------------
    // CallSid aur messageId nikalo
    //
    // Priority order:
    // 1. data.sid = actual Twilio CallSid (CA_xxx) ← PRIMARY
    // 2. source URL ka phoneCallId = GHL internal ID ← FALLBACK only
    // 3. data.request.parameters.CallSid            ← FALLBACK
    //
    // messageId source URL se milta hai
    // -------------------------------------------------------
    let CallSid   = null;
    let messageId = null;

    // 1. data.sid = real Twilio CallSid — yeh sabse reliable hai
    CallSid = event?.data?.sid || null;

    // messageId — source URL se nikalo
    if (source) {
      try {
        const sourceUrl = new URL(source);
        messageId = sourceUrl.searchParams.get('messageId') || null;
        // phoneCallId sirf fallback ke liye — agar data.sid nahi mila
        if (!CallSid) {
          const phoneCallId = sourceUrl.searchParams.get('phoneCallId');
          // Sirf valid Twilio CallSid use karo (CA se shuru hota hai)
          if (phoneCallId && phoneCallId.startsWith('CA')) {
            CallSid = phoneCallId;
          }
        }
      } catch {
        console.warn('transcribe: Could not parse source URL:', source);
      }
    }

    // Fallback — data.request.parameters se try karo
    if (!CallSid) {
      const params = event?.data?.request?.parameters || event?.data?.parameters || {};
      CallSid   = params?.CallSid || params?.['Call Sid'] || null;
      messageId = messageId || params?.messageId || null;
    }

    console.log(`transcribe: CallSid=${CallSid}, MessageId=${messageId}`);

    if (!CallSid) {
      console.error('transcribe: No CallSid found — cannot process');
      return res.status(200).send('No CallSid found, ignoring');
    }

    // -------------------------------------------------------
    // QStash ko queue karo — 2 minute delay
    // Twilio recording process hone mein time lagta hai
    // delay se ensure hoga ke recording ready ho
    // -------------------------------------------------------
    const DELAY_SECONDS = 120; // 2 minutes

    const dedupId = CallSid || messageId;
    const publishOptions = {
      url: `${process.env.PUBLIC_APP_URL}/api/process-call`,
      body: { CallSid, messageId },
      retries: 3,
      delay: DELAY_SECONDS,
    };
    if (dedupId) publishOptions.deduplicationId = dedupId;

    await qstash.publishJSON(publishOptions);

    console.log(`transcribe: Queued with ${DELAY_SECONDS}s delay — CallSid=${CallSid}, MessageId=${messageId}`);
    return res.status(200).send('Queued');

  } catch (err) {
    console.error('transcribe error:', err);
    return res.status(500).send('Error queuing job');
  }
}
