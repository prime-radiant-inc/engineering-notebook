import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { generateTitle } from "./titles";
import type { SummaryProvider } from "./llm";

describe("generateTitle with a configured provider", () => {
  let server: ReturnType<typeof Bun.serve>;
  let captured: { model: string } | null;
  let reply: string;

  beforeEach(() => {
    captured = null;
    reply = "Refactored the auth module";
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { model: string };
        captured = { model: body.model };
        return new Response(
          JSON.stringify({ choices: [{ message: { content: reply } }] }),
          { headers: { "Content-Type": "application/json" } }
        );
      },
    });
  });

  afterEach(() => server.stop(true));

  function provider(): SummaryProvider {
    return {
      type: "openai",
      base_url: `http://localhost:${server.port}/v1`,
      model: "gemma-4",
    };
  }

  test("titles come from the configured model, not Claude", async () => {
    const title = await generateTitle("**jesse (2026-07-31 10:00):** fix auth", provider());

    expect(captured!.model).toBe("gemma-4");
    expect(title).toBe("Refactored the auth module");
  });

  test("strips quotes and trailing punctuation from the model's answer", async () => {
    reply = '"Refactored the auth module."';
    const title = await generateTitle("transcript", provider());
    expect(title).toBe("Refactored the auth module");
  });

  test("takes the first non-empty line when the model adds preamble", async () => {
    reply = "\n\nRefactored the auth module\nsome trailing chatter";
    const title = await generateTitle("transcript", provider());
    expect(title).toBe("Refactored the auth module");
  });
});
