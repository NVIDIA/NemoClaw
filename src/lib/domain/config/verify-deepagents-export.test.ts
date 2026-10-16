// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import {
  asExportedConfig,
  exportedDeepAgentsSandbox,
} from "../../../../test/support/config-export-document";
import { exportNativeInferenceReceipt, type ObservedExportSnapshot } from "./export-evidence";
import { nativeLocalIdentity } from "../../inference/native-local/contract";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import { resolveManagedStartupInferenceRoute } from "../../inference/gateway/route-contract";
import {
  entry,
  dcodeImageRef,
  dcodeProfileInput,
  dcodeSnapshot,
  managedWorkload,
  verify,
} from "./export-source-test-fixture";

function dcodeWorkload(
  overrides: Partial<ReturnType<typeof dcodeProfileInput>>,
): NonNullable<ObservedExportSnapshot["registry"]["workload"]> {
  const input = dcodeProfileInput();
  return managedWorkload(
    {
      ...input,
      ...overrides,
      inference: overrides.inference ?? input.inference,
    },
    dcodeImageRef,
  );
}

describe("Deep Agents config export (#11860)", () => {
  it.each([false, true])(
    "verifies native compatible endpoint identity with drift=%s (#13197)",
    (drift) => {
      const endpoint = "http://host.openshell.internal:8000/v1";
      const provider = "compatible-endpoint" as const;
      const binding = {
        provider,
        endpointUrl: endpoint,
        credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        authMode: "authenticated" as const,
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
      };
      const receipt = {
        ...binding,
        ...nativeLocalIdentity(binding),
        schemaVersion: 1 as const,
        providerId: "fixture-provider",
      };
      const route = resolveManagedStartupInferenceRoute(
        "langchain-deepagents-code",
        provider,
        "gpt-5",
        "openai-completions",
        true,
        endpoint,
      );
      const value = dcodeSnapshot({
        provider,
        endpointUrl: endpoint,
        credentialEnv: "COMPATIBLE_API_KEY",
        nativeLocalProviderAttachment: receipt,
        workload: dcodeWorkload({
          inference: {
            ...dcodeProfileInput().inference!,
            upstreamProvider: provider,
            upstreamEndpointUrl: endpoint,
            routeProvider: route.providerKey,
            routedBaseUrl: route.inferenceBaseUrl,
          },
        }),
      });
      const inference: ObservedExportSnapshot["inference"] = {
        ...value.inference,
        provider,
        endpoint,
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointEvidence: {
          endpoint,
          source: { kind: "managed-profile", profileId: receipt.profileId },
          provider: {
            ...value.inference.endpointEvidence!.provider,
            name: receipt.providerName,
            id: drift ? "foreign-provider" : receipt.providerId,
            managedProfile: {
              id: receipt.profileId,
              source: "user",
              scope: "workspace",
              resourceVersion: "1",
            },
          },
        },
      };
      const result = verify({
        ...value,
        sandbox: { ...value.sandbox, providerNames: [receipt.providerName] },
        inference,
      });
      // Receipt fidelity does not expand V1's authenticated HTTP export contract.
      expect(result).toMatchObject({
        kind: "rejected",
        findings: expect.arrayContaining([
          expect.objectContaining({
            field: "spec.inferenceProviders[].credential",
            category: "unsupported",
          }),
        ]),
      });
      const findings = result.kind === "verified" ? [] : result.findings;
      expect(findings.filter(({ field }) => field === "source.inference.endpoint")).toEqual(
        drift ? [expect.objectContaining({ category: "drifted" })] : [],
      );
    },
  );

  it("exports the canonical disabled baseline through the v1alpha1 harness", async () => {
    const observed = dcodeSnapshot();

    expect(verify(observed)).toMatchObject({
      kind: "verified",
      source: {
        agent: "langchain-deepagents-code",
        runtime: { provider: "docker", imageRef: dcodeImageRef },
        inference: { api: "openai-completions" },
      },
    });

    const result = await exportSnapshots([observed]);
    expect(result.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    const [yaml] = result.writeStdout.mock.calls[0]!;
    const document = asExportedConfig(YAML.parse(yaml));
    const sandbox = document.spec.sandboxes[0]!;
    expect(document.apiVersion).toBe("nemoclaw.nvidia.com/v1alpha1");
    expect(document.spec.gateway).toEqual({
      management: "managed",
      endpoint: "http://127.0.0.1:8080",
    });
    expect(document.spec.inferenceProviders).toEqual([
      {
        name: "hosted-openai-api",
        provider: "openai",
        api: "openai-completions",
        endpoint: "https://api.openai.com/v1",
        credential: { env: "OPENAI_API_KEY" },
      },
    ]);
    expect(sandbox.harness).toEqual({ kind: "deepagents" });
    expect(sandbox.runtime).toEqual({ provider: "docker" });
    expect("agent" in sandbox).toBe(true);
    const deepAgentsSandbox = exportedDeepAgentsSandbox(sandbox);
    expect(deepAgentsSandbox.image).toEqual({ ref: dcodeImageRef });
    expect(deepAgentsSandbox.agent).toEqual({
      name: "primary",
      inference: {
        routes: [
          {
            name: "primary",
            providerRef: "hosted-openai-api",
            overrides: { model: "gpt-5" },
          },
        ],
      },
    });
    expect(sandbox.network.policy.explicit).toMatchObject({
      process: { run_as_user: "1000", run_as_group: "1000" },
      filesystem_policy: {
        read_only: expect.arrayContaining(["/opt/fabric", "/opt/nemoclaw"]),
      },
    });
    expect(sandbox.network.policy.explicit).not.toMatchObject({
      filesystem_policy: { read_only: expect.arrayContaining(["/opt/hermes", "/app"]) },
    });
    expect(sandbox.harness).not.toHaveProperty("observability");
    expect(sandbox.harness).not.toHaveProperty("interfaces");
  });

  it.each([
    {
      label: "thread opt-in approval",
      observed: () =>
        dcodeSnapshot({
          dcodeAutoApprovalMode: "thread-opt-in",
          workload: dcodeWorkload({ dcodeAutoApprovalMode: "thread-opt-in" }),
        }),
      field: "source.registry.dcodeAutoApprovalMode",
      category: "unsupported",
    },
    {
      label: "enabled observability",
      observed: () =>
        dcodeSnapshot({
          observabilityEnabled: true,
          workload: dcodeWorkload({ observabilityEnabled: true }),
        }),
      field: "spec.sandboxes[].observability",
      category: "unsupported",
    },
    {
      label: "enabled web search",
      observed: () => dcodeSnapshot({ webSearchEnabled: true, webSearchProvider: "brave" }),
      field: "spec.sandboxes[].integrations.webSearch",
      category: "unsupported",
    },
    {
      label: "enabled Tavily web search",
      observed: () => dcodeSnapshot({ webSearchEnabled: true, webSearchProvider: "tavily" }),
      field: "spec.sandboxes[].integrations.webSearch",
      category: "unsupported",
    },
    {
      label: "missing web search provenance",
      observed: () => dcodeSnapshot({ webSearchEnabled: undefined, webSearchProvider: undefined }),
      field: "spec.sandboxes[].integrations.webSearch",
      category: "missing-provenance",
    },
    {
      label: "unsupported inference API",
      observed: () => dcodeSnapshot({ preferredInferenceApi: "openai-responses" }),
      field: "spec.inferenceProviders[].api",
      category: "unsupported",
    },
    {
      label: "missing credential reference",
      observed: () => dcodeSnapshot({ credentialEnv: undefined }),
      field: "spec.inferenceProviders[].credential.env",
      category: "missing-provenance",
    },
    {
      label: "missing approval provenance",
      observed: () => dcodeSnapshot({ dcodeAutoApprovalMode: undefined }),
      field: "source.registry.dcodeAutoApprovalMode",
      category: "missing-provenance",
    },
    {
      label: "upstream endpoint drift",
      observed: () => {
        const input = dcodeProfileInput();
        return dcodeSnapshot({
          workload: dcodeWorkload({
            inference: { ...input.inference!, upstreamEndpointUrl: "https://drift.example/v1" },
          }),
        });
      },
      field: "spec.inferenceProviders",
      category: "drifted",
    },
    {
      label: "missing workload authority",
      observed: () => dcodeSnapshot({ workload: undefined }),
      field: "spec.sandboxes[].runtime.image",
      category: "missing-provenance",
    },
    {
      label: "sandbox image identity drift",
      observed: () => ({
        ...dcodeSnapshot(),
        sandbox: {
          ...dcodeSnapshot().sandbox,
          imageRef: "registry.example/drift@sha256:" + "e".repeat(64),
        },
      }),
      field: "spec.sandboxes[].runtime.image",
      category: "drifted",
    },
  ])("does not publish $label", async ({ observed, field, category }) => {
    const result = await exportSnapshots([observed()]);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: expect.arrayContaining([expect.objectContaining({ field, category })]),
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });
});

it.each([
  ["ollama-local", null, "NEMOCLAW_LOCAL_INFERENCE_TOKEN", true],
  ["ollama-local", OLLAMA_LOCAL_CREDENTIAL_ENV, "NEMOCLAW_LOCAL_INFERENCE_TOKEN", true],
  ["vllm-local", null, "NEMOCLAW_LOCAL_INFERENCE_TOKEN", true],
  ["compatible-endpoint", "COMPATIBLE_API_KEY", "NEMOCLAW_LOCAL_INFERENCE_TOKEN", true],
  ["compatible-endpoint", OLLAMA_LOCAL_CREDENTIAL_ENV, "NEMOCLAW_LOCAL_INFERENCE_TOKEN", true],
  ["compatible-endpoint", null, "NEMOCLAW_LOCAL_INFERENCE_TOKEN", true],
  ["compatible-endpoint", "UNRELATED_API_KEY", "NEMOCLAW_LOCAL_INFERENCE_TOKEN", false],
  ["vllm-local", "UNRELATED_API_KEY", "NEMOCLAW_LOCAL_INFERENCE_TOKEN", false],
  ["ollama-local", "UNRELATED_API_KEY", "NEMOCLAW_LOCAL_INFERENCE_TOKEN", false],
  ["ollama-local", null, "UNRELATED_API_KEY", false],
] as const)(
  "validates export credential mapping %s/%s/%s as %s (#13197)",
  (provider, credentialEnv, receiptCredential, expected) => {
    const binding = {
      provider,
      endpointUrl: "http://host.openshell.internal:8000/v1",
      credentialEnv: receiptCredential,
      authMode: "authenticated" as const,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
    };
    const receipt = {
      ...binding,
      ...nativeLocalIdentity(binding),
      schemaVersion: 1 as const,
      providerId: "fixture-provider",
    };
    const result = exportNativeInferenceReceipt(
      entry({
        name: "alpha",
        provider,
        gatewayName: "nemoclaw",
        credentialEnv: credentialEnv ?? undefined,
        nativeLocalProviderAttachment: receipt,
      }),
    );
    expect(result).toEqual(expected ? receipt : null);
  },
);
