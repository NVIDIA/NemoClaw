// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { fingerprintOpenShellSandboxId } from "../adapters/openshell/sandbox-identity";
import type { SandboxEntry } from "../state/registry/types";
import {
  canonicalizeEffectivePolicy,
  classifyExportRegistryFidelity,
  observeStableExportSource,
  type ExportObservationDependencies,
} from "./export-observation";

const id = "018f47e2-9d93-7d15-9c41-3ecf70b2550f";
const fingerprint = fingerprintOpenShellSandboxId(id)!;
const policy =
  "version: 1\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\nnetwork_policies:\n  api:\n    name: api\n    endpoints: [{host: api.example.com, port: 443}]\n    binaries: [{path: /usr/bin/curl}]\nfilesystem_policy:\n  include_workdir: false\n  read_only: [/usr]\n  read_write: [/sandbox]\n";
function entry(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    openshellDriver: "docker",
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: fingerprint,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    provider: "openai-api",
    model: "gpt-5",
    preferredInferenceApi: "openai-responses",
    endpointUrl: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference:
        "nvcr.io/nvidia/nemoclaw@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      platform: "linux/amd64",
      release: "1.0.0",
      sourceRevision: "abc",
      sourceCohort: "cohort",
      capabilityContractVersion: 1,
      startupProfileContractVersion: 1,
      encodedProfile: "e30",
      startupProfileSha256: "sha256:profile",
      credentialProxyReplayRequired: false,
      shared: true,
    },
    ...overrides,
  };
}
function deps(
  tokens = ["stable"],
  overrides: Partial<ExportObservationDependencies> = {},
): ExportObservationDependencies {
  let token = 0;
  return {
    sourceTokenFor: vi.fn(() => "stable"),
    readSourceToken: vi.fn(async () => tokens[token++] ?? tokens.at(-1)!),
    readRegistryEntry: vi.fn(async () => entry()),
    readSandboxIdentity: vi.fn(async () => ({
      sandboxId: id,
      fingerprint,
      lifecycleGeneration: "generation-1",
      identity: "live-sandbox-1",
    })),
    readGateway: vi.fn(async () => ({
      name: "nemoclaw",
      port: 8080,
      management: "nemoclaw" as const,
      stateRootOwned: true,
      identity: "gateway-1",
    })),
    readInference: vi.fn(async () => ({
      topology: "hosted" as const,
      provider: "openai-api",
      model: "gpt-5",
      api: "openai-responses",
      endpoint: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY",
      identity: "route-1",
    })),
    readEffectivePolicy: vi.fn(async () => ({
      sandboxId: id,
      revision: "policy-1",
      document: policy,
    })),
    ...overrides,
  };
}

describe("stable config export source observation (#10938)", () => {
  it("observes the supported profile through only read dependencies", async () => {
    const d = deps();
    const result = await observeStableExportSource("alpha", d);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(result.ok && result.source.policyBasis).toBe("verified-effective-state");
    expect(d.readSourceToken).toHaveBeenCalledTimes(1);
    expect(d.readRegistryEntry).toHaveBeenCalledTimes(1);
  });
  it("discards one unstable attempt and retries the complete observation", async () => {
    const d = deps(["changed", "stable"]);
    await expect(observeStableExportSource("alpha", d)).resolves.toMatchObject({
      ok: true,
      attempts: 2,
    });
    expect(d.readRegistryEntry).toHaveBeenCalledTimes(2);
    expect(d.readEffectivePolicy).toHaveBeenCalledTimes(2);
  });
  it("fails as unstable-source after two changing attempts", async () => {
    await expect(
      observeStableExportSource("alpha", deps(["changed", "changed"])),
    ).resolves.toMatchObject({ ok: false, category: "unstable-source", attempts: 2 });
  });
  it("reports every excluded capability instead of omitting it", () => {
    const findings = classifyExportRegistryFidelity(
      entry({
        agent: "hermes",
        fromDockerfile: "/tmp/Dockerfile",
        sandboxGpuEnabled: true,
        hostMounts: [{ source: "/host", target: "/sandbox", readOnly: true }],
        observabilityEnabled: true,
        webSearchEnabled: true,
        messaging: { configured: {} } as never,
        mcp: { bridges: {} } as never,
        openclawImagePluginInstalls: [{ id: "secondary" }] as never,
        hostLocalInferenceReceipt: "receipt",
      }),
    );
    expect(findings.filter((x) => x.category === "unsupported").map((x) => x.field)).toEqual(
      expect.arrayContaining([
        "spec.sandboxes[].runtime.customImage",
        "spec.sandboxes[].runtime.gpu",
        "spec.sandboxes[].mounts",
        "spec.sandboxes[].observability",
        "spec.sandboxes[].integrations.webSearch",
        "spec.sandboxes[].integrations.messaging",
        "spec.sandboxes[].integrations.mcp",
        "spec.sandboxes[].agents.secondary",
        "spec.sandboxes[].agents[0].type",
        "spec.inferenceProviders",
      ]),
    );
  });
  it("fails closed on lifecycle, gateway, route, and policy drift", async () => {
    const result = await observeStableExportSource(
      "alpha",
      deps(["stable", "stable"], {
        readRegistryEntry: vi.fn(async () => entry({ lifecycleGeneration: "old" })),
        readGateway: vi.fn(async () => ({
          name: "other",
          port: 8081,
          management: "external" as const,
          stateRootOwned: false,
          identity: "gw",
        })),
        readInference: vi.fn(async () => ({
          topology: "local" as const,
          provider: "x",
          model: "y",
          api: "z",
          endpoint: "http://local",
          credentialEnv: null,
          identity: "route",
        })),
        readEffectivePolicy: vi.fn(async () => ({
          sandboxId: "018f47e2-9d93-7d15-9c41-3ecf70b25500",
          revision: "r",
          document: policy,
        })),
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.findings.map((x) => x.field)).toEqual(
      expect.arrayContaining([
        "source.lifecycle.generation",
        "spec.gateway.management",
        "spec.gateway",
        "spec.inferenceProviders",
        "spec.sandboxes[].network.policy",
      ]),
    );
  });
  it.each(["_KEY", "DSH_TOKEN", "OPENSHELL_TOKEN", "VITEST_TOKEN", "NEMOCLAW_TEST_SECRET"])(
    "rejects reserved credential identifier %s during observation",
    async (credentialEnv) => {
      const result = await observeStableExportSource(
        "alpha",
        deps(["stable", "stable"], {
          readInference: vi.fn(async () => ({
            topology: "hosted" as const,
            provider: "openai-api",
            model: "gpt-5",
            api: "openai-responses",
            endpoint: "https://api.openai.com/v1",
            credentialEnv,
            identity: "route-1",
          })),
        }),
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "spec.inferenceProviders[].credential.env" }),
        ]),
      );
    },
  );
  it("classifies missing gateway and runtime driver provenance", () => {
    const findings = classifyExportRegistryFidelity(
      entry({ gatewayName: undefined, gatewayPort: undefined, openshellDriver: null }),
    );
    expect(findings.map(({ field }) => field)).toEqual(
      expect.arrayContaining(["spec.gateway", "spec.sandboxes[].runtime.provider"]),
    );
  });
  it("canonicalizes policy independently of mapping insertion order (#10938)", () => {
    const first = canonicalizeEffectivePolicy(
      "version: 1\nnetwork_policies:\n  ä:\n    name: ä\n    endpoints: [{host: z.example.com, port: 443}]\n    binaries: [{path: /usr/bin/z}]\n  z:\n    name: z\n    endpoints: [{host: a.example.com, port: 443}]\n    binaries: [{path: /usr/bin/a}]\n",
    );
    const second = canonicalizeEffectivePolicy(
      "network_policies:\n  z:\n    binaries: [{path: /usr/bin/a}]\n    endpoints: [{port: 443, host: a.example.com}]\n    name: z\n  ä:\n    binaries: [{path: /usr/bin/z}]\n    endpoints: [{port: 443, host: z.example.com}]\n    name: ä\nversion: 1\n",
    );
    expect(second).toEqual(first);
  });

  it("canonicalizes policy losslessly and rejects malformed policy", () => {
    expect(canonicalizeEffectivePolicy(policy)).toEqual({
      filesystem_policy: { include_workdir: false, read_only: ["/usr"], read_write: ["/sandbox"] },
      network_policies: {
        api: {
          binaries: [{ path: "/usr/bin/curl" }],
          endpoints: [{ host: "api.example.com", port: 443 }],
          name: "api",
        },
      },
      process: { run_as_group: "sandbox", run_as_user: "sandbox" },
      version: 1,
    });
    expect(() => canonicalizeEffectivePolicy("network_policies: [not-a-map]")).toThrow();
  });
  it("redacts exceptions from live readers", async () => {
    const result = await observeStableExportSource(
      "alpha",
      deps(["stable"], {
        readInference: vi.fn(async () => {
          throw new Error("credential-canary");
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("credential-canary");
    expect(result).toMatchObject({ ok: false, category: "live-verification-failed" });
  });
});
