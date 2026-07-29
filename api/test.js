// Test endpoint — GHL aur QStash APIs check karne ke liye
// URL: https://twiliovoicecode.vercel.app/api/test

export default async function handler(req, res) {
  const results = {};

  // ---------- 1. ENV Variables check ----------
  results.env = {
    QSTASH_TOKEN:        process.env.QSTASH_TOKEN        ? '✅ Set' : '❌ Missing',
    OPENAI_API_KEY:      process.env.OPENAI_API_KEY      ? '✅ Set' : '❌ Missing',
    TWILIO_SID:          process.env.TWILIO_SID          ? '✅ Set' : '❌ Missing',
    TWILIO_AUTH_TOKEN:   process.env.TWILIO_AUTH_TOKEN   ? '✅ Set' : '❌ Missing',
    GHL_API_KEY:         process.env.GHL_API_KEY         ? '✅ Set' : '❌ Missing',
    GHL_LOCATION_ID:     process.env.GHL_LOCATION_ID     ? '✅ Set' : '❌ Missing',
    PUBLIC_APP_URL:      process.env.PUBLIC_APP_URL      ? '✅ Set' : '❌ Missing',
    QSTASH_CURRENT_KEY:  process.env.QSTASH_CURRENT_SIGNING_KEY ? '✅ Set' : '❌ Missing',
    QSTASH_NEXT_KEY:     process.env.QSTASH_NEXT_SIGNING_KEY    ? '✅ Set' : '❌ Missing',
  };

  // ---------- 2. GHL API check ----------
  try {
    const ghlRes = await fetch(
      `https://services.leadconnectorhq.com/locations/${process.env.GHL_LOCATION_ID}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          Version: '2021-07-28',
        },
      }
    );
    results.ghl = {
      status: ghlRes.status,
      ok: ghlRes.ok ? '✅ Connected' : '❌ Failed',
    };
  } catch (err) {
    results.ghl = { error: err.message };
  }

  // ---------- 3. OpenAI API check ----------
  try {
    const openaiRes = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    results.openai = {
      status: openaiRes.status,
      ok: openaiRes.ok ? '✅ Connected' : '❌ Failed',
    };
  } catch (err) {
    results.openai = { error: err.message };
  }

  return res.status(200).json(results);
}
