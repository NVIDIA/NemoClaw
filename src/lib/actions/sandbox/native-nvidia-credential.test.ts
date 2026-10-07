// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellSandboxBufferedCommandRequest } from "../../adapters/openshell/sandbox-command";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_NVIDIA_CREDENTIAL_GUARD } from "../../inference/native-nvidia/credential";
import { readNativeNvidiaCredentialPlaceholder } from "./inference-invocation-probe";

const scoped = "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY";
const rejected = [
  "",
  "raw-credential-must-not-leave-sandbox",
  "nemoclaw-openshell-provider",
  "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY",
  "openshell:resolve:env:v7_OTHER_API_KEY",
  scoped + "\nextra",
  scoped + "\n",
  scoped + "\r",
  "$(touch /should-not-run)",
];

describe("native NVIDIA credential transport", () => {
  it.each([scoped, `openshell:resolve:env:s${"a".repeat(64)}_NVIDIA_INFERENCE_API_KEY`])(
    "reads the scoped placeholder issued to the sandbox process (%s)",
    async (placeholder) => {
      const runBuffered = vi.fn(async (request: OpenShellSandboxBufferedCommandRequest) => {
        const result = spawnSync(request.command[0], request.command.slice(1), {
          encoding: "utf8",
          env: { PATH: process.env.PATH, NVIDIA_INFERENCE_API_KEY: placeholder },
        });
        return {
          outcome: { kind: "completed" as const, exitCode: result.status ?? 1 },
          stdout: result.stdout,
          stderr: result.stderr,
        };
      });
      await expect(
        readNativeNvidiaCredentialPlaceholder("alpha", "gateway-a", { runBuffered }),
      ).resolves.toBe(placeholder);
      expect(runBuffered.mock.calls[0][0]).toMatchObject({
        sandboxName: "alpha",
        target: { kind: "named", gatewayName: "gateway-a" },
      });
    },
  );

  it.each(rejected)("rejects an unusable value without printing it or continuing (%j)", (value) => {
    const result = spawnSync(
      "/bin/sh",
      ["-c", `${NATIVE_NVIDIA_CREDENTIAL_GUARD}; printf should-not-run`],
      { encoding: "utf8", env: { PATH: process.env.PATH, NVIDIA_INFERENCE_API_KEY: value } },
    );
    expect(result.status).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it.each(rejected)("does not trust malformed transport output (%j)", async (stdout) => {
    const runBuffered = vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode: 0 },
      stdout,
      stderr: "",
    }));
    await expect(
      readNativeNvidiaCredentialPlaceholder("alpha", "gateway-a", { runBuffered }),
    ).rejects.toThrow("no verified scoped native NVIDIA credential placeholder");
  });

  it("does not report transport diagnostics that might contain credentials", async () => {
    const runBuffered = vi.fn(async () => {
      throw new Error("raw-credential-from-transport");
    });
    await expect(
      readNativeNvidiaCredentialPlaceholder("alpha", "gateway-a", { runBuffered }),
    ).rejects.toThrow(/^The sandbox has no verified scoped native NVIDIA credential placeholder/);
  });
});
