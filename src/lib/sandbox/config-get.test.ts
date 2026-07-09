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
  stubSandboxRawRead(JSON.stringify(rawConfig));
}

function stubSandboxRawRead(raw: string): void {
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

function captureError(run: () => void): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected callback to throw.");
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

  it("does not echo credential-bearing source text from malformed JSON", () => {
    const secret = "nvapi-jsonabcdefghijklmnopqrstuvwxyz0123456789";
    const sourceLine = `{"provider":{"apiKey":"${secret}"}} trailing-text`;
    stubSandboxRawRead(sourceLine);

    const error = captureError(() => loadConfigGet()("alpha"));

    expect(error.message).toContain("Invalid JSON configuration syntax.");
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(sourceLine);
  });
});

describe("configGet parsing for manifest-declared formats (#6548)", () => {
  const registryPath = require.resolve("../state/registry");
  const agentDefsPath = require.resolve("../agent/defs");
  const registry = require(registryPath) as { getSandbox: (name: string) => unknown };
  const agentDefs = require(agentDefsPath) as { loadAgent: (name: string) => unknown };
  const realGetSandbox = registry.getSandbox;
  const realLoadAgent = agentDefs.loadAgent;

  // A dcode config.toml as generate-config.ts writes it: a `# ...` comment
  // header (the byte that broke JSON.parse in #6548) plus nested tables and an
  // array, so parseConfig must use a real TOML parser, not JSON.parse.
  const DCODE_CONFIG_TOML = [
    "# Generated by NemoClaw. Do not edit by hand.",
    "",
    "[models]",
    'default = "openai:nvidia/meta/llama-3.1-8b-instruct"',
    "",
    "[models.providers.openai]",
    'models = ["nvidia/meta/llama-3.1-8b-instruct"]',
    "enabled = true",
    "",
    "[update]",
    "check = false",
    "",
    "[provider]",
    'api_key = "nvapi-abcdefghijklmnopqrstuvwxyz0123456789"',
    "",
    "[gateway]",
    'token = "nvapi-gateway000000000000000000000000000000"',
    'url = "http://127.0.0.1:8080"',
    "",
  ].join("\n");

  beforeEach(() => {
    // Make the sandbox resolve to the dcode agent, whose manifest declares
    // `format: toml`, so parseConfig takes the TOML branch.
    registry.getSandbox = () => ({ agent: "langchain-deepagents-code" });
    agentDefs.loadAgent = () => ({
      configPaths: { dir: "/sandbox/.deepagents", configFile: "config.toml", format: "toml" },
    });
    // The sandbox `cat` returns the raw TOML text.
    client.captureOpenshellCommand = () => ({
      status: 0,
      signal: null,
      stdout: DCODE_CONFIG_TOML,
      output: DCODE_CONFIG_TOML,
      stderr: "",
    });
  });

  afterEach(() => {
    registry.getSandbox = realGetSandbox;
    agentDefs.loadAgent = realLoadAgent;
    client.captureOpenshellCommand = realCapture;
    delete require.cache[configModulePath];
  });

  it("parses a dcode TOML config (comment header + nested tables) rather than failing JSON.parse", () => {
    const configGet = loadConfigGet();
    const out = captureStdout(() => configGet("dcode-sb"));

    const parsed = JSON.parse(out) as {
      models: { default: string; providers: { openai: { enabled: boolean; models: string[] } } };
      update: { check: boolean };
    };
    expect(parsed.models.default).toBe("openai:nvidia/meta/llama-3.1-8b-instruct");
    expect(parsed.models.providers.openai.enabled).toBe(true);
    expect(parsed.models.providers.openai.models).toEqual(["nvidia/meta/llama-3.1-8b-instruct"]);
    expect(parsed.update.check).toBe(false);
  });

  it("returns a TOML-origin leaf selected with --key", () => {
    const configGet = loadConfigGet();
    const out = captureStdout(() => configGet("dcode-sb", { key: "models.default" }));

    expect(JSON.parse(out)).toBe("openai:nvidia/meta/llama-3.1-8b-instruct");
  });

  it("renders sanitized TOML-origin config as requested YAML", () => {
    const configGet = loadConfigGet();
    const out = captureStdout(() => configGet("dcode-sb", { format: "yaml" }));
    const parsed = require("yaml").parse(out) as {
      models: { default: string };
      update: { check: boolean };
      provider: { api_key: string };
    };

    expect(parsed.models.default).toBe("openai:nvidia/meta/llama-3.1-8b-instruct");
    expect(parsed.update.check).toBe(false);
    expect(parsed.provider.api_key).toBe("[STRIPPED_BY_MIGRATION]");
    expect(parsed).not.toHaveProperty("gateway");
    expect(out).not.toContain("nvapi-");
  });

  it("redacts credentials and omits gateway auth after TOML parsing", () => {
    const configGet = loadConfigGet();
    const out = captureStdout(() => configGet("dcode-sb"));

    expect(out).not.toContain("nvapi-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("nvapi-gateway000000000000000000000000000000");
    expect(out).toContain("[STRIPPED_BY_MIGRATION]");
    expect(JSON.parse(out)).not.toHaveProperty("gateway");
  });

  it("does not echo credential-bearing source lines from malformed TOML", () => {
    const secret = "nvapi-tomlabcdefghijklmnopqrstuvwxyz0123456789";
    const sourceLine = `api_key = "${secret}" trailing-text`;
    stubSandboxRawRead(["[provider]", sourceLine].join("\n"));

    const error = captureError(() => loadConfigGet()("dcode-sb"));

    expect(error.message).toContain("Invalid TOML configuration syntax.");
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(sourceLine);
  });

  it("rejects excessive TOML structure without echoing credential-bearing source", () => {
    const secret = "credential-canary-must-not-escape";
    const tablePath = Array.from({ length: 64 }, (_, index) => `level${index}`).join(".");
    stubSandboxRawRead(`[${tablePath}]\npassword = "${secret}"`);

    const error = captureError(() => loadConfigGet()("dcode-sb"));

    expect(error.message).toContain("Config exceeds safe structural limits.");
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(tablePath);
  });

  it("does not echo credential-bearing source lines from malformed YAML", () => {
    registry.getSandbox = () => ({ agent: "hermes" });
    agentDefs.loadAgent = () => ({
      configPaths: { dir: "/sandbox/.hermes", configFile: "config.yaml", format: "yaml" },
    });
    const secret = "nvapi-yamlabcdefghijklmnopqrstuvwxyz0123456789";
    const sourceLine = `api_key: "${secret}" trailing-text`;
    stubSandboxRawRead(sourceLine);

    const error = captureError(() => loadConfigGet()("hermes-sb"));

    expect(error.message).toContain("Invalid YAML configuration syntax.");
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(sourceLine);
  });

  it("refuses config set before attempting to rewrite an image-baked TOML file", async () => {
    delete require.cache[configModulePath];
    const { configSet } = require(configModulePath) as {
      configSet: (name: string, opts: { key: string; value: string }) => Promise<void>;
    };

    await expect(
      configSet("dcode-sb", { key: "models.default", value: "openai:nvidia/new-model" }),
    ).rejects.toThrow(/config set is not available.*baked into the sandbox image.*re-onboard/i);
  });
});
