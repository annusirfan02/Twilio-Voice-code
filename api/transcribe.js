// ============================================================
// STEP 1: GHL/Twilio recording-status webhook yahan hit karta hai
// Iska kaam: turant "OK" bolna aur asli kaam QStash ko dena
// ============================================================

import { Client } from '@upstash/qstash';

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

// Raw body chahiye taake sahi parse ho sake
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

    // Debug: raw body log karo taake format pata chale
    console.log('RAW BODY:', rawBody.substring(0, 500));

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (e) {
      console.error('JSON parse failed:', e.message);
      return res.status(200).send('Invalid JSON, ignoring');
    }

    // Debug: parsed body log karo
    console.log('PARSED BODY keys:', Object.keys(body));

    // GHL nested format se parameters nikalo
    const parameters = body?.data?.requestData?.parameters || body?.data?.parameters || body;

    console.log('PARAMETERS:', JSON.stringify(parameters).substring(0, 300));

    const RecordingUrl    = parameters?.['Recording Url']    || parameters?.RecordingUrl;
    const CallSid         = parameters?.['Call Sid']         || parameters?.CallSid;
    const RecordingStatus = parameters?.['Recording Status'] || parameters?.RecordingStatus;

    console.log(`RecordingUrl: ${RecordingUrl}, Status: ${RecordingStatus}`);

    // messageId — pehle direct fields check karo, phir sirf valid URL fields se nikalo
    let messageId = body?.data?.messageId || body?.messageId || null;

    if (!messageId) {
      // Sirf woh fields check karo jo actual URLs ho sakti hain
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

    console.log(`MessageId: ${messageId}`);

    // Sirf completed recordings process karo — agar status missing ya non-completed ho, ignore karo
    if (RecordingStatus !== 'completed') {
      console.log(`Skipping — RecordingStatus: ${RecordingStatus}`);
      return res.status(200).send('Recording not completed yet, ignoring');
    }

    if (!RecordingUrl) {
      return res.status(200).send('No recording URL found, ignoring');
    }

    // Queue mein job daal do — deduplicationId se same call dobara process nahi hogi
    const publishOptions = {
      url: `${process.env.PUBLIC_APP_URL}/api/process-call`,
      body: { RecordingUrl, CallSid, messageId },
      retries: 3,
    };
    // Sirf tab deduplicationId set karo jab CallSid actually available ho
    if (CallSid) publishOptions.deduplicationId = CallSid;

    await qstash.publishJSON(publishOptions);

    console.log('Successfully queued to QStash');
    return res.status(200).send('Queued');

  } catch (err) {
    console.error('transcribe error:', err);
    return res.status(500).send('Error queuing job');
  }
}
