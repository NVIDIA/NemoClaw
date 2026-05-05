// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./runner", () => ({ ROOT: process.cwd() }));
vi.mock("./openshell-runtime", () => ({
  getOpenshellBinary: () => "openshell",
  runOpenshell: () => ({ status: 0 }),
}));

import {
  buildEnableSandboxAuditLogsArgs,
  buildSandboxLogsArgs,
  buildSandboxOpenclawGatewayLogsArgs,
  describeLogProbeResult,
  getLogsProbeTimeoutMs,
  normalizeSandboxLogsOptions,
} from "./sandbox-logs-action";

describe("sandbox logs action helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    ).toEqual(["sandbox", "exec", "-n", "alpha", "--", "tail", "-n", "25", "-f", "/tmp/gateway.log"]);
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

    vi.stubEnv("NEMOCLAW_LOGS_PROBE_TIMEOUT_MS", "1234");
    expect(getLogsProbeTimeoutMs()).toBe(1234);
    vi.stubEnv("NEMOCLAW_LOGS_PROBE_TIMEOUT_MS", "0");
    expect(getLogsProbeTimeoutMs()).toBe(5000);
    vi.stubEnv("NEMOCLAW_LOGS_PROBE_TIMEOUT_MS", "not-a-number");
    expect(getLogsProbeTimeoutMs()).toBe(5000);
  });
});
