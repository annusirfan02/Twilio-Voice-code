// ============================================================
// STEP 1: Twilio Events webhook yahan hit karta hai
// Event type: com.twilio.voice.status-callback.recording.processed
// Payload mein RecordingUrl nahi hota — CallSid se Twilio API
// se recording fetch karni padti hai
// ============================================================

import { Client } from '@upstash/qstash';
import { URLSearchParams } from 'url';

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

// JSON ya form-urlencoded dono parse karta hai
function parseBody(rawBody, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
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

  // Pehli recording lo (latest)
  const recording = recordings[0];
  const recordingSid = recording.sid;

  // RecordingUrl banao
  const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Recordings/${recordingSid}`;

  console.log(`transcribe: Recording found — RecordingSid=${recordingSid}, CallSid=${callSid}`);

  return {
    recordingUrl,
    recordingSid,
    from: recording.from || null,
    to: recording.to || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const rawBody = await getRawBody(req);
    const contentType = req.headers['content-type'] || '';

    console.log('transcribe: Content-Type:', contentType);
    console.log('transcribe: RAW BODY (first 500):', rawBody.substring(0, 500));

    const body = parseBody(rawBody, contentType);
    if (!body) {
      console.error('transcribe: Body parse failed');
      return res.status(200).send('Unparseable body, ignoring');
    }

    // -------------------------------------------------------
    // Event type check — sirf recording.processed handle karo
    // -------------------------------------------------------
    const eventType = body?.type || '';
    console.log(`transcribe: Event type: ${eventType}`);

    if (
      eventType &&
      !eventType.includes('recording.processed') &&
      !eventType.includes('call.completed')
    ) {
      console.log(`transcribe: Skipping event type: ${eventType}`);
      return res.status(200).send('Event type not relevant, ignoring');
    }

    // -------------------------------------------------------
    // CallSid nikalo — naye format mein data.sid mein hota hai
    // Purane format mein parameters.CallSid mein
    // -------------------------------------------------------
    const parameters =
      body?.data?.requestData?.parameters ||
      body?.data?.parameters ||
      body?.data?.request?.parameters ||
      body;

    const CallSid =
      body?.data?.sid ||           // naya Twilio Events format
      parameters?.CallSid ||        // purana format
      parameters?.['Call Sid'] ||
      parameters?.call_sid ||
      null;

    // messageId — GHL se aata hai
    let messageId = body?.data?.messageId || body?.messageId || null;
    if (!messageId) {
      const urlCandidates = [
        body?.data?.requestUrl,
        body?.data?.url,
        body?.data?.request?.url,
        body?.requestUrl,
      ].filter(Boolean);

      for (const url of urlCandidates) {
        const match = url.match(/messageId=([^&]+)/);
        if (match) { messageId = match[1]; break; }
      }
    }

    console.log(`transcribe: CallSid=${CallSid}, MessageId=${messageId}`);

    if (!CallSid) {
      console.error('transcribe: No CallSid found in payload');
      return res.status(200).send('No CallSid found, ignoring');
    }

    // -------------------------------------------------------
    // Pehle check karo kya RecordingUrl directly available hai
    // (purana format) — agar nahi toh Twilio API se fetch karo
    // -------------------------------------------------------
    let RecordingUrl =
      parameters?.RecordingUrl ||
      parameters?.['Recording Url'] ||
      parameters?.recording_url ||
      null;

    let From =
      parameters?.From ||
      parameters?.CallerNumber ||
      parameters?.caller ||
      null;

    let To =
      parameters?.To ||
      parameters?.Called ||
      parameters?.called ||
      null;

    if (!RecordingUrl) {
      // Naya format — Twilio API se recording fetch karo
      console.log(`transcribe: No RecordingUrl in payload — fetching from Twilio API for CallSid=${CallSid}`);

      try {
        const recordingData = await fetchRecordingForCall(CallSid);
        RecordingUrl = recordingData.recordingUrl;
        From = From || recordingData.from;
        To   = To   || recordingData.to;
      } catch (err) {
        console.error(`transcribe: Failed to fetch recording: ${err.message}`);
        // 500 taake retry ho sake — recording abhi ready nahi hogi
        return res.status(500).send(`Failed to fetch recording: ${err.message}`);
      }
    }

    console.log(`transcribe: RecordingUrl=${RecordingUrl}, From=${From}, To=${To}`);

    // QStash ko queue karo
    const dedupId = CallSid || messageId;
    const publishOptions = {
      url: `${process.env.PUBLIC_APP_URL}/api/process-call`,
      body: { RecordingUrl, CallSid, messageId, From, To },
      retries: 3,
    };
    if (dedupId) publishOptions.deduplicationId = dedupId;

    await qstash.publishJSON(publishOptions);

    console.log(`transcribe: Successfully queued — CallSid=${CallSid}, From=${From}, To=${To}`);
    return res.status(200).send('Queued');

  } catch (err) {
    console.error('transcribe error:', err);
    return res.status(500).send('Error queuing job');
  }
}
