// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { captureSanitizedResolvedOpenshellAsync } from "../../adapters/openshell/sanitized-capture";
import type { ConfigObject } from "../../security/credential-filter";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import { recordingProbeShell } from "../../../../test/helpers/native-local-probe-shell";
import { probeSandboxInferenceInvocation } from "../sandbox/inference-invocation-probe";
import { resolveRegisteredSelection, readRegisteredInferenceCredentialHandle } from "./registered";
vi.mock("../../adapters/openshell/sanitized-capture", () => ({
  captureSanitizedResolvedOpenshellAsync: vi.fn(),
}));

function selection(config: ConfigObject) {
  const f = registeredInferenceFixture();
  return {
    ...f,
    input: {
      provider: f.binding.providerName,
      sandboxName: f.binding.sandboxName,
      gatewayName: f.binding.gatewayName,
      agentName: "openclaw",
      config,
      adapter: f.adapter,
    },
  };
}

function nativeConfig(extra: Record<string, unknown> = {}) {
  return {
    models: {
      providers: {
        "native-extra": {
          baseUrl: "https://native.example/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "VENDOR_API_KEY" },
          ...extra,
        },
      },
    },
  };
}

describe("registered provider native projection", () => {
  it("uses an exact environment secret reference without reading a host secret", async () => {
    const f = selection(nativeConfig());
    await expect(resolveRegisteredSelection(f.input)).resolves.toEqual(f.binding);
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["endpoint", { endpointUrl: "https://other.example/v1" }],
    ["API", { inferenceApi: "openai-responses" }],
    ["credential", { credentialEnv: "OTHER_API_KEY" }],
  ])("refuses disagreeing explicit %s metadata before mutation", async (_label, fields) => {
    const f = selection(nativeConfig());
    await expect(resolveRegisteredSelection({ ...f.input, ...fields })).rejects.toThrow(
      "disagrees",
    );
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });

  it.each([
    { apiKey: "raw-credential-canary" },
    { headers: { Authorization: "raw-credential-canary" } },
    { default_headers: { "x-api-key": "raw-credential-canary" } },
  ])("refuses raw credential or authentication header configuration", async (fields) => {
    const f = selection(nativeConfig(fields));
    await expect(resolveRegisteredSelection(f.input)).rejects.toThrow(/credential|authentication/);
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });

  it("recovers all metadata from the same-provider recorded binding", async () => {
    const f = selection({});
    await expect(resolveRegisteredSelection({ ...f.input, previous: f.binding })).resolves.toEqual(
      f.binding,
    );
  });

  it("reads the published Hermes URL and transport on retry", async () => {
    const f = selection({
      providers: {
        "native-extra": {
          api: "https://native.example/v1",
          api_mode: "chat_completions",
          api_key: "${VENDOR_API_KEY}",
        },
      },
    });
    await expect(
      resolveRegisteredSelection({ ...f.input, agentName: "hermes", previous: f.binding }),
    ).resolves.toEqual(f.binding);
  });
});

describe("registered provider invocation shell", () => {
  it("sends the scoped handle only to the recorded endpoint", async () => {
    const f = registeredInferenceFixture(true);
    const shell = recordingProbeShell(
      "200",
      JSON.stringify({ choices: [{ message: { content: "ready" } }] }),
      { VENDOR_API_KEY: f.handle },
    );
    await expect(
      probeSandboxInferenceInvocation(
        {
          sandboxName: f.binding.sandboxName,
          gatewayName: f.binding.gatewayName,
          provider: f.binding.providerName,
          model: "vendor/model",
          preferredInferenceApi: f.binding.inferenceApi,
          nativeProvider: true,
          registeredInferenceProviderAttachment: f.binding,
        },
        { execute: shell.execute },
      ),
    ).resolves.toEqual({ ok: true });
    expect(shell.destinations()).toEqual(["https://native.example/v1/chat/completions"]);
    expect(shell.requests[0]).toContain("Authorization: Bearer " + f.handle);
  });

  it.each([
    "raw-credential-canary",
    "openshell:resolve:env:VENDOR_API_KEY",
    "openshell:resolve:env:v7_OTHER_API_KEY",
    "openshell:resolve:env:v7_VENDOR_API_KEY\nraw-credential-canary",
  ])("rejects an invalid credential before curl (%s)", async (credential) => {
    const f = registeredInferenceFixture(true);
    const shell = recordingProbeShell("200", "{}", { VENDOR_API_KEY: credential });
    const result = await probeSandboxInferenceInvocation(
      {
        sandboxName: f.binding.sandboxName,
        gatewayName: f.binding.gatewayName,
        provider: f.binding.providerName,
        model: "vendor/model",
        preferredInferenceApi: f.binding.inferenceApi,
        nativeProvider: true,
        registeredInferenceProviderAttachment: f.binding,
      },
      { execute: shell.execute },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(shell.requests).toEqual([]);
  });
});

describe("registered credential handle read", () => {
  it.each([
    ["scoped", "openshell:resolve:env:v7_VENDOR_API_KEY", true],
    ["raw", "raw-credential-canary", false],
    ["unscoped", "openshell:resolve:env:VENDOR_API_KEY", false],
    ["wrong environment", "openshell:resolve:env:v7_OTHER_KEY", false],
    ["multiline", "openshell:resolve:env:v7_VENDOR_API_KEY\nraw-credential-canary", false],
  ])("reads the actual shell result for %s", async (_label, value, valid) => {
    const f = registeredInferenceFixture();
    vi.mocked(captureSanitizedResolvedOpenshellAsync).mockImplementation(async (args) => {
      expect(args.slice(0, 9)).toEqual([
        "sandbox",
        "exec",
        "--name",
        f.binding.sandboxName,
        "-g",
        f.binding.gatewayName,
        "--",
        "sh",
        "-c",
      ]);
      const result = spawnSync("/bin/sh", ["-c", String(args[9])], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, VENDOR_API_KEY: String(value) },
      });
      return {
        status: result.status ?? 1,
        output: result.stdout,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    });
    const observed = await readRegisteredInferenceCredentialHandle(f.binding, async () => {}).then(
      (handle) => ({ ok: true, handle }),
      (error) => ({ ok: false, message: String(error) }),
    );
    expect(observed.ok).toBe(valid);
    expect(observed).toEqual(
      valid
        ? { ok: true, handle: value }
        : { ok: false, message: expect.stringContaining("did not expose a provider-bound") },
    );
  });
});

describe("registered native API dialects", () => {
  it.each([
    {
      api: "openai-responses" as const,
      path: "responses",
      body: { output: [{ type: "message", content: [{ type: "output_text", text: "ready" }] }] },
      header: "Authorization: Bearer ",
    },
    {
      api: "anthropic-messages" as const,
      path: "messages",
      body: { type: "message", content: [{ type: "text", text: "ready" }] },
      header: "x-api-key: ",
    },
  ])("uses $api native request and response semantics", async ({ api, path, body, header }) => {
    const f = registeredInferenceFixture(true);
    const binding = { ...f.binding, inferenceApi: api };
    const shell = recordingProbeShell("200", JSON.stringify(body), { VENDOR_API_KEY: f.handle });
    const result = await probeSandboxInferenceInvocation(
      {
        sandboxName: binding.sandboxName,
        gatewayName: binding.gatewayName,
        provider: binding.providerName,
        model: "vendor/model",
        preferredInferenceApi: api,
        registeredInferenceProviderAttachment: binding,
      },
      { execute: shell.execute },
    );
    expect(result).toEqual({ ok: true });
    expect(shell.destinations()).toEqual(["https://native.example/v1/" + path]);
    expect(shell.requests[0]).toContain(header + f.handle);
  });
});
