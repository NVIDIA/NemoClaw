// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, expect, it } from "vitest";

import {
  quarantineSandbox,
  type QuarantineSandboxDeps,
} from "../../../src/lib/actions/sandbox/quarantine/index.ts";
import { listAgents, loadAgent } from "../../../src/lib/agent/defs.ts";
import type { AgentDefinition } from "../../../src/lib/agent/definition-types.ts";
import type { RuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/contract.ts";
import { createDockerRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/docker.ts";
import { createRuntimeProviderBundleRegistry } from "../../../src/lib/onboard/runtime-provider/registry.ts";
import type {
  SandboxEntry,
  SandboxQuarantineFence,
} from "../../../src/lib/state/registry/types.ts";
import { catalogueTarget } from "../../../tools/e2e/target-catalogue.mts";

const LIVE_IDENTITY = "a".repeat(64);
const PROVIDER_HANDLE = "b".repeat(64);
const RUNTIME_HANDLE = "c".repeat(64);

function quarantineQualifiedAgent(agent: AgentDefinition) {
  let sandbox: SandboxEntry = {
    name: `qualification-${agent.name}`,
    agent: agent.name,
    openshellDriver: "docker",
    lifecycleGeneration: "qualification-generation",
    lifecycleLiveIdentityFingerprint: LIVE_IDENTITY,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  };
  const base = createDockerRuntimeProviderBundle();
  assert.equal(base.quarantine.supported, true);
  const authority = {
    schemaVersion: 1 as const,
    providerId: "docker",
    sandboxName: sandbox.name,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: sandbox.lifecycleGeneration!,
    liveIdentityFingerprint: LIVE_IDENTITY,
    providerHandle: PROVIDER_HANDLE,
    providerLifecycleGeneration: "provider-running",
    runtime: { kind: "docker-container" as const, handle: RUNTIME_HANDLE },
  };
  const provider: RuntimeProviderBundle = {
    ...base,
    preflightDoctor: { ...base.preflightDoctor, preflightLifecycle: () => null },
    quarantine: {
      ...base.quarantine,
      prepare: () => authority,
      stop: () => ({ outcome: "succeeded" }),
      observe: () => ({
        execution: { outcome: "succeeded" },
        sandboxAccess: { outcome: "succeeded" },
      }),
    },
  };
  const deps: QuarantineSandboxDeps = {
    beginFence: (_name, fence: SandboxQuarantineFence) => {
      sandbox = { ...sandbox, quarantine: fence };
      return { status: "started", fence };
    },
    getAgent: () => agent,
    getSandbox: () => sandbox,
    now: () => new Date("2026-08-25T04:00:00.000Z"),
    randomId: () => "00000000-0000-4000-8000-000000000001",
    readReceipt: () => null,
    runtimeProviders: createRuntimeProviderBundleRegistry([["docker", provider]]),
    stopMessaging: () => true,
    stopServiceAccess: () => true,
    teardownDashboard: () => true,
    updateFence: (_name, fence) => {
      sandbox = { ...sandbox, quarantine: fence };
      return true;
    },
    withLifecycleLock: (_name, operation) => operation(),
    writeReceipt: () => undefined,
    log: () => undefined,
  };
  return quarantineSandbox(
    sandbox.name,
    { reason: "qualification", idempotencyKey: "qualification" },
    deps,
  );
}

describe("all-agent quarantine qualification", () => {
  it.each(listAgents({}))(
    "maps default selectable manifest %s to its own required live lane (#10140)",
    (agentName) => {
      const qualification = loadAgent(agentName, {}).quarantineQualification;
      expect(qualification, agentName).not.toBeNull();
      const target = catalogueTarget(qualification!.liveE2eTarget);
      expect(target).toMatchObject({
        id: qualification!.liveE2eTarget,
        agentRuntime: agentName,
        testFile: "test/e2e/live/sandbox-quarantine.test.ts",
        prAdvisorSelectable: true,
        releaseRequired: true,
      });
      expect(target.owningPaths).toEqual(
        expect.arrayContaining([
          "src/lib/state/registry/quarantine.ts",
          "src/lib/state/registry/quarantine-operations.ts",
          "src/lib/state/registry/quarantine-receipt.ts",
        ]),
      );
      expect(quarantineQualifiedAgent(loadAgent(agentName, {}))).toMatchObject({
        exitCode: 0,
        status: "quarantined",
        outcomes: {
          executionObservation: "succeeded",
          sandboxAccessObservation: "succeeded",
          serviceAccessStop: "succeeded",
        },
      });
    },
  );
});
