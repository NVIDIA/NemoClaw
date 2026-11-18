// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  parseNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
} from "../../config/model";
import { buildExportConfig, V1_IMAGE_REF_PLACEHOLDER } from "./export-document";
import type { VerifiedExportSource } from "./export-evidence";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const firstUid = parseNemoClawConfigDocumentUid("018f47e2-9d93-7d15-9c41-3ecf70b2550f");
const secondUid = parseNemoClawConfigDocumentUid("018f47e2-9d93-7d15-9c41-3ecf70b25510");
const alphaDocumentName = parseNemoClawConfigDocumentName("alpha");
const workAgentsDocumentName = parseNemoClawConfigDocumentName("work-agents");
const policy = {
  version: 1,
  process: { run_as_user: "sandbox", run_as_group: "sandbox" },
  network_policies: {
    api: {
      name: "api",
      endpoints: [{ host: "api.example.com", port: 443 }],
      binaries: [{ path: "/usr/bin/openclaw" }],
    },
  },
  filesystem_policy: {
    include_workdir: false,
    read_only: ["/usr"],
    read_write: ["/sandbox"],
  },
};
const source = {
  sandboxName: "alpha",
  agent: "openclaw",
  runtime: {
    provider: "docker",
    imageRef: `nvcr.io/nvidia/nemoclaw@${digest}`,
  },
  gateway: { name: "nemoclaw", port: 8080 },
  inference: {
    provider: "openai-api",
    model: "gpt-5",
    api: "openai-responses",
    endpoint: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
  },
  policy,
} as unknown as VerifiedExportSource;

describe("export config builder", () => {
  it.each([true, false])(
    "omits the gateway credential marker %s without changing authored policy or source (#12138)",
    (providerCredentialed) => {
      const endpoint = {
        host: "api.tavily.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        request_body_credential_rewrite: true,
        rules: [{ allow: { method: "POST", path: "/search" } }],
      };
      const original = {
        ...policy,
        network_policies: {
          api: {
            ...policy.network_policies.api,
            endpoints: [{ ...endpoint, provider_credentialed: providerCredentialed }],
          },
        },
      };
      const result = buildExportConfig(
        { ...source, policy: original as unknown as VerifiedExportSource["policy"] },
        { documentName: alphaDocumentName, documentUid: firstUid },
      );
      expect(result.spec.sandboxes.alpha?.network.policy.explicit.network_policies).toEqual({
        api: { ...policy.network_policies.api, endpoints: [endpoint] },
      });
      expect(original.network_policies.api.endpoints[0]?.provider_credentialed).toBe(
        providerCredentialed,
      );
    },
  );

  it.each([true, false])(
    "omits the gateway credential marker %s without changing authored controls or source policy (#12146)",
    (marker) => {
      const endpoint = {
        host: "api.example.com",
        port: 443,
        allow_uninspected_credentials: true,
      };
      const observedPolicy = {
        ...policy,
        network_policies: {
          api: {
            ...policy.network_policies.api,
            endpoints: [{ ...endpoint, provider_credentialed: marker }],
          },
          public: { endpoints: [{ host: "public.example.com", port: 443 }] },
          disabled: {},
        },
      };
      const before = structuredClone(observedPolicy);
      const result = buildExportConfig(
        { ...source, policy: observedPolicy as unknown as VerifiedExportSource["policy"] },
        { documentName: alphaDocumentName, documentUid: firstUid },
      );

      expect(result.spec.sandboxes.alpha?.network.policy.explicit.network_policies).toEqual({
        ...observedPolicy.network_policies,
        api: { ...observedPolicy.network_policies.api, endpoints: [endpoint] },
      });
      expect(observedPolicy).toEqual(before);
    },
  );

  it("leaves out the V0 image's filesystem, process and Landlock sections without changing source policy (#14580)", () => {
    const original = { ...policy, landlock: { compatibility: "strict" } };
    const before = structuredClone(original);
    const result = buildExportConfig(
      { ...source, policy: original as unknown as VerifiedExportSource["policy"] },
      { documentName: alphaDocumentName, documentUid: firstUid },
    );
    expect(result.spec.sandboxes.alpha?.network.policy.explicit).toEqual({
      version: 1,
      network_policies: policy.network_policies,
    });
    expect(original).toEqual(before);
  });

  it.each(["openclaw", "hermes"] as const)(
    "emits one singular %s agent for the v1alpha1 consumer (#12131)",
    (agent) => {
      const result = buildExportConfig(
        { ...source, agent, interfaces: undefined },
        { documentName: alphaDocumentName, documentUid: firstUid },
      );
      const sandbox = result.spec.sandboxes.alpha!;

      expect(sandbox).toHaveProperty("agent");
      expect(sandbox).not.toHaveProperty("agents");
    },
  );

  it("maps a verified source into one aggregate (#10938)", () => {
    const result = buildExportConfig(source, {
      documentName: workAgentsDocumentName,
      documentUid: firstUid,
    });

    expect(result.spec.sandboxes.alpha?.harness).not.toHaveProperty("observability");
    expect(result).toMatchObject({
      apiVersion: "nemoclaw.nvidia.com/v1alpha1",
      kind: "NemoClawConfig",
      metadata: { name: "work-agents", uid: firstUid },
      spec: {
        gateway: {
          management: "managed",
          runtime: { provider: "docker" },
          endpoint: "http://127.0.0.1:8080",
        },
        inferenceProviders: {
          "hosted-openai-api": {
            provider: "openai",
            api: "openai-responses",
            endpoint: "https://api.openai.com/v1",
            credential: { env: "OPENAI_API_KEY" },
          },
        },
        sandboxes: {
          alpha: {
            network: {
              policy: {
                // The V0 image's filesystem and process sections are left out (#14580).
                explicit: { version: 1, network_policies: policy.network_policies },
              },
            },
            harness: { kind: "nvidia.fabric.openclaw" },
            image: { ref: V1_IMAGE_REF_PLACEHOLDER },
            agent: {
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
            },
          },
        },
      },
    });
    expect(result.spec.sandboxes.alpha).not.toHaveProperty("name");
  });

  it("emits a verified Brave integration without another inference provider (#10904)", () => {
    const webSearch = {
      provider: "brave",
      agentRefs: ["primary"],
      credential: { env: "BRAVE_API_KEY" },
    } as const;
    const document = buildExportConfig(
      { ...source, webSearch },
      {
        documentName: alphaDocumentName,
        documentUid: firstUid,
      },
    );
    expect(document.spec.integrations).toEqual({
      "brave-search": {
        kind: "webSearch",
        provider: "brave",
        credential: { env: "BRAVE_API_KEY" },
      },
    });
    const sandbox = document.spec.sandboxes.alpha!;
    expect("agent" in sandbox).toBe(true);
    expect(sandbox.agent.integrationRefs).toEqual(["brave-search"]);
    expect(Object.keys(document.spec.inferenceProviders)).toHaveLength(1);
    expect(
      buildExportConfig(source, { documentName: alphaDocumentName, documentUid: firstUid }).spec,
    ).not.toHaveProperty("integrations");
    expect(sandbox).not.toHaveProperty("integrations");
  });

  it.each(["openclaw", "hermes"] as const)(
    "emits a Tavily integration granted only to the exported %s agent (#12138)",
    (agent) => {
      const document = buildExportConfig(
        {
          ...source,
          agent,
          interfaces: undefined,
          webSearch: {
            provider: "tavily",
            agentRefs: ["primary"],
            credential: { env: "TAVILY_API_KEY" },
          },
        },
        { documentName: alphaDocumentName, documentUid: firstUid },
      );
      const sandbox = document.spec.sandboxes.alpha!;
      expect(sandbox.harness.kind).toBe(`nvidia.fabric.${agent}`);
      expect(sandbox).not.toHaveProperty("integrations");
      expect(document.spec.integrations).toEqual({
        "tavily-search": {
          kind: "webSearch",
          provider: "tavily",
          credential: { env: "TAVILY_API_KEY" },
        },
      });
      expect(sandbox.agent.integrationRefs).toEqual(["tavily-search"]);
      expect(sandbox.agent.name).toBe("primary");
      expect(Object.keys(document.spec.inferenceProviders)).toHaveLength(1);
      expect(sandbox.agent.inference).toEqual(
        buildExportConfig(source, {
          documentName: alphaDocumentName,
          documentUid: firstUid,
        }).spec.sandboxes.alpha!.agent.inference,
      );
    },
  );

  it("uses the supplied identity and keeps derived references deterministic (#10938)", () => {
    const first = buildExportConfig(source, {
      documentName: alphaDocumentName,
      documentUid: firstUid,
    });
    const second = buildExportConfig(source, {
      documentName: alphaDocumentName,
      documentUid: secondUid,
    });

    expect(second.metadata.uid).toBe(secondUid);
    expect(second.metadata.uid).not.toBe(first.metadata.uid);
    expect(second.spec).toEqual(first.spec);
    expect(Object.keys(second.spec.inferenceProviders)).toEqual(["hosted-openai-api"]);
    const sandbox = second.spec.sandboxes.alpha!;
    expect("agent" in sandbox).toBe(true);
    expect(sandbox.agent.inference.routes[0]?.providerRef).toBe("hosted-openai-api");
  });

  it("preserves the verified Hermes agent type (#11286)", () => {
    const result = buildExportConfig(
      { ...source, agent: "hermes", interfaces: undefined },
      {
        documentName: alphaDocumentName,
        documentUid: firstUid,
      },
    );

    expect(result.spec.sandboxes.alpha?.harness.kind).toBe("nvidia.fabric.hermes");
    expect(result.spec.sandboxes.alpha?.image).toEqual({ ref: V1_IMAGE_REF_PLACEHOLDER });
    expect(result.spec.sandboxes.alpha?.harness).not.toHaveProperty("observability");
    expect(result.spec.sandboxes.alpha?.network.policy.explicit).toEqual({
      version: 1,
      network_policies: policy.network_policies,
    });
  });

  it("binds verified Hermes API-key authentication to its inference provider (#11432)", () => {
    const result = buildExportConfig(
      {
        ...source,
        agent: "hermes",
        interfaces: undefined,
        auth: { method: "api-key" },
        inference: {
          provider: "hermes-provider",
          model: "moonshotai/kimi-k2.6",
          api: "openai-completions",
          endpoint: "https://inference-api.nousresearch.com/v1",
          credentialEnv: "NOUS_API_KEY",
        },
      },
      {
        documentName: alphaDocumentName,
        documentUid: firstUid,
      },
    );

    const sandbox = result.spec.sandboxes.alpha!;
    expect("agent" in sandbox).toBe(true);
    expect(sandbox.agent.auth).toEqual({
      method: "api-key",
    });
  });

  it("omits an absent hosted credential reference (#10938)", () => {
    const credentialless: VerifiedExportSource = {
      ...source,
      inference: { ...source.inference, credentialEnv: undefined },
    };

    expect(
      buildExportConfig(credentialless, {
        documentName: alphaDocumentName,
        documentUid: firstUid,
      }).spec.inferenceProviders["hosted-openai-api"],
    ).toEqual({
      provider: "openai",
      api: "openai-responses",
      endpoint: "https://api.openai.com/v1",
    });
  });

  it.each([
    { label: "default ports", daemonPort: 11_434, proxyPort: 11_435 },
    { label: "custom ports", daemonPort: 21_434, proxyPort: 21_435 },
  ])(
    "maps attached Ollama with $label into the accepted v1alpha1 shape (#12012)",
    ({ daemonPort, proxyPort }) => {
      const model = "qwen3.5:9b";
      const result = buildExportConfig(
        {
          ...source,
          inference: {
            provider: "ollama-local",
            model,
            api: "openai-completions",
            overrides: { contextWindow: 32_768, maxTokens: 4096 },
            serving: {
              backend: "ollama",
              daemon: { management: "external", hostPort: daemonPort },
              proxy: { management: "nemoclaw", hostPort: proxyPort },
              model: { servedName: model, digest },
            },
          },
        } as unknown as VerifiedExportSource,
        {
          documentName: alphaDocumentName,
          documentUid: firstUid,
        },
      );

      expect(result.spec.inferenceProviders).toEqual({
        local: { provider: "openai", api: "openai-completions", serviceRef: "ollama-auth" },
      });
      expect(result.spec.services).toEqual({
        "ollama-auth": {
          kind: "ollamaProxy",
          image: `REPLACE-ME@sha256:${"0".repeat(64)}`,
          endpoint: `http://172.30.154.1:${proxyPort}/v1`,
          upstream: {
            endpoint: `http://127.0.0.1:${daemonPort}/v1`,
            model: {
              name: model,
              digest: "a".repeat(64),
            },
          },
        },
      });
      expect(result.spec.inferenceProviders.local).not.toHaveProperty("credential");
      const sandbox = result.spec.sandboxes.alpha!;
      expect(sandbox.agent.inference.routes[0]).toEqual({
        name: "primary",
        providerRef: "local",
        // v1 overrides keep maxTokens; contextWindow has no home there.
        overrides: { model, maxTokens: 4096 },
      });
    },
  );

  it("maps fixed managed vLLM into a human-completable current-v1 service (#12012)", () => {
    const servedName = "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4";
    const result = buildExportConfig(
      {
        ...source,
        inference: {
          provider: "vllm-local",
          model: servedName,
          api: "openai-completions",
          serving: {
            backend: "vllm",
            catalogDigest: digest,
            profile: {
              id: "vllm.linux-amd64-nvidia.single.nemotron-3.5-lightning-30b-a3b-nvfp4",
              digest,
            },
            recipe: {
              id: "vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.linux-amd64-single.v1",
              digest,
            },
            model: {
              id: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4",
              revision: "0dcd680e5585c791728c83342b311d0a0026dbeb",
              servedName,
            },
            runtime: { image: { ref: `vllm/vllm-openai@${digest}` } },
            hostPort: 18_000,
          },
        },
      } as unknown as VerifiedExportSource,
      { documentName: alphaDocumentName, documentUid: firstUid },
    );

    expect(result.spec.inferenceProviders).toEqual({
      "managed-vllm": { provider: "openai", api: "openai-completions", serviceRef: "vllm" },
    });
    expect(result.spec.services).toEqual({
      vllm: {
        kind: "vllm",
        authentication: "bearer",
        hardware: {
          architecture: "amd64",
          minComputeCapability: 90,
          minGpuMemoryBytes: 96_000_000_000,
          minDriverMajor: 580,
        },
        container: { ipc: "host", sharedMemoryGiB: 32 },
        image: `REPLACE-ME@sha256:${"0".repeat(64)}`,
        model: {
          repository: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4",
          revision: "0dcd680e5585c791728c83342b311d0a0026dbeb",
        },
        serving: {
          modelName: servedName,
          mambaBackend: "flashinfer",
          enforceEager: false,
          toolParser: "qwen3_coder",
          reasoningParser: "nemotron_v3",
          port: 18_000,
          contextTokens: 65_536,
          maxSequences: 1,
          batchTokens: 4096,
          startupTimeoutSeconds: 1800,
        },
        memory: { gpuMemoryUtilization: 0.75 },
      },
    });
  });
});
