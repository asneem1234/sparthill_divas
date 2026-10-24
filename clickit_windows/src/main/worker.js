// Client for the Cloudflare Worker proxy (clicky/worker). The app never calls
// an AI provider directly, so no API keys live in this app.
//
// Routes the repo's worker currently serves:
//   POST /chat        Anthropic-style body -> SSE of content_block_delta text_delta events
//   POST /transcribe  { data: base64 audio, mime } -> { text }
// /tts is optional (the original macOS app used ElevenLabs through it). When the
// worker doesn't have it, speech falls back to the Windows system voice.

// Gemini 2.5 models spend part of this budget on hidden "thinking" before they
// answer, so a small cap can cut a reply off or leave it empty. The cap only
// prevents truncation: it doesn't make replies longer.
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Pulls the human-readable "message" out of a Gemini error body, if there is one. */
function extractErrorMessage(errorText) {
  const jsonStart = errorText.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsedBody = JSON.parse(errorText.slice(jsonStart));
      const message = parsedBody.error && parsedBody.error.message;
      if (typeof message === 'string') return message;
    } catch (parseError) {
      // Fall through to the raw text.
    }
  }
  return errorText;
}

/** Removes anything that looks like an API key, so a key can never end up in a message shown to the user. */
function scrubSecrets(text) {
  return String(text)
    .replace(/\bAQ\.[A-Za-z0-9_-]{16,}/g, '[hidden]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[hidden]')
    .replace(/([?&]key=)[^&\s"]+/gi, '$1[hidden]');
}

/** Turns a failed worker request into a message a person can act on. Never contains key names, file paths or keys. */
function describeWorkerError(error, workerBaseUrl) {
  return scrubSecrets(describeWorkerErrorUnscrubbed(error, workerBaseUrl));
}

function describeWorkerErrorUnscrubbed(error, workerBaseUrl) {
  const errorDetails = String((error && (error.cause || error.message)) || error);
  if (error instanceof TypeError || /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(errorDetails)) {
    return `Couldn't reach the worker at ${workerBaseUrl}. Is it running? Check the Worker field in the panel.`;
  }

  const errorText = String(error && error.message ? error.message : error);
  const statusMatch = /\((\d{3})\)/.exec(errorText);
  const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
  const detailMessage = extractErrorMessage(errorText);

  if (statusCode === 429) {
    const retryMatch = /retry in ([\d.]+)s/i.exec(detailMessage);
    const waitText = retryMatch ? ` Try again in about ${Math.ceil(Number(retryMatch[1]))} seconds.` : ' Wait a minute and try again.';
    return `Gemini's request limit was reached.${waitText}`;
  }
  if (/API key not valid|API_KEY_INVALID/i.test(detailMessage)) {
    return 'Gemini rejected the request (credentials). Check the worker setup, then restart the worker.';
  }
  if (statusCode === 404) {
    return `Gemini doesn't offer that model: ${detailMessage.slice(0, 160)}`;
  }
  if (statusCode === 403) {
    return `Gemini refused the request (permission): ${detailMessage.slice(0, 160)}`;
  }
  if (statusCode === 500 || statusCode === 503) {
    return 'Gemini is busy or having trouble right now. Try again in a moment.';
  }
  return detailMessage.slice(0, 300);
}

class WorkerClient {
  /** @param {() => string} getWorkerBaseUrl */
  constructor(getWorkerBaseUrl) {
    this.getWorkerBaseUrl = getWorkerBaseUrl;
    this.hasStartedConnectionWarmup = false;
    this.isTextToSpeechRouteUnavailable = false;
  }

  buildUrl(routePath) {
    const trimmedBaseUrl = this.getWorkerBaseUrl().trim().replace(/\/+$/, '');
    return `${trimmedBaseUrl}${routePath}`;
  }

  /** Called when the user changes the worker URL, so TTS support is re-probed. */
  resetRouteAvailability() {
    this.isTextToSpeechRouteUnavailable = false;
    this.hasStartedConnectionWarmup = false;
  }

  /**
   * Fire-and-forget request that opens the TLS/TCP connection early so the first
   * real call (which carries large screenshots) doesn't pay for a cold handshake.
   */
  warmUpConnectionIfNeeded() {
    if (this.hasStartedConnectionWarmup) return;
    this.hasStartedConnectionWarmup = true;

    let warmupUrl;
    try {
      const parsedUrl = new URL(this.buildUrl('/'));
      parsedUrl.pathname = '/';
      warmupUrl = parsedUrl.toString();
    } catch (error) {
      return;
    }

    fetch(warmupUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) }).catch(() => {
      // The response doesn't matter, the connection setup is the goal.
    });
  }

  /** Detects the image MIME type from the first bytes (PNG signature vs JPEG). */
  detectImageMediaType(imageBuffer) {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47];
    if (imageBuffer.length >= 4 && pngSignature.every((byte, index) => imageBuffer[index] === byte)) {
      return 'image/png';
    }
    return 'image/jpeg';
  }

  /**
   * Sends a vision request with streaming. Calls onTextChunk with the full text
   * accumulated so far each time new text arrives.
   *
   * @param {object} requestOptions
   * @param {{imageBuffer: Buffer, label: string}[]} requestOptions.images
   * @param {string} requestOptions.systemPrompt
   * @param {string} requestOptions.model
   * @param {{userTranscript: string, assistantResponse: string}[]} [requestOptions.conversationHistory]
   * @param {string} requestOptions.userPrompt
   * @param {(accumulatedText: string) => void} [requestOptions.onTextChunk]
   * @param {AbortSignal} [requestOptions.abortSignal]
   * @param {number} [requestOptions.maxTokens]
   */
  async analyzeImageStreaming({
    images,
    systemPrompt,
    model,
    conversationHistory = [],
    userPrompt,
    onTextChunk = () => {},
    abortSignal,
    maxTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  }) {
    const startTimeMilliseconds = Date.now();
    const messages = [];

    for (const historyEntry of conversationHistory) {
      messages.push({ role: 'user', content: historyEntry.userTranscript });
      messages.push({ role: 'assistant', content: historyEntry.assistantResponse });
    }

    // Current message: every labeled image followed by the prompt.
    const contentBlocks = [];
    for (const image of images) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: this.detectImageMediaType(image.imageBuffer),
          data: image.imageBuffer.toString('base64'),
        },
      });
      contentBlocks.push({ type: 'text', text: image.label });
    }
    contentBlocks.push({ type: 'text', text: userPrompt });
    messages.push({ role: 'user', content: contentBlocks });

    const requestBody = JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      system: systemPrompt,
      messages,
    });
    console.log(`[ClickIt] Chat streaming request: ${(requestBody.length / 1048576).toFixed(1)}MB, ${images.length} image(s)`);

    const timeoutSignal = AbortSignal.timeout(300000);
    const combinedSignal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;

    const response = await fetch(this.buildUrl('/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
      signal: combinedSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`API Error (${response.status}): ${errorBody}`);
    }

    // SSE stream: each event is "data: {json}\n\n".
    const textDecoder = new TextDecoder();
    const streamReader = response.body.getReader();
    let unprocessedText = '';
    let accumulatedResponseText = '';
    let hasReachedEndOfStream = false;

    const processLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const jsonString = line.slice(5).trim();
      if (jsonString === '[DONE]') {
        hasReachedEndOfStream = true;
        return;
      }

      let eventPayload;
      try {
        eventPayload = JSON.parse(jsonString);
      } catch (error) {
        return;
      }

      // Only content_block_delta events carry text chunks.
      if (
        eventPayload.type === 'content_block_delta' &&
        eventPayload.delta &&
        eventPayload.delta.type === 'text_delta' &&
        typeof eventPayload.delta.text === 'string'
      ) {
        accumulatedResponseText += eventPayload.delta.text;
        onTextChunk(accumulatedResponseText);
      }
    };

    while (!hasReachedEndOfStream) {
      const { done, value } = await streamReader.read();
      if (done) break;
      unprocessedText += textDecoder.decode(value, { stream: true });
      const completeLines = unprocessedText.split('\n');
      unprocessedText = completeLines.pop() ?? '';
      for (const completeLine of completeLines) processLine(completeLine);
    }
    if (unprocessedText) processLine(unprocessedText);

    return { text: accumulatedResponseText, durationSeconds: (Date.now() - startTimeMilliseconds) / 1000 };
  }

  /** Uploads a WAV recording and returns the transcript text ('' when silent). */
  async transcribeWavAudio(wavAudioBuffer, abortSignal) {
    const timeoutSignal = AbortSignal.timeout(45000);
    const combinedSignal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;

    const response = await fetch(this.buildUrl('/transcribe'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: wavAudioBuffer.toString('base64'), mime: 'audio/wav' }),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Transcription failed (${response.status}): ${errorBody}`);
    }

    const responseJson = await response.json();
    return typeof responseJson.text === 'string' ? responseJson.text.trim() : '';
  }

  /**
   * Asks the worker for spoken audio. Returns an MP3 Buffer, or null when the
   * worker has no /tts route (or it failed), so the caller can use the system voice.
   */
  async synthesizeSpeech(textToSpeak, abortSignal) {
    if (this.isTextToSpeechRouteUnavailable) return null;

    try {
      const timeoutSignal = AbortSignal.timeout(30000);
      const combinedSignal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;

      const response = await fetch(this.buildUrl('/tts'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: textToSpeak,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: combinedSignal,
      });

      if (!response.ok) {
        if (response.status === 404 || response.status === 405 || response.status === 501) {
          this.isTextToSpeechRouteUnavailable = true;
          console.log('[ClickIt] Worker has no /tts route, using the Windows system voice.');
        } else {
          console.warn(`[ClickIt] TTS API error (${response.status}), using the Windows system voice.`);
        }
        return null;
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (abortSignal && abortSignal.aborted) throw error;
      console.warn('[ClickIt] TTS request failed, using the Windows system voice:', error.message);
      return null;
    }
  }
}

module.exports = { WorkerClient, describeWorkerError };
