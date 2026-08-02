/**
 * Model provider for journal summarization.
 *
 * Defaults to Claude via the Agent SDK. Any OpenAI-compatible endpoint can be
 * used instead — including a local llama.cpp server — by configuring a
 * `summary_provider` block.
 */

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";

/** Reasoning models spend completion tokens thinking before emitting content. */
const DEFAULT_MAX_TOKENS = 4000;

export type SummaryProvider =
  | { type: "anthropic"; model?: string }
  | {
      type: "openai";
      /** Endpoint root, e.g. http://host:8001/v1 */
      base_url: string;
      model: string;
      /** Name of the environment variable holding the API key. */
      api_key_env?: string;
      max_tokens?: number;
    };

/** The model name to record against generated entries. */
export function providerModel(provider?: SummaryProvider): string {
  if (!provider || provider.type === "anthropic") {
    return provider?.model ?? DEFAULT_CLAUDE_MODEL;
  }
  return provider.model;
}

async function completeOpenAI(
  prompt: string,
  provider: Extract<SummaryProvider, { type: "openai" }>
): Promise<string> {
  const url = `${provider.base_url.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  const apiKey = provider.api_key_env ? process.env[provider.api_key_env] : undefined;
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: provider.max_tokens ?? DEFAULT_MAX_TOKENS,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `${provider.model} request failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";

  if (!text.trim()) {
    throw new Error(
      `${provider.model} returned no content (reasoning models need a larger max_tokens budget)`
    );
  }

  return text;
}

async function completeAnthropic(
  prompt: string,
  provider?: Extract<SummaryProvider, { type: "anthropic" }>
): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const result = query({
    prompt,
    options: {
      model: provider?.model ?? DEFAULT_CLAUDE_MODEL,
      maxTurns: 1,
      tools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      env,
    },
  });

  let text = "";
  for await (const message of result) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if ("text" in block && typeof block.text === "string") {
          text += block.text;
        }
      }
    }
  }

  if (!text.trim()) throw new Error("Empty response from LLM");
  return text;
}

/** Send a single prompt and return the model's text response. */
export async function complete(
  prompt: string,
  provider?: SummaryProvider
): Promise<string> {
  if (provider?.type === "openai") return completeOpenAI(prompt, provider);
  return completeAnthropic(prompt, provider);
}
