// ============================================================
// STEP 3: QStash yahan call karta hai (process-call.js ke baad)
// Kaam: GPT se summarize karo, GHL contact dhundho, note add karo
// ============================================================

import fetch from 'node-fetch';
import { Receiver } from '@upstash/qstash';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
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
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const rawBody = await getRawBody(req);

  // --- QStash signature verify ---
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

  const { transcript, CallSid, messageId } = JSON.parse(rawBody);

  if (!transcript) {
    // 500 taake QStash retry kare — missing transcript transient issue ho sakta hai
    return res.status(500).json({ error: 'Missing transcript' });
  }

  try {
    // ---------- 1. GHL se From/To aur contactId lo messageId se ----------
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
        contactId = msg?.contactId || null;
      } else {
        console.warn(`GHL message fetch failed: ${msgRes.status}`);
      }
    }

    console.log(`Summarizing — From: ${From}, To: ${To}, ContactId: ${contactId}`);

    // ---------- 2. GPT summarization ----------
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

    // ---------- 3a. contactId nahi mila — From number se search karo ----------
    // From = customer, To = agent/business — hamesha customer (From) se search karo
    if (!contactId) {
      const searchPhone = From !== 'unknown' ? From : To;

      if (searchPhone === 'unknown') {
        throw new Error('No phone number available for contact search');
      }

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

      // ---------- 3b. Contact nahi mila — naya banao ----------
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

    if (!contactId) {
      throw new Error(`No contactId found — cannot add note. From: ${From}, To: ${To}`);
    }

    // ---------- 4. GHL contact note add karo ----------
    const noteBody = `📞 Call Summary (${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })})\nFrom: ${From} → To: ${To}\n\n${summary}\n\n---\n📝 Full Transcript:\n${transcript}`;

    const noteRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          Version: '2021-07-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: noteBody }),
      }
    );

    if (!noteRes.ok) {
      const errText = await noteRes.text();
      throw new Error(`GHL note creation failed: ${errText}`);
    }

    console.log(`Call ${CallSid} summarized and noted — From: ${From}, To: ${To}`);
    return res.status(200).json({ status: 'done', summary });

  } catch (err) {
    console.error('summarize error:', err);
    return res.status(500).json({ error: err.message });
  }
}
