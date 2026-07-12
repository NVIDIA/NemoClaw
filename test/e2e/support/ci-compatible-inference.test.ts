// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isGatewayManagedCompatibleInference } from "../fixtures/ci-compatible-inference.ts";

describe("gateway-managed compatible inference detection", () => {
  it.each([
    {
      label: "the explicit hosted sentinel",
      env: { NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1" },
    },
    {
      label: "a hosted-compatible key",
      env: {
        NEMOCLAW_PROVIDER: "custom",
        NVIDIA_INFERENCE_API_KEY: "hosted-compatible-test-key",
      },
    },
  ])("skips the live sandbox-egress repro for $label (#4434)", ({ env: hostedEnv }) => {
    const {
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: _hostedSentinel,
      NEMOCLAW_PROVIDER: _provider,
      NVIDIA_INFERENCE_API_KEY: _hostedKey,
      NVIDIA_API_KEY: _publicKey,
      COMPATIBLE_API_KEY: _compatibleKey,
      ...baseEnv
    } = process.env;
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      NEMOCLAW_RUN_LIVE_E2E: "1",
      NEMOCLAW_ISSUE_4434_LIVE: "1",
      ...hostedEnv,
    };

    const output = execFileSync(
      process.execPath,
      [
        path.resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "--project",
        "e2e-live",
        "test/e2e/live/issue-4434-tui-unreachable-inference.test.ts",
        "--reporter=json",
      ],
      { encoding: "utf8", env, timeout: 30_000 },
    );
    const report = JSON.parse(output) as {
      numPendingTests: number;
      numFailedTests: number;
      success: boolean;
      testResults: Array<{ assertionResults: Array<{ status: string }> }>;
    };

    expect(report.success).toBe(true);
    expect(report.numFailedTests).toBe(0);
    expect(report.numPendingTests).toBe(1);
    expect(report.testResults[0]?.assertionResults[0]?.status).toBe("skipped");
  }, 30_000);

  it("detects the explicit hosted inference sentinel", () => {
    expect(isGatewayManagedCompatibleInference({ NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1" })).toBe(
      true,
    );
  });

  it("detects a hosted-compatible key for non-public providers", () => {
    expect(
      isGatewayManagedCompatibleInference({
        NEMOCLAW_PROVIDER: "custom",
        NVIDIA_INFERENCE_API_KEY: "hosted-compatible-test-key",
      }),
    ).toBe(true);
  });

  it.each([
    "build",
    "cloud",
    "nvidia",
    "nvidia-prod",
  ])("keeps %s on the public inference path", (provider) => {
    expect(
      isGatewayManagedCompatibleInference({
        NEMOCLAW_PROVIDER: provider,
        NVIDIA_INFERENCE_API_KEY: "hosted-compatible-test-key",
      }),
    ).toBe(false);
  });

  it("keeps public nvapi keys on the sandbox-egress repro path", () => {
    expect(
      isGatewayManagedCompatibleInference({ NVIDIA_INFERENCE_API_KEY: "nvapi-test-key" }),
    ).toBe(false);
  });
});
