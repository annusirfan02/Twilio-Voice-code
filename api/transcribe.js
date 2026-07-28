// ============================================================
// STEP 1: GHL/Twilio recording-status webhook yahan hit karta hai
// Iska kaam sirf ek hai: turant "OK" bolna aur asli kaam
// QStash queue ke hawale karna (taake timeout na ho)
// ============================================================

import { Client } from '@upstash/qstash';

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    // Event Streams / GHL webhook ka nested data format
    const body = req.body;

    // Data parameters nikalo — GHL format mein nested hain
    const parameters = body?.data?.requestData?.parameters || body;

    const RecordingUrl    = parameters?.['Recording Url']    || parameters?.RecordingUrl;
    const RecordingSid    = parameters?.['Recording Sid']    || parameters?.RecordingSid;
    const CallSid         = parameters?.['Call Sid']         || parameters?.CallSid;
    const AccountSid      = parameters?.['Account Sid']      || parameters?.AccountSid;
    const RecordingStatus = parameters?.['Recording Status'] || parameters?.RecordingStatus;

    // Caller number GHL URL se nikalna hoga ya fallback
    const From = parameters?.From || AccountSid || 'unknown';

    // Sirf completed recordings process karo
    if (RecordingStatus && RecordingStatus !== 'completed') {
      return res.status(200).send('Recording not completed yet, ignoring');
    }

    if (!RecordingUrl) {
      return res.status(200).send('No recording URL found, ignoring');
    }

    // Queue mein job daal do
    await qstash.publishJSON({
      url: `${process.env.PUBLIC_APP_URL}/api/process-call`,
      body: { RecordingUrl, RecordingSid, From, CallSid },
      retries: 3,
    });

    return res.status(200).send('Queued');

  } catch (err) {
    console.error('transcribe error:', err);
    return res.status(500).send('Error queuing job');
  }
}
