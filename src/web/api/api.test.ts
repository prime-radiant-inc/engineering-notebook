import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../db";
import { createApiRouter } from "./index";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("api router", () => {
  let tempDir: string, db: ReturnType<typeof initDb>;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "api-")); db = initDb(join(tempDir, "t.db")); });
  afterEach(() => { closeDb(); rmSync(tempDir, { recursive: true, force: true }); });

  test("GET /api/ping returns ok", async () => {
    const app = createApiRouter(db);
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
