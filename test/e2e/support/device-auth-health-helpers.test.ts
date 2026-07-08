// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createOpenAiLikeAuthConfig } from "../../../src/lib/adapters/http/auth-config";
import { runCurlProbe } from "../../../src/lib/adapters/http/probe";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
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

describe("device auth health fixture inference wiring", () => {
  const inference = {
    apiKey: "fixture-credential",
    endpointUrl: "http://127.0.0.1:34567/v1",
    model: "fixture-model",
  };

  it("stages the authenticated fixture as a compatible endpoint", () => {
    const env = commandEnv(inference);

    expect(env.NEMOCLAW_PROVIDER).toBe("custom");
    expect(env.NEMOCLAW_ENDPOINT_URL).toBe(inference.endpointUrl);
    expect(env.NEMOCLAW_MODEL).toBe(inference.model);
    expect(env.NEMOCLAW_COMPAT_MODEL).toBe(inference.model);
    expect(env.NEMOCLAW_PREFERRED_API).toBe("openai-completions");
    expect(env.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(env.COMPATIBLE_API_KEY).toBe(inference.apiKey);
  });

  it("runs install.sh fresh with authenticated fixture inference env", async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const host = {
      command: async (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ args, env: options.env });
        return okResult([_command, ...args]);
      },
    } as HostCliClient;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-auth-health-helper-"));

    try {
      await installDeviceAuthSandbox(host, inference, path.join(tmpDir, "install.log"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["install.sh", "--non-interactive", "--fresh"]);
    expect(calls[0].env).toMatchObject({
      COMPATIBLE_API_KEY: inference.apiKey,
      NEMOCLAW_ENDPOINT_URL: inference.endpointUrl,
      NEMOCLAW_MODEL: inference.model,
      NEMOCLAW_PROVIDER: "custom",
    });
  });

  it("observes bearer auth through the production curl-config transport", async () => {
    const fake = await startFakeOpenAiCompatibleServer({
      apiKey: inference.apiKey,
      model: inference.model,
      requireAuth: true,
    });
    const authConfig = createOpenAiLikeAuthConfig(inference.apiKey);

    try {
      const result = runCurlProbe(
        [
          "-sS",
          "-H",
          "Content-Type: application/json",
          ...authConfig.args,
          "-d",
          JSON.stringify({
            model: inference.model,
            messages: [{ role: "user", content: "Reply with exactly: OK" }],
            max_tokens: 8,
          }),
          `${fake.baseUrl}/chat/completions`,
        ],
        { trustedConfigFiles: authConfig.trustedConfigFiles },
      );

      expect(result.ok, result.message).toBe(true);
      expect(fake.requests()).toContainEqual(
        expect.objectContaining({
          auth: "ok",
          model: inference.model,
          path: "/v1/chat/completions",
        }),
      );
    } finally {
      authConfig.cleanup();
      await fake.close();
    }
  });
});
