// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildEnableSandboxAuditLogsArgs,
  buildSandboxLogsArgs,
  buildSandboxOpenclawGatewayLogsArgs,
  describeLogProbeResult,
  exitCodeFromSignal,
  getLogsProbeTimeoutMs,
  normalizeSandboxLogsOptions,
} from "./logs";

describe("sandbox logs helpers", () => {
  it("normalizes boolean and partial logs options", () => {
    expect(normalizeSandboxLogsOptions(true)).toEqual({ follow: true, lines: "200", since: null });
    expect(normalizeSandboxLogsOptions({ follow: false, lines: "", since: "" })).toEqual({
      follow: false,
      lines: "200",
      since: null,
    });
    expect(normalizeSandboxLogsOptions({ follow: true, lines: "50", since: "5m" })).toEqual({
      follow: true,
      lines: "50",
      since: "5m",
    });
  });

  it("builds OpenClaw gateway and OpenShell log argv", () => {
    expect(
      buildSandboxOpenclawGatewayLogsArgs("alpha", {
        follow: true,
        lines: "25",
        since: null,
      }),
    ).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "tail",
      "-n",
      "25",
      "-f",
      "/tmp/gateway.log",
    ]);
    expect(
      buildSandboxLogsArgs("alpha", {
        follow: true,
        lines: "25",
        since: "5m",
      }),
    ).toEqual(["logs", "alpha", "-n", "25", "--source", "all", "--since", "5m", "--tail"]);
    expect(buildEnableSandboxAuditLogsArgs("alpha")).toEqual([
      "settings",
      "set",
      "alpha",
      "--key",
      "ocsf_json_enabled",
      "--value",
      "true",
    ]);
  });

  it("describes log probe results and bounds probe timeout env input", () => {
    expect(describeLogProbeResult({ status: null, error: new Error("boom") })).toBe("boom");
    expect(describeLogProbeResult({ status: null, signal: "SIGTERM" })).toBe("signal SIGTERM");
    expect(describeLogProbeResult({ status: 7 })).toBe("exit 7");

    expect(getLogsProbeTimeoutMs({ NEMOCLAW_LOGS_PROBE_TIMEOUT_MS: "1234" })).toBe(1234);
    expect(getLogsProbeTimeoutMs({ NEMOCLAW_LOGS_PROBE_TIMEOUT_MS: "0" })).toBe(5000);
    expect(getLogsProbeTimeoutMs({ NEMOCLAW_LOGS_PROBE_TIMEOUT_MS: "not-a-number" })).toBe(5000);
    expect(getLogsProbeTimeoutMs({})).toBe(5000);
  });

  it("maps signals to conventional process exit codes", () => {
    expect(exitCodeFromSignal(null)).toBe(1);
    expect(exitCodeFromSignal("SIGINT")).toBe(130);
  });
});

import { mergeTailLogLines, parseLineTimestamp } from "./logs";

describe("parseLineTimestamp", () => {
  it("parses the bracketed epoch-seconds format from OpenShell OCSF audit", () => {
    expect(parseLineTimestamp("[1779488798.644] [sandbox] [OCSF ] NET:OPEN DENIED")).toBe(
      1779488798644,
    );
  });

  it("parses the bracketed epoch with no fractional component", () => {
    expect(parseLineTimestamp("[1779488800] [sandbox] [INFO ] ok")).toBe(1779488800000);
  });

  it("pads short fractional seconds to milliseconds", () => {
    expect(parseLineTimestamp("[1779488798.6] [sandbox] x")).toBe(1779488798600);
    expect(parseLineTimestamp("[1779488798.64] [sandbox] x")).toBe(1779488798640);
  });

  it("parses the ISO 8601 gateway-log format", () => {
    expect(
      parseLineTimestamp("2026-05-22T20:55:38.152+00:00 [gateway] starting HTTP server..."),
    ).toBe(Date.parse("2026-05-22T20:55:38.152+00:00"));
  });

  it("parses the ISO 8601 format with Z suffix", () => {
    expect(parseLineTimestamp("2026-05-22T20:55:38.152Z [gateway] ok")).toBe(
      Date.parse("2026-05-22T20:55:38.152Z"),
    );
  });

  it("returns null when no recognised timestamp prefix is present", () => {
    expect(parseLineTimestamp("just a free-form line")).toBeNull();
    expect(parseLineTimestamp("")).toBeNull();
    expect(parseLineTimestamp("  [not-a-timestamp]")).toBeNull();
  });
});

describe("mergeTailLogLines", () => {
  it("returns the empty string when no sources or no lines requested", () => {
    expect(mergeTailLogLines([], 5)).toBe("");
    expect(mergeTailLogLines(["[1] a\n"], 0)).toBe("[1] a\n");
  });

  it("caps the merged output at maxLines (closes #4100)", () => {
    const gateway = ["[1] g1", "[3] g2", "[5] g3"].join("\n") + "\n";
    const openshell = ["[2] o1", "[4] o2", "[6] o3"].join("\n") + "\n";
    const merged = mergeTailLogLines([gateway, openshell], 3);
    const lines = merged.split("\n").filter((line) => line.length > 0);
    expect(lines).toEqual(["[4] o2", "[5] g3", "[6] o3"]);
  });

  it("interleaves chronologically across sources", () => {
    const gateway = "[1779488800.100] g first\n[1779488800.300] g third\n";
    const openshell = "[1779488800.200] o second\n[1779488800.400] o fourth\n";
    const merged = mergeTailLogLines([gateway, openshell], 10);
    expect(merged.trimEnd().split("\n")).toEqual([
      "[1779488800.100] g first",
      "[1779488800.200] o second",
      "[1779488800.300] g third",
      "[1779488800.400] o fourth",
    ]);
  });

  it("keeps continuation lines attached to their preceding timestamped line", () => {
    const gateway = [
      "[1779488800.100] g header",
      "  continuation line for g",
      "[1779488800.400] g next",
    ].join("\n");
    const openshell = "[1779488800.200] o middle\n";
    const merged = mergeTailLogLines([gateway, openshell], 10);
    expect(merged.trimEnd().split("\n")).toEqual([
      "[1779488800.100] g header",
      "  continuation line for g",
      "[1779488800.200] o middle",
      "[1779488800.400] g next",
    ]);
  });

  it("deterministically interleaves identically-timestamped lines by source order", () => {
    const gateway = "[1779488800.000] g\n";
    const openshell = "[1779488800.000] o\n";
    const merged = mergeTailLogLines([gateway, openshell], 10);
    expect(merged.trimEnd().split("\n")).toEqual(["[1779488800.000] g", "[1779488800.000] o"]);
  });

  it("preserves source order for untimestamped lines and places them before timestamped lines", () => {
    const single = "no timestamp here\n[1779488800.000] later\n";
    const merged = mergeTailLogLines([single], 10);
    expect(merged.trimEnd().split("\n")).toEqual(["no timestamp here", "[1779488800.000] later"]);
  });

  it("returns at most maxLines when both sources individually have >= maxLines", () => {
    // The original bug: passing --tail 5 to each source yields 10 lines.
    const gatewayFive = Array.from({ length: 5 }, (_v, i) => `[${i + 1}] g${i + 1}`).join("\n");
    const openshellFive = Array.from({ length: 5 }, (_v, i) => `[${i + 1}.5] o${i + 1}`).join("\n");
    const merged = mergeTailLogLines([gatewayFive, openshellFive], 5);
    const lines = merged.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBe(5);
  });

  it("ignores empty sources without producing extra blank lines", () => {
    const merged = mergeTailLogLines(["", "[1] a\n", ""], 3);
    expect(merged).toBe("[1] a\n");
  });

  it("appends a trailing newline so callers can pipe through process.stdout.write", () => {
    expect(mergeTailLogLines(["[1] a"], 3).endsWith("\n")).toBe(true);
  });
});
