// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const { captureOpenshell } = vi.hoisted(() => ({ captureOpenshell: vi.fn() }));

vi.mock("../../adapters/openshell/runtime", () => ({ captureOpenshell }));

import {
  maybeEmitPolicyDenialHint,
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
    );

    expect(captureOpenshell).toHaveBeenNthCalledWith(
      1,
      ["settings", "set", "runtime-sandbox", "--key", "ocsf_json_enabled", "--value", "true"],
      expect.objectContaining({
        ignoreError: true,
        includeStderr: true,
        timeout: POLICY_HINT_MAX_RUNTIME_TIMEOUT_MS,
      }),
    );
    expect(captureOpenshell).toHaveBeenNthCalledWith(
      2,
      ["logs", "runtime-sandbox", "-n", String(POLICY_HINT_TAIL_LINES), "--source", "all"],
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
