// api/transcribe.js
// Vercel Serverless Function
// Receives a POST request from Zapier, does the heavy lifting
// (Twilio download -> Whisper transcription -> GPT summary),
// then calls back to a Zapier "Catch Hook" webhook with the result.
//
// This has NO 30-second limit like Zapier Code steps do, so it safely
// handles long calls (7+ minutes and beyond).

export const config = {
  maxDuration: 60, // Vercel Hobby (free) plan max — see README for Pro plan option
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const {
    twilioSid,
    twilioToken,
    recordingSid,
    openaiKey,
    callbackUrl, // Zapier "Catch Hook" URL to send the final result to
  } = req.body || {};

  // Basic validation
  const missing = [];
  if (!twilioSid) missing.push('twilioSid');
  if (!twilioToken) missing.push('twilioToken');
  if (!recordingSid) missing.push('recordingSid');
  if (!openaiKey) missing.push('openaiKey');
  if (!callbackUrl) missing.push('callbackUrl');

  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  // Respond to Zapier immediately so Zapier's own step doesn't wait/timeout.
  // The real work continues after this response is sent (Vercel keeps the
  // function alive until the async work below finishes, up to maxDuration).
  res.status(202).json({ status: 'processing_started' });

  try {
    // ---------- 1. Download recording from Twilio ----------
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Recordings/${recordingSid}.mp3`;
    const authHeader = 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');

    const recordingResponse = await fetch(twilioUrl, {
      headers: { Authorization: authHeader },
    });

    if (!recordingResponse.ok) {
      const errText = await recordingResponse.text();
      throw new Error(`Twilio download failed: ${recordingResponse.status} ${errText}`);
    }

    const audioBuffer = await recordingResponse.arrayBuffer();

    // ---------- 2. Transcribe with OpenAI Whisper ----------
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), `${recordingSid}.mp3`);
    formData.append('model', 'whisper-1');

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: formData,
    });

    if (!whisperResponse.ok) {
      const errText = await whisperResponse.text();
      throw new Error(`Whisper transcription failed: ${whisperResponse.status} ${errText}`);
    }

    const whisperResult = await whisperResponse.json();
    const transcript = whisperResult.text;

    // ---------- 3. Summarize with GPT ----------
    const systemPrompt = `You are analyzing a sales closing call. Summarize the call using ONLY the following format:

**1. 👤 Client Background**
- Name, job, family situation, and any relevant background info mentioned

**2. 🚧 Blocks / Challenges / Problems**
- What problems, pain points, or challenges did they mention?
- What do they need help with?

**3. 🎯 Goals / Desires / Timeframe**
- What are they trying to achieve?
- Any deadlines or urgency mentioned?

**4. 💼 Programs Pitched & Offers**
- What program(s) were presented?
- What bonuses or special offers were mentioned?

**5. ❌ Objections**
- What objections or hesitations did the client raise?

**6. 📊 Outcome**
- Win (sold) / Follow Up (next steps) / Lost (did not buy)
- Any specific next steps or follow-up date mentioned?`;

    const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // swap to 'gpt-4o' if you need higher quality and have the time budget
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Here is the call transcript:\n\n${transcript}` },
        ],
        temperature: 0.3,
      }),
    });

    if (!gptResponse.ok) {
      const errText = await gptResponse.text();
      throw new Error(`GPT summarization failed: ${gptResponse.status} ${errText}`);
    }

    const gptResult = await gptResponse.json();
    const summary = gptResult.choices[0].message.content;

    // ---------- 4. Send result back to Zapier ----------
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recordingSid,
        transcript,
        summary,
        status: 'success',
      }),
    });

  } catch (error) {
    // On failure, still notify Zapier so you know it failed (and can alert/retry)
    try {
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordingSid,
          status: 'error',
          error: error.message,
        }),
      });
    } catch (callbackError) {
      console.error('Failed to send error callback to Zapier:', callbackError);
    }

    console.error('Transcription pipeline error:', error);
  }
}
