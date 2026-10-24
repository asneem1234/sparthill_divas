/**
 * ClickIt Proxy Worker
 *
 * Proxies requests to the Google Gemini API so the app never ships with a
 * raw API key. The key is stored as a Cloudflare secret.
 *
 * Routes:
 *   POST /chat        -> Gemini streamGenerateContent (re-emitted as SSE text deltas)
 *   POST /transcribe  -> Gemini generateContent with audio, returns { text }
 *   GET  /live        -> WebSocket proxy to the Gemini Live API (voice-to-voice).
 *                        The key is added here; the client never sees it.
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

    if (url.pathname === "/live") return handleLive(request, env);

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

const LIVE_UPSTREAM =
  "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
/** Only conversational Live / native-audio models may be requested through this proxy. */
const LIVE_MODEL_PATTERN = /^models\/gemini-[a-z0-9.\-]*(live|native-audio)[a-z0-9.\-]*$/i;

/**
 * Pipes a client WebSocket to the Gemini Live API. The first client message
 * must be a `setup` whose model passes LIVE_MODEL_PATTERN; anything else is
 * closed with 1008. Messages sent before the upstream is open are queued.
 */
function handleLive(request: Request, env: Env): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  if (!env.GEMINI_API_KEY) return new Response("Worker has no GEMINI_API_KEY", { status: 500 });

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  let upstream: WebSocket | null = null;
  let setupSeen = false;
  const queued: (string | ArrayBuffer)[] = [];

  const closeBoth = (code: number, reason: string) => {
    try { server.close(code, reason); } catch { /* already closed */ }
    try { upstream?.close(code === 1008 ? 1000 : code, reason); } catch { /* already closed */ }
  };

  const connectUpstream = async () => {
    try {
      const response = await fetch(`${LIVE_UPSTREAM}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
        headers: { Upgrade: "websocket" },
      });
      const socket = (response as any).webSocket as WebSocket | null;
      if (!socket) {
        const detail = (await response.text()).slice(0, 300);
        console.error(`[/live] upstream refused: ${response.status} ${detail}`);
        closeBoth(1011, `Gemini refused the connection (${response.status})`);
        return;
      }
      socket.accept();
      upstream = socket;
      socket.addEventListener("message", (event) => {
        try { server.send(event.data as any); } catch { /* client gone */ }
      });
      socket.addEventListener("close", (event) => {
        try { server.close(event.code === 1005 ? 1000 : event.code, (event.reason || "").slice(0, 120)); } catch { /* gone */ }
      });
      socket.addEventListener("error", () => closeBoth(1011, "Upstream error"));
      for (const message of queued.splice(0)) socket.send(message);
    } catch (error) {
      console.error("[/live] upstream connect failed:", error);
      closeBoth(1011, "Could not reach Gemini");
    }
  };

  server.addEventListener("message", (event) => {
    const data = event.data as string | ArrayBuffer;
    if (!setupSeen) {
      let model: unknown;
      try {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        model = JSON.parse(text)?.setup?.model;
      } catch { /* falls through to rejection */ }
      if (typeof model !== "string" || !LIVE_MODEL_PATTERN.test(model)) {
        closeBoth(1008, "First message must be a setup for a Gemini live model");
        return;
      }
      setupSeen = true;
      queued.push(data);
      void connectUpstream();
      return;
    }
    if (upstream) upstream.send(data);
    else queued.push(data);
  });
  server.addEventListener("close", () => { try { upstream?.close(1000, "client closed"); } catch { /* gone */ } });
  server.addEventListener("error", () => { try { upstream?.close(1011, "client error"); } catch { /* gone */ } });

  return new Response(null, { status: 101, webSocket: client } as any);
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
