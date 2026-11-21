// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  nativeLocalIdentity,
  type NativeLocalBinding,
} from "../../../src/lib/inference/native-local/contract.ts";
import type { SandboxEntry } from "../../../src/lib/state/registry.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { gpuOllamaChatCommand, readGpuOllamaRoute, SANDBOX_NAME } from "../live/gpu-e2e-helpers.ts";

const binding = {
  provider: "ollama-local" as const,
  agent: "openclaw" as const,
  endpointUrl: "http://host.openshell.internal:11435/v1",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "authenticated" as const,
  gatewayName: "gpu-gateway",
  sandboxName: SANDBOX_NAME,
};
const receipt = {
  ...binding,
  ...nativeLocalIdentity(binding),
  schemaVersion: 1 as const,
  providerId: "gpu-provider-id",
};
const environment = { OPENSHELL_GATEWAY: "gpu-gateway" };

function changedReceipt(changes: Partial<NativeLocalBinding>) {
  const selected = { ...binding, ...changes };
  return { ...receipt, ...selected, ...nativeLocalIdentity(selected) };
}
const metadata = [
  `Name: ${receipt.providerName}`,
  `Id: ${receipt.providerId}`,
  "Resource version: 1",
  `Type: ${receipt.profileId}`,
  "Credential keys: NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  "Config keys: <none>",
].join("\n");

function entry(overrides: Record<string, unknown> = {}): SandboxEntry {
  return {
    name: SANDBOX_NAME,
    agent: null,
    provider: "ollama-local",
    nativeLocalProviderAttachment: receipt,
    ...overrides,
  } as SandboxEntry;
}

function client(providerText = metadata, attachedText = receipt.providerName, exitCode = 0) {
  const openshell = vi
    .fn()
    .mockResolvedValueOnce({ exitCode, stdout: providerText, stderr: "" })
    .mockResolvedValueOnce({ exitCode: 0, stdout: attachedText, stderr: "" });
  return { openshell, sandbox: { openshell } as unknown as SandboxClient };
}

describe("GPU Ollama native route evidence", () => {
  it("observes the scoped provider identity and sandbox attachment", async () => {
    const { sandbox, openshell } = client();
    expect(await readGpuOllamaRoute(sandbox, entry(), environment)).toEqual(receipt);
    expect(openshell.mock.calls).toEqual([
      [
        ["provider", "get", "-g", "gpu-gateway", receipt.providerName],
        {
          env: environment,
          timeoutMs: 30_000,
          captureLimitBytes: 16 * 1024,
          artifactName: "gpu-ollama-native-provider",
        },
      ],
      [
        ["sandbox", "provider", "list", "-g", "gpu-gateway", SANDBOX_NAME],
        {
          env: environment,
          timeoutMs: 30_000,
          captureLimitBytes: 16 * 1024,
          artifactName: "gpu-ollama-native-attachment",
        },
      ],
    ]);
  });

  it.each([
    ["missing receipt", { nativeLocalProviderAttachment: undefined }],
    ["wrong sandbox", { name: "e2e-other" }],
    ["wrong registry gateway", { gatewayName: "other" }],
    ["wrong agent", { agent: "hermes" }],
    ["wrong provider", { provider: "vllm-local" }],
    ["wrong receipt agent", { nativeLocalProviderAttachment: changedReceipt({ agent: "hermes" }) }],
    ["sentinel auth", { nativeLocalProviderAttachment: changedReceipt({ authMode: "sentinel" }) }],
    [
      "different credential authority",
      { nativeLocalProviderAttachment: changedReceipt({ credentialEnv: "OTHER_KEY" }) },
    ],
    [
      "wrong receipt identity",
      { nativeLocalProviderAttachment: { ...receipt, providerName: "other" } },
    ],
    [
      "wrong receipt sandbox",
      { nativeLocalProviderAttachment: { ...receipt, sandboxName: "e2e-other" } },
    ],
    [
      "wrong credential binding",
      { nativeLocalProviderAttachment: { ...receipt, credentialEnv: "OTHER_KEY" } },
    ],
  ])("rejects %s before querying the runtime", async (_label, overrides) => {
    const { sandbox, openshell } = client();
    expect(
      await readGpuOllamaRoute(sandbox, entry(overrides as Record<string, unknown>), environment),
    ).toBeNull();
    expect(openshell).not.toHaveBeenCalled();
  });

  it("rejects a different gateway", async () => {
    const { sandbox, openshell } = client();
    expect(await readGpuOllamaRoute(sandbox, entry(), { OPENSHELL_GATEWAY: "other" })).toBeNull();
    expect(openshell).not.toHaveBeenCalled();
  });

  it.each([
    ["provider name", `Name: ${receipt.providerName}`, "Name: other"],
    ["immutable id", `Id: ${receipt.providerId}`, "Id: other-id"],
    ["profile", `Type: ${receipt.profileId}`, "Type: openai"],
    ["credential", "Credential keys: NEMOCLAW_LOCAL_INFERENCE_TOKEN", "Credential keys: OTHER_KEY"],
    [
      "extra credential",
      "Credential keys: NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      "Credential keys: NEMOCLAW_LOCAL_INFERENCE_TOKEN, OTHER_KEY",
    ],
    ["legacy config", "Config keys: <none>", "Config keys: OPENAI_BASE_URL"],
  ])("rejects mismatched runtime %s", async (_label, original, replacement) => {
    const { sandbox } = client(metadata.replace(original, replacement));
    expect(await readGpuOllamaRoute(sandbox, entry(), environment)).toBeNull();
  });

  it("rejects failed provider reads even when stdout looks valid", async () => {
    const { sandbox } = client(metadata, receipt.providerName, 1);
    expect(await readGpuOllamaRoute(sandbox, entry(), environment)).toBeNull();
  });

  it("rejects a provider attached only under a different name", async () => {
    const { sandbox } = client(metadata, `${receipt.providerName}-other`);
    expect(await readGpuOllamaRoute(sandbox, entry(), environment)).toBeNull();
  });

  it("rejects a failed attachment read", async () => {
    const { sandbox, openshell } = client();
    openshell
      .mockReset()
      .mockResolvedValueOnce({ exitCode: 0, stdout: metadata })
      .mockResolvedValueOnce({ exitCode: 1, stdout: receipt.providerName });
    expect(await readGpuOllamaRoute(sandbox, entry(), environment)).toBeNull();
  });
});

describe("GPU Ollama native request", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "gpu-native-request-"));
    writeFileSync(path.join(directory, "curl"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o755,
    });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function run(handle: string, model = "qwen3.5:9b") {
    return execFileSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", gpuOllamaChatCommand(receipt, model)],
      {
        encoding: "utf8",
        env: {
          HOME: directory,
          PATH: `${directory}:/usr/bin:/bin`,
          NEMOCLAW_LOCAL_INFERENCE_TOKEN: handle,
        },
      },
    );
  }

  it("sends the scoped handle and quoted payload to the native endpoint", () => {
    const handle = "openshell:resolve:env:v2_NEMOCLAW_LOCAL_INFERENCE_TOKEN";
    const model = "model'with quote";
    const args = run(handle, model).trim().split("\n");
    expect(args).toEqual([
      "-sS",
      "--max-time",
      "120",
      `${receipt.endpointUrl}/chat/completions`,
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${handle}`,
      "--data",
      JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
        reasoning_effort: "none",
        seed: 0,
        temperature: 0,
        max_tokens: 32,
      }),
    ]);
  });

  it.each([
    "",
    "raw-proxy-secret",
    "openshell:resolve:env:OTHER_KEY",
    "openshell:resolve:env:v2_NEMOCLAW_LOCAL_INFERENCE_TOKEN\nraw",
  ])("rejects an invalid credential handle %j before curl", (handle) => {
    expect(() => run(handle)).toThrow();
  });
});
