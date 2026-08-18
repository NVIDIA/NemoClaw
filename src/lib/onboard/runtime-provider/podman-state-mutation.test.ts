// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDockerStateMutationRoots,
  createPodmanStateMutationHarness as harness,
  dockerStateMutationPlan as plan,
} from "../../../../test/helpers/docker-state-mutation-harness";
import type { PodmanBoundContainerEngine, PodmanContainerEngine } from "../../adapters/podman";
import { loadAgent } from "../../agent/defs";
import {
  runHermesRuntimeProviderStateMutation,
  type HermesRuntimeStateMutationConfigTarget,
} from "../../shields/hermes-runtime-state-mutation";
import { createPodmanRuntimeProviderBundle } from "./podman";
import { createRuntimeProviderBundleRegistry } from "./registry";

function companionEngine(
  operation: "host-doctor" | "sandbox-lifecycle",
  stateMutation: PodmanContainerEngine,
): PodmanContainerEngine {
  return {
    operation,
    engineId: "podman",
    displayName: "Podman",
    authorityId: `${stateMutation.endpointAuthorityId}:${operation}`,
    endpointAuthorityId: stateMutation.endpointAuthorityId,
    capture: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    captureHost: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  };
}

function hermesConfigTarget(): HermesRuntimeStateMutationConfigTarget {
  const agent = loadAgent("hermes");
  return {
    agentName: agent.name,
    configPath: path.posix.join(agent.configPaths.dir, agent.configPaths.configFile),
    configDir: agent.configPaths.dir,
    configFile: agent.configPaths.configFile,
    format: agent.configPaths.format,
    sensitiveFiles: [
      path.posix.join(agent.configPaths.dir, ".config-hash"),
      ...agent.configPaths.shieldsFiles.map((entry) =>
        path.posix.join(agent.configPaths.dir, entry),
      ),
    ],
    stateLockPlan: agent.stateLockPlan,
    stateLockPlanInImage: agent.stateLockPlanInImage,
  };
}

afterEach(() => cleanupDockerStateMutationRoots());

describe("Podman runtime-provider state mutation", () => {
  it("holds one exact Podman fence through rollback, activation, and durable release", () => {
    const runtime = harness();
    const fence = runtime.owner.acquire({ ...runtime.context, plan: plan() });

    expect(fence).toMatchObject({
      providerId: "podman",
      phase: "fenced",
      providerHandle: expect.stringMatching(/^podman-state-mutation-v1:/u),
    });
    expect(runtime.engineAuthorityStore.load("state-mutation")).toMatchObject({
      providerId: "podman",
      operation: "state-mutation",
      engineId: "podman",
    });

    runtime.owner.rollback(runtime.context, fence);
    const proof = runtime.owner.activate(runtime.context, fence);
    expect(proof).toMatchObject({
      providerId: "podman",
      providerHandle: expect.stringMatching(/^podman-state-mutation-activation-v1:/u),
    });
    runtime.owner.release(runtime.context, fence, proof, "e".repeat(64));

    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
    expect(runtime.helperActions).toEqual([
      "acquire",
      "rollback",
      "activate",
      "activate",
      "release",
    ]);
    expect(
      runtime.capture.mock.calls.every(([, args]) =>
        (args as readonly string[])
          .slice(0, 2)
          .every((value, index) =>
            index === 0 ? value === "--url" : value === "unix:///run/user/1000/podman/podman.sock",
          ),
      ),
    ).toBe(true);
  });

  it("replays one lost acquire from durable intent under the same Podman authority", () => {
    const runtime = harness({ loseAcquireResponseOnce: true });

    expect(() => runtime.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "root helper acquire did not complete successfully",
    );
    expect(runtime.lifecycleStore.listUnfinished()).toMatchObject([
      {
        action: "state-mutation",
        phase: "prepared",
        engineAuthority: { providerId: "podman", operation: "state-mutation" },
      },
    ]);

    const recovered = runtime.owner.recover(runtime.context);

    expect(recovered).toMatchObject({
      providerId: "podman",
      phase: "fenced",
      providerHandle: expect.stringMatching(/^podman-state-mutation-v1:/u),
    });
    expect(runtime.acquireRequests[1]).toBe(runtime.acquireRequests[0]);
    expect(runtime.helperActions).toEqual(["acquire", "acquire"]);
  });

  it("rejects runtime identity drift before retrying the retained fence", () => {
    const runtime = harness();
    const fence = runtime.owner.acquire({ ...runtime.context, plan: plan() });
    runtime.state.mountSource = "/var/lib/openshell/replaced/hermes";

    expect(() => runtime.owner.assertFenced(runtime.context, fence)).toThrow(
      "runtime changed after the state mutation fence was established",
    );
    expect(runtime.helperActions).toEqual(["acquire"]);
  });

  it("runs the named Hermes consumer only through an injected Podman bundle", () => {
    const runtime = harness();
    const stateMutation = runtime.authority.engine as PodmanBoundContainerEngine;
    const bundle = createPodmanRuntimeProviderBundle({
      engines: {
        hostDoctor: companionEngine("host-doctor", stateMutation),
        sandboxLifecycle: companionEngine("sandbox-lifecycle", stateMutation),
        stateMutation,
      },
      stateMutation: { resolveStateDir: () => runtime.root },
    });
    const providers = createRuntimeProviderBundleRegistry([["podman", bundle]]);
    const sandbox = { ...runtime.context.sandbox, agent: "hermes" };

    const result = runHermesRuntimeProviderStateMutation({
      environment: runtime.context.environment,
      sandbox,
      sandboxName: sandbox.name,
      configTarget: hermesConfigTarget(),
      target: "locked",
      rollback: "mutable",
      providers,
    });

    expect(result).toMatchObject({
      fence: {
        providerId: "podman",
        providerHandle: expect.stringMatching(/^podman-state-mutation-v1:/u),
      },
      proof: {
        providerId: "podman",
        providerHandle: expect.stringMatching(/^podman-state-mutation-activation-v1:/u),
      },
    });
    expect(runtime.helperActions).toEqual([
      "acquire",
      "assert",
      "publish",
      "assert",
      "activate",
      "activate",
      "release",
    ]);
  });
});
