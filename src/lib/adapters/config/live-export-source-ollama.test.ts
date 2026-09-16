// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  raw,
  mockSupportedLiveSource,
  exportLiveSource,
  expectExportRefusal,
} from "../../../../test/support/config-export-harness";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { EXPORTED_OLLAMA_MODEL } from "../../config/model";
import { validateNemoClawConfig } from "../../config/schema";
import { createOllamaExportProbe } from "../../inference/ollama/proxy";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { ObservedOllamaProxy } from "../../inference/ollama/proxy-observation";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { getLiveGatewayInference } from "../../inference/live";
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
    models: [{ name: observed.serving.model.servedName, digest: observed.serving.model.digest }],
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

function mockOllamaSource() {
  vi.spyOn(os, "platform").mockReturnValue("linux");
  const model = EXPORTED_OLLAMA_MODEL;
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
  vi.mocked(getLiveGatewayInference).mockReturnValue({
    failure: null,
    inference: { provider: "ollama-local", model },
    output: "",
    status: 0,
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
    "exports the $name binding without reading gateway credentials (#11435)",
    async ({ workspace, credentialEnv, readProfile }) => {
      const { source, observed, probe, readCredential, localProvider, effectivePolicy } =
        mockOllamaSource();
      source.credentialEnv = credentialEnv;
      localProvider.profileWorkspace = workspace;
      raw.getProviderProfile.mockImplementation(readProfile);
      const { result, writeStdout, publish } = await exportLiveSource();
      expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
      const yaml = writeStdout.mock.calls[0]![0];
      const document = validateNemoClawConfig(YAML.parse(yaml));
      expect(document.spec.inferenceProviders).toEqual([
        {
          name: "local-ollama",
          provider: "ollama-local",
          api: "openai-completions",
          serving: observed.serving,
        },
      ]);
      expect(document.spec.sandboxes[0]!.agents[0]!.inference.routes).toEqual([
        {
          name: "primary",
          providerRef: "local-ollama",
          overrides: { model: EXPORTED_OLLAMA_MODEL },
        },
      ]);
      expect(probe.readActiveConfig).toHaveBeenCalledWith(11440);
      expect(probe.readDaemonModels).toHaveBeenCalledWith(11439);
      expect(readCredential).not.toHaveBeenCalled();
      expect(yaml).not.toMatch(/NEMOCLAW_OLLAMA_PROXY_TOKEN|credential-canary-value/u);
      expect(JSON.stringify(document.spec.inferenceProviders)).not.toContain(
        "host.openshell.internal",
      );
      expect(document.spec.sandboxes[0]!.network.policy.explicit).toEqual(effectivePolicy);
      expect(publish).not.toHaveBeenCalled();
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
    [
      { endpointUrl: "http://host.openshell.internal:11435/v1" },
      { field: "spec.inferenceProviders[].endpoint", category: "drifted" },
    ],
    [
      { credentialEnv: "OTHER_TOKEN" },
      { field: "source.live", category: "live-verification-failed" },
    ],
    [{ agent: "hermes" }, { field: "spec.inferenceProviders[].serving", category: "drifted" }],
    [
      { sandboxGpuEnabled: true, sandboxGpuDevice: "nvidia.com/gpu=all" },
      { field: "spec.sandboxes[].runtime.gpu", category: "unsupported" },
    ],
  ])("refuses unsupported or drifted local route intent %# (#11435)", async (change, finding) => {
    const { source } = mockOllamaSource();
    Object.assign(source, change);
    expectExportRefusal(await exportLiveSource(), finding);
  });
  it("refuses an absent provider attachment (#11435)", async () => {
    mockOllamaSource();
    raw.getSandbox.mockResolvedValue(inventory());
    expectExportRefusal(await exportLiveSource(), {
      field: "spec.inferenceProviders[].serving",
      category: "drifted",
    });
  });
  it("refuses a continuously changing active proxy identity (#11435)", async () => {
    const { observed } = mockOllamaSource();
    let pid = observed.pid;
    vi.mocked(createOllamaExportProbe).mockImplementation(() =>
      ollamaProbe({ ...observed, pid: ++pid }),
    );
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
