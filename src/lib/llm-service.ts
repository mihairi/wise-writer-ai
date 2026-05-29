// Adapted from project DocAIremix — local LLM service (Ollama / LM Studio)

export type LLMProvider = "ollama" | "lmstudio";

export interface LLMConfig {
  provider: LLMProvider;
  host: string;
  port: string;
  model: string;
  thinking?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const DEFAULTS: Record<LLMProvider, Omit<LLMConfig, "model">> = {
  ollama: { provider: "ollama", host: "10.200.20.2", port: "11434" },
  lmstudio: { provider: "lmstudio", host: "10.200.20.2", port: "1234" },
};

export function getDefaultConfig(provider: LLMProvider): Omit<LLMConfig, "model"> {
  return DEFAULTS[provider];
}

export function getBaseUrl(config: LLMConfig): string {
  const host = config.host || "10.200.20.2";
  const port = config.port || (config.provider === "ollama" ? "11434" : "1234");
  return `http://${host}:${port}`;
}

export async function fetchModels(config: LLMConfig): Promise<string[]> {
  const base = getBaseUrl(config);
  try {
    if (config.provider === "ollama") {
      const res = await fetch(`${base}/api/tags`);
      const data = await res.json();
      return (data.models || []).map((m: any) => m.name);
    }
    const res = await fetch(`${base}/v1/models`);
    const data = await res.json();
    return (data.data || []).map((m: any) => m.id);
  } catch (e) {
    console.error("fetchModels failed", e);
    return [];
  }
}

/**
 * Stateful filter that strips <think>...</think> blocks out of a streamed
 * content channel, routing the inner thought tokens to onThinking. Works
 * across chunk boundaries.
 */
function makeThinkSplitter(onContent: (t: string) => void, onThinking?: (t: string) => void) {
  let buf = "";
  let inThink = false;
  const OPEN = "<think>";
  const CLOSE = "</think>";
  return {
    push(chunk: string) {
      buf += chunk;
      // Process as long as we can find a definitive boundary or are safely past one.
      while (buf.length) {
        if (!inThink) {
          const i = buf.indexOf(OPEN);
          if (i === -1) {
            // Emit everything except the last few chars (might be partial "<think")
            const safe = buf.length - (OPEN.length - 1);
            if (safe > 0) {
              onContent(buf.slice(0, safe));
              buf = buf.slice(safe);
            }
            return;
          }
          if (i > 0) onContent(buf.slice(0, i));
          buf = buf.slice(i + OPEN.length);
          inThink = true;
        } else {
          const j = buf.indexOf(CLOSE);
          if (j === -1) {
            const safe = buf.length - (CLOSE.length - 1);
            if (safe > 0) {
              onThinking?.(buf.slice(0, safe));
              buf = buf.slice(safe);
            }
            return;
          }
          if (j > 0) onThinking?.(buf.slice(0, j));
          buf = buf.slice(j + CLOSE.length);
          inThink = false;
        }
      }
    },
    flush() {
      if (buf) {
        if (inThink) onThinking?.(buf);
        else onContent(buf);
        buf = "";
      }
    },
  };
}

export interface StreamChatArgs {
  config: LLMConfig;
  messages: ChatMessage[];
  onDelta: (t: string) => void;
  onThinking?: (t: string) => void;
  onDone: (info?: { finishReason?: string }) => void;
  onError: (m: string) => void;
  signal?: AbortSignal;
  /** Soft upper bound on tokens to generate per request. Default is very large. */
  maxTokens?: number;
}

export async function streamChat(args: StreamChatArgs) {
  const { config, messages, onDelta, onThinking, onDone, onError, signal } = args;
  const maxTokens = args.maxTokens ?? 32000;
  const splitter = makeThinkSplitter(onDelta, onThinking);
  const base = getBaseUrl(config);
  try {
    if (config.provider === "ollama") {
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: true,
          ...(config.thinking ? { think: true } : {}),
          options: {
            // -1 = unlimited; large num_ctx so big docs fit.
            num_predict: -1,
            num_ctx: 32768,
          },
        }),
        signal,
      });
      if (!res.ok) throw new Error(`Ollama error ${res.status}`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finishReason: string | undefined;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const p = JSON.parse(line);
            if (p.message?.thinking) onThinking?.(p.message.thinking);
            if (p.message?.content) splitter.push(p.message.content);
            if (p.done) {
              finishReason = p.done_reason || "stop";
              splitter.flush();
              onDone({ finishReason });
              return;
            }
          } catch {}
        }
      }
      splitter.flush();
      onDone({ finishReason });
    } else {
      const body: any = {
        model: config.model,
        messages,
        stream: true,
        max_tokens: maxTokens,
        temperature: 0.4,
      };
      if (config.thinking) {
        // Best-effort hints for reasoning-capable LM Studio models.
        body.reasoning_effort = "high";
        body.reasoning = { effort: "high" };
      }
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`LM Studio error ${res.status}: ${errBody.slice(0, 300) || res.statusText}`);
      }
      if (!res.body) throw new Error("LM Studio returned no response body.");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let deltas = 0;
      let rawBytes = 0;
      let finishReason: string | undefined;
      const flushLine = (rawLine: string) => {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line) return false;
        const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
        if (!payload) return false;
        if (payload === "[DONE]") return true;
        try {
          const p = JSON.parse(payload);
          const choice = p.choices?.[0];
          const reasoning =
            choice?.delta?.reasoning_content ??
            choice?.delta?.reasoning ??
            choice?.message?.reasoning_content;
          if (reasoning) onThinking?.(reasoning);
          const c =
            choice?.delta?.content ??
            choice?.message?.content ??
            choice?.text;
          if (c) {
            deltas++;
            splitter.push(c);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        } catch {
          // ignore non-JSON keepalive lines
        }
        return false;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawBytes += value?.byteLength ?? 0;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (flushLine(line)) {
            splitter.flush();
            onDone({ finishReason });
            return;
          }
        }
      }
      if (buf.trim()) flushLine(buf);
      splitter.flush();
      if (deltas === 0) {
        console.warn("[llm] no deltas parsed. rawBytes=", rawBytes);
        onError(
          `No content received from LM Studio (${rawBytes} bytes). Make sure the loaded model supports chat completions and that "${config.model}" matches the model ID shown in LM Studio's Server tab.`
        );
        return;
      }
      onDone({ finishReason });
    }
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    const msg = e?.message || "Connection failed";
    if (msg.toLowerCase().includes("failed to fetch")) {
      onError(
        "Cannot reach the local LLM. Check that Ollama or LM Studio is running and that host/port match Settings."
      );
      return;
    }
    onError(msg);
  }
}

/**
 * Run a chat to completion, automatically continuing when the model stops
 * because it hit its output-length cap. This is what lets us produce big
 * deliverables on local models with conservative default token limits.
 */
export async function generateLong(opts: {
  config: LLMConfig;
  messages: ChatMessage[];
  onDelta: (t: string) => void;
  onThinking?: (t: string) => void;
  onStage?: (s: string) => void;
  signal?: AbortSignal;
  maxContinuations?: number;
}): Promise<string> {
  const maxCont = opts.maxContinuations ?? 4;
  let full = "";
  let messages = [...opts.messages];
  let pass = 0;
  while (true) {
    pass++;
    opts.onStage?.(pass === 1 ? "Generating…" : `Continuing (pass ${pass})…`);
    let passText = "";
    let err: string | null = null;
    let finishReason: string | undefined;
    await streamChat({
      config: opts.config,
      messages,
      signal: opts.signal,
      onDelta: (t) => {
        passText += t;
        full += t;
        opts.onDelta(t);
      },
      onThinking: opts.onThinking,
      onDone: (info) => {
        finishReason = info?.finishReason;
      },
      onError: (m) => {
        err = m;
      },
    });
    if (err) throw new Error(err);
    if (opts.signal?.aborted) break;
    const truncated =
      finishReason === "length" || finishReason === "max_tokens" || finishReason === "MAX_TOKENS";
    if (!truncated || pass >= maxCont || passText.length < 200) break;
    messages = [
      ...opts.messages,
      { role: "assistant", content: full },
      {
        role: "user",
        content:
          "Continue exactly where you left off. Do not repeat previous content, do not summarise, do not add a closing remark or transition — just resume the next sentence.",
      },
    ];
  }
  return full;
}

/** Non-streaming chat completion — returns the full assistant text. */
export async function chatComplete(opts: {
  config: LLMConfig;
  messages: ChatMessage[];
  signal?: AbortSignal;
}): Promise<string> {
  let acc = "";
  let err: string | null = null;
  await streamChat({
    ...opts,
    onDelta: (t) => {
      acc += t;
    },
    onDone: () => {},
    onError: (m) => {
      err = m;
    },
  });
  if (err) throw new Error(err);
  return acc;
}



const KEY = "corpdoc-llm-config";
export function loadConfig(): LLMConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { ...DEFAULTS.ollama, model: "" };
}
export function saveConfig(c: LLMConfig) {
  localStorage.setItem(KEY, JSON.stringify(c));
}
