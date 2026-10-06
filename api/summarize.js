// ============================================================
// STEP 4: QStash yahan call karta hai (whisper.js ke baad)
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

  // QStash signature verify
  try {
    const isValid = await receiver.verify({
      signature: req.headers['upstash-signature'],
      body: rawBody,
    });
    if (!isValid) return res.status(401).send('Invalid signature');
  } catch (err) {
    console.error('summarize: Signature verification failed:', err);
    return res.status(401).send('Invalid signature');
  }

  const {
    transcript,
    CallSid,
    messageId,
    From: fromPayload,
    To: toPayload,
  } = JSON.parse(rawBody);

  // Transcript missing = permanent failure — 400 se QStash retry nahi karega
  if (!transcript) {
    console.error('summarize: Missing transcript in payload');
    return res.status(400).json({ error: 'Missing transcript' });
  }

  try {
    // ---------- 1. GHL se contactId nikalo ----------
    // From/To payload se lo (transcribe.js ne forward kiye hain)
    // null rakho 'unknown' string nahi — taake phone search sahi kaam kare
    let From = fromPayload || null;
    let To   = toPayload   || null;
    let contactId = null;

    // messageId se GHL conversation message try karo
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
        From      = msg?.from      || From;
        To        = msg?.to        || To;
        contactId = msg?.contactId || null;
        console.log(`summarize: GHL message found — contactId=${contactId}, From=${From}, To=${To}`);
      } else {
        console.warn(`summarize: GHL message fetch failed (${msgRes.status}) — falling back to phone search`);
      }
    }

    console.log(`summarize: After messageId lookup — contactId=${contactId ?? 'null'}, From=${From}, To=${To}`);

    // ---------- 2. GPT se summarize karo ----------
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY env variable missing');
    }

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
              'You are a sales call summarizer. Summarize the call transcript into 3-4 concise bullet points highlighting key discussion points and next steps.',
          },
          { role: 'user', content: transcript },
        ],
      }),
    });

    if (!gptRes.ok) {
      const errText = await gptRes.text();
      throw new Error(`GPT failed (${gptRes.status}): ${errText}`);
    }

    const gptData = await gptRes.json();
    const summary = gptData?.choices?.[0]?.message?.content;

    if (!summary) {
      throw new Error('GPT returned empty summary');
    }

    console.log(`summarize: GPT done — summary length=${summary.length} chars`);

    // ---------- 3. contactId nahi mila — phone number se search karo ----------
    if (!contactId) {
      // Inbound: From = customer, Outbound: To = customer — dono try karo
      const searchPhone = From || To || null;

      if (!searchPhone) {
        throw new Error(
          'No phone number available — From and To both null, cannot find GHL contact'
        );
      }

      console.log(`summarize: Searching GHL contact by phone=${searchPhone}`);

      // IMPORTANT: /contacts/search/duplicate ke liye correct version = 2021-04-15
      const searchRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&phone=${encodeURIComponent(searchPhone)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${process.env.GHL_API_KEY}`,
            Version: '2021-04-15',
          },
        }
      );

      if (searchRes.ok) {
        const searchData = await searchRes.json();
        contactId = searchData?.contact?.id || null;
        console.log(`summarize: Phone search result — contactId=${contactId ?? 'not found'}`);
      } else {
        const errText = await searchRes.text();
        console.warn(`summarize: GHL phone search failed (${searchRes.status}): ${errText}`);
      }

      // ---------- 4. Contact nahi mila — naya banao ----------
      if (!contactId) {
        console.log(`summarize: Creating new GHL contact — phone=${searchPhone}`);

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
          throw new Error(`GHL contact create failed (${createRes.status}): ${errText}`);
        }

        const createData = await createRes.json();
        contactId = createData?.contact?.id || null;
        console.log(`summarize: New contact created — contactId=${contactId}`);
      }
    }

    if (!contactId) {
      throw new Error(
        `No contactId found — cannot add note. From=${From}, To=${To}`
      );
    }

    // ---------- 5. GHL contact mein note add karo ----------
    const timestamp = new Date().toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
    });

    const noteBody = [
      `📞 Call Summary (${timestamp})`,
      `From: ${From ?? 'unknown'} → To: ${To ?? 'unknown'}`,
      '',
      summary,
      '',
      '---',
      '📝 Full Transcript:',
      transcript,
    ].join('\n');

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
      throw new Error(`GHL note creation failed (${noteRes.status}): ${errText}`);
    }

    console.log(
      `summarize: Note added successfully — contactId=${contactId}, CallSid=${CallSid ?? 'unknown'}`
    );
    return res.status(200).json({ status: 'done', summary });

  } catch (err) {
    console.error('summarize error:', err.message);
    // 500 taake QStash retry kare — transient failures ke liye
    return res.status(500).json({ error: err.message });
  }
}
