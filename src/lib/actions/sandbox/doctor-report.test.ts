// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDoctorReport, type DoctorCheck, renderDoctorReport } from "./doctor-report";

function check(status: DoctorCheck["status"], group = "Host"): DoctorCheck {
  return { group, label: `${status} check`, status, detail: `${status} detail` };
}

describe("doctor reports", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { checks: [], status: "ok", failed: 0, warnings: 0 },
    { checks: [check("ok"), check("info")], status: "ok", failed: 0, warnings: 0 },
    { checks: [check("warn"), check("info")], status: "warn", failed: 0, warnings: 1 },
    { checks: [check("warn"), check("fail")], status: "fail", failed: 1, warnings: 1 },
  ] as const)("summarizes $status reports", ({ checks, status, failed, warnings }) => {
    expect(buildDoctorReport("alpha", [...checks])).toMatchObject({
      schemaVersion: 1,
      sandbox: "alpha",
      status,
      failed,
      warnings,
    });
  });

  it("renders the machine-readable report and returns a failing exit code", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const report = buildDoctorReport("alpha", [check("fail")]);

    expect(renderDoctorReport(report, true)).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(report);
  });

  it("renders preferred groups first, preserves extra-group order, and includes hints", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line = "") => lines.push(String(line)));
    const custom = { ...check("info", "Custom"), hint: "inspect the custom probe" };
    const report = buildDoctorReport("alpha", [custom, check("warn", "Messaging"), check("ok")]);

    expect(renderDoctorReport(report, false)).toBe(0);
    const output = lines.join("\n");
    expect(output.indexOf("Host:")).toBeLessThan(output.indexOf("Messaging:"));
    expect(output.indexOf("Messaging:")).toBeLessThan(output.indexOf("Custom:"));
    expect(output).toContain("hint: inspect the custom probe");
    expect(output).toContain("healthy with 1 warning(s)");
  });
});
