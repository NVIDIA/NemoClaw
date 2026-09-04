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

  it("rejects global --fix before running health checks (#10212)", async () => {
    await expect(DoctorCommand.run(["--fix"], rootDir)).rejects.toThrow(/fix/i);

    expect(mocks.runGlobalDoctor).not.toHaveBeenCalled();
  });

  it("shows global help without running health checks (#10212)", async () => {
    await expect(DoctorCommand.run(["--help"], rootDir)).rejects.toThrow(/EEXIT: 0/);

    expect(mocks.runGlobalDoctor).not.toHaveBeenCalled();
  });
});
