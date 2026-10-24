'use strict';

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TRANSCRIBE_MODEL = 'gemini-3.5-flash';

/**
 * Reads GEMINI_API_KEY from the environment or from clicky-windows/.env
 * (git-ignored). Returns '' when no key is configured.
 */
function getApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.*)\s*$/);
      if (match) return match[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch {
    // No .env file.
  }
  return '';
}

function hasApiKey() {
  return getApiKey() !== '';
}

function safeModel(model) {
  return /^gemini-[a-z0-9.\-]+$/i.test(model || '') ? model : 'gemini-3.5-flash';
}

async function readError(response) {
  const body = await response.text().catch(() => '');
  return `HTTP ${response.status}: ${body.slice(0, 300)}`;
}

/** Visible text from a Gemini response chunk, skipping "thought" parts. */
function extractText(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('');
}

/**
 * Streams a Gemini answer directly from the Gemini API.
 * `history` is [{userTranscript, assistantResponse}], `images` is [{data: Buffer, label}].
 */
async function streamChat({ model, systemPrompt, history, images, userPrompt, signal, onText }) {
  const contents = [];
  for (const entry of history) {
    contents.push({ role: 'user', parts: [{ text: entry.userTranscript }] });
    contents.push({ role: 'model', parts: [{ text: entry.assistantResponse }] });
  }

  const parts = [];
  for (const image of images) {
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: image.data.toString('base64') } });
    parts.push({ text: image.label });
  }
  parts.push({ text: userPrompt });
  contents.push({ role: 'user', parts });

  const response = await fetch(`${API_BASE}/${safeModel(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'x-goog-api-key': getApiKey(), 'content-type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: 4096 },
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed (${await readError(response)})`);
  }

  const decoder = new TextDecoder();
  let buffered = '';
  let accumulated = '';

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    const text = extractText(chunk);
    if (text) {
      accumulated += text;
      onText?.(accumulated);
    }
  };

  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    lines.forEach(handleLine);
  }
  if (buffered) handleLine(buffered);

  return accumulated;
}

/** Transcribes a recorded clip (base64) with Gemini. */
async function transcribe({ data, mime, signal }) {
  const response = await fetch(`${API_BASE}/${TRANSCRIBE_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': getApiKey(), 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'Transcribe this audio exactly. Reply with only the spoken words, no commentary. ' +
                'If there is no speech, reply with an empty string.',
            },
            { inline_data: { mime_type: mime, data } },
          ],
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Transcription failed (${await readError(response)})`);
  }
  return extractText(await response.json()).trim();
}

module.exports = { hasApiKey, streamChat, transcribe };
