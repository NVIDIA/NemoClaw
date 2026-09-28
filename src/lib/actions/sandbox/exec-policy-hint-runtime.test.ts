// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const { captureOpenshell, enableAuditLogs } = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  enableAuditLogs: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({ captureOpenshell }));
vi.mock("../../adapters/openshell/sandbox-settings-cli", () => ({
  cliOpenShellSandboxSettings: { enableAuditLogs },
}));

import {
  maybeEmitPolicyDenialHint,
  POLICY_HINT_MAX_RUNTIME_TIMEOUT_MS,
  POLICY_HINT_TAIL_LINES,
} from "./exec-policy-hint";
import { preparePolicyHint } from "./exec-policy-hint-integration";

const DENIAL_TIME_MS = 1783046573602;
const DENIED_LINE =
  "[1783046573.602] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /usr/bin/curl(1) -> example.com:443 [reason:not allowed by any policy]";

describe("policy-denial hint runtime adapter integration (#5978)", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("enables audit and reads the bounded OpenShell log tail through the runtime adapter", async () => {
    enableAuditLogs.mockResolvedValue({ ok: true, value: undefined });
    captureOpenshell.mockReturnValueOnce({ output: DENIED_LINE, status: 0 });
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

    expect(enableAuditLogs).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw-8091" },
      sandboxName: "runtime-sandbox",
      timeoutMs: POLICY_HINT_MAX_RUNTIME_TIMEOUT_MS,
    });
    expect(captureOpenshell).toHaveBeenNthCalledWith(
      1,
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
    enableAuditLogs.mockResolvedValue({ ok: true, value: undefined });
    captureOpenshell.mockReturnValueOnce({ error: timeout, output: "", status: null });
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
    expect(captureOpenshell).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("post-exec policy hint integration (#11763)", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ["successful", 0, 0, undefined],
    [
      "failed",
      1,
      1,
      [
        "logs",
        "-g",
        "nemoclaw-8091",
        "oc-fresh",
        "-n",
        String(POLICY_HINT_TAIL_LINES),
        "--source",
        "all",
      ],
    ],
  ])(
    "does not inspect pending devices after a %s command",
    async (_label, commandCode, calls, expectedArgv) => {
      enableAuditLogs.mockResolvedValue({ ok: true, value: undefined });
      captureOpenshell.mockReturnValue({ output: "", status: 0 });
      const complete = preparePolicyHint(
        "nemoclaw",
        "oc-fresh",
        {
          attempts: 1,
          env: {},
        },
        "nemoclaw-8091",
      );

      await complete({ commandCode });

      expect(captureOpenshell).toHaveBeenCalledTimes(calls);
      expect(captureOpenshell.mock.calls[0]?.[0]).toEqual(expectedArgv);
    },
  );
});
