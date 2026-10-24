/**
 * ClickIt Proxy Worker
 *
 * Proxies requests to the Google Gemini API so the app never ships with a
 * raw API key. The key is stored as a Cloudflare secret.
 *
 * Routes:
 *   POST /chat        -> Gemini streamGenerateContent (re-emitted as SSE text deltas)
 *   POST /transcribe  -> Gemini generateContent with audio, returns { text }
 */

interface Env {
  GEMINI_API_KEY: string;
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash";
const TRANSCRIBE_MODEL = "gemini-3.5-flash";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      if (url.pathname === "/chat") return await handleChat(request, env);
      if (url.pathname === "/transcribe") return await handleTranscribe(request, env);
    } catch (error) {
      console.error(`[${url.pathname}] Unhandled error:`, error);
      return jsonResponse({ error: String(error) }, 500);
    }

    return new Response("Not found", { status: 404 });
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Only allow plain Gemini model ids so the value can't alter the request path. */
function safeModel(requested: unknown, fallback: string): string {
  return typeof requested === "string" && /^gemini-[a-z0-9.\-]+$/i.test(requested)
    ? requested
    : fallback;
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as any;
  const model = safeModel(body.model, DEFAULT_MODEL);

  const response = await fetch(`${API_BASE}/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(toGeminiRequest(body)),
  });

  if (!response.ok || !response.body) {
    const errorBody = await response.text();
    console.error(`[/chat] Gemini API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status || 502,
      headers: { "content-type": "application/json" },
    });
  }

  return geminiSseToTextDeltas(response.body);
}

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  const { data, mime } = (await request.json()) as { data?: string; mime?: string };
  if (!data || !mime) return jsonResponse({ error: "data and mime are required" }, 400);

  const response = await fetch(`${API_BASE}/${TRANSCRIBE_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Transcribe this audio exactly. Reply with only the spoken words, no commentary. " +
                "If there is no speech, reply with an empty string.",
            },
            { inline_data: { mime_type: mime, data } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/transcribe] Gemini API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  const result = (await response.json()) as any;
  return jsonResponse({ text: extractText(result).trim() });
}

/** Concatenates visible text parts, skipping Gemini "thought" parts. */
function extractText(chunk: any): string {
  const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part: any) => typeof part.text === "string" && !part.thought)
    .map((part: any) => part.text)
    .join("");
}

/** Converts an Anthropic-style request body (as sent by the app) to Gemini's format. */
function toGeminiRequest(body: any): any {
  const contents = (body.messages ?? []).map((message: any) => {
    const parts: any[] = [];
    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item.type === "text") {
          parts.push({ text: item.text });
        } else if (item.type === "image" && item.source) {
          parts.push({
            inline_data: {
              mime_type: item.source.media_type || "image/jpeg",
              data: item.source.data,
            },
          });
        }
      }
    } else if (typeof message.content === "string") {
      parts.push({ text: message.content });
    }
    return { role: message.role === "assistant" ? "model" : "user", parts };
  });

  const request: any = {
    contents,
    generationConfig: { maxOutputTokens: body.max_tokens ?? 4096 },
  };
  if (body.system) request.systemInstruction = { parts: [{ text: body.system }] };
  return request;
}

/**
 * Reads Gemini's SSE stream and re-emits each text chunk as
 * `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":...}}`,
 * the format the app already parses.
 */
function geminiSseToTextDeltas(upstream: ReadableStream<Uint8Array>): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  let buffer = "";

  /** Returns true if it enqueued something. */
  const emitLine = (line: string, controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return false;
    try {
      const text = extractText(JSON.parse(payload));
      if (!text) return false;
      const event = { type: "content_block_delta", delta: { type: "text_delta", text } };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      return true;
    } catch (error) {
      console.error("Could not parse Gemini chunk:", error);
      return false;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    // pull() is only called again after it enqueues data, so keep reading
    // until something is enqueued or the upstream ends.
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) emitLine(buffer, controller);
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        let enqueued = false;
        for (const line of lines) enqueued = emitLine(line, controller) || enqueued;
        if (enqueued) return;
      }
    },
    cancel() {
      return reader.cancel();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
