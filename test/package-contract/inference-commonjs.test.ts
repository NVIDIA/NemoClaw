// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("compiled inference CommonJS contracts", () => {
  it("rejects non-WSL Ollama when the backend and proxy ports collide", () => {
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        [
          "const platform = require('./dist/lib/platform.js');",
          "platform.isWsl = () => false;",
          "const localInference = require('./dist/lib/inference/local.js');",
          "const result = localInference.validateLocalProvider('ollama-local', () => '{\"models\":[]}');",
          "process.stdout.write(JSON.stringify(result));",
        ].join(""),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_OLLAMA_PORT: "11435",
          NEMOCLAW_OLLAMA_PROXY_PORT: "11435",
        },
      },
    );

    const result = JSON.parse(output);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("NEMOCLAW_OLLAMA_PORT");
    expect(result.message).toContain("NEMOCLAW_OLLAMA_PROXY_PORT");
    expect(result.message).toContain("11435");
  });

  it("retries strict tool-call validation after the parent curl process times out", () => {
    const onboardProbePath = JSON.stringify(
      path.join(process.cwd(), "dist", "lib", "inference", "onboard-probes.js"),
    );
    const httpProbePath = JSON.stringify(
      path.join(process.cwd(), "dist", "lib", "adapters", "http", "probe.js"),
    );
    const script = `
const httpProbe = require(${httpProbePath});
let calls = 0;
const timeoutMs = [];
httpProbe.runCurlProbe = (_args, opts = {}) => {
  calls += 1;
  timeoutMs.push(opts.timeoutMs ?? null);
  if (calls === 1) {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: -110,
      body: "",
      stderr: "spawnSync curl ETIMEDOUT",
      message: "curl failed (exit -110): spawnSync curl ETIMEDOUT",
    };
  }
  return {
    ok: true,
    httpStatus: 200,
    curlStatus: 0,
    body: JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              {
                type: "function",
                function: {
                  name: "sessions_send",
                  arguments: { message: "hello" },
                },
              },
            ],
          },
        },
      ],
    }),
    stderr: "",
    message: "HTTP 200",
  };
};
const probes = require(${onboardProbePath});
const result = probes.probeOpenAiLikeEndpoint(
  "https://api.example.com/v1",
  "test-model",
  null,
  { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
);
process.stdout.write(JSON.stringify({ result, calls, timeoutMs }));
`;

    const run = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    const payload = JSON.parse(run.stdout);
    expect(payload.result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(payload.calls).toBe(2);
    expect(payload.timeoutMs).toHaveLength(2);
    expect(payload.timeoutMs[0]).toBeGreaterThan(0);
    expect(payload.timeoutMs[1]).toBeGreaterThan(payload.timeoutMs[0]);
  });
});
