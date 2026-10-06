// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { nativeInferenceProbeAuthScript } from "./native-inference-probe-auth";

describe("native probe workload credential handles", () => {
  describe.each([
    "NVIDIA_INFERENCE_API_KEY",
    "NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY",
    "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
  ] as const)("issued credential binding for %s", (credentialEnv) => {
    it.each([
      ["v42", false],
      ["v42", true],
      [`s${"a".repeat(64)}`, false],
      [`s${"a".repeat(64)}`, true],
    ] as const)("uses issued %s handle with anthropic=%s", (version, anthropic) => {
      const handle = `openshell:resolve:env:${version}_${credentialEnv}`;
      const command = [
        ...nativeInferenceProbeAuthScript(credentialEnv, anthropic),
        'printf "%s" "$AUTH_HEADER"',
      ].join("; ");
      const result = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, [credentialEnv]: handle },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        `${anthropic ? "x-api-key: " : "Authorization: Bearer "}${handle}`,
      );
      expect(result.stderr).toBe("");
    });
  });

  it.each([
    "",
    "sk-real-secret",
    "unused",
    "nemoclaw-openshell-provider",
    "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY",
    "openshell:resolve:env:v42_OTHER_KEY",
    "openshell:resolve:env:sabc_NVIDIA_INFERENCE_API_KEY",
    "openshell:resolve:env:v42_NVIDIA_INFERENCE_API_KEY\nInjected: value",
    "openshell:resolve:env:v42_NVIDIA_INFERENCE_API_KEY\n",
  ])("refuses invalid workload input without exposing it or continuing (%#)", (handle) => {
    const command = [
      ...nativeInferenceProbeAuthScript("NVIDIA_INFERENCE_API_KEY"),
      'printf "request-started"',
    ].join("; ");
    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, NVIDIA_INFERENCE_API_KEY: handle },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("credential-handle-unavailable\n");
    expect(result.stderr).toBe("");
  });
});
