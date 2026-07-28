// ============================================================
// STEP 2: QStash yahan call karta hai (asli, bhaari kaam yahan hota hai)
// 1. GHL se messageId ke zariye From/To number lo
// 2. Twilio se recording download karo
// 3. Whisper se transcribe karo
// 4. GPT se summarize karo
// 5. To number se GHL contact dhundho aur notes mein add karo
// ============================================================

import fetch from 'node-fetch';
import FormData from 'form-data';
import { Receiver } from '@upstash/qstash';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

// Vercel ko batana ki raw body chahiye signature verify karne ke liye
export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  // --- Security: QStash signature verify karo ---
  const rawBody = await getRawBody(req);

  try {
    const isValid = await receiver.verify({
      signature: req.headers['upstash-signature'],
      body: rawBody,
    });
    if (!isValid) return res.status(401).send('Invalid signature');
  } catch (err) {
    console.error('Signature verification failed:', err);
    return res.status(401).send('Invalid signature');
  }

  const { RecordingUrl, RecordingSid, CallSid, messageId } = JSON.parse(rawBody);

  try {
    // ---------- 1. GHL se From/To number aur contactId lo messageId se ----------
    let From = 'unknown';
    let To = 'unknown';
    let contactId = null;

    if (messageId) {
      const msgRes = await fetch(
        `https://services.leadconnectorhq.com/conversations/messages/${messageId}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${process.env.GHL_API_KEY}`,
            Version: '2021-07-28',
          },
        }
      );

      if (msgRes.ok) {
        const msgData = await msgRes.json();
        const msg = msgData?.message || msgData;
        From      = msg?.from      || 'unknown';
        To        = msg?.to        || 'unknown';
        contactId = msg?.contactId || null;  // directly mil gaya — search ki zaroorat nahi
      } else {
        console.warn(`GHL message fetch failed: ${msgRes.status}`);
      }
    }

    console.log(`Processing call — From: ${From}, To: ${To}, ContactId: ${contactId}`);

    // ---------- 2. Twilio recording download ----------
    const twilioAuth = Buffer.from(
      `${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    const audioRes = await fetch(`${RecordingUrl}.mp3`, {
      headers: { Authorization: `Basic ${twilioAuth}` },
    });

    if (!audioRes.ok) {
      throw new Error(`Twilio download failed: ${audioRes.status}`);
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // ---------- 3. Whisper transcription ----------
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'call.mp3' });
    form.append('model', 'whisper-1');

    const whisperRes = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        body: form,
      }
    );

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      throw new Error(`Whisper failed: ${errText}`);
    }

    const { text: transcript } = await whisperRes.json();

    // ---------- 4. GPT summarization ----------
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'Aap ek sales call summarizer hain. Call transcript ko 3-4 concise bullet points mein summarize karein, key points aur next steps highlight karein.',
          },
          { role: 'user', content: transcript },
        ],
      }),
    });

    if (!gptRes.ok) {
      const errText = await gptRes.text();
      throw new Error(`GPT failed: ${errText}`);
    }

    const gptData = await gptRes.json();
    const summary = gptData.choices[0].message.content;

    // ---------- 5a. GHL contact — messageId se contactId already mila hua hai ----------
    // Agar messageId se nahi mila toh phone number se search karo
    if (!contactId) {
      const searchPhone = To !== 'unknown' ? To : From;

      const searchRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&phone=${encodeURIComponent(searchPhone)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${process.env.GHL_API_KEY}`,
            Version: '2021-07-28',
          },
        }
      );

      if (!searchRes.ok) {
        const errText = await searchRes.text();
        throw new Error(`GHL contact search failed: ${errText}`);
      }

      const searchData = await searchRes.json();
      contactId = searchData?.contact?.id;

      // ---------- 5b. Agar contact nahi mila toh naya banao ----------
      if (!contactId) {
        const createRes = await fetch(
          'https://services.leadconnectorhq.com/contacts/',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.GHL_API_KEY}`,
              Version: '2021-07-28',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              locationId: process.env.GHL_LOCATION_ID,
              phone: searchPhone,
            }),
          }
        );

        if (!createRes.ok) {
          const errText = await createRes.text();
          throw new Error(`GHL contact create failed: ${errText}`);
        }

        const createData = await createRes.json();
        contactId = createData?.contact?.id;
      }
    }

    // ---------- 5c. Contact ki Notes mein summary add karo ----------
    if (!contactId) {
      throw new Error(`No contactId found — cannot add note. From: ${From}, To: ${To}`);
    }

    const noteBody = `📞 Call Summary (${new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })})\nFrom: ${From} → To: ${To}\n\n${summary}\n\n---\n📝 Full Transcript:\n${transcript}`;

    const noteRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          Version: '2021-07-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          body: noteBody,
        }),
      }
    );

    if (!noteRes.ok) {
      const errText = await noteRes.text();
      throw new Error(`GHL note creation failed: ${errText}`);
    }

    console.log(`Call ${CallSid} processed successfully — From: ${From}, To: ${To}`);
    return res.status(200).json({ status: 'done', summary });

  } catch (err) {
    console.error('process-call error:', err);
    return res.status(500).json({ error: err.message });
  }
}
