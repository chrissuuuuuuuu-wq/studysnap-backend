// Netlify Function: turns one chunk of extracted notes into reviewer JSON.
// Works with a FREE Google Gemini key (GEMINI_API_KEY) or an Anthropic key (ANTHROPIC_API_KEY).
// Secrets live ONLY in Netlify environment variables - never in the browser or on GitHub:
//   GEMINI_API_KEY     - free key from aistudio.google.com (use this one if you can't pay)
//   ANTHROPIC_API_KEY  - optional alternative
//   ALLOWED_ORIGIN     - websites allowed to call this, comma-separated, no path, no trailing slash
//   GEMINI_MODEL       - optional, defaults to gemini-2.5-flash (change if Google retires it)

const buildPrompt = (text, part, total) =>
  'You are a study assistant. Turn the notes below into a concise study reviewer. ' +
  'Use ONLY information found in the notes; never add outside facts. ' +
  (total > 1 ? 'These notes are part ' + part + ' of ' + total + ' of a longer document; cover only this part. ' : '') +
  'Respond with ONLY a JSON object (no markdown fences) with these keys: ' +
  'title (string), subject (one or two words), chapter (string, or Notes), ' +
  'sections (array of {h: heading, b: array of short bullet strings}, 1 to 4 sections), ' +
  'terms (array of {t: term, d: short definition}, 2 to 6 items), ' +
  'facts (array of short strings: dates, formulas, examples, exceptions that appear in the notes), ' +
  'quick (array of 2 to 3 short final-review strings).\n\n<notes>\n' + text + '\n</notes>';

async function callGemini(key, prompt, signal) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'POST', signal,
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2000 },
    }),
  });
  if (!res.ok) {
    let msg = ''; try { msg = (await res.json()).error.message; } catch (e) {}
    const err = new Error('Gemini API ' + res.status + (msg ? ': ' + msg : '')); err.status = res.status; throw err;
  }
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('');
}

async function callAnthropic(key, prompt, signal) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    let msg = ''; try { msg = (await res.json()).error.message; } catch (e) {}
    const err = new Error('Anthropic API ' + res.status + (msg ? ': ' + msg : '')); err.status = res.status; throw err;
  }
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('');
}

exports.handler = async (event) => {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || '';
  const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  const own = 'https://' + (h.host || h.Host || '');
  const originOk = !!origin && (allowed.includes(origin) || origin === own);
  const cors = originOk ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  } : {};
  const reply = (statusCode, body) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify(body),
  });

  if (event.httpMethod === 'OPTIONS') return { statusCode: originOk ? 204 : 403, headers: cors, body: '' };
  if (origin && !originOk) return reply(403, { error: 'This website is not allowed to use the AI service (check ALLOWED_ORIGIN)' });
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  const geminiKey = process.env.GEMINI_API_KEY, claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !claudeKey) return reply(500, { error: 'No GEMINI_API_KEY or ANTHROPIC_API_KEY is set in Netlify environment variables' });

  let text = '', part = 1, total = 1;
  try {
    const b = JSON.parse(event.body || '{}');
    text = String(b.text || '').slice(0, 8000);
    part = Number(b.part) || 1; total = Number(b.total) || 1;
  } catch (e) { return reply(400, { error: 'Invalid request' }); }
  if (text.length < 20) return reply(400, { error: 'Not enough text' });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8500);
  try {
    const prompt = buildPrompt(text, part, total);
    const raw = geminiKey ? await callGemini(geminiKey, prompt, ctl.signal) : await callAnthropic(claudeKey, prompt, ctl.signal);
    const match = raw.match(/\{[\s\S]*\}/);
    try { return reply(200, JSON.parse(match[0])); }
    catch (e) { return reply(502, { error: 'Unreadable AI response' }); }
  } catch (e) {
    if (e.name === 'AbortError') return reply(504, { error: 'The AI took too long to answer this part' });
    if (e.status) return reply(e.status === 429 ? 429 : 502, { error: e.message });
    return reply(504, { error: 'Network error calling the AI' });
  } finally { clearTimeout(timer); }
};
