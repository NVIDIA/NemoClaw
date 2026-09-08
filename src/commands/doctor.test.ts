// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../test/helpers/timeouts";

const mocks = vi.hoisted(() => ({
  runGlobalDoctor: vi.fn(),
}));

vi.mock("../lib/actions/sandbox/doctor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/actions/sandbox/doctor")>()),
  runGlobalDoctor: mocks.runGlobalDoctor,
}));

import DoctorCommand from "./doctor";

const rootDir = process.cwd();

/** Capture global console calls and direct writes in per-stream order. */
function captureCommandOutput(): { stderr: string[]; stdout: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(`${parts.map(String).join(" ")}\n`);
  });
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(`${parts.map(String).join(" ")}\n`);
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stderr, stdout };
}

describe("global doctor command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mocks.runGlobalDoctor.mockResolvedValue({
      schemaVersion: 1,
      scope: "global",
      status: "ok",
      failed: 0,
      warnings: 0,
      checks: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it(
    "runs the read-only text diagnosis without a sandbox (#10212)",
    testTimeoutOptions(30_000),
    async () => {
      await DoctorCommand.run(["--text"], rootDir);

      expect(mocks.runGlobalDoctor).toHaveBeenCalledWith();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("returns redacted JSON and a nonzero status for failed checks (#10212)", async () => {
    mocks.runGlobalDoctor.mockResolvedValueOnce({
      schemaVersion: 1,
      scope: "global",
      status: "fail",
      failed: 1,
      warnings: 0,
      checks: [
        {
          group: "Gateway",
          label: "OpenShell status",
          status: "fail",
          detail: "Authorization: Bearer sk-abc123DEF456ghi789",
        },
      ],
    });

    const report = (await DoctorCommand.run(["--json"], rootDir)) as {
      checks: Array<{ detail: string }>;
      scope: string;
    };

    expect(mocks.runGlobalDoctor).toHaveBeenCalledWith({ quiet: true });
    expect(process.exitCode).toBe(1);
    expect(report.scope).toBe("global");
    expect(report.checks[0]?.detail).toBe("Authorization: Bearer <REDACTED>");
    expect(JSON.stringify(report)).not.toContain("sk-abc123DEF456ghi789");
  });

  it.each([
    ["--text", "--json"],
    ["--json", "--text"],
  ])("rejects conflicting output modes before a doctor check runs for %s %s (#11150)", async (
    first,
    second,
  ) => {
    const { stdout, stderr } = captureCommandOutput();

    await DoctorCommand.run([first, second], rootDir);

    expect(mocks.runGlobalDoctor).not.toHaveBeenCalled();
    // Parsing the whole of stdout is the assertion: a second document or any
    // stray text after the envelope makes it throw.
    const stdoutText = stdout.join("");
    expect(Buffer.byteLength(stdoutText)).toBeLessThan(1_000);
    expect(JSON.parse(stdoutText)).toEqual({
      error: {
        message: "--json and --text are mutually exclusive. Use one or the other.",
        exit: 2,
      },
    });
    expect(stderr.join("")).toContain("--json and --text are mutually exclusive");
    expect(process.exitCode).toBeGreaterThan(0);
  });

  it("does not report another parse failure as an output-mode conflict (#11150)", async () => {
    const { stdout, stderr } = captureCommandOutput();

    await DoctorCommand.run(["--bogus", "--text", "--json"], rootDir);

    expect(mocks.runGlobalDoctor).not.toHaveBeenCalled();
    expect(stdout.join("")).toContain("--bogus");
    expect(stdout.join("")).not.toContain("mutually exclusive");
    expect(stderr.join("")).not.toContain("mutually exclusive");
    expect(process.exitCode).toBeGreaterThan(0);
  });

  it("rejects global --fix before running health checks (#10212)", async () => {
    await expect(DoctorCommand.run(["--fix"], rootDir)).rejects.toThrow(/fix/i);

    expect(mocks.runGlobalDoctor).not.toHaveBeenCalled();
  });

  it("shows global help without running health checks (#10212)", async () => {
    await expect(DoctorCommand.run(["--help"], rootDir)).rejects.toThrow(/EEXIT: 0/);

    expect(mocks.runGlobalDoctor).not.toHaveBeenCalled();
  });
});
