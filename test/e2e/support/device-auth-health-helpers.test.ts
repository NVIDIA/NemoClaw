// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { commandEnv, installDeviceAuthSandbox } from "../live/device-auth-health-helpers.ts";

function okResult(command: string[]): ShellProbeResult {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command,
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout: "ok",
    timedOut: false,
  };
}

describe("device auth health hosted inference wiring", () => {
  it("stages the repo NVIDIA_INFERENCE_API_KEY as a compatible endpoint credential", () => {
    const env = commandEnv("repo-hosted-key");

    expect(env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE).toBe("1");
    expect(env.NEMOCLAW_PROVIDER).toBe("custom");
    expect(env.NEMOCLAW_ENDPOINT_URL).toBe("https://inference-api.nvidia.com/v1");
    expect(env.NEMOCLAW_MODEL).toBe("nvidia/nvidia/nemotron-3-ultra");
    expect(env.NEMOCLAW_COMPAT_MODEL).toBe("nvidia/nvidia/nemotron-3-ultra");
    expect(env.NEMOCLAW_PREFERRED_API).toBe("openai-completions");
    expect(env.NVIDIA_INFERENCE_API_KEY).toBe("repo-hosted-key");
    expect(env.COMPATIBLE_API_KEY).toBe("repo-hosted-key");
  });

  it("runs install.sh fresh with hosted-compatible inference env", async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const host = {
      command: async (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ args, env: options.env });
        return okResult([_command, ...args]);
      },
    } as HostCliClient;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-auth-health-helper-"));

    try {
      await installDeviceAuthSandbox(host, "repo-hosted-key", path.join(tmpDir, "install.log"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["install.sh", "--non-interactive", "--fresh"]);
    expect(calls[0].env).toMatchObject({
      COMPATIBLE_API_KEY: "repo-hosted-key",
      NVIDIA_INFERENCE_API_KEY: "repo-hosted-key",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NEMOCLAW_PROVIDER: "custom",
    });
  });
});
