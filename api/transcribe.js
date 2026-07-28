// ============================================================
// STEP 1: GHL recording-status webhook yahan hit karta hai
// Iska kaam: turant "OK" bolna aur asli kaam QStash ko dena
// ============================================================

import { Client } from '@upstash/qstash';

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const body = req.body;

    // GHL nested format se parameters nikalo
    const parameters = body?.data?.requestData?.parameters || body;

    const RecordingUrl    = parameters?.['Recording Url']    || parameters?.RecordingUrl;
    const RecordingSid    = parameters?.['Recording Sid']    || parameters?.RecordingSid;
    const CallSid         = parameters?.['Call Sid']         || parameters?.CallSid;
    const RecordingStatus = parameters?.['Recording Status'] || parameters?.RecordingStatus;

    // messageId GHL source URL se nikalo
    // Source URL: .../recording-status?phoneCallId=xxx&messageId=yyy
    const sourceUrl = body?.source || body?.data?.requestUrl || '';
    const messageIdMatch = sourceUrl.match(/messageId=([^&]+)/);
    const messageId = messageIdMatch ? messageIdMatch[1] : null;

    // Sirf completed recordings process karo
    if (RecordingStatus && RecordingStatus !== 'completed') {
      return res.status(200).send('Recording not completed yet, ignoring');
    }

    if (!RecordingUrl) {
      return res.status(200).send('No recording URL found, ignoring');
    }

    // Queue mein job daal do — messageId bhi saath bhejo
    await qstash.publishJSON({
      url: `${process.env.PUBLIC_APP_URL}/api/process-call`,
      body: { RecordingUrl, RecordingSid, CallSid, messageId },
      retries: 3,
    });

    return res.status(200).send('Queued');

  } catch (err) {
    console.error('transcribe error:', err);
    return res.status(500).send('Error queuing job');
  }
}
