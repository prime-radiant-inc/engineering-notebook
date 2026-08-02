import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { complete, providerModel, type SummaryProvider } from "./llm";

type Captured = { path: string; auth: string | null; body: any };

describe("complete (openai-compatible provider)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let captured: Captured | null;
  let reply: any;
  let status: number;

  beforeEach(() => {
    captured = null;
    status = 200;
    reply = {
      choices: [{ message: { content: "HEADLINE: did a thing" }, finish_reason: "stop" }],
    };
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        captured = {
          path: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
          body: await req.json(),
        };
        return new Response(JSON.stringify(reply), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
  });

  afterEach(() => server.stop(true));

  function provider(extra: Partial<Extract<SummaryProvider, { type: "openai" }>> = {}): SummaryProvider {
    return {
      type: "openai",
      base_url: `http://localhost:${server.port}/v1`,
      model: "gemma-4",
      ...extra,
    };
  }

  test("posts to the chat completions endpoint and returns the content", async () => {
    const text = await complete("summarize this", provider());

    expect(captured!.path).toBe("/v1/chat/completions");
    expect(captured!.body.model).toBe("gemma-4");
    expect(captured!.body.messages[0].content).toBe("summarize this");
    expect(text).toBe("HEADLINE: did a thing");
  });

  test("sends the bearer token from the configured env var", async () => {
    process.env.TEST_SPARK_KEY = "sk-test-123";
    try {
      await complete("x", provider({ api_key_env: "TEST_SPARK_KEY" }));
      expect(captured!.auth).toBe("Bearer sk-test-123");
    } finally {
      delete process.env.TEST_SPARK_KEY;
    }
  });

  test("requests a token budget large enough for a reasoning model", async () => {
    await complete("x", provider());
    // Gemma spends completion tokens on reasoning before emitting content.
    expect(captured!.body.max_tokens).toBeGreaterThanOrEqual(2000);
  });

  test("honours an explicit max_tokens", async () => {
    await complete("x", provider({ max_tokens: 8000 }));
    expect(captured!.body.max_tokens).toBe(8000);
  });

  test("fails loudly when the model returns only reasoning and no content", async () => {
    reply = { choices: [{ message: { content: "", reasoning_content: "thinking..." } }] };
    expect(complete("x", provider())).rejects.toThrow(/no content/i);
  });

  test("surfaces an HTTP error rather than returning empty text", async () => {
    status = 401;
    reply = { error: { message: "invalid api key" } };
    expect(complete("x", provider())).rejects.toThrow(/401/);
  });
});

describe("providerModel", () => {
  test("names the configured openai model", () => {
    expect(
      providerModel({ type: "openai", base_url: "http://x/v1", model: "gemma-4" })
    ).toBe("gemma-4");
  });

  test("falls back to the built-in Claude model when unconfigured", () => {
    expect(providerModel(undefined)).toBe("claude-haiku-4-5-20251001");
  });
});
