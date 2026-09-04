// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { validateLocalProvider } from "./local";

describe("local inference Docker client isolation", () => {
  it("passes only the isolated Docker config to local-inference probe commands (#10349)", () => {
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const isolatedConfig = "/tmp/nemoclaw-isolated-docker-config";
    const calls: Array<{ cmd: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const outputs = ['{"models":[]}', "200"];
    const mockCapture = (
      cmd: readonly string[],
      opts?: { ignoreError?: boolean; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ cmd, env: opts?.env });
      return outputs[calls.length - 1] ?? "";
    };

    const result = validateLocalProvider(
      "ollama-local",
      mockCapture,
      () => {},
      () => ({
        env: { DOCKER_CONFIG: isolatedConfig },
        isolatedCredentialConfig: true,
        cleanup,
      }),
    );

    expect(result.ok).toBe(true);
    expect(calls[0]?.cmd[0]).toBe("curl");
    expect(calls[0]?.env).toBeUndefined();
    expect(calls[1]?.cmd[0]).toBe("docker");
    expect(calls[1]?.env).toEqual({ DOCKER_CONFIG: isolatedConfig });
    expect(calls[1]?.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(cleanup).toHaveBeenCalledOnce();
  }, 30_000);
});
