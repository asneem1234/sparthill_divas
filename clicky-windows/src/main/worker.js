'use strict';

const settings = require('./settings');
const gemini = require('./gemini');

/**
 * Two modes:
 *  - Worker URL set in the panel: requests go through the Cloudflare Worker.
 *  - Otherwise, if GEMINI_API_KEY is available (env or clicky-windows/.env),
 *    the app calls Gemini directly. No deployment needed.
 */
function useDirect() {
  return !settings.load().workerUrl && gemini.hasApiKey();
}

function baseUrl() {
  const url = settings.load().workerUrl;
  if (!url) {
    throw new Error(
      'No Gemini access configured. Put GEMINI_API_KEY in clicky-windows/.env, or paste a Worker URL in the ClickIt panel.'
    );
  }
  return url;
}

async function readError(response) {
  const body = await response.text().catch(() => '');
  return `HTTP ${response.status}: ${body.slice(0, 300)}`;
}

/**
 * Streams a Gemini response through the Worker's /chat route.
 * Calls onText with the accumulated text after every chunk.
 */
async function streamChat(args) {
  if (useDirect()) return gemini.streamChat(args);
  return streamChatViaWorker(args);
}

async function streamChatViaWorker({ model, systemPrompt, history, images, userPrompt, signal, onText }) {
  const messages = [];
  
  // Add conversation history
  for (const entry of history) {
    messages.push({ role: 'user', content: entry.userTranscript });
    messages.push({ role: 'assistant', content: entry.assistantResponse });
  }

  // Build current message with images and text
  const content = [];
  
  for (const image of images) {
    content.push({
      type: 'image',
      source: { 
        type: 'base64', 
        media_type: 'image/jpeg', 
        data: image.data.toString('base64') 
      },
    });
    content.push({ type: 'text', text: image.label });
  }
  
  content.push({ type: 'text', text: userPrompt });
  messages.push({ role: 'user', content });

  const response = await fetch(`${baseUrl()}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ 
      model, 
      max_tokens: 1024, 
      stream: true, 
      system: systemPrompt, 
      messages 
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed (${await readError(response)})`);
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
        throw new Error(`Gemini stream error: ${event.error?.message ?? 'unknown'}`);
      }
    }
  }

  return accumulated;
}

/** Transcribes a recorded clip (base64) via the Worker's /transcribe route. */
async function transcribe({ data, mime, signal }) {
  if (useDirect()) return gemini.transcribe({ data, mime, signal });
  const response = await fetch(`${baseUrl()}/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data, mime }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Transcription failed (${await readError(response)})`);
  }
  const json = await response.json();
  return typeof json.text === 'string' ? json.text : '';
}

module.exports = { streamChat, transcribe };
