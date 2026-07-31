// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  executeRuntimeCaseThroughProvider,
  type RuntimeProviderFixture,
} from "../fixtures/runtime-provider.ts";
import { buildLiveTargetRunPlan } from "../live/run-plan.ts";
import { target } from "../registry/builder.ts";
import {
  defineExecutionProfile,
  type ExecutionProfile,
  executionProviderId,
} from "../registry/execution-profile.ts";
import {
  compileRuntimeMatrix,
  executionPreparationKey,
  type RuntimeMatrixDefinition,
  resolveRuntimeCase,
} from "../registry/runtime-matrix.ts";
import {
  foundationDefinition,
  foundationProfiles,
  obligationBindings,
} from "./cross-runtime-foundation-fixtures.ts";

function fakeRuntimeProvider(
  profile: ExecutionProfile,
  adapterCalls: string[] = [],
): RuntimeProviderFixture {
  const imageDigest = `sha256:${"b".repeat(64)}`;
  return {
    profile,
    environment: {
      async prepare() {
        return {
          profileId: profile.id,
          ready: true,
          engineName: `${profile.provider}-fixture`,
          engineVersion: "0.0.0-fixture",
          capabilities: profile.capabilities,
        };
      },
    },
    lifecycle: {
      async executeAdapter(adapterId, request) {
        if (
          !adapterId.startsWith(`${profile.provider}.`) ||
          !adapterId.endsWith(`.${request.obligationId}`)
        ) {
          throw new Error(`Fixture provider cannot execute ${adapterId}`);
        }
        adapterCalls.push(adapterId);
      },
      async cleanup() {
        return [
          {
            kind: "cleanup",
            operationId: `${profile.provider}.cleanup`,
            value: { fixture: true },
          },
        ];
      },
    },
    state: {
      async inspectWorkload({ logicalId }) {
        return {
          logicalId,
          providerResourceId: `${profile.provider}://fixture/${logicalId}`,
          managedImages: [{ role: "agent", digest: imageDigest }],
        };
      },
      async observe({ caseId }) {
        const agent = caseId.split("-smoke--", 1)[0]!;
        return {
          desiredState: {
            agent,
            inference: { model: "fixture-model", provider: "fixture-inference" },
          },
          fsmTrace: [
            { from: "requested", event: "provision", to: "ready" },
            { from: "ready", event: "complete turn", to: "completed" },
          ],
          terminalOutcome: { status: "succeeded", state: "completed" },
          userVisibleState: { status: "ready", response: "fixture response" },
          providerReceipts: [
            {
              kind: "lifecycle",
              operationId: `${profile.provider}.lifecycle`,
              value: { fixture: true },
            },
          ],
        };
      },
    },
  };
}

describe("cross-runtime E2E matrix compiler", () => {
  it("binds OpenClaw, Hermes, and DCode explicitly on Docker and fake MXC", () => {
    const { cases, shards } = compileRuntimeMatrix(foundationDefinition());

    expect(cases).toHaveLength(6);
    expect(cases.map((entry) => `${entry.scenario.agent}:${entry.profile.provider}`)).toEqual([
      "dcode:docker",
      "dcode:test-mxc",
      "hermes:docker",
      "hermes:test-mxc",
      "openclaw:docker",
      "openclaw:test-mxc",
    ]);
    for (const entry of cases) {
      expect(entry.obligationBindings).toHaveLength(entry.scenario.supportObligations.length);
    }
    expect(shards).toHaveLength(2);
    expect(shards.some((shard) => shard.cases.length > 1)).toBe(true);
    for (const shard of shards) {
      expect(shard.preparations).toHaveLength(1);
      expect(shard.cases).toEqual(shard.preparations.flatMap((entry) => entry.cases));
    }
  });

  it("fails incompatible profile bindings before producing a matrix", () => {
    const definition = foundationDefinition();
    const scenario = definition.scenarios[0]!;
    const baseProfile = definition.profiles[0]!;
    const incompatible = defineExecutionProfile({
      ...baseProfile,
      id: "docker-without-turn",
      capabilities: baseProfile.capabilities.filter((capability) => capability !== "agent.turn"),
    });

    expect(() =>
      compileRuntimeMatrix({
        scenarios: [scenario],
        profiles: [incompatible],
        adapterCatalog: definition.adapterCatalog,
        bindings: [
          {
            scenarioId: scenario.id,
            profileId: incompatible.id,
            obligationBindings: obligationBindings(scenario, incompatible),
          },
        ],
      }),
    ).toThrow(/incompatible.*agent\.turn/);
  });

  it("fails bindings that omit a scenario support obligation", () => {
    const definition = foundationDefinition();
    const scenario = definition.scenarios[0]!;
    const profile = definition.profiles[0]!;

    expect(() =>
      compileRuntimeMatrix({
        scenarios: [scenario],
        profiles: [profile],
        adapterCatalog: definition.adapterCatalog,
        bindings: [
          {
            scenarioId: scenario.id,
            profileId: profile.id,
            obligationBindings: obligationBindings(scenario, profile).slice(1),
          },
        ],
      }),
    ).toThrow(/missing obligations: provision/);
  });

  it("assigns deterministic bounded host shards and isolated resource identities", () => {
    const definition = foundationDefinition();
    const first = compileRuntimeMatrix(definition);
    const reversed: RuntimeMatrixDefinition = {
      scenarios: [...definition.scenarios].reverse(),
      profiles: [...definition.profiles].reverse(),
      adapterCatalog: [...definition.adapterCatalog].reverse(),
      bindings: [...definition.bindings].reverse(),
    };
    const second = compileRuntimeMatrix(reversed);

    expect(second).toEqual(first);
    expect(first.shards).toHaveLength(2);
    expect(new Set(first.shards.map((shard) => shard.runner.hostId))).toEqual(
      new Set(["fixture-host"]),
    );
    const preparationKeys = first.shards.flatMap((shard) =>
      shard.preparations.map((preparation) => preparation.preparationKey),
    );
    expect(new Set(preparationKeys).size).toBe(2);
    for (const shard of first.shards) {
      expect(shard.index).toBeGreaterThanOrEqual(1);
      expect(shard.index).toBeLessThanOrEqual(shard.count);
      expect(shard.count).toBeLessThanOrEqual(shard.runner.maxShards);
      expect(shard.id).toContain("runtime-lane");
      expect(shard.cases).toHaveLength(3);
      for (const preparation of shard.preparations) {
        expect(new Set(preparation.cases.map((entry) => entry.preparationKey))).toEqual(
          new Set([preparation.preparationKey]),
        );
      }
    }
    const allIdentities = first.cases.flatMap((entry) => Object.values(entry.identities));
    expect(new Set(allIdentities).size).toBe(first.cases.length * 4);
  });

  it("derives preparation identity from every profile and runner dimension", () => {
    const profile = foundationProfiles()[0]!;
    const variants = [
      { ...profile, id: "docker-linux-amd64-second" },
      { ...profile, provider: executionProviderId("future-provider") },
      { ...profile, platform: "macos" as const },
      { ...profile, architecture: "arm64" as const },
      { ...profile, rootMode: "rootless" as const },
      { ...profile, acceleration: "nvidia-gpu" as const },
      { ...profile, capabilities: [...profile.capabilities, "transport.socket-free" as const] },
      { ...profile, runner: { ...profile.runner, hostId: "fixture-host-second" } },
      { ...profile, runner: { ...profile.runner, label: "fixture-linux-second" } },
      { ...profile, runner: { ...profile.runner, maxShards: 1 } },
    ].map(defineExecutionProfile);

    expect(new Set([profile, ...variants].map(executionPreparationKey)).size).toBe(
      variants.length + 1,
    );
  });

  it("rejects obligation bindings whose adapter is not registered", () => {
    const definition = foundationDefinition();
    const binding = definition.bindings[0]!;
    expect(() =>
      compileRuntimeMatrix({
        ...definition,
        bindings: [
          {
            ...binding,
            obligationBindings: binding.obligationBindings.map((entry, index) =>
              index === 0 ? { ...entry, adapterId: "docker.missing.adapter" } : entry,
            ),
          },
          ...definition.bindings.slice(1),
        ],
      }),
    ).toThrow(/unregistered adapter/);
  });

  it("schedules preparation-atomic work within the shared host maxShards ceiling", () => {
    const definition = foundationDefinition();
    const scenario = definition.scenarios[0]!;
    const docker = definition.profiles[0]!;
    const mxc = definition.profiles[1]!;
    const secondDockerPreparation = defineExecutionProfile({
      ...docker,
      id: "docker-linux-amd64-rootless",
      rootMode: "rootless",
    });

    const compiled = compileRuntimeMatrix({
      scenarios: [scenario],
      profiles: [docker, mxc, secondDockerPreparation],
      adapterCatalog: definition.adapterCatalog,
      bindings: [docker, mxc, secondDockerPreparation].map((profile) => ({
        scenarioId: scenario.id,
        profileId: profile.id,
        obligationBindings: obligationBindings(scenario, profile),
      })),
    });

    expect(compiled.shards).toHaveLength(2);
    expect(compiled.shards.flatMap((shard) => shard.preparations)).toHaveLength(3);
    expect(compiled.shards.some((shard) => shard.preparations.length === 2)).toBe(true);
    expect(
      new Set(
        compiled.shards.flatMap((shard) =>
          shard.preparations.map((preparation) => preparation.preparationKey),
        ),
      ).size,
    ).toBe(3);
  });

  it("keeps Docker and socket-free fake MXC commands behind one provider fixture seam", async () => {
    const providers = foundationProfiles().map((profile) => fakeRuntimeProvider(profile));

    for (const provider of providers) {
      const ready = await provider.environment.prepare();
      const workload = await provider.state.inspectWorkload({ logicalId: "fixture-workload" });
      await provider.lifecycle.executeAdapter(`${provider.profile.provider}.openclaw.provision`, {
        caseId: "fixture-case",
        obligationId: "provision",
        workloadId: workload.logicalId,
      });
      const lifecycle = await provider.state.observe({
        caseId: "fixture-case",
        workload,
      });
      const cleanup = await provider.lifecycle.cleanup(workload);

      expect(ready.profileId).toBe(provider.profile.id);
      expect(workload.providerResourceId).toMatch(new RegExp(`^${provider.profile.provider}:`));
      expect(lifecycle.terminalOutcome.status).toBe("succeeded");
      expect(cleanup).toHaveLength(1);
    }
    expect(providers[1]?.profile.capabilities).toContain("transport.socket-free");
    expect(providers[1]?.profile.capabilities).not.toContain("transport.docker-socket");
  });

  it("executes compiled cases only through the provider-neutral seam", async () => {
    const matrix = compileRuntimeMatrix(foundationDefinition());
    for (const runtimeCase of matrix.cases.filter((entry) => entry.scenario.agent === "openclaw")) {
      const shard = matrix.shards.find((entry) => entry.cases.includes(runtimeCase));
      if (!shard) throw new Error(`Missing shard for ${runtimeCase.id}`);
      const adapterCalls: string[] = [];
      const resolved = resolveRuntimeCase(matrix, {
        scenarioId: runtimeCase.scenario.id,
        profileId: runtimeCase.profile.id,
      });
      expect(resolved.shard).toBe(shard);
      const evidence = await executeRuntimeCaseThroughProvider({
        resolved,
        provider: fakeRuntimeProvider(runtimeCase.profile, adapterCalls),
        source: {
          headSha: "0123456789abcdef0123456789abcdef01234567",
          baseSha: "89abcdef0123456789abcdef0123456789abcdef",
        },
      });
      expect(evidence.caseId).toBe(runtimeCase.id);
      expect(evidence.runtime.provider).toBe(runtimeCase.profile.provider);
      expect(evidence.providerReceipts.map((receipt) => receipt.kind)).toEqual([
        "lifecycle",
        "cleanup",
      ]);
      expect(adapterCalls).toEqual(
        ["provision", "configure", "turn", "observe"].map(
          (obligation) =>
            `${runtimeCase.profile.provider}.${runtimeCase.scenario.agent}.${obligation}`,
        ),
      );
    }
  });

  it("compiles optional runtime metadata through the existing target run-plan path", () => {
    const runtimeMatrix = foundationDefinition();
    const compiled = compileRuntimeMatrix(runtimeMatrix);
    const registered = target("synthetic-cross-runtime")
      .manifest("test/e2e/manifests/openclaw-nvidia.yaml")
      .environment({
        platform: "ubuntu-local",
        install: "repo-current",
        runtime: "docker-running",
        onboarding: "cloud-openclaw",
      })
      .expectedState("cloud-openclaw-ready")
      .runtimeCase({
        scenarioId: "openclaw-smoke",
        profileId: "docker-linux-amd64",
      })
      .build();

    const plan = buildLiveTargetRunPlan(registered, compiled);
    expect(plan.runtimeCase?.case.id).toBe("openclaw-smoke--docker-linux-amd64");
    expect(plan.runtimeCase?.shard.cases).toContain(plan.runtimeCase?.case);
    expect(plan.phases).toEqual(["environment", "onboarding", "state-validation"]);
  });
});
