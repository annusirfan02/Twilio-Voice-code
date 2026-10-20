// ============================================================
// STEP 4: QStash yahan call karta hai (whisper.js ke baad)
// Kaam: GHL messageId se contact dhundho, GPT se summarize karo,
//       contact mein note add karo
// ============================================================

import fetch from 'node-fetch';
import { Receiver } from '@upstash/qstash';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

const GHL_BASE = 'https://services.leadconnectorhq.com';

export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function ghlHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: '2021-07-28',
    ...extra,
  };
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

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { transcript, RecordingSid, messageId } = payload;

  // Transcript/messageId missing = permanent failure — 400 se QStash retry nahi karega
  if (!transcript || !messageId) {
    console.error('summarize: Missing transcript or messageId in payload');
    return res.status(400).json({ error: 'Missing transcript or messageId' });
  }

  try {
    // ---------- 1. GHL messageId se contactId nikalo ----------
    // GPT se pehle — taake contact na mile toh GPT ka paisa waste na ho
    const msgRes = await fetch(`${GHL_BASE}/conversations/messages/${messageId}`, {
      headers: ghlHeaders(),
    });

    if (!msgRes.ok) {
      const errText = await msgRes.text();
      throw new Error(`GHL message fetch failed (${msgRes.status}): ${errText}`);
    }

    const msgData = await msgRes.json();
    const msg = msgData?.message || msgData;
    const contactId = msg?.contactId || null;

    if (!contactId) {
      throw new Error(`No contactId on GHL message ${messageId}`);
    }

    console.log(`summarize: GHL message found — contactId=${contactId}`);

    // ---------- 2. Is recording ka note pehle se hai? (QStash retry pe duplicate na bane) ----------
    const marker = `Recording: ${RecordingSid}`;
    const notesRes = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
      headers: ghlHeaders(),
    });
    if (notesRes.ok) {
      const notesData = await notesRes.json();
      if (notesData?.notes?.some((n) => n?.body?.includes(marker))) {
        console.log(`summarize: Note already exists — contactId=${contactId}, ${marker}`);
        return res.status(200).json({ status: 'already done' });
      }
    }

    // ---------- 3. GPT se summarize karo ----------
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

    // ---------- 4. GHL contact mein note add karo ----------
    const timestamp = new Date().toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
    });

    const noteBody = [
      `📞 Call Summary (${timestamp})`,
      '',
      summary,
      '',
      '---',
      '📝 Full Transcript:',
      transcript,
      '',
      marker,
    ].join('\n');

    const noteRes = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: ghlHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ body: noteBody }),
    });

    if (!noteRes.ok) {
      const errText = await noteRes.text();
      throw new Error(`GHL note creation failed (${noteRes.status}): ${errText}`);
    }

    console.log(`summarize: Note added successfully — contactId=${contactId}, ${marker}`);
    return res.status(200).json({ status: 'done', summary });

  } catch (err) {
    console.error('summarize error:', err.message);
    // 500 taake QStash retry kare — transient failures ke liye
    return res.status(500).json({ error: err.message });
  }
}
