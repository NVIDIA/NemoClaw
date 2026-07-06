// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Output-assembly contract for `nemoclaw <name> config get [--key ...]`.
//
// This pins the two invariants the command owes the operator, both of which
// live in configGet's own assembly step rather than in the shared credential
// filter (whose field detection is covered by credential-filter.test.ts):
//
//   1. No credential-shaped value ever reaches stdout — provider keys
//      (`nvapi-`, `sk-`), `Bearer ` tokens, etc. are stripped by
//      stripCredentials before printing (whole config AND a nested --key view).
//   2. The `gateway` field is dropped entirely, because it holds runtime
//      auth material regenerated at gateway launch.
//
// The class of gap: an `nvapi-` credential-format assertion that previously
// only existed in a live E2E test, so a regression here shipped unnoticed. We
// drive the real configGet through a stubbed openshell read + captured stdout.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The shared source-require hook compiles the TypeScript sources into the same
// writable CommonJS cache these modules already share, so replacing the
// openshell client's capture export before requiring ./config makes configGet's
// internal read return our fixture instead of shelling out to a real sandbox.
const clientModulePath = require.resolve("../adapters/openshell/client");
const configModulePath = require.resolve("./config");

type CaptureResult = {
  status: number;
  signal: null;
  error?: undefined;
  stdout: string;
  output: string;
  stderr: string;
};

const client = require(clientModulePath) as {
  captureOpenshellCommand: (...args: unknown[]) => CaptureResult;
};
const realCapture = client.captureOpenshellCommand;

// The raw config the fake sandbox `cat` returns. It carries every secret
// shape the redaction contract must strip plus a gateway block that must be
// omitted wholesale, alongside benign fields that must survive untouched.
const SANDBOX_CONFIG = {
  model: { id: "nvidia/nemotron-3", temperature: 0.2 },
  provider: {
    // Low-entropy, obviously-fake fixtures (sequential alphabet) so the secret
    // scanner does not flag them while they still match the redaction patterns.
    apiKey: "nvapi-abcdefghijklmnopqrstuvwxyz0123456789",
    baseUrl: "https://inference.nvidia.com/v1",
  },
  openaiCompat: { apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" },
  mcp: {
    remote: { headers: { authorization: "Bearer super-secret-token-value" } },
  },
  gateway: {
    token: "nvapi-gateway000000000000000000000000000000",
    url: "http://127.0.0.1:8080",
  },
};

function loadConfigGet(): (name: string, opts?: { key?: string; format?: string }) => void {
  delete require.cache[configModulePath];
  const mod = require(configModulePath) as {
    configGet: (name: string, opts?: { key?: string; format?: string }) => void;
  };
  return mod.configGet;
}

function stubSandboxRead(rawConfig: unknown): void {
  const raw = JSON.stringify(rawConfig);
  client.captureOpenshellCommand = () => ({
    status: 0,
    signal: null,
    stdout: raw,
    output: raw,
    stderr: "",
  });
}

function captureStdout(run: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("\n");
}

describe("configGet output redaction and gateway omission (#config-get)", () => {
  beforeEach(() => {
    stubSandboxRead(SANDBOX_CONFIG);
  });

  afterEach(() => {
    client.captureOpenshellCommand = realCapture;
    delete require.cache[configModulePath];
  });

  it("never prints nvapi-, sk-, or Bearer credential values in the full config", () => {
    const configGet = loadConfigGet();
    const out = captureStdout(() => configGet("alpha"));

    expect(out).not.toMatch(/nvapi-/);
    expect(out).not.toMatch(/sk-proj-/);
    expect(out).not.toMatch(/Bearer super-secret-token-value/);
    expect(out).not.toContain("super-secret-token-value");
  });

  it("omits the gateway field entirely from the full config", () => {
    const configGet = loadConfigGet();
    const out = captureStdout(() => configGet("alpha"));

    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("gateway");
  });

  it("passes non-secret fields through unredacted", () => {
    const configGet = loadConfigGet();
    const out = captureStdout(() => configGet("alpha"));

    const parsed = JSON.parse(out) as {
      model: { id: string; temperature: number };
      provider: { baseUrl: string };
    };
    expect(parsed.model.id).toBe("nvidia/nemotron-3");
    expect(parsed.model.temperature).toBe(0.2);
    // The provider URL is not a credential and must survive redaction.
    expect(parsed.provider.baseUrl).toBe("https://inference.nvidia.com/v1");
  });

  it("redacts a credential reached through a nested --key path", () => {
    const configGet = loadConfigGet();
    const out = captureStdout(() => configGet("alpha", { key: "provider.apiKey" }));

    expect(out).not.toMatch(/nvapi-/);
    expect(out).toContain("[STRIPPED_BY_MIGRATION]");
  });

  it("returns the leaf value for a non-secret --key path", () => {
    const configGet = loadConfigGet();
    const out = captureStdout(() => configGet("alpha", { key: "model.id" }));

    expect(JSON.parse(out)).toBe("nvidia/nemotron-3");
  });

  it("refuses to expose the gateway section via --key gateway (#config-get)", () => {
    const configGet = loadConfigGet();
    // gateway is deleted before dotpath extraction, so the key is not found and
    // the command fails rather than leaking regenerated auth material.
    expect(() => configGet("alpha", { key: "gateway.token" })).toThrow(/not found/i);
  });
});
