// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const spawnProcess = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnProcess };
});

const CONFLICTING_PORT = "11434";
const FORBIDDEN_ARTIFACTS = [
  "bedrock-runtime-adapter.pid",
  "bedrock-runtime-adapter-token",
  "bedrock-runtime-adapter.json",
  "openrouter-runtime-adapter.pid",
  "openrouter-runtime-adapter-token",
  "openrouter-runtime-adapter.json",
  "https-pin-runtime-adapter.pid",
  "https-pin-runtime-adapter-token",
  "https-pin-runtime-adapter.json",
];

async function withConflictingAdapterPort(
  envVar: string,
  operation: (tempHome: string) => Promise<void>,
): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-port-test-"));
  vi.stubEnv("HOME", tempHome);
  vi.stubEnv(envVar, CONFLICTING_PORT);
  vi.resetModules();
  spawnProcess.mockClear();
  try {
    await operation(tempHome);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

function expectNoAdapterLifecycleEffects(tempHome: string): void {
  expect(spawnProcess).not.toHaveBeenCalled();
  const stateDir = path.join(tempHome, ".nemoclaw");
  for (const filename of FORBIDDEN_ARTIFACTS) {
    expect(fs.existsSync(path.join(stateDir, filename)), filename).toBe(false);
  }
}

describe("runtime adapter port validation at public lifecycle boundaries", () => {
  it("rejects a Bedrock collision before spawning or persisting lifecycle state", async () => {
    await withConflictingAdapterPort("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT", async (tempHome) => {
      const { ensureBedrockRuntimeAdapter } = await import("./bedrock-runtime-adapter");

      await expect(
        ensureBedrockRuntimeAdapter({
          classification: {
            kind: "bedrock-runtime",
            endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            hostname: "bedrock-runtime.us-east-1.amazonaws.com",
            region: "us-east-1",
            fips: false,
          },
        }),
      ).rejects.toThrow(
        'Invalid port: NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT="11434" — must not overlap the Ollama inference default port (11434)',
      );
      expectNoAdapterLifecycleEffects(tempHome);
    });
  });

  it("rejects an OpenRouter collision before spawning or persisting lifecycle state", async () => {
    await withConflictingAdapterPort(
      "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
      async (tempHome) => {
        const { ensureOpenRouterRuntimeAdapter } = await import("./openrouter-runtime-adapter");

        await expect(
          ensureOpenRouterRuntimeAdapter({ authorizationToken: "sk-or-test" }),
        ).rejects.toThrow(
          'Invalid port: NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT="11434" — must not overlap the Ollama inference default port (11434)',
        );
        expectNoAdapterLifecycleEffects(tempHome);
      },
    );
  });

  it("rejects an HTTPS Pin collision before spawning or persisting lifecycle state", async () => {
    await withConflictingAdapterPort(
      "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
      async (tempHome) => {
        const { ensureHttpsPinRuntimeAdapter } = await import("./https-pin-runtime-adapter");

        await expect(
          ensureHttpsPinRuntimeAdapter({
            gatewayName: "gw",
            provider: "compatible-endpoint",
            endpointUrl: "https://public.example.test/v1",
            providerType: "openai",
            credentialValue: "sk-test",
            lookup: async () => [{ address: "93.184.216.34", family: 4 }],
            discoverAllowedSourceCidrs: () => ["127.0.0.1/32"],
          }),
        ).rejects.toThrow(
          'Invalid port: NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT="11434" — must not overlap the Ollama inference default port (11434)',
        );
        expectNoAdapterLifecycleEffects(tempHome);
      },
    );
  });
});
