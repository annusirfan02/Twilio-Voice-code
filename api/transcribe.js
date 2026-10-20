// ============================================================
// STEP 1: Twilio Events webhook yahan hit karta hai
// Event type: com.twilio.voice.status-callback.recording.processed
// Payload ek ARRAY hai [{...}] — object nahi
// CallSid → data.sid se nikalta hai
// messageId → source URL se nikalta hai
// Recording fetch 2 min delay ke baad process-call.js mein hoti hai
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const rawBody = await getRawBody(req);
    console.log('transcribe: RAW BODY (first 500):', rawBody.substring(0, 500));

    // Payload ek JSON array hai [{...}]
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
    // Priority:
    // 1. data.sid = actual Twilio CallSid (CA_xxx) ← PRIMARY
    // 2. source URL phoneCallId (sirf agar CA se shuru ho) ← FALLBACK
    // 3. data.request.parameters ← FALLBACK
    // -------------------------------------------------------
    let CallSid   = null;
    let messageId = null;

    // 1. data.sid — real Twilio CallSid
    CallSid = event?.data?.sid || null;

    // messageId + CallSid fallback — source URL se
    if (source) {
      try {
        const sourceUrl = new URL(source);
        messageId = sourceUrl.searchParams.get('messageId') || null;
        if (!CallSid) {
          const phoneCallId = sourceUrl.searchParams.get('phoneCallId');
          if (phoneCallId && phoneCallId.startsWith('CA')) {
            CallSid = phoneCallId;
          }
        }
      } catch {
        console.warn('transcribe: Could not parse source URL:', source);
      }
    }

    // 3. data.request.parameters fallback
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
    // Recording Twilio pe process hone mein waqt lagta hai
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
