import { describe, test, expect } from "bun:test";
import {
  toJsonl,
  syncOpenCodeSessions,
  runToFile,
  listSessionsFromDb,
  type OpenCodeExport,
  type OpenCodeRunner,
} from "./opencode";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function exportFixture(overrides: Partial<OpenCodeExport> = {}): OpenCodeExport {
  return {
    info: {
      id: "ses_abc",
      directory: "/Users/jesse/projects/myapp",
      title: "Build the thing",
      version: "1.18.0",
      model: { providerID: "spark", id: "qwen3-coder" },
      time: { created: 1785256551718, updated: 1785256600000 },
    },
    messages: [
      {
        info: { role: "user", time: { created: 1785256552352 } },
        parts: [{ type: "text", text: "hello" }],
      },
      {
        info: { role: "assistant", time: { created: 1785256553000 } },
        parts: [
          { type: "step-start" },
          { type: "text", text: "hi there" },
          { type: "step-finish" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("toJsonl", () => {
  test("emits an opencode_meta record as the first line", () => {
    const lines = toJsonl(exportFixture()).trim().split("\n");
    const meta = JSON.parse(lines[0]!);

    expect(meta.type).toBe("opencode_meta");
    expect(meta.payload.id).toBe("ses_abc");
    expect(meta.payload.cwd).toBe("/Users/jesse/projects/myapp");
    expect(meta.payload.model).toBe("spark/qwen3-coder");
    expect(meta.payload.parent_id).toBeNull();
  });

  test("converts epoch millis to ISO timestamps", () => {
    const lines = toJsonl(exportFixture()).trim().split("\n");
    const meta = JSON.parse(lines[0]!);

    expect(meta.timestamp).toBe(new Date(1785256551718).toISOString());
  });

  test("emits one record per message with joined text parts", () => {
    const lines = toJsonl(exportFixture()).trim().split("\n");

    expect(lines.length).toBe(3); // meta + 2 messages
    const user = JSON.parse(lines[1]!);
    const assistant = JSON.parse(lines[2]!);

    expect(user.type).toBe("user");
    expect(user.message.content).toBe("hello");
    expect(assistant.type).toBe("assistant");
    expect(assistant.message.content).toBe("hi there");
  });

  test("drops non-text parts such as step-start and step-finish", () => {
    const lines = toJsonl(exportFixture()).trim().split("\n");
    const assistant = JSON.parse(lines[2]!);

    expect(assistant.message.content).not.toContain("step");
  });

  test("skips messages that carry no text parts", () => {
    const exp = exportFixture({
      messages: [
        {
          info: { role: "assistant", time: { created: 1785256553000 } },
          parts: [{ type: "step-start" }, { type: "tool", text: undefined }],
        },
      ],
    });

    const lines = toJsonl(exp).trim().split("\n");
    expect(lines.length).toBe(1); // meta only
  });

  test("carries parentID through as parent_id for subagent sessions", () => {
    const exp = exportFixture();
    exp.info.parentID = "ses_parent";

    const meta = JSON.parse(toJsonl(exp).trim().split("\n")[0]!);
    expect(meta.payload.parent_id).toBe("ses_parent");
  });
});

function fakeRunner(
  sessions: Array<{ id: string; updated: number }>,
  calls: string[] = []
): OpenCodeRunner {
  return {
    async listSessions() {
      return sessions.map((s) => ({
        id: s.id,
        title: "t",
        updated: s.updated,
        created: 1785256551718,
        directory: "/Users/jesse/projects/myapp",
      }));
    },
    async exportSession(id: string) {
      calls.push(id);
      const exp = exportFixture();
      exp.info.id = id;
      return exp;
    },
  };
}

describe("listSessionsFromDb", () => {
  function makeDb(dir: string): string {
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT NOT NULL,
      title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    )`);
    db.exec(`INSERT INTO session VALUES
      ('ses_a','global',NULL,'/Users/jesse/projects/one','First',100,200),
      ('ses_b','global',NULL,'/Users/jesse/projects/two','Second',300,400),
      ('ses_c','global','ses_a','/Users/jesse/projects/one','Child',500,600)`);
    db.close();
    return path;
  }

  test("enumerates sessions across every project, not just the cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-db-"));
    try {
      const sessions = listSessionsFromDb(makeDb(dir));
      expect(sessions.length).toBe(3);
      expect(new Set(sessions.map((s) => s.directory)).size).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns the most recently updated sessions first", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-db-"));
    try {
      const sessions = listSessionsFromDb(makeDb(dir));
      expect(sessions[0]!.id).toBe("ses_c");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("honours maxCount", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-db-"));
    try {
      expect(listSessionsFromDb(makeDb(dir), 2).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns nothing when the database is absent", () => {
    expect(listSessionsFromDb(join(tmpdir(), "no-such-opencode.db"))).toEqual([]);
  });
});

describe("runToFile", () => {
  test("captures stdout larger than a pipe buffer without truncation", () => {
    // The opencode CLI yields empty stdout when spawned with a pipe, and
    // exports run to megabytes, so command output is captured via a file.
    const size = 2 * 1024 * 1024;
    const out = runToFile("python3", [
      "-c",
      `import sys; sys.stdout.write("x" * ${size})`,
    ]);
    expect(out.length).toBe(size);
  });

  test("returns the full text of small outputs", () => {
    expect(runToFile("printf", ["hello"])).toBe("hello");
  });
});

describe("syncOpenCodeSessions", () => {
  let staging: string;

  function withStaging(fn: (dir: string) => Promise<void>) {
    return async () => {
      staging = mkdtempSync(join(tmpdir(), "oc-staging-"));
      try {
        await fn(staging);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    };
  }

  test(
    "writes one .jsonl file per session",
    withStaging(async (dir) => {
      const runner = fakeRunner([
        { id: "ses_a", updated: 100 },
        { id: "ses_b", updated: 200 },
      ]);

      const result = await syncOpenCodeSessions(dir, runner);

      expect(result.written).toBe(2);
      expect(existsSync(join(dir, "ses_a.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "ses_b.jsonl"))).toBe(true);
    })
  );

  test(
    "writes parseable JSONL carrying the session id",
    withStaging(async (dir) => {
      await syncOpenCodeSessions(dir, fakeRunner([{ id: "ses_a", updated: 100 }]));

      const content = readFileSync(join(dir, "ses_a.jsonl"), "utf-8");
      const meta = JSON.parse(content.trim().split("\n")[0]!);
      expect(meta.type).toBe("opencode_meta");
      expect(meta.payload.id).toBe("ses_a");
    })
  );

  test(
    "skips re-exporting a session whose updated time has not changed",
    withStaging(async (dir) => {
      const calls: string[] = [];
      const sessions = [{ id: "ses_a", updated: 100 }];

      await syncOpenCodeSessions(dir, fakeRunner(sessions, calls));
      const second = await syncOpenCodeSessions(dir, fakeRunner(sessions, calls));

      expect(calls).toEqual(["ses_a"]); // exported once, not twice
      expect(second.written).toBe(0);
      expect(second.skipped).toBe(1);
    })
  );

  test(
    "re-exports a session that has been updated since the last sync",
    withStaging(async (dir) => {
      const calls: string[] = [];
      await syncOpenCodeSessions(dir, fakeRunner([{ id: "ses_a", updated: 100 }], calls));
      const second = await syncOpenCodeSessions(
        dir,
        fakeRunner([{ id: "ses_a", updated: 999 }], calls)
      );

      expect(calls).toEqual(["ses_a", "ses_a"]);
      expect(second.written).toBe(1);
    })
  );
});
