import { describe, test, expect } from "bun:test";
import { startJob, jobStatus } from "./reports";

describe("report jobs", () => {
  test("a new job starts pending and reaches done", async () => {
    const id = startJob(async () => {});
    expect(jobStatus(id)?.state).toBe("pending");
    await Bun.sleep(10);
    expect(jobStatus(id)?.state).toBe("done");
  });

  test("a failing job records the error message", async () => {
    const id = startJob(async () => {
      throw new Error("model unreachable");
    });
    await Bun.sleep(10);
    const s = jobStatus(id);
    expect(s?.state).toBe("error");
    expect(s?.error).toContain("model unreachable");
  });

  test("an unknown job id returns null", () => {
    expect(jobStatus("nope")).toBeNull();
  });
});
