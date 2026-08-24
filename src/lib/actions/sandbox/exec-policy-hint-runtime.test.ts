// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const { captureOpenshell } = vi.hoisted(() => ({ captureOpenshell: vi.fn() }));

vi.mock("../../adapters/openshell/runtime", () => ({ captureOpenshell }));

import {
  maybeEmitPolicyDenialHint,
  maybeEmitScopeUpgradeHint,
  POLICY_HINT_DEVICE_PROBE_TIMEOUT_MS,
  POLICY_HINT_MAX_RUNTIME_TIMEOUT_MS,
  POLICY_HINT_TAIL_LINES,
} from "./exec-policy-hint";

const DENIAL_TIME_MS = 1783046573602;
const DENIED_LINE =
  "[1783046573.602] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /usr/bin/curl(1) -> example.com:443 [reason:not allowed by any policy]";

describe("policy-denial hint runtime adapter integration (#5978)", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("enables audit and reads the bounded OpenShell log tail through the runtime adapter", async () => {
    captureOpenshell
      .mockReturnValueOnce({ output: "", status: 0 })
      .mockReturnValueOnce({ output: DENIED_LINE, status: 0 });
    const stderr: string[] = [];

    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "runtime-sandbox",
      56,
      false,
      DENIAL_TIME_MS,
      {
        attempts: 1,
        env: {},
        writeStderr: (line) => stderr.push(line),
      },
      "nemoclaw-8091",
    );

    expect(captureOpenshell).toHaveBeenNthCalledWith(
      1,
      [
        "settings",
        "set",
        "-g",
        "nemoclaw-8091",
        "runtime-sandbox",
        "--key",
        "ocsf_json_enabled",
        "--value",
        "true",
      ],
      expect.objectContaining({
        ignoreError: true,
        includeStderr: true,
        timeout: POLICY_HINT_MAX_RUNTIME_TIMEOUT_MS,
      }),
    );
    expect(captureOpenshell).toHaveBeenNthCalledWith(
      2,
      [
        "logs",
        "-g",
        "nemoclaw-8091",
        "runtime-sandbox",
        "-n",
        String(POLICY_HINT_TAIL_LINES),
        "--source",
        "all",
      ],
      expect.objectContaining({
        ignoreError: true,
        includeStderr: true,
        timeout: POLICY_HINT_MAX_RUNTIME_TIMEOUT_MS,
      }),
    );
    expect(hint).toContain("example.com:443");
    expect(stderr).toEqual([hint]);
  });

  it("stops after one failed log read without sleeping or retrying", async () => {
    const timeout = Object.assign(new Error("OpenShell log read timed out"), {
      code: "ETIMEDOUT",
    });
    captureOpenshell
      .mockReturnValueOnce({ output: "", status: 0 })
      .mockReturnValueOnce({ error: timeout, output: "", status: null });
    const sleep = vi.fn(async () => {});

    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "runtime-sandbox",
      56,
      false,
      DENIAL_TIME_MS,
      { env: {}, sleep },
    );

    expect(hint).toBeNull();
    expect(captureOpenshell).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("scope-upgrade hint runtime adapter integration (#9744)", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("reads pending devices through one bounded read-only OpenShell exec", async () => {
    captureOpenshell.mockReturnValueOnce({
      output: JSON.stringify({ pending: [{ requestId: "req-1" }] }),
      status: 0,
    });
    const stderr: string[] = [];

    const hint = await maybeEmitScopeUpgradeHint(
      "nemoclaw",
      "oc-fresh",
      1,
      false,
      ["openclaw", "cron", "add"],
      { env: {}, writeStderr: (line: string) => stderr.push(line) },
      "nemoclaw-8091",
    );

    expect(captureOpenshell).toHaveBeenCalledTimes(1);
    expect(captureOpenshell.mock.calls[0]?.[0]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "oc-fresh",
      "-g",
      "nemoclaw-8091",
      "--no-tty",
      "--",
      "openclaw",
      "devices",
      "list",
      "--json",
    ]);
    // The probe enters the sandbox and starts the OpenClaw CLI, so it needs a
    // budget the host-side audit-log read ceiling does not give it. Under that
    // ceiling the probe timed out before the OpenClaw CLI could print, and a
    // timed-out probe is silent (#10070).
    // Asserted against the shared ceiling, not only the new budget, so this
    // still fails if the probe is put back on `runtimeTimeoutMs()`.
    expect(captureOpenshell.mock.calls[0]?.[1]?.timeout).toBeGreaterThan(
      POLICY_HINT_MAX_RUNTIME_TIMEOUT_MS,
    );
    expect(captureOpenshell.mock.calls[0]?.[1]?.timeout).toBeGreaterThanOrEqual(
      POLICY_HINT_DEVICE_PROBE_TIMEOUT_MS,
    );
    expect(stderr).toEqual([hint]);
  });

  it("emits the review path when the in-sandbox probe outlasts the log-read ceiling (#10070)", async () => {
    // The probe enters the sandbox and starts the OpenClaw CLI before it can
    // answer. This adapter answers only when the caller allowed enough time,
    // so the assertion is what the operator sees rather than the option
    // NemoClaw passed.
    const SANDBOX_PROBE_DURATION_MS = 2_000;
    captureOpenshell.mockImplementation((_argv: unknown, options: { timeout: number }) =>
      options.timeout >= SANDBOX_PROBE_DURATION_MS
        ? { output: JSON.stringify({ pending: [{ requestId: "req-1" }] }), status: 0 }
        : {
            error: Object.assign(new Error("OpenShell exec timed out"), { code: "ETIMEDOUT" }),
            output: "",
            status: null,
          },
    );
    const stderr: string[] = [];

    const hint = await maybeEmitScopeUpgradeHint(
      "nemoclaw",
      "oc-fresh",
      1,
      false,
      ["openclaw", "cron", "add"],
      { env: {}, writeStderr: (line: string) => stderr.push(line) },
      "nemoclaw-8091",
    );

    expect(hint).toContain("nemoclaw oc-fresh exec -- openclaw devices list");
    expect(stderr).toEqual([hint]);
  });

  it("keeps the probe budget fixed when the log-read setting is raised (#10070)", async () => {
    // A log-read setting must not extend how long a failed exec waits for
    // optional guidance, so the budget is fixed rather than derived from it.
    vi.stubEnv("NEMOCLAW_LOGS_PROBE_TIMEOUT_MS", "60000");
    captureOpenshell.mockReturnValueOnce({
      output: JSON.stringify({ pending: [{ requestId: "req-1" }] }),
      status: 0,
    });

    await maybeEmitScopeUpgradeHint(
      "nemoclaw",
      "oc-fresh",
      1,
      false,
      ["openclaw", "cron", "add"],
      { env: {}, writeStderr: () => {} },
      "nemoclaw-8091",
    );

    expect(captureOpenshell.mock.calls[0]?.[1]?.timeout).toBe(POLICY_HINT_DEVICE_PROBE_TIMEOUT_MS);
  });

  it("stays silent when the pending-devices probe exceeds its budget (#10070)", async () => {
    const timeout = Object.assign(new Error("OpenShell exec timed out"), { code: "ETIMEDOUT" });
    captureOpenshell.mockReturnValueOnce({ error: timeout, output: "", status: null });
    const stderr: string[] = [];

    const hint = await maybeEmitScopeUpgradeHint(
      "nemoclaw",
      "oc-fresh",
      1,
      false,
      ["openclaw", "cron", "add"],
      { env: {}, writeStderr: (line: string) => stderr.push(line) },
      "nemoclaw-8091",
    );

    expect(hint).toBeNull();
    expect(stderr).toEqual([]);
  });

  it("stays silent when the pending-devices probe exits non-zero", async () => {
    captureOpenshell.mockReturnValueOnce({ output: "", status: 1 });
    const stderr: string[] = [];

    const hint = await maybeEmitScopeUpgradeHint(
      "nemoclaw",
      "oc-fresh",
      1,
      false,
      ["openclaw", "cron", "add"],
      { env: {}, writeStderr: (line: string) => stderr.push(line) },
    );

    expect(hint).toBeNull();
    expect(stderr).toEqual([]);
  });
});
