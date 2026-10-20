// ============================================================
// STEP 1: Twilio Events webhook yahan hit karta hai
// Event type: com.twilio.voice.status-callback.recording.processed
// Payload ek ARRAY hai [{...}] — ek se zyada events ho sakte hain
// RecordingSid → data.sid se nikalta hai (RE_xxx)
// messageId → source URL se nikalta hai (GHL message ID)
// Recording fetch delay ke baad process-call.js mein hoti hai
// ============================================================

import { Client } from '@upstash/qstash';

const qstash = new Client({
  token: process.env.QSTASH_TOKEN,
  baseUrl: process.env.QSTASH_URL?.trim() || 'https://qstash.upstash.io',
});

// Recording Twilio pe process hone mein waqt lagta hai
const DELAY_SECONDS = 120; // 2 minutes

export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Ek event se RecordingSid aur messageId nikalo — relevant na ho toh null
function extractJob(event) {
  const eventType = event?.type || '';
  if (!eventType.includes('recording.processed')) {
    console.log(`transcribe: Skipping — event type: ${eventType || '(none)'}`);
    return null;
  }

  const params = event?.data?.request?.parameters || event?.data?.parameters || {};

  // data.sid = Recording SID — sirf RE_xxx accept karo
  const RecordingSid = event?.data?.sid || params?.RecordingSid || null;
  if (!RecordingSid || !RecordingSid.startsWith('RE')) {
    console.warn(`transcribe: Invalid/missing RecordingSid: ${RecordingSid}`);
    return null;
  }

  // source URL se GHL messageId nikalo
  let messageId = null;
  if (event?.source) {
    try {
      messageId = new URL(event.source).searchParams.get('messageId') || null;
    } catch {
      console.warn('transcribe: Could not parse source URL:', event.source);
    }
  }
  messageId = messageId || params?.messageId || null;

  if (!messageId) {
    console.warn(`transcribe: No GHL messageId for RecordingSid=${RecordingSid} — contact nahi milega`);
    return null;
  }

  return { RecordingSid, messageId };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // Optional shared secret — webhook URL mein ?secret=xxx lagao
  // Taake koi bhi fake request na bhej sake
  if (process.env.WEBHOOK_SECRET) {
    const secret = new URL(req.url, 'http://localhost').searchParams.get('secret');
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).send('Unauthorized');
    }
  }

  try {
    const rawBody = await getRawBody(req);
    console.log('transcribe: RAW BODY:', rawBody.substring(0, 4000));

    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch (e) {
      console.error('transcribe: JSON parse failed:', e.message);
      return res.status(200).send('Invalid JSON, ignoring');
    }

    // Array ho ya object — normalize karo, har event handle karo
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const jobs = events.map(extractJob).filter(Boolean);

    if (jobs.length === 0) {
      return res.status(200).send('No relevant recording events, ignoring');
    }

    for (const { RecordingSid, messageId } of jobs) {
      await qstash.publishJSON({
        url: `${process.env.PUBLIC_APP_URL}/api/process-call`,
        body: { RecordingSid, messageId },
        retries: 3,
        delay: DELAY_SECONDS,
        deduplicationId: `process-${RecordingSid}`,
      });
      console.log(`transcribe: Queued with ${DELAY_SECONDS}s delay — RecordingSid=${RecordingSid}, MessageId=${messageId}`);
    }

    return res.status(200).send(`Queued ${jobs.length}`);

  } catch (err) {
    console.error('transcribe error:', err);
    return res.status(500).send('Error queuing job');
  }
}
