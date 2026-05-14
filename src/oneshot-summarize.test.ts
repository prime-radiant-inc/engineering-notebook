import { describe, test, expect } from "bun:test";
import { buildOneShotPrompt, fitsOneShot } from "./oneshot-summarize";

describe("buildOneShotPrompt", () => {
  test("uses sandwich format: instructions appear both before and after the transcript", () => {
    const prompt = buildOneShotPrompt(
      "myapp",
      "2026-05-13",
      "**User:** hello"
    );
    // Find first and last occurrence of a phrase that only exists in instructions.
    const marker = "Reply with ONLY a JSON object";
    const first = prompt.indexOf(marker);
    const last = prompt.lastIndexOf(marker);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    // The transcript should sit between them.
    const transcriptIdx = prompt.indexOf("<transcript>");
    expect(transcriptIdx).toBeGreaterThan(first);
    expect(transcriptIdx).toBeLessThan(last);
  });

  test("explicitly lists every required field in the prompt body", () => {
    const prompt = buildOneShotPrompt(
      "myapp",
      "2026-05-13",
      "transcript"
    );
    // With think:false, Ollama doesn't enforce schema requiredness; the only
    // way to make every field appear is to list them in the prompt.
    for (const field of [
      "skipped",
      "skip_reason",
      "headline",
      "summary",
      "topics",
      "open_questions",
    ]) {
      expect(prompt).toContain(field);
    }
  });

  test("includes summary_instructions when set", () => {
    const prompt = buildOneShotPrompt(
      "myapp",
      "2026-05-13",
      "x",
      "Focus on commits."
    );
    expect(prompt).toContain("Focus on commits.");
  });

  test("includes anti-continuation guidance to prevent the model from extending the transcript", () => {
    const prompt = buildOneShotPrompt("myapp", "2026-05-13", "x");
    expect(prompt).toMatch(/do NOT continue|do not continue/i);
  });
});

describe("fitsOneShot", () => {
  test("returns true for transcripts under default threshold", () => {
    expect(fitsOneShot(50_000)).toBe(true);
    expect(fitsOneShot(500_000)).toBe(true);
    expect(fitsOneShot(799_999)).toBe(true);
  });

  test("returns false for transcripts above default threshold", () => {
    expect(fitsOneShot(800_001)).toBe(false);
    expect(fitsOneShot(2_000_000)).toBe(false);
  });

  test("respects custom threshold", () => {
    expect(fitsOneShot(50_000, 30_000)).toBe(false);
    expect(fitsOneShot(50_000, 100_000)).toBe(true);
  });
});
