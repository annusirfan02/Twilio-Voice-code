// ============================================================
// STEP 3: QStash yahan call karta hai (process-call.js ke baad)
// Kaam: Twilio se audio download karo, chunks mein todo (agar badi file ho),
//       har chunk Whisper se transcribe karo (parallel), join karo,
//       phir summarize.js ko QStash ke zariye bhejo
//
// Chunking logic:
//   - Agar audio > 10 MB ho toh chunks mein todo (Whisper limit 25MB hai)
//   - Har chunk max 8 MB — Whisper ke liye safe size
//   - MP3 ID3 header har chunk ke saath copy hota hai — valid MP3 banti hai
//   - Chunks parallel process hote hain — time bachta hai
//   - Transcripts order mein join hote hain
// ============================================================

import fetch from 'node-fetch';
import FormData from 'form-data';
import { Receiver, Client } from '@upstash/qstash';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

const qstash = new Client({
  token: process.env.QSTASH_TOKEN,
  // EU region ke liye baseUrl explicitly set karo
  ...(process.env.QSTASH_URL && { baseUrl: process.env.QSTASH_URL }),
});

// Agar audio > yeh size ho toh chunks mein toro
const CHUNK_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB

// Har chunk ki max size — 8MB safe hai Whisper ke liye (hard limit 25MB)
const MAX_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB

export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// MP3 ID3v2 header ka size nikalo
// ID3v2 header format: "ID3" + version(2) + flags(1) + size(4 syncsafe bytes)
function getID3HeaderSize(buffer) {
  // ID3v2 header check
  if (
    buffer.length >= 10 &&
    buffer[0] === 0x49 && // 'I'
    buffer[1] === 0x44 && // 'D'
    buffer[2] === 0x33    // '3'
  ) {
    // Size 4 syncsafe bytes mein hai (each byte max 0x7F)
    const size =
      ((buffer[4] & 0x7f) << 21) |
      ((buffer[5] & 0x7f) << 14) |
      ((buffer[6] & 0x7f) << 7)  |
       (buffer[7] & 0x7f);
    return 10 + size; // 10 = header itself
  }
  return 0; // Koi ID3 header nahi
}

// Buffer ko chunks mein toro — har chunk ke saath original ID3 header copy karo
// Taake Whisper har chunk ko valid MP3 file samjhe
function splitBufferIntoChunks(buffer, maxChunkSize) {
  const id3Size = getID3HeaderSize(buffer);
  const id3Header = id3Size > 0 ? buffer.slice(0, id3Size) : null;

  const chunks = [];
  let offset = id3Size; // ID3 header ke baad se shuru karo

  while (offset < buffer.byteLength) {
    const audioEnd = Math.min(offset + maxChunkSize, buffer.byteLength);
    const audioSlice = buffer.slice(offset, audioEnd);

    // Har chunk mein ID3 header + audio data — valid MP3 banti hai
    const chunkBuffer = id3Header
      ? Buffer.concat([id3Header, audioSlice])
      : audioSlice;

    chunks.push(chunkBuffer);
    offset = audioEnd;
  }

  return chunks;
}

// Ek chunk ko Whisper se transcribe karo
async function transcribeChunk(audioBuffer, chunkIndex, totalChunks, callId) {
  const form = new FormData();
  form.append('file', audioBuffer, {
    filename: `call_chunk_${chunkIndex + 1}.mp3`,
    contentType: 'audio/mpeg',
  });
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!whisperRes.ok) {
    const errText = await whisperRes.text();
    throw new Error(
      `Whisper failed on chunk ${chunkIndex + 1}/${totalChunks} (${whisperRes.status}): ${errText}`
    );
  }

  const data = await whisperRes.json();
  const text = data?.text || '';

  console.log(
    `whisper: Chunk ${chunkIndex + 1}/${totalChunks} done — callId=${callId ?? 'unknown'}, chars=${text.length}`
  );

  return text;
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
    console.error('whisper: Signature verification failed:', err);
    return res.status(401).send('Invalid signature');
  }

  const { audioUrl, callId, messageId, From, To } = JSON.parse(rawBody);

  if (!audioUrl) {
    console.warn('whisper: No audioUrl in payload');
    return res.status(400).json({ error: 'Missing audioUrl' });
  }

  // Env variables early check — clear error agar missing ho
  if (!process.env.TWILIO_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.error('whisper: TWILIO_SID or TWILIO_AUTH_TOKEN missing');
    return res.status(500).json({ error: 'Twilio credentials not configured in env' });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('whisper: OPENAI_API_KEY missing');
    return res.status(500).json({ error: 'OpenAI API key not configured in env' });
  }

  // Twilio auth env se banao — payload mein credentials nahi jaani chahiye
  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  try {
    // ---------- 1. Twilio se audio download ----------
    console.log(`whisper: Downloading audio — callId=${callId ?? 'unknown'}, url=${audioUrl}`);

    const audioRes = await fetch(audioUrl, {
      headers: { Authorization: `Basic ${twilioAuth}` },
    });

    if (!audioRes.ok) {
      throw new Error(`Audio download failed (${audioRes.status}) — url=${audioUrl}`);
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    if (audioBuffer.byteLength === 0) {
      throw new Error(`Empty audio file downloaded — callId=${callId ?? 'unknown'}`);
    }

    const audioSizeMB = (audioBuffer.byteLength / 1024 / 1024).toFixed(2);
    console.log(`whisper: Audio downloaded — callId=${callId ?? 'unknown'}, size=${audioSizeMB} MB`);

    // ---------- 2. Chunking decision ----------
    let transcript = '';

    if (audioBuffer.byteLength <= CHUNK_THRESHOLD_BYTES) {
      // Chhoti file (<=10 MB) — seedha Whisper ko bhejo
      console.log(`whisper: File ${audioSizeMB} MB <= 10 MB, sending directly to Whisper`);
      transcript = await transcribeChunk(audioBuffer, 0, 1, callId);

    } else {
      // Badi file (>10 MB) — 8MB chunks mein todo aur parallel bhejo
      // splitBufferIntoChunks ID3 header har chunk mein copy karta hai
      const chunks = splitBufferIntoChunks(audioBuffer, MAX_CHUNK_BYTES);
      console.log(
        `whisper: File ${audioSizeMB} MB > 10 MB — splitting into ${chunks.length} chunks (with ID3 header on each)`
      );

      // Parallel transcription — order preserve hota hai Promise.all mein
      const transcriptParts = await Promise.all(
        chunks.map((chunk, i) => transcribeChunk(chunk, i, chunks.length, callId))
      );

      // Parts ko space se join karo — smooth transcript banta hai
      transcript = transcriptParts.join(' ').trim();
      console.log(
        `whisper: All ${chunks.length} chunks transcribed — total chars=${transcript.length}`
      );
    }

    if (!transcript || transcript.trim().length === 0) {
      throw new Error(`Whisper returned empty transcript — callId=${callId ?? 'unknown'}`);
    }

    // ---------- 3. summarize.js ko QStash ke zariye bhejo ----------
    const summarizeOptions = {
      url: `${process.env.PUBLIC_APP_URL}/api/summarize`,
      body: { transcript, CallSid: callId, messageId, From, To },
      retries: 3,
    };
    if (callId) summarizeOptions.deduplicationId = `summarize-${callId}`;

    await qstash.publishJSON(summarizeOptions);

    console.log(`whisper: Queued summarize job — callId=${callId ?? 'unknown'}`);
    return res.status(200).json({ status: 'transcribed, queued for summary' });

  } catch (err) {
    console.error('whisper error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
