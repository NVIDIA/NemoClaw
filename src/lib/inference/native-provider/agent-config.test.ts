// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import { nativeHostedAgentConfig } from "./agent-config";
import { HOSTED_NATIVE_PROVIDERS } from "./hosted";

describe.each(HOSTED_NATIVE_PROVIDERS)("$label agent credential binding", (provider) => {
  it("uses only an OpenShell placeholder for the native endpoint (#12589)", () => {
    expect(nativeHostedAgentConfig(provider.logicalProvider, provider.endpoint)?.apiKey).toBe(
      `openshell:resolve:env:${provider.credentialEnv}`,
    );
  });
});

describe.each(
  HOSTED_NATIVE_PROVIDERS.filter((provider) => provider.logicalProvider !== "hermes-provider"),
)("$label fixed destination", (provider) => {
  it.each(["https://attacker.example/v1"])(
    "rejects a different destination %s (#12589)",
    (endpoint) => {
      expect(() => nativeHostedAgentConfig(provider.logicalProvider, endpoint)).toThrow(
        /does not match/u,
      );
    },
  );
});

it("carries both OpenRouter attribution headers on native requests (#12589)", () => {
  expect(
    nativeHostedAgentConfig("openrouter-api", "https://openrouter.ai/api/v1")?.headers,
  ).toEqual({
    "HTTP-Referer": "https://www.nvidia.com/nemoclaw/",
    "X-OpenRouter-Title": "NVIDIA NemoClaw",
  });
});

it.each(HOSTED_NATIVE_PROVIDERS)(
  "preserves existing shared-route $label configuration until selection changes",
  (provider) => {
    expect(
      nativeHostedAgentConfig(provider.logicalProvider, "https://inference.local/v1"),
    ).toBeUndefined();
  },
);

it.each([
  "https://user:secret@example.com/v1",
  "https://example.com/v1?token=secret",
  "https://example.com/v1#fragment",
  "https://example.com/v1%2fextra",
  "https://example.com/v1%5cextra",
  "https://example.com/v1%0Aextra",
  "https://example.com/\n/v1",
  "file:///etc/passwd",
])("rejects malformed retained Hermes image configuration %s", (endpoint) => {
  expect(() => nativeHostedAgentConfig("hermes-provider", endpoint)).toThrow();
});

it.each(["http://host.openshell.internal:42103/v1", "https://retained.example/team/v1"])(
  "serializes only a resolver handle for retained Hermes endpoint %s",
  (endpoint) => {
    vi.stubEnv("OPENAI_API_KEY", "host-secret-must-not-enter-config");
    expect(nativeHostedAgentConfig("hermes-provider", endpoint)).toEqual({
      credentialEnv: "OPENAI_API_KEY",
      apiKey: "openshell:resolve:env:OPENAI_API_KEY",
    });
  },
);

it("loads image provider configuration without host modules or compiled CLI dependencies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-hosted-image-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const providers = path.join(root, "inference", "native-provider");
  fs.mkdirSync(providers, { recursive: true });
  fs.copyFileSync(
    path.join(import.meta.dirname, "agent-config.ts"),
    path.join(providers, "agent-config.ts"),
  );
  fs.copyFileSync(path.join(import.meta.dirname, "catalog.ts"), path.join(providers, "catalog.ts"));
  const core = path.join(root, "core");
  fs.mkdirSync(core);
  fs.copyFileSync(
    path.resolve(import.meta.dirname, "../../core/endpoint-url-safety.ts"),
    path.join(core, "endpoint-url-safety.ts"),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { nativeHostedAgentConfig } from ${JSON.stringify(new URL(`file://${providers}/agent-config.ts`).href)};
    console.log(JSON.stringify(nativeHostedAgentConfig("hermes-provider", "http://host.openshell.internal:42103/v1")));
  `,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH, OPENAI_API_KEY: "must-stay-private" },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    credentialEnv: "OPENAI_API_KEY",
    apiKey: "openshell:resolve:env:OPENAI_API_KEY",
  });
});
