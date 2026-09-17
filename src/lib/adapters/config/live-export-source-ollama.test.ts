// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  raw,
  mockSupportedLiveSource,
  exportLiveSource,
  expectExportRefusal,
} from "../../../../test/support/config-export-harness";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import ConfigExportCommand from "../../../commands/config/export";
import { tunedEnvironment } from "../../domain/config/export-source-test-fixture";
import { validateNemoClawConfig } from "../../config/schema";
import { createOllamaExportProbe } from "../../inference/ollama/proxy";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { ObservedOllamaProxy } from "../../inference/ollama/proxy-observation";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { getLiveGatewayInference } from "../../inference/live";
import { load as loadRegistry } from "../../state/registry/persistence";
import { publishExportFile } from "../fs/config-export-file";
import {
  readFailureCanary,
  inventory,
  configuration,
  provider,
  openAiProviderProfile,
  ollamaSource,
} from "./live-export-source-test-fixture";

vi.mock("../fs/config-export-file", () => ({ publishExportFile: vi.fn() }));

const readOnlyRoster = [
  { id: "researcher", tools: { allow: ["read"] } },
  { id: "reviewer", tools: { allow: ["read"] }, model: "inference/qwen2.5:0.5b" },
];

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

function mockOllamaSource(model: string = "qwen3.5:9b", environment: NodeJS.ProcessEnv = {}) {
  vi.spyOn(os, "platform").mockReturnValue("linux");
  const { source, observed } = ollamaSource(model, environment);
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

function mockOllamaRoster(agents: unknown = readOnlyRoster) {
  return mockOllamaSource("qwen2.5:0.5b", {
    NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify(agents),
  });
}

describe("attached Ollama export pipeline", () => {
  it
    .skipIf(process.platform !== "linux")
    .each([{ names: ["researcher"] }, { names: ["researcher", "reviewer"] }])(
    "publishes the complete Ollama command for $names to a private file (#11858)",
    async ({ names }) => {
      mockOllamaRoster(names.map((id) => ({ id, tools: { allow: ["read"] } })));
      const actual = await vi.importActual<typeof import("../fs/config-export-file")>(
        "../fs/config-export-file",
      );
      vi.mocked(publishExportFile).mockImplementation(actual.publishExportFile);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-roster-"));
      const outputPath = path.join(directory, "roster.yaml");
      try {
        const result = await ConfigExportCommand.run(
          ["alpha", "--output", outputPath],
          process.cwd(),
        );
        expect(result).toMatchObject({ status: "succeeded", outputPath });
        const document = validateNemoClawConfig(YAML.parse(fs.readFileSync(outputPath, "utf8")));
        expect(document.spec.sandboxes[0]!.agents.map(({ name }) => name)).toEqual([
          "primary",
          ...names,
        ]);
        expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { names: ["researcher"], model: "qwen3.5:9b" },
    { names: ["researcher", "reviewer"], model: "qwen2.5:0.5b" },
    { names: Array.from({ length: 12 }, (_, index) => `reader-${index}`), model: "qwen2.5:0.5b" },
  ])(
    "exports the complete command for $names sharing $model (#11858)",
    async ({ names, model }) => {
      const fixture = mockOllamaSource(model, {
        ...tunedEnvironment,
        NEMOCLAW_OPENCLAW_OTEL: "1",
        NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify(
          names.map((id, index) => ({
            id,
            tools: { allow: ["read"] },
            ...(index === 1 ? { model: `inference/${model}` } : {}),
          })),
        ),
      });
      const before = structuredClone(fixture.source);
      const output = vi.spyOn(process.stdout, "write").mockImplementation(((
        _chunk: string,
        callback?: (error?: Error | null) => void,
      ) => {
        callback?.();
        return true;
      }) as typeof process.stdout.write);
      await ConfigExportCommand.run(["alpha", "--output", "-"], process.cwd());
      const yaml = output.mock.calls.map(([chunk]) => String(chunk)).join("");
      const document = validateNemoClawConfig(YAML.parse(yaml));
      const [primary, ...additional] = document.spec.sandboxes[0]!.agents;
      expect(primary).toMatchObject({
        name: "primary",
        execution: { timeoutSeconds: 900, heartbeatEvery: "30m" },
        observability: { otlp: { enabled: true } },
        inference: {
          routes: [
            {
              name: "primary",
              providerRef: "local-ollama",
              overrides: {
                model,
                contextWindow: 65536,
                maxTokens: 8192,
                reasoning: true,
                reasoningEffort: "high",
              },
            },
          ],
        },
      });
      expect(additional).toEqual(
        names.map((name) => ({
          name,
          type: "openclaw",
          tools: { allow: ["read"] },
          inference: primary!.inference,
        })),
      );
      expect(document.spec.inferenceProviders).toEqual([
        {
          name: "local-ollama",
          provider: "ollama-local",
          api: "openai-completions",
          serving: fixture.observed.serving,
        },
      ]);
      expect(fixture.source).toEqual(before);
      expect(fixture.readCredential).not.toHaveBeenCalled();
      expect(yaml).not.toMatch(/NEMOCLAW_OLLAMA_PROXY_TOKEN|credential-canary-value/u);
      expect(fixture.probe.readDaemonModels).toHaveBeenCalledTimes(2);
      expect(fixture.probe.readProxyModels).toHaveBeenCalledTimes(2);
      expect(publishExportFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    { field: "model", change: { model: "inference/other" } },
    { field: "route", change: { model: "other/qwen2.5:0.5b" } },
    { field: "duplicate identity", change: { id: "researcher" } },
    { field: "reserved identity", change: { id: "primary" } },
    { field: "tools", change: { tools: { allow: ["read", "exec"] } } },
    { field: "execution", change: { execution: { timeoutSeconds: 1 } } },
    { field: "interfaces", change: { interfaces: { dashboard: { port: 19000 } } } },
    { field: "observability", change: { observability: { otlp: { enabled: true } } } },
    { field: "delegation", change: { subagents: { allowAgents: ["researcher"] } } },
  ])(
    "refuses unsupported $field on the last Ollama agent without publication (#11858)",
    async ({ change }) => {
      mockOllamaRoster([readOnlyRoster[0], { ...readOnlyRoster[1], ...change }]);
      expectExportRefusal(await exportLiveSource(), { category: "unsupported" });
    },
  );

  it.each<{
    field: string;
    category: string;
    change: (fixture: ReturnType<typeof mockOllamaRoster>) => void;
  }>([
    {
      field: "workload authority",
      category: "missing-provenance",
      change: ({ source }) => {
        delete source.workload;
      },
    },
    {
      field: "identity authority",
      category: "missing-provenance",
      change: ({ source }) => {
        delete source.lifecycleLiveIdentityFingerprint;
      },
    },
    {
      field: "proxy authentication",
      category: "live-verification-failed",
      change: ({ localProvider }) => {
        localProvider.credentials = {};
      },
    },
    {
      field: "daemon digest",
      category: "live-verification-failed",
      change: ({ probe }) => {
        probe.readDaemonModels.mockReturnValue(
          JSON.stringify({
            models: [{ name: "qwen2.5:0.5b", digest: `sha256:${"b".repeat(64)}` }],
          }),
        );
      },
    },
    {
      field: "backend mapping",
      category: "live-verification-failed",
      change: ({ probe }) => {
        const active = JSON.parse(probe.readActiveConfig()) as Record<string, unknown>;
        probe.readActiveConfig.mockReturnValue(
          JSON.stringify({ ...active, backendOrigin: "http://127.0.0.1:11434" }),
        );
      },
    },
    {
      field: "live model",
      category: "live-verification-failed",
      change: () => {
        vi.mocked(getLiveGatewayInference).mockReturnValue({
          failure: null,
          inference: { provider: "ollama-local", model: "qwen3.5:9b" },
          output: "",
          status: 0,
        });
      },
    },
  ])("refuses Ollama roster export with invalid $field (#11858)", async ({ category, change }) => {
    change(mockOllamaRoster());
    expectExportRefusal(await exportLiveSource(), { category });
  });

  it("refuses reordered Ollama rosters across both observation pairs (#11858)", async () => {
    const { source } = mockOllamaRoster();
    const reordered = ollamaSource("qwen2.5:0.5b", {
      NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify([...readOnlyRoster].reverse()),
    }).source;
    let reads = 0;
    vi.mocked(loadRegistry).mockImplementation(() => ({
      sandboxes: { alpha: reads++ % 2 === 0 ? source : reordered },
      defaultSandbox: null,
    }));
    expectExportRefusal(await exportLiveSource(), { category: "unstable-source" });
  });

  it("publishes no file when the complete Ollama roster command lacks authority (#11858)", async () => {
    const { source } = mockOllamaRoster();
    delete source.workload;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "/tmp/ollama-roster.yaml"], process.cwd()),
    ).rejects.toThrow();
    expect(publishExportFile).not.toHaveBeenCalled();
  });

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
    "exports the $name binding without reading gateway credentials (#11857)",
    async ({ workspace, credentialEnv, readProfile, model = "qwen3.5:9b" }) => {
      const { source, observed, probe, readCredential, localProvider, effectivePolicy } =
        mockOllamaSource(model);
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
          overrides: { model },
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
        vi.mocked(getLiveGatewayInference).mockReturnValue({
          failure: null,
          inference: { provider: "ollama-local", model: "qwen3.5:9b" },
          output: "",
          status: 0,
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
    const { observed } = mockOllamaRoster();
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
