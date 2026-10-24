'use strict';

const settings = require('./settings');

function baseUrl() {
  const url = settings.load().workerUrl;
  if (!url) {
    throw new Error('No Worker URL set. Open the Clicky panel from the system tray and paste your Cloudflare Worker URL.');
  }
  return url;
}

async function readError(response) {
  const body = await response.text().catch(() => '');
  return `HTTP ${response.status}: ${body.slice(0, 300)}`;
}

/**
 * Streams a Claude response through the Worker's /chat route.
 * Calls onText with the accumulated text after every chunk.
 */
async function streamChat({ model, systemPrompt, history, images, userPrompt, signal, onText }) {
  const messages = [];
  for (const entry of history) {
    messages.push({ role: 'user', content: entry.userTranscript });
    messages.push({ role: 'assistant', content: entry.assistantResponse });
  }

  const content = [];
  for (const image of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: image.data.toString('base64') },
    });
    content.push({ type: 'text', text: image.label });
  }
  content.push({ type: 'text', text: userPrompt });
  messages.push({ role: 'user', content });

  const response = await fetch(`${baseUrl()}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1024, stream: true, system: systemPrompt, messages }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Claude request failed (${await readError(response)})`);
  }

  // Server-sent events: each event is "data: {json}" on its own line.
  const decoder = new TextDecoder();
  let buffered = '';
  let accumulated = '';

  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        accumulated += event.delta.text;
        onText?.(accumulated);
      } else if (event.type === 'error') {
        throw new Error(`Claude stream error: ${event.error?.message ?? 'unknown'}`);
      }
    }
  }

  return accumulated;
}

/** Returns mp3 bytes for the given text via the Worker's /tts route. */
async function synthesizeSpeech(text, signal) {
  const response = await fetch(`${baseUrl()}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_flash_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Text-to-speech failed (${await readError(response)})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Fetches a short-lived AssemblyAI streaming token via the Worker. */
async function fetchTranscriptionToken() {
  const response = await fetch(`${baseUrl()}/transcribe-token`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Could not get transcription token (${await readError(response)})`);
  }
  const json = await response.json();
  if (!json.token) throw new Error('Transcription token response was missing a token.');
  return json.token;
}

module.exports = { streamChat, synthesizeSpeech, fetchTranscriptionToken };
