// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { buildConfig as buildOpenClawConfig } from "../../../../scripts/generate-openclaw-config.mts";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { validateNemoClawConfig } from "../../config/schema";
import { EXPORTED_VLLM_PROFILE_ID } from "../../config/model";
import { loadServingCatalog } from "../../inference/serving/catalog-loader";
import { servingProfileProvenance } from "../../inference/serving/profile-provenance";
import { mapManagedStartupProfileToAgentEnvironment } from "../../onboard/managed-startup/agent-environment";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import {
  entry,
  managedWorkload,
  profileInput,
  snapshot,
  tunedEnvironment,
} from "./export-source-test-fixture";

function additionalAgentSnapshot(manifest: unknown, environment: NodeJS.ProcessEnv = {}) {
  return snapshot({
    registry: entry({
      workload: managedWorkload(
        profileInput({
          environment: { ...environment, NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify(manifest) },
        }),
      ),
    }),
  });
}

function generatedAdditionalAgentConfig(manifest: unknown) {
  const { profile } = buildManagedStartupProfile(
    profileInput({
      environment: { ...tunedEnvironment, NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify(manifest) },
    }),
  );
  const mapped = mapManagedStartupProfileToAgentEnvironment(profile);
  return buildOpenClawConfig({
    ...mapped.configurationEnvironment,
    ...mapped.runtimeEnvironment,
  });
}

describe("read-only secondary-agent export", () => {
  it.each([
    ["array", [{ id: "researcher", tools: { allow: ["read"] } }]],
    ["object", { agents: [{ id: "researcher", tools: { allow: ["read"] } }] }],
    [
      "canonical paths and same model",
      {
        agents: [
          {
            id: "researcher",
            tools: { allow: ["read"] },
            model: "openai/gpt-5",
            workspace: "/sandbox/.openclaw/./workspace-researcher",
            agentDir: "/sandbox/.openclaw/agents/researcher",
          },
        ],
        defaults: { subagents: {} },
        main: {},
      },
    ],
  ])(
    "exports the %s manifest with the primary route and no filesystem paths (#11434)",
    async (_case, manifest) => {
      const generated = generatedAdditionalAgentConfig(manifest);
      expect(generated.agents.list).toMatchObject([
        { id: "main", default: true },
        {
          id: "researcher",
          workspace: "/sandbox/.openclaw/workspace-researcher",
          agentDir: "/sandbox/.openclaw/agents/researcher",
          tools: { allow: ["read"] },
        },
      ]);
      expect(
        generated.agents.list.filter((agent: { default?: boolean }) => agent.default),
      ).toHaveLength(1);
      expect(generated.agents.defaults.model.primary).toBe("openai/gpt-5");
      const observed = additionalAgentSnapshot(manifest, {
        ...tunedEnvironment,
        NEMOCLAW_OPENCLAW_OTEL: "1",
      });
      const result = await exportSnapshots([observed, observed]);
      expect(result.outcome.ok).toBe(true);
      const document = validateNemoClawConfig(YAML.parse(result.writeStdout.mock.calls[0]![0]));
      const [primary, secondary] = document.spec.sandboxes[0]!.agents;
      expect(primary).toMatchObject({
        name: "primary",
        observability: {
          otlp: {
            enabled: true,
            endpoint: "http://host.openshell.internal:4318",
            serviceName: "openclaw-gateway",
            sampleRate: 1,
          },
        },
      });
      expect(secondary).toEqual({
        name: "researcher",
        type: "openclaw",
        tools: { allow: ["read"] },
        inference: primary!.inference,
      });
      expect(primary!.inference.routes[0]!.overrides).toMatchObject({
        model: "gpt-5",
        contextWindow: 65536,
        maxTokens: 8192,
      });
      expect(document.spec.inferenceProviders).toHaveLength(1);
      expect(JSON.stringify(document)).not.toContain("workspace-researcher");
    },
  );

  it.each(
    [
      [{ id: "main", tools: { allow: ["read"] } }],
      [{ id: "primary", tools: { allow: ["read"] } }],
      [{ id: "with_underscore", tools: { allow: ["read"] } }],
      [{ id: "researcher", tools: { allow: ["read"] }, default: true }],
      [{ id: "researcher", tools: { allow: ["write"] } }],
      [{ id: "researcher", tools: {} }],
      [{ id: "researcher", tools: { allow: ["read"], deny: ["exec"] } }],
      [{ id: "researcher", tools: { allow: ["read"] }, model: "openai/other" }],
      [{ id: "researcher", tools: { allow: ["read"] }, model: "other/model" }],
      [
        {
          id: "researcher",
          tools: { allow: ["read"] },
          workspace: "/sandbox/.openclaw/../../tmp/other",
        },
      ],
      [
        {
          id: "researcher",
          tools: { allow: ["read"] },
          agentDir: "/sandbox/.openclaw/agents/other",
        },
      ],
      [{ id: "researcher", tools: { allow: ["read"] }, subagents: { model: "openai/gpt-5" } }],
      [{ id: "researcher", tools: { allow: ["read"] }, description: "unsupported" }],
      [
        { id: "researcher", tools: { allow: ["read"] } },
        { id: "another", tools: { allow: ["read"] } },
      ],
    ].map((agents) => ({ agents })),
  )(
    "rejects an unsupported secondary manifest without publication (#11434)",
    async ({ agents }) => {
      const observed = additionalAgentSnapshot(agents);
      const result = await exportSnapshots([observed, observed]);
      expect(result.outcome.ok).toBe(false);
      expect(result.writeStdout).not.toHaveBeenCalled();
      expect(result.publish).not.toHaveBeenCalled();
    },
  );

  it.each(["podman", "managed serving"])(
    "rejects secondary export with %s (#11434)",
    async (runtime) => {
      const observed = additionalAgentSnapshot([{ id: "researcher", tools: { allow: ["read"] } }]);
      const registry = {
        ...observed.registry,
        ...(runtime === "podman"
          ? { openshellDriver: "podman" as const }
          : {
              servingProfileProvenance: servingProfileProvenance(
                loadServingCatalog(),
                EXPORTED_VLLM_PROFILE_ID,
              ),
            }),
      };
      const result = await exportSnapshots([{ ...observed, registry }]);
      expect(result.outcome).toMatchObject({
        ok: false,
        failure: {
          findings: expect.arrayContaining([
            expect.objectContaining({ field: "spec.sandboxes[].agents", category: "unsupported" }),
          ]),
        },
      });
      expect(result.writeStdout).not.toHaveBeenCalled();
      expect(result.publish).not.toHaveBeenCalled();
    },
  );

  it("rejects changing secondary identity across both observation pairs (#11434)", async () => {
    const first = additionalAgentSnapshot([{ id: "researcher", tools: { allow: ["read"] } }]);
    const second = additionalAgentSnapshot([{ id: "reviewer", tools: { allow: ["read"] } }]);
    const result = await exportSnapshots([first, second, first, second]);
    expect(result.outcome).toMatchObject({ ok: false });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it.each([
    { defaults: { subagents: { maxSpawnDepth: 2 } } },
    { main: { tools: { allow: ["read"] } } },
    { main: { subagents: { model: "openai/gpt-5" } } },
  ])("rejects primary and default overrides in a two-agent profile (#11434)", async (overrides) => {
    const observed = additionalAgentSnapshot({
      agents: [{ id: "researcher", tools: { allow: ["read"] } }],
      ...overrides,
    });
    const result = await exportSnapshots([observed, observed]);
    expect(result.outcome.ok).toBe(false);
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });
});
