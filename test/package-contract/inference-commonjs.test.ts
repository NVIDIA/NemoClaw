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

  it("exposes the WSL advisory through the compiled probe interface (#10413)", () => {
    // `onboard-probes` replaces its module namespace with an explicit
    // `module.exports` object, so a TypeScript `export const` alone is dropped
    // from the compiled artifact. Source-mode tests cannot see that: they
    // resolve the ESM export and pass either way.
    const script = [
      "const probes = require('./dist/lib/inference/onboard-probes.js');",
      "process.stdout.write(JSON.stringify({",
      "  type: typeof probes.WSL_SLOW_VERIFICATION_ADVISORY,",
      "  value: probes.WSL_SLOW_VERIFICATION_ADVISORY || '',",
      "}));",
    ].join("");

    const run = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    const payload = JSON.parse(run.stdout) as { type: string; value: string };
    expect(payload.type).toBe("string");
    expect(payload.value).toContain("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS");
  });

  it("no longer re-exports the validation timing helper from onboarding (#10413)", () => {
    // The helper's owner is `probe-http-helpers`. The onboarding module used to
    // forward it for one test and no production caller. Proving the new import
    // works is not enough: the superseded path has to be gone from the public
    // boundary, otherwise the coupling can return unnoticed.
    const script = [
      "const onboard = require('./dist/lib/onboard.js');",
      "process.stdout.write(JSON.stringify({",
      "  forwarded: Object.prototype.hasOwnProperty.call(onboard, 'getValidationProbeCurlArgs'),",
      "  owner: typeof require('./dist/lib/inference/probe-http-helpers.js')",
      "    .getValidationProbeCurlArgs,",
      "}));",
    ].join("");

    const run = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    const payload = JSON.parse(run.stdout) as { forwarded: boolean; owner: string };
    expect(payload.forwarded).toBe(false);
    expect(payload.owner).toBe("function");
  });
});
