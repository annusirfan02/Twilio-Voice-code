// ============================================================
// STEP 1: GHL/Twilio recording-status webhook yahan hit karta hai
// Iska kaam: turant "OK" bolna aur asli kaam QStash ko dena
// Supports: JSON (GHL) aur form-urlencoded (Twilio direct) dono
// ============================================================

import { Client } from '@upstash/qstash';
import { URLSearchParams } from 'url';

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

// GHL JSON aur Twilio form-urlencoded dono parse karta hai
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
      console.error('transcribe: Body parse failed — not JSON or form-urlencoded');
      return res.status(200).send('Unparseable body, ignoring');
    }

    console.log('transcribe: PARSED BODY keys:', Object.keys(body));

    // GHL 3 nested formats handle karo
    const parameters =
      body?.data?.requestData?.parameters ||
      body?.data?.parameters ||
      body;

    console.log('transcribe: PARAMETERS (first 300):', JSON.stringify(parameters).substring(0, 300));

    // Twilio direct fields AND GHL spaced fields dono handle karo
    const RecordingUrl =
      parameters?.RecordingUrl ||
      parameters?.['Recording Url'] ||
      parameters?.recording_url ||
      null;

    const CallSid =
      parameters?.CallSid ||
      parameters?.['Call Sid'] ||
      parameters?.call_sid ||
      null;

    const RecordingStatus =
      parameters?.RecordingStatus ||
      parameters?.['Recording Status'] ||
      parameters?.recording_status ||
      null;

    // From: Twilio = 'From', GHL = 'CallerNumber'
    const From =
      parameters?.From ||
      parameters?.CallerNumber ||
      parameters?.caller ||
      null;

    // To: Twilio = 'To', GHL = 'Called'
    const To =
      parameters?.To ||
      parameters?.Called ||
      parameters?.called ||
      null;

    console.log(`transcribe: RecordingUrl=${RecordingUrl}, Status=${RecordingStatus}, From=${From}, To=${To}`);

    // messageId — GHL se aata hai URL params ya body mein
    let messageId = body?.data?.messageId || body?.messageId || null;
    if (!messageId) {
      const urlCandidates = [
        body?.data?.requestUrl,
        body?.data?.url,
        body?.requestUrl,
      ].filter(Boolean);

      for (const url of urlCandidates) {
        const match = url.match(/messageId=([^&]+)/);
        if (match) { messageId = match[1]; break; }
      }
    }

    console.log(`transcribe: CallSid=${CallSid}, MessageId=${messageId}`);

    // Sirf completed recordings process karo
    const statusLower = RecordingStatus?.toLowerCase();
    if (statusLower && statusLower !== 'completed') {
      console.log(`transcribe: Skipping — RecordingStatus: ${RecordingStatus}`);
      return res.status(200).send('Recording not completed yet, ignoring');
    }

    if (!RecordingUrl) {
      console.log('transcribe: No RecordingUrl found — ignoring');
      return res.status(200).send('No recording URL found, ignoring');
    }

    // QStash ko queue karo — deduplication CallSid ya messageId se
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
