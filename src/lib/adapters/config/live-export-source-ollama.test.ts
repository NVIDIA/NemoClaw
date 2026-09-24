// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  raw,
  mockSupportedLiveSource,
  exportLiveSource,
  expectExportRefusal,
} from "../../../../test/support/config-export-harness";
import os from "node:os";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { asExportedConfig } from "../../../../test/support/config-export-document";
import { createOllamaExportProbe } from "../../inference/ollama/proxy";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { ObservedOllamaProxy } from "../../inference/ollama/proxy-observation";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import {
  readFailureCanary,
  inventory,
  configuration,
  provider,
  openAiProviderProfile,
  ollamaSource,
} from "./live-export-source-test-fixture";

function ollamaProbe(observed: ObservedOllamaProxy) {
  const models = JSON.stringify({
    models: [
      { name: "unrelated:latest", digest: `sha256:${"b".repeat(64)}` },
      { name: observed.serving.model.servedName, digest: observed.serving.model.digest },
    ],
  });
  return {
    backend: {
      kind: "ollama" as const,
      url: `http://127.0.0.1:${observed.serving.daemon.hostPort}`,
    },
    proxyPort: String(observed.serving.proxy.hostPort),
    pid: String(observed.pid),
    processMatches: vi.fn(() => true),
    readActiveConfig: vi.fn(() =>
      JSON.stringify({
        schemaVersion: 1,
        pid: observed.pid,
        listener: { address: observed.listenerAddress, port: observed.serving.proxy.hostPort },
        backendOrigin: `http://127.0.0.1:${observed.serving.daemon.hostPort}`,
      }),
    ),
    readProxyModels: vi.fn(() => models),
    readDaemonModels: vi.fn(() => models),
  };
}

function mockOllamaSource(model: string = "qwen3.5:9b") {
  vi.spyOn(os, "platform").mockReturnValue("linux");
  const { source, observed } = ollamaSource(model);
  mockSupportedLiveSource(3, 3, source);
  const effective = configuration();
  effective.policy.network_policies.api.endpoints = [
    { host: "host.openshell.internal", port: observed.serving.proxy.hostPort },
  ];
  raw.getSandboxConfig.mockResolvedValue(effective);
  const probe = ollamaProbe(observed);
  vi.mocked(createOllamaExportProbe).mockReturnValue(probe);
  vi.mocked(getSandboxEntryInference).mockReturnValue({
    kind: "configured",
    provider: "ollama-local",
    model,
  });
  vi.mocked(captureSanitizedResolvedOpenshell).mockReturnValue({
    status: 0,
    output: `Gateway inference:\n  Provider: ollama-local\n  Model: ${model}\n`,
  });
  const liveSandbox = inventory();
  Object.assign(liveSandbox.sandbox.spec, { providers: ["ollama-local"] });
  raw.getSandbox.mockResolvedValue(liveSandbox);
  const readCredential = vi.fn(() => {
    throw new Error(readFailureCanary);
  });
  const credentials = Object.defineProperty({}, OLLAMA_LOCAL_CREDENTIAL_ENV, {
    enumerable: true,
    get: readCredential,
  });
  const localProvider = {
    ...provider().provider,
    metadata: { ...provider().provider.metadata, name: "ollama-local" },
    profileWorkspace: "default",
    credentials,
    config: { OPENAI_BASE_URL: source.endpointUrl },
  };
  raw.getProvider.mockResolvedValue({ provider: localProvider });
  raw.getProviderProfile.mockRejectedValue({ code: 5 });
  return {
    source,
    observed,
    probe,
    readCredential,
    localProvider,
    effectivePolicy: effective.policy,
  };
}

describe("attached Ollama export pipeline", () => {
  it.each([
    {
      name: "selected non-default model",
      model: "qwen2.5:0.5b",
      workspace: "default",
      credentialEnv: null,
      readProfile: () => Promise.resolve(openAiProviderProfile()),
    },
    {
      name: "legacy workspace without a user credential",
      workspace: "default",
      credentialEnv: null,
      readProfile: () => Promise.reject({ code: 5 }),
    },
    {
      name: "legacy global without a user credential",
      workspace: "",
      credentialEnv: null,
      readProfile: () => Promise.reject({ code: 5 }),
    },
    {
      name: "qualified workspace",
      workspace: "default",
      credentialEnv: null,
      readProfile: () => Promise.resolve(openAiProviderProfile()),
    },
    {
      name: "explicit internal proxy credential",
      workspace: "",
      credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
      readProfile: () => Promise.reject({ code: 5 }),
    },
  ])(
    "exports the $name binding without reading gateway credentials (#11857, #12012)",
    async ({ workspace, credentialEnv, readProfile, model = "qwen3.5:9b" }) => {
      const { source, probe, readCredential, localProvider } = mockOllamaSource(model);
      source.credentialEnv = credentialEnv;
      localProvider.profileWorkspace = workspace;
      raw.getProviderProfile.mockImplementation(readProfile);
      const { result, writeStdout, publish } = await exportLiveSource();
      expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
      const document = asExportedConfig(YAML.parse(writeStdout.mock.calls[0]![0]));
      expect(document.spec.inferenceProviders).toEqual([
        {
          name: "local",
          provider: "openai",
          api: "openai-completions",
          serviceRef: "ollama-auth",
        },
      ]);
      expect(document.spec.services).toEqual({
        "ollama-auth": {
          kind: "ollamaProxy",
          image: null,
          endpoint: "http://172.30.48.1:11440/v1",
          upstream: {
            endpoint: "http://127.0.0.1:11439/v1",
            model: {
              name: model,
              digest: "a".repeat(64),
            },
          },
        },
      });
      const sandbox = document.spec.sandboxes[0]!;
      expect(sandbox.agent.inference.routes[0]).toMatchObject({
        providerRef: "local",
        overrides: { model },
      });
      expect(writeStdout.mock.calls[0]![0]).not.toContain("credential");
      expect(writeStdout.mock.calls[0]![0]).toContain("image: null");
      expect(probe.readActiveConfig).toHaveBeenCalledWith(11440);
      expect(probe.readDaemonModels).toHaveBeenCalledWith(11439);
      expect(readCredential).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("refuses a stable proxy-port drift without publication (#12012)", async () => {
    const { observed } = mockOllamaSource();
    observed.serving.proxy.hostPort = 21_435;
    vi.mocked(createOllamaExportProbe).mockReturnValue(ollamaProbe(observed));
    expectExportRefusal(await exportLiveSource(), {
      field: "spec.services[].upstream",
      category: "drifted",
    });
  });

  it.each([
    {
      authority: "retained selection",
      category: "drifted",
      change: ({ source }: ReturnType<typeof mockOllamaSource>) => {
        source.model = "qwen3.5:9b";
      },
    },
    {
      authority: "live route",
      category: "live-verification-failed",
      change: () => {
        vi.mocked(captureSanitizedResolvedOpenshell).mockReturnValue({
          status: 0,
          output: "Gateway inference:\n  Provider: ollama-local\n  Model: qwen3.5:9b\n",
        });
      },
    },
    {
      authority: "startup profile",
      category: "drifted",
      change: ({ source }: ReturnType<typeof mockOllamaSource>) => {
        source.workload = ollamaSource().source.workload;
      },
    },
  ])(
    "refuses a selected model that disagrees with the $authority (#11857)",
    async ({ category, change }) => {
      change(mockOllamaSource("qwen2.5:0.5b"));
      expectExportRefusal(await exportLiveSource(), { category });
    },
  );

  it.each(["readProxyModels", "readDaemonModels"] as const)(
    "refuses invalid selected-model evidence from %s without publication (#11857)",
    async (reader) => {
      const { probe } = mockOllamaSource("qwen2.5:0.5b");
      probe[reader].mockReturnValue(JSON.stringify({ models: [] }));
      expectExportRefusal(await exportLiveSource(), { category: "live-verification-failed" });
    },
  );
  it.each([
    { name: "missing", credentials: {} },
    { name: "different", credentials: { OTHER_TOKEN: "redacted" } },
    {
      name: "additional",
      credentials: { [OLLAMA_LOCAL_CREDENTIAL_ENV]: "redacted", OTHER_TOKEN: "redacted" },
    },
  ])(
    "refuses $name gateway proxy credentials without user credentials (#11435)",
    async ({ credentials }) => {
      const { localProvider } = mockOllamaSource();
      localProvider.credentials = credentials;
      expectExportRefusal(await exportLiveSource(), { category: "live-verification-failed" });
    },
  );
  it("sanitizes a failed or legacy proxy observation and publishes nothing (#11435)", async () => {
    mockOllamaSource();
    vi.mocked(createOllamaExportProbe).mockImplementation(() => {
      throw new Error(readFailureCanary);
    });
    const { result, writeStdout } = await exportLiveSource();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
    expect(writeStdout).not.toHaveBeenCalled();
  });

  it.each([
    {
      field: "pid",
      change: (observed: ObservedOllamaProxy, revision: number) => {
        Object.assign(observed, { pid: observed.pid + revision });
      },
    },
    {
      field: "daemon port",
      change: (observed: ObservedOllamaProxy, revision: number) => {
        observed.serving.daemon.hostPort += revision * 10;
      },
    },
    {
      field: "proxy port",
      change: (observed: ObservedOllamaProxy, revision: number) => {
        observed.serving.proxy.hostPort += revision;
      },
    },
    {
      field: "digest",
      change: (observed: ObservedOllamaProxy, revision: number) => {
        observed.serving.model.digest = `sha256:${String(revision).repeat(64)}`;
      },
    },
  ])("refuses continuously changing Ollama $field observations (#11857)", async ({ change }) => {
    const { observed } = mockOllamaSource("qwen2.5:0.5b");
    let revision = 0;
    vi.mocked(createOllamaExportProbe).mockImplementation(() => {
      const changed = structuredClone(observed);
      revision += 1;
      change(changed, revision);
      return ollamaProbe(changed);
    });
    expectExportRefusal(await exportLiveSource(), { category: "unstable-source" });
  });
  it.each(["", "default"])(
    "refuses a profile that appears in %j between export snapshots (#11435)",
    async (workspace) => {
      const { localProvider } = mockOllamaSource();
      localProvider.profileWorkspace = workspace;
      const presentProfile = openAiProviderProfile();
      presentProfile.profile.scope = workspace === "" ? "platform" : "workspace";
      raw.getProviderProfile
        .mockRejectedValueOnce({ code: 5 })
        .mockResolvedValueOnce(presentProfile)
        .mockRejectedValueOnce({ code: 5 })
        .mockResolvedValueOnce(presentProfile);
      expectExportRefusal(await exportLiveSource(), { category: "unstable-source" });
    },
  );
});
