// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";
import { createHermesTransitionFailureController } from "../../../test/helpers/hermes-runtime-state-mutation-test-helpers";
import { testTimeout } from "../../../test/helpers/timeouts";

import { loadAgent } from "../agent/defs";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
  type RuntimeProviderPreparedStateMutationPlan,
  type RuntimeProviderStateMutationActivationProof,
  type RuntimeProviderStateMutationContext,
  type RuntimeProviderStateMutationFence,
} from "../onboard/runtime-provider/access";
import { RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION } from "../onboard/runtime-provider/contract";
import type { SandboxEntry } from "../state/registry";
import {
  HERMES_RUNTIME_STATE_MUTATION_CAPABILITY,
  HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_METADATA,
  hermesRuntimeProviderPhaseBlocksMutation,
  runHermesRuntimeProviderStateMutation,
  supportsHermesRuntimeProviderStateMutation,
} from "./hermes-runtime-state-mutation";

const sandbox: SandboxEntry = {
  name: "hermes",
  agent: "hermes",
  openshellDriver: "docker",
  lifecycleGeneration: "generation-1",
  workload: {
    schemaVersion: 1,
    kind: "managed-image",
    reference: "ghcr.io/nvidia/nemoclaw/hermes@sha256:abc",
    platform: "linux/amd64",
    release: "test",
    sourceRevision: "a".repeat(40),
    sourceCohort: "test",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile: "e30",
    startupProfileSha256: "b".repeat(64),
    credentialProxyReplayRequired: true,
    shared: true,
  },
};

const hermesAgent = loadAgent("hermes");
const configTarget = {
  agentName: hermesAgent.name,
  configPath: path.posix.join(hermesAgent.configPaths.dir, hermesAgent.configPaths.configFile),
  configDir: hermesAgent.configPaths.dir,
  configFile: hermesAgent.configPaths.configFile,
  format: hermesAgent.configPaths.format,
  sensitiveFiles: [
    path.posix.join(hermesAgent.configPaths.dir, ".config-hash"),
    ...hermesAgent.configPaths.shieldsFiles.map((entry) =>
      path.posix.join(hermesAgent.configPaths.dir, entry),
    ),
  ],
  stateLockPlan: hermesAgent.stateLockPlan,
  stateLockPlanInImage: hermesAgent.stateLockPlanInImage,
};

const fence: RuntimeProviderStateMutationFence = {
  schemaVersion: 1,
  intent: "protection-transition",
  phase: "fenced",
  providerId: "docker",
  sandboxName: "hermes",
  transactionId: "1".repeat(64),
  lifecycleGeneration: "generation-1",
  runtimeId: "2".repeat(64),
  runtimeStateSha256: "3".repeat(64),
  engineBindingSha256: "4".repeat(64),
  stateRoot: "/sandbox/.hermes",
  mountNamespaceId: "mnt:[123]",
  stateRootDevice: "4",
  stateRootInode: "5",
  planSha256: "6".repeat(64),
  projectionSha256: "7".repeat(64),
  target: "locked",
  rollback: "mutable",
  nonce: "8".repeat(64),
  providerHandle: `docker-state-mutation-v1:${"1".repeat(64)}:${"9".repeat(64)}`,
};

const mutableFence: RuntimeProviderStateMutationFence = {
  ...fence,
  target: "mutable",
  rollback: "locked",
};

const proof: RuntimeProviderStateMutationActivationProof = {
  schemaVersion: 1,
  providerId: "docker",
  sandboxName: "hermes",
  lifecycleGeneration: "generation-1",
  runtimeId: "2".repeat(64),
  nonce: "8".repeat(64),
  configurationGeneration: "a".repeat(64),
  listenerIdentity: "tcp:18642:pid:321:start:654",
  healthSha256: "b".repeat(64),
  providerHandle: `docker-state-mutation-activation-v1:${"1".repeat(64)}:${"c".repeat(64)}`,
};

type SurfaceOverrides = Partial<{
  acquire: (
    input: RuntimeProviderStateMutationContext & {
      readonly plan: RuntimeProviderPreparedStateMutationPlan;
    },
  ) => RuntimeProviderStateMutationFence;
  assertFenced: (
    input: RuntimeProviderStateMutationContext,
    value: RuntimeProviderStateMutationFence,
  ) => void;
  publish: (
    input: RuntimeProviderStateMutationContext,
    value: RuntimeProviderStateMutationFence,
  ) => void;
  rollback: (
    input: RuntimeProviderStateMutationContext,
    value: RuntimeProviderStateMutationFence,
  ) => void;
  activate: (
    input: RuntimeProviderStateMutationContext,
    value: RuntimeProviderStateMutationFence,
  ) => RuntimeProviderStateMutationActivationProof;
  release: (
    input: RuntimeProviderStateMutationContext,
    value: RuntimeProviderStateMutationFence,
    activation: RuntimeProviderStateMutationActivationProof,
    digest: string,
  ) => void;
  recover: (input: RuntimeProviderStateMutationContext) => RuntimeProviderStateMutationFence | null;
}>;

function providers(overrides: SurfaceOverrides = {}): RuntimeProviderBundleRegistry {
  const docker = CURRENT_RUNTIME_PROVIDER_BUNDLES.docker!;
  return {
    docker: {
      ...docker,
      stateMutation: {
        providerId: "docker",
        supported: true,
        contractVersion: RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION,
        acquire: overrides.acquire ?? (() => fence),
        assertFenced: overrides.assertFenced ?? (() => undefined),
        publish: overrides.publish ?? (() => undefined),
        rollback: overrides.rollback ?? (() => undefined),
        activate: overrides.activate ?? (() => proof),
        release: overrides.release ?? (() => undefined),
        recover: overrides.recover ?? (() => null),
      },
    },
  };
}

function run(
  runtimeProviders: RuntimeProviderBundleRegistry,
  targetPosture: "locked" | "mutable" = "locked",
  rollback: "locked" | "mutable" = "mutable",
  targetConfig = configTarget,
) {
  return runHermesRuntimeProviderStateMutation({
    environment: { HOME: "/tmp/test-home" },
    sandbox,
    sandboxName: sandbox.name,
    configTarget: targetConfig,
    target: targetPosture,
    rollback,
    providers: runtimeProviders,
  });
}

describe("Hermes runtime-provider state mutation consumer", () => {
  it("allows a retained mutation to recover while OpenShell is Provisioning", () => {
    expect(hermesRuntimeProviderPhaseBlocksMutation("Provisioning", true)).toBe(false);
    expect(hermesRuntimeProviderPhaseBlocksMutation("Provisioning", false)).toBe(true);
  });

  it(
    "resolves the current Docker provider when the caller does not inject a registry",
    () => {
      expect(
        supportsHermesRuntimeProviderStateMutation(sandbox, {
          content: HERMES_RUNTIME_STATE_MUTATION_CAPABILITY,
          metadata: HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_METADATA,
        }),
      ).toBe(true);
    },
    testTimeout(30_000),
  );

  it("selects the registered native provider state-mutation surface without a provider-name branch", () => {
    expect(
      supportsHermesRuntimeProviderStateMutation(
        { ...sandbox, openshellDriver: "podman" },
        {
          content: HERMES_RUNTIME_STATE_MUTATION_CAPABILITY,
          metadata: HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_METADATA,
        },
      ),
    ).toBe(true);
  });

  it("selects only an exact current managed Hermes Docker image capability", () => {
    const capability = {
      content: HERMES_RUNTIME_STATE_MUTATION_CAPABILITY,
      metadata: HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_METADATA,
    };
    expect(supportsHermesRuntimeProviderStateMutation(sandbox, capability, providers())).toBe(true);
    expect(
      supportsHermesRuntimeProviderStateMutation(
        { ...sandbox, workload: undefined },
        capability,
        providers(),
      ),
    ).toBe(false);
    expect(
      supportsHermesRuntimeProviderStateMutation(
        sandbox,
        { ...capability, metadata: "644 0 0 1 regular file" },
        providers(),
      ),
    ).toBe(false);
    expect(
      supportsHermesRuntimeProviderStateMutation(
        sandbox,
        { ...capability, content: `${capability.content} ` },
        providers(),
      ),
    ).toBe(false);
  });

  it("publishes and activates the exact AgentDefinition plan before durable release", () => {
    const calls: string[] = [];
    let acquiredPlan: RuntimeProviderPreparedStateMutationPlan | undefined;
    let completionDigest = "";
    const result = run(
      providers({
        recover: () => {
          calls.push("recover");
          return null;
        },
        acquire: (input) => {
          calls.push("acquire");
          acquiredPlan = input.plan;
          return fence;
        },
        assertFenced: () => calls.push("assert"),
        publish: () => calls.push("publish"),
        activate: () => {
          calls.push("activate");
          return proof;
        },
        release: (_context, _fence, _proof, digest) => {
          calls.push("release");
          completionDigest = digest;
        },
      }),
    );

    expect(calls).toEqual([
      "recover",
      "acquire",
      "assert",
      "publish",
      "assert",
      "activate",
      "release",
    ]);
    expect(acquiredPlan?.plan).toMatchObject({
      intent: "protection-transition",
      stateRoot: "/sandbox/.hermes",
      target: "locked",
      rollback: "mutable",
    });
    expect(acquiredPlan?.serializedPlan).not.toMatch(/command|callback|executable/u);
    expect(completionDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result).toEqual({ fence, proof });
  });

  it.each([
    ["locked", "mutable", fence],
    ["mutable", "locked", mutableFence],
  ] as const)(
    "executes a same-%s transition with a synthetic %s rollback",
    (target, expectedRollback, acquiredFence) => {
      const calls: string[] = [];
      let acquiredPlan: RuntimeProviderPreparedStateMutationPlan | undefined;
      const result = run(
        providers({
          recover: () => {
            calls.push("recover");
            return null;
          },
          acquire: (input) => {
            calls.push("acquire");
            acquiredPlan = input.plan;
            return acquiredFence;
          },
          assertFenced: () => calls.push("assert"),
          publish: () => calls.push("publish"),
          activate: () => {
            calls.push("activate");
            return proof;
          },
          release: () => calls.push("release"),
        }),
        target,
        target,
      );

      expect(acquiredPlan?.plan).toMatchObject({ target, rollback: expectedRollback });
      expect(calls).toEqual([
        "recover",
        "acquire",
        "assert",
        "publish",
        "assert",
        "activate",
        "release",
      ]);
      expect(result).toEqual({ fence: acquiredFence, proof });
    },
  );

  it.each(["publication", "verification", "activation"] as const)(
    "rolls a same-mutable transition back to locked after %s failure",
    (failureStage) => {
      const calls: string[] = [];
      const failure = new Error(`${failureStage} failed`);
      const failureController = createHermesTransitionFailureController(failureStage, failure, {
        failOnlyFirstActivation: true,
      });
      let acquiredPlan: RuntimeProviderPreparedStateMutationPlan | undefined;

      expect(() =>
        run(
          providers({
            acquire: (input) => {
              calls.push("acquire");
              acquiredPlan = input.plan;
              return mutableFence;
            },
            assertFenced: () => {
              calls.push("assert");
              failureController.afterAssertion();
            },
            publish: () => {
              calls.push("publish");
              failureController.afterPublication();
            },
            rollback: (_context, value) => {
              calls.push("rollback");
              expect(value).toMatchObject({ target: "mutable", rollback: "locked" });
            },
            activate: () => {
              calls.push("activate");
              failureController.beforeActivation();
              return proof;
            },
            release: () => calls.push("release"),
          }),
          "mutable",
          "mutable",
        ),
      ).toThrow(failure);

      expect(acquiredPlan?.plan).toMatchObject({ target: "mutable", rollback: "locked" });
      expect(calls.filter((call) => call === "rollback")).toHaveLength(1);
      expect(calls.at(-1)).toBe("release");
    },
  );

  it.each(["publication", "verification", "activation"] as const)(
    "retains a same-locked restrictive fence after %s failure",
    (failureStage) => {
      const calls: string[] = [];
      const failure = new Error(`${failureStage} failed`);
      const failureController = createHermesTransitionFailureController(failureStage, failure);
      let acquiredPlan: RuntimeProviderPreparedStateMutationPlan | undefined;

      expect(() =>
        run(
          providers({
            acquire: (input) => {
              calls.push("acquire");
              acquiredPlan = input.plan;
              return fence;
            },
            assertFenced: () => {
              calls.push("assert");
              failureController.afterAssertion();
            },
            publish: () => {
              calls.push("publish");
              failureController.afterPublication();
            },
            rollback: () => calls.push("rollback"),
            activate: () => {
              calls.push("activate");
              failureController.beforeActivation();
              return proof;
            },
            release: () => calls.push("release"),
          }),
          "locked",
          "locked",
        ),
      ).toThrow(failure);

      expect(acquiredPlan?.plan).toMatchObject({ target: "locked", rollback: "mutable" });
      expect(calls).not.toContain("rollback");
      expect(calls).not.toContain("release");
    },
  );

  it("rolls back and releases a recovered prior fence before acquiring a new one", () => {
    const calls: string[] = [];
    const recoveries = [mutableFence, null];
    run(
      providers({
        recover: () => {
          calls.push("recover");
          return recoveries.shift() ?? null;
        },
        assertFenced: () => calls.push("assert"),
        rollback: () => calls.push("rollback"),
        activate: () => {
          calls.push("activate");
          return proof;
        },
        release: () => calls.push("release"),
        acquire: () => {
          calls.push("acquire");
          return fence;
        },
        publish: () => calls.push("publish"),
      }),
    );

    expect(calls.slice(0, 6)).toEqual([
      "recover",
      "assert",
      "rollback",
      "assert",
      "activate",
      "release",
    ]);
    expect(calls[6]).toBe("acquire");
  });

  it("preserves locked containment while retaining exclusion after lock publication fails", () => {
    const calls: string[] = [];
    const failure = new Error("publisher rejected target");
    let acquiredPlan: RuntimeProviderPreparedStateMutationPlan | undefined;
    expect(() =>
      run(
        providers({
          acquire: (input) => {
            acquiredPlan = input.plan;
            return fence;
          },
          assertFenced: () => calls.push("assert"),
          publish: () => {
            calls.push("publish");
            throw failure;
          },
          rollback: () => calls.push("rollback"),
          activate: () => {
            calls.push("activate");
            return proof;
          },
          release: () => calls.push("release"),
        }),
      ),
    ).toThrow(failure);
    expect(calls).toEqual(["assert", "publish"]);
    expect(acquiredPlan?.plan).toMatchObject({ target: "locked", rollback: "mutable" });
  });

  it("preserves locked containment when the first fence assertion fails", () => {
    const calls: string[] = [];
    const failure = new Error("fence assertion transport failed");
    expect(() =>
      run(
        providers({
          assertFenced: () => {
            calls.push("assert");
            throw failure;
          },
          rollback: () => calls.push("rollback"),
          activate: () => {
            calls.push("activate");
            return proof;
          },
          release: () => calls.push("release"),
        }),
      ),
    ).toThrow(failure);
    expect(calls).toEqual(["assert"]);
  });

  it("keeps the prior locked posture as the unlock rollback", () => {
    let acquiredPlan: RuntimeProviderPreparedStateMutationPlan | undefined;
    run(
      providers({
        acquire: (input) => {
          acquiredPlan = input.plan;
          return mutableFence;
        },
      }),
      "mutable",
      "locked",
    );
    expect(acquiredPlan?.plan).toMatchObject({ target: "mutable", rollback: "locked" });
  });

  it("retains the locked fence without rollback when activation fails", () => {
    const calls: string[] = [];
    const failure = new Error("locked gateway activation failed");
    expect(() =>
      run(
        providers({
          assertFenced: () => calls.push("assert"),
          publish: () => calls.push("publish"),
          activate: () => {
            calls.push("activate");
            throw failure;
          },
          rollback: () => calls.push("rollback"),
          release: () => calls.push("release"),
        }),
      ),
    ).toThrow(failure);
    expect(calls).toEqual(["assert", "publish", "assert", "activate"]);
  });

  it("recovers the exact retained locked fence after the first activation fails", () => {
    const calls: string[] = [];
    const firstFailure = new Error("first locked activation failed");
    const recoveredFence = { ...fence, phase: "published" as const };
    let recoverCount = 0;
    const activations = [
      () => {
        throw firstFailure;
      },
      () => proof,
    ];
    const result = run(
      providers({
        recover: () => {
          calls.push("recover");
          recoverCount += 1;
          return recoverCount === 1 ? null : recoveredFence;
        },
        acquire: () => {
          calls.push("acquire");
          return fence;
        },
        assertFenced: () => calls.push("assert"),
        publish: () => calls.push("publish"),
        activate: () => {
          calls.push("activate");
          return (activations.shift() ?? (() => proof))();
        },
        rollback: () => calls.push("rollback"),
        release: () => calls.push("release"),
      }),
    );

    expect(result).toEqual({ fence: recoveredFence, proof });
    expect(calls).toEqual([
      "recover",
      "acquire",
      "assert",
      "publish",
      "assert",
      "activate",
      "recover",
      "assert",
      "activate",
      "release",
    ]);
    expect(calls).not.toContain("rollback");
  });

  it("refuses activation recovery when the retained fence authority changes", () => {
    const primary = new Error("first locked activation failed");
    let recoverCount = 0;
    expect(() =>
      run(
        providers({
          recover: () => {
            recoverCount += 1;
            return recoverCount === 1
              ? null
              : {
                  ...fence,
                  phase: "published",
                  runtimeStateSha256: "d".repeat(64),
                };
          },
          activate: () => {
            throw primary;
          },
        }),
      ),
    ).toThrow(/first locked activation failed.*different state-mutation fence/iu);
  });

  it("recovers an acquire transport failure and rolls back the exact discovered fence", () => {
    const calls: string[] = [];
    const primary = new Error("acquire transport closed");
    let recoverCount = 0;
    expect(() =>
      run(
        providers({
          acquire: () => {
            calls.push("acquire");
            throw primary;
          },
          recover: () => {
            calls.push("recover");
            recoverCount += 1;
            return recoverCount === 1 ? null : mutableFence;
          },
          assertFenced: () => calls.push("assert"),
          rollback: () => calls.push("rollback"),
          activate: () => {
            calls.push("activate");
            return proof;
          },
          release: () => calls.push("release"),
        }),
      ),
    ).toThrow(primary);
    expect(calls).toEqual([
      "recover",
      "acquire",
      "recover",
      "assert",
      "rollback",
      "assert",
      "activate",
      "release",
    ]);
  });

  it("completes a recovered locked acquire before surfacing the lost response", () => {
    const calls: string[] = [];
    const primary = new Error("locked acquire response lost");
    let recoverCount = 0;
    expect(() =>
      run(
        providers({
          acquire: () => {
            calls.push("acquire");
            throw primary;
          },
          recover: () => {
            calls.push("recover");
            recoverCount += 1;
            return recoverCount === 1 ? null : fence;
          },
          assertFenced: () => calls.push("assert"),
          publish: () => calls.push("publish"),
          rollback: () => calls.push("rollback"),
          activate: () => {
            calls.push("activate");
            return proof;
          },
          release: () => calls.push("release"),
        }),
      ),
    ).toThrow(primary);
    expect(calls).toEqual([
      "recover",
      "acquire",
      "recover",
      "assert",
      "publish",
      "assert",
      "activate",
      "release",
    ]);
    expect(calls).not.toContain("rollback");
  });

  it("finishes an ambiguous release through provider recovery without republishing", () => {
    const calls: string[] = [];
    let recoverCount = 0;
    run(
      providers({
        recover: () => {
          calls.push("recover");
          recoverCount += 1;
          return null;
        },
        acquire: () => fence,
        assertFenced: () => calls.push("assert"),
        publish: () => calls.push("publish"),
        activate: () => {
          calls.push("activate");
          return proof;
        },
        release: () => {
          calls.push("release");
          throw new Error("response lost after release");
        },
      }),
    );
    expect(recoverCount).toBe(2);
    expect(calls.filter((entry) => entry === "publish")).toHaveLength(1);
    expect(calls.at(-1)).toBe("recover");
  });

  it.each([
    ["schema authority", { schemaVersion: 2 }],
    ["runtime authority", { runtimeStateSha256: "d".repeat(64) }],
    ["engine authority", { engineBindingSha256: "d".repeat(64) }],
    ["mount authority", { mountNamespaceId: "mnt:[999]" }],
    ["state-root scope", { stateRoot: "/sandbox/.hermes-other" }],
    ["state-root identity", { stateRootInode: "99" }],
    ["plan authority", { projectionSha256: "d".repeat(64) }],
  ])("rejects %s drift in a recovered release fence", (_label, mutation) => {
    let recoveryCount = 0;
    expect(() =>
      run(
        providers({
          recover: () => {
            recoveryCount += 1;
            return recoveryCount === 1
              ? null
              : ({
                  ...fence,
                  ...mutation,
                  phase: "activation-proven",
                } as RuntimeProviderStateMutationFence);
          },
          release: () => {
            throw new Error("release response lost");
          },
        }),
      ),
    ).toThrow(/different state-mutation fence/u);
  });

  it("rejects a recovered release fence that has not retained activation proof", () => {
    let recoveryCount = 0;
    expect(() =>
      run(
        providers({
          recover: () => {
            recoveryCount += 1;
            return recoveryCount === 1 ? null : { ...fence, phase: "published" };
          },
          release: () => {
            throw new Error("release response lost");
          },
        }),
      ),
    ).toThrow(/different state-mutation fence/u);
  });

  it("keeps the fence active and reports both failures when rollback cannot complete", () => {
    const failure = new Error("activation failed");
    expect(() =>
      run(
        providers({
          acquire: () => mutableFence,
          activate: () => {
            throw failure;
          },
          rollback: () => {
            throw new Error("rollback blocked");
          },
        }),
        "mutable",
        "locked",
      ),
    ).toThrow(/activation failed.*retained.*rollback blocked/iu);
  });

  it("recovers a retained fence before rejecting a stale config target without acquiring", () => {
    const calls: string[] = [];
    const recoveries = [{ ...fence, phase: "published" as const }, null];
    expect(() =>
      run(
        providers({
          recover: () => {
            calls.push("recover");
            return recoveries.shift() ?? null;
          },
          assertFenced: () => calls.push("assert"),
          publish: () => calls.push("publish"),
          rollback: () => calls.push("rollback"),
          activate: () => {
            calls.push("activate");
            return proof;
          },
          release: () => calls.push("release"),
          acquire: () => {
            calls.push("acquire");
            return fence;
          },
        }),
        "locked",
        "mutable",
        { ...configTarget, configPath: "/sandbox/.hermes/old-config.yaml" },
      ),
    ).toThrow(/no longer matches the current AgentDefinition config projection/u);
    expect(calls).toEqual(["recover", "assert", "activate", "release"]);
    expect(calls).not.toContain("rollback");
    expect(calls).not.toContain("publish");
    expect(calls).not.toContain("acquire");
  });

  it("refuses to release a retained locked transition whose mutable rollback was published", () => {
    expect(() =>
      run(
        providers({
          recover: () => ({ ...fence, phase: "rolled-back" }),
        }),
      ),
    ).toThrow(/already published its mutable rollback.*refusing to release mutable state/iu);
  });
});
