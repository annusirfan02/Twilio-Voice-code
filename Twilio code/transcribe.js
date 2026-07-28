
// ============================================================
// STEP 1: Twilio yahan hit karega jab call/recording khatam ho
// Iska kaam sirf ek hai: turant "OK" bolna aur asli kaam
// QStash queue ke hawale karna (taake Twilio timeout na ho)
// ============================================================

import { Client } from '@upstash/qstash';

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const { RecordingUrl, RecordingSid, From, To, CallSid } = req.body;

    if (!RecordingUrl) {
      // Recording abhi ready nahi hui, ignore kar do
      return res.status(200).send('No recording yet, ignoring');
    }

    // Queue mein job daal do - yeh turant return karega
    await qstash.publishJSON({
      url: `${process.env.PUBLIC_APP_URL}/api/process-call`,
      body: { RecordingUrl, RecordingSid, From, To, CallSid },
      retries: 3, // agar fail ho to 3 baar retry karega apne aap
    });

    // Twilio ko turant response - isse Twilio timeout nahi hoga
    return res.status(200).send('Queued');

  } catch (err) {
    console.error('call-completed error:', err);
    return res.status(500).send('Error queuing job');
  }
}
