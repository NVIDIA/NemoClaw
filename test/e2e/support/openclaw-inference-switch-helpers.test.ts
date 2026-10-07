// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentReplyContainsToken,
  anthropicToolCount,
  classifyOpenClawPostSwitchInferenceAttempt,
  gatewayOwnerProbeSource,
  MOCK_BASELINE_API_KEY,
  MOCK_BASELINE_MODEL,
  mockBaselineInference,
  parseOpenClawGatewayModelRun,
} from "../live/openclaw-inference-switch-helpers.ts";

function runGatewayOwnerProbe(
  observations: unknown[],
  options: { previousOwnerId?: string; timeoutMs?: number; modules?: number } = {},
) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-owner-probe-"));
  try {
    fs.writeFileSync(path.join(distDir, "package.json"), '{"type":"module"}');
    const reader = `const observations = ${JSON.stringify(observations)};
let index = 0;
export async function readActiveGatewayLockIdentity(options) {
  if (options.requireInspection !== true) throw new Error("Inspection is required");
  return observations[Math.min(index++, observations.length - 1)];
}`;
    fs.writeFileSync(
      path.join(distDir, options.modules === 0 ? "unrelated.js" : "gateway-lock-public.js"),
      reader,
    );
    fs.writeFileSync(
      path.join(distDir, "gateway-lock-internal.js"),
      options.modules === 2 ? reader : "export const internal = true;",
    );
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        gatewayOwnerProbeSource({
          distDir,
          previousOwnerId: options.previousOwnerId,
          timeoutMs: options.timeoutMs ?? 0,
        }),
      ],
      { encoding: "utf8", timeout: 5_000, env: { PATH: process.env.PATH } },
    );
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}

describe("OpenClaw gateway restart identity", () => {
  it("records an inspected native gateway before the switch", () => {
    const identity = { ownerId: "initial-owner", pid: 17, port: 18789 };
    const result = runGatewayOwnerProbe([identity]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(identity);
  });

  it("waits through the old owner and missing lease for a new owner with the same PID", () => {
    const identity = { ownerId: "new-owner", pid: 17, port: 18789 };
    const result = runGatewayOwnerProbe([{ ...identity, ownerId: "old-owner" }, null, identity], {
      previousOwnerId: "old-owner",
      timeoutMs: 2_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(identity);
  });

  it.each([null, {}, { ownerId: "" }, { ownerId: "old-owner", pid: 999 }])(
    "refuses missing or unchanged owner evidence: %j",
    (identity) => {
      const result = runGatewayOwnerProbe([identity], { previousOwnerId: "old-owner" });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Gateway owner did not become ready or change");
    },
  );

  it.each([0, 2])("refuses %i native identity readers", (modules) => {
    const result = runGatewayOwnerProbe([{ ownerId: "new-owner" }], { modules });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("openclaw-inference-switch post-switch retry classification", () => {
  const attempt = {
    exitCode: 1,
    httpStatus: "000",
    malformed: false,
    output: "",
    productMatched: false,
  };

  it.each([6, 7, 28, 35, 52, 56])(
    "retries only explicit transport and HTTP failures [%s]",
    (exitCode) => {
      expect(
        classifyOpenClawPostSwitchInferenceAttempt({
          ...attempt,
          exitCode,
          output: "curl transport failed",
        }),
      ).toEqual({ outcome: "failed", failureClass: "transient-external" });

      expect(
        classifyOpenClawPostSwitchInferenceAttempt({
          ...attempt,
          exitCode: 0,
          httpStatus: "503",
          output: "service unavailable",
        }),
      ).toEqual({ outcome: "failed", failureClass: "transient-external" });
      expect(
        classifyOpenClawPostSwitchInferenceAttempt({
          ...attempt,
          exitCode: 1,
          output: "ETIMEDOUT",
        }),
      ).toEqual({ outcome: "failed", failureClass: "deterministic" });
    },
  );

  it("keeps terminal and successful product mismatches out of retries", () => {
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        output: "HTTP 401 authentication failed after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "authentication" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 28,
        output: "HTTP 403 authorization failed after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "authorization" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 28,
        output: "denied by network policy after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "policy-denial" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 28,
        output: "invalid API key after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "authentication" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 0,
        httpStatus: "200",
        output: "wrong model after ETIMEDOUT",
      }),
    ).toEqual({ outcome: "failed", failureClass: "deterministic" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 0,
        httpStatus: "429",
        output: "invalid JSON after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "malformed-input" });
  });
});

describe("openclaw-inference-switch agent reply matching", () => {
  it("tolerates wrapped PONG", () => {
    expect(agentReplyContainsToken("P\nO N G", "PONG")).toBe(true);
    expect(agentReplyContainsToken("wrapped: p o\nng", "PONG")).toBe(false);
    expect(agentReplyContainsToken("the answer is PONG", "PONG")).toBe(false);
    expect(agentReplyContainsToken("PONG because the route works", "PONG")).toBe(false);
    expect(agentReplyContainsToken("PANG", "PONG")).toBe(false);
    expect(agentReplyContainsToken("SPONGE", "PONG")).toBe(false);
    expect(agentReplyContainsToken("pingpong", "PONG")).toBe(false);
  });
});

describe("openclaw-inference-switch Anthropic tool evidence", () => {
  it("distinguishes tool-free requests from malformed tool metadata", () => {
    expect(anthropicToolCount(undefined)).toBe(0);
    expect(anthropicToolCount([])).toBe(0);
    expect(anthropicToolCount([{ name: "shell" }])).toBe(1);
    expect(anthropicToolCount({ name: "shell" })).toBeNull();
    expect(anthropicToolCount("invalid")).toBeNull();
  });
});

describe("openclaw-inference-switch gateway model-run output", () => {
  it("accepts the stable gateway inference envelope", () => {
    expect(
      parseOpenClawGatewayModelRun(
        JSON.stringify({
          ok: true,
          capability: "model.run",
          transport: "gateway",
          provider: "anthropic",
          model: "mock-anthropic-model",
          attempts: [],
          outputs: [{ text: "PONG", mediaUrl: null }],
        }),
      ),
    ).toEqual({
      model: "mock-anthropic-model",
      provider: "anthropic",
      text: "PONG",
      transport: "gateway",
    });
  });

  it.each([
    "not json",
    JSON.stringify({ ok: false, capability: "model.run", transport: "gateway", outputs: [] }),
    JSON.stringify({
      ok: true,
      capability: "model.run",
      transport: "local",
      provider: "anthropic",
      model: "mock-anthropic-model",
      outputs: [{ text: "PONG" }],
    }),
    JSON.stringify({
      ok: true,
      capability: "model.run",
      transport: "gateway",
      provider: "anthropic",
      model: "mock-anthropic-model",
      outputs: [{ mediaUrl: null }],
    }),
  ])("rejects malformed or non-gateway output", (raw) => {
    expect(parseOpenClawGatewayModelRun(raw)).toBeNull();
  });
});

describe("openclaw-inference-switch mock-Anthropic baseline", () => {
  it("uses an authenticated local baseline with the compatible env wiring", () => {
    expect(mockBaselineInference("http://127.0.0.1:34567/v1")).toEqual({
      apiKey: MOCK_BASELINE_API_KEY,
      endpointUrl: "http://127.0.0.1:34567/v1",
      model: MOCK_BASELINE_MODEL,
      env: {
        COMPATIBLE_API_KEY: MOCK_BASELINE_API_KEY,
        NEMOCLAW_COMPAT_MODEL: MOCK_BASELINE_MODEL,
        NEMOCLAW_ENDPOINT_URL: "http://127.0.0.1:34567/v1",
        NEMOCLAW_MODEL: MOCK_BASELINE_MODEL,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        NEMOCLAW_PROVIDER: "custom",
      },
    });
  });

  it("threads the endpoint URL into both the config and the env", () => {
    const baseline = mockBaselineInference("http://10.0.0.5:9000/v1");
    expect(baseline.endpointUrl).toBe("http://10.0.0.5:9000/v1");
    expect(baseline.env.NEMOCLAW_ENDPOINT_URL).toBe("http://10.0.0.5:9000/v1");
  });
});
