// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import type {
  LaunchReadinessFence,
  LaunchReadinessIdentity,
  LaunchReadinessLease,
} from "../../state/launch-readiness-lease";
import type { SandboxEntry } from "../../state/registry";
import {
  buildLaunchReadinessRegistryProjection,
  inspectLaunchReadiness,
  type LaunchReadinessDeps,
  launchReadinessDigest,
  launchReadinessPolicyDigest,
  publicationFromDecision,
  publishLaunchReadiness,
} from "./launch-readiness";

const SANDBOX = "alpha";
const GATEWAY_NAME = "nemoclaw";
const GATEWAY_PORT = 8080;
const EPOCH = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);
const DIGEST = "c".repeat(64);

const POLICY_A = `version: 1
network_policies:
  public_api:
    name: Public API
    endpoints:
      - host: example.com
        port: 443
    binaries:
      - path: /usr/bin/curl
`;

const POLICY_A_REORDERED = `network_policies:
  public_api:
    binaries:
      - path: /usr/bin/curl
    endpoints:
      - port: 443
        host: example.com
    name: Public API
version: 1
`;

const POLICY_B = POLICY_A.replace("example.com", "api.example.com");

function entry(agent = "openclaw"): SandboxEntry {
  return {
    name: SANDBOX,
    openshellDriver: "docker",
    openshellVersion: "0.0.99",
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: FINGERPRINT,
    agent,
    agentVersion: "1.0.0",
    nemoclawVersion: "2.0.0",
    imageTag: "example@sha256:immutable",
    policyPresetsFinalized: true,
    policies: ["managed_inference"],
    policyTier: "standard",
    provider: null,
    model: null,
    endpointUrl: null,
    credentialEnv: null,
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
  };
}

function fence(): LaunchReadinessFence {
  return {
    schemaVersion: 1,
    kind: "fence",
    epochId: EPOCH,
    sandboxName: SANDBOX,
    fencedWallMs: 1,
    fencedUptimeMs: 1,
    bootId: "boot-a",
    uid: 1,
    homeDevice: "1",
    homeInode: "2",
    storeDevice: "1",
    storeInode: "3",
    publicationState: "ready",
    preservedLeaseStartedWallMs: null,
    preservedLeaseExpiresWallMs: null,
    preservedLeaseElapsedMs: null,
  };
}

function lease(identity: LaunchReadinessIdentity): LaunchReadinessLease {
  return {
    schemaVersion: 1,
    kind: "lease",
    epochId: EPOCH,
    sandboxName: SANDBOX,
    leaseStartedWallMs: 1,
    leaseExpiresWallMs: 86_400_001,
    elapsedAtPublicationMs: 0,
    publishedWallMs: 1,
    publishedUptimeMs: 1,
    bootId: "boot-a",
    uid: 1,
    homeDevice: "1",
    homeInode: "2",
    storeDevice: "1",
    storeInode: "3",
    identity,
  };
}

describe("launch readiness validation", () => {
  let sandbox: SandboxEntry;
  let policy: string;
  let routeOutput: string;
  let readKind: "missing" | "valid";
  let publishedIdentity: LaunchReadinessIdentity | null;
  let runtimeHealthy: boolean | null;
  let forwardsHealthy: boolean | null;
  let observedFingerprint: string;
  let lockEvents: string[];
  let externalEvents: string[];
  let observationRequests: Array<{
    sandboxName: string;
    gatewayName: string;
    gatewayPort: number;
  }>;
  let captureRequests: string[][];

  beforeEach(() => {
    sandbox = entry();
    policy = POLICY_A;
    routeOutput = "Gateway Inference:\n\n  Not configured\n";
    readKind = "missing";
    publishedIdentity = null;
    runtimeHealthy = true;
    forwardsHealthy = true;
    observedFingerprint = FINGERPRINT;
    lockEvents = [];
    externalEvents = [];
    observationRequests = [];
    captureRequests = [];
    performance.clearMeasures("nemoclaw.launch-readiness.storage-read");
    performance.clearMeasures("nemoclaw.launch-readiness.live-validation");
    performance.clearMeasures("nemoclaw.launch-readiness.evidence-fence");
    performance.clearMeasures("nemoclaw.launch-readiness.publication-validation");
    performance.clearMeasures("nemoclaw.launch-readiness.publication-store");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function deps(): LaunchReadinessDeps {
    return {
      getSandbox: () => sandbox,
      listAgents: () => ["openclaw", "langchain-deepagents-code"],
      loadAgent,
      observeSandbox: (request) => {
        externalEvents.push("sandbox-get");
        observationRequests.push(request);
        return {
          state: "ready",
          liveIdentityFingerprint: observedFingerprint,
        };
      },
      capture: (args) => {
        externalEvents.push(args[0] === "policy" ? "policy-get" : "inference-get");
        captureRequests.push([...args]);
        return {
          status: 0,
          output: args[0] === "policy" ? policy : routeOutput,
          stdout: args[0] === "policy" ? policy : routeOutput,
          stderr: "",
        } as ReturnType<NonNullable<LaunchReadinessDeps["capture"]>>;
      },
      gatewayHealth: async () => {
        externalEvents.push("gateway-health");
        return runtimeHealthy;
      },
      forwardsHealthy: () => {
        externalEvents.push("forward-list");
        return forwardsHealthy;
      },
      smoke: () => ({ ok: true }),
      inferenceProbe: () => {
        externalEvents.push("inference-health");
        return { healthy: true, broken: false, httpStatus: 200, detail: "OK 200" };
      },
      readLease: () =>
        readKind === "valid" && publishedIdentity
          ? { kind: "valid", lease: lease(publishedIdentity) }
          : { kind: "missing" },
      fenceLease: () => fence(),
      publishLease: (_name, _port, _epoch, identity) => {
        publishedIdentity = identity;
        return lease(identity);
      },
      withSandboxLock: async <T>(_name: string, operation: () => Promise<T> | T) => {
        lockEvents.push("sandbox:start");
        const result = await operation();
        lockEvents.push("sandbox:end");
        return result;
      },
      withGatewayLock: async <T>(_name: string, operation: () => Promise<T> | T) => {
        lockEvents.push("gateway:start");
        const result = await operation();
        lockEvents.push("gateway:end");
        return result;
      },
    };
  }

  async function createAcceptedLease(currentDeps = deps()) {
    const first = await inspectLaunchReadiness(SANDBOX, currentDeps);
    expect(first).toMatchObject({ kind: "fallback", category: "missing", fenceFailed: false });
    expect(
      await publishLaunchReadiness(publicationFromDecision(SANDBOX, first), currentDeps),
    ).toEqual({ kind: "published" });
    expect(publishedIdentity).not.toBeNull();
    readKind = "valid";
    lockEvents = [];
    return currentDeps;
  }

  it("accepts only after final capture and follows sandbox then gateway lock order", async () => {
    const currentDeps = await createAcceptedLease();
    externalEvents = [];
    const decision = await inspectLaunchReadiness(SANDBOX, currentDeps);
    expect(decision).toMatchObject({ kind: "accepted", category: "accepted" });
    expect(lockEvents).toEqual(["sandbox:start", "gateway:start", "gateway:end", "sandbox:end"]);
    expect(externalEvents).toEqual([
      "sandbox-get",
      "policy-get",
      "inference-get",
      "gateway-health",
      "forward-list",
    ]);
  });

  it("records only accepted-path stages without wall-clock pass thresholds", async () => {
    const currentDeps = await createAcceptedLease();
    performance.clearMeasures("nemoclaw.launch-readiness.storage-read");
    performance.clearMeasures("nemoclaw.launch-readiness.live-validation");
    performance.clearMeasures("nemoclaw.launch-readiness.evidence-fence");
    performance.clearMeasures("nemoclaw.launch-readiness.publication-validation");
    performance.clearMeasures("nemoclaw.launch-readiness.publication-store");
    await inspectLaunchReadiness(SANDBOX, currentDeps);

    const names = performance
      .getEntriesByType("measure")
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("nemoclaw.launch-readiness."));
    expect(new Set(names)).toEqual(
      new Set([
        "nemoclaw.launch-readiness.storage-read",
        "nemoclaw.launch-readiness.live-validation",
      ]),
    );
  });

  it("fences config, policy, live identity, and health changes before fallback", async () => {
    const currentDeps = await createAcceptedLease();
    const cases: Array<{
      category: "config" | "identity" | "health";
      mutate: () => void;
      restore: () => void;
    }> = [
      {
        category: "config",
        mutate: () => {
          sandbox = { ...sandbox, policyTier: "strict" };
        },
        restore: () => {
          sandbox = { ...sandbox, policyTier: "standard" };
        },
      },
      {
        category: "config",
        mutate: () => {
          policy = POLICY_B;
        },
        restore: () => {
          policy = POLICY_A;
        },
      },
      {
        category: "identity",
        mutate: () => {
          observedFingerprint = DIGEST;
        },
        restore: () => {
          observedFingerprint = FINGERPRINT;
        },
      },
      {
        category: "health",
        mutate: () => {
          runtimeHealthy = false;
        },
        restore: () => {
          runtimeHealthy = true;
        },
      },
      {
        category: "health",
        mutate: () => {
          forwardsHealthy = false;
        },
        restore: () => {
          forwardsHealthy = true;
        },
      },
    ];
    for (const testCase of cases) {
      testCase.mutate();
      const decision = await inspectLaunchReadiness(SANDBOX, currentDeps);
      expect(decision).toMatchObject({
        kind: "fallback",
        category: testCase.category,
        fence: { epochId: EPOCH },
        fenceFailed: false,
      });
      testCase.restore();
    }
  });

  it("requires exact owning-gateway policy, inference route, and semantic health", async () => {
    sandbox = {
      ...sandbox,
      provider: "nvidia",
      model: "model-a",
      credentialEnv: "NVIDIA_API_KEY",
    };
    routeOutput = "Gateway Inference:\n\n  Provider: nvidia\n  Model: model-a\n";
    const currentDeps = await createAcceptedLease();
    externalEvents = [];
    expect(await inspectLaunchReadiness(SANDBOX, currentDeps)).toMatchObject({ kind: "accepted" });
    expect(externalEvents).toEqual([
      "sandbox-get",
      "policy-get",
      "inference-get",
      "gateway-health",
      "forward-list",
      "inference-health",
    ]);
    expect(observationRequests).toContainEqual({
      sandboxName: SANDBOX,
      gatewayName: GATEWAY_NAME,
      gatewayPort: GATEWAY_PORT,
    });
    expect(captureRequests).toContainEqual([
      "policy",
      "get",
      "-g",
      GATEWAY_NAME,
      "--full",
      SANDBOX,
    ]);
    expect(captureRequests).toContainEqual(["inference", "get", "-g", GATEWAY_NAME]);
    routeOutput = "Gateway Inference:\n\n  Provider: nvidia\n  Model: model-b\n";
    expect(await inspectLaunchReadiness(SANDBOX, currentDeps)).toMatchObject({
      kind: "fallback",
      category: "config",
    });

    routeOutput = "Gateway Inference:\n\n  Provider: nvidia\n  Model: model-a\n";
    currentDeps.inferenceProbe = () => ({
      healthy: false,
      broken: true,
      httpStatus: 503,
      detail: "BROKEN 503",
    });
    expect(await inspectLaunchReadiness(SANDBOX, currentDeps)).toMatchObject({
      kind: "fallback",
      category: "health",
    });
  });

  it("rejects a caller-controlled OpenShell gateway endpoint", async () => {
    const currentDeps = await createAcceptedLease();
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://attacker.invalid");
    expect(await inspectLaunchReadiness(SANDBOX, currentDeps)).toMatchObject({
      kind: "fallback",
      category: "config",
      fence: { epochId: EPOCH },
    });
  });

  it("uses terminal-agent smoke health for a supported non-OpenClaw runtime", async () => {
    sandbox = entry("langchain-deepagents-code");
    const currentDeps = deps();
    const gatewayHealth = vi.fn(async () => true);
    const smoke = vi.fn(() => ({ ok: true }) as const);
    currentDeps.gatewayHealth = gatewayHealth;
    currentDeps.smoke = smoke;
    await createAcceptedLease(currentDeps);
    expect(await inspectLaunchReadiness(SANDBOX, currentDeps)).toMatchObject({ kind: "accepted" });
    expect(smoke).toHaveBeenCalled();
    expect(gatewayHealth).not.toHaveBeenCalled();
  });

  it("hashes parsed policy semantics instead of presentation bytes", () => {
    expect(launchReadinessPolicyDigest(POLICY_A_REORDERED)).toBe(
      launchReadinessPolicyDigest(POLICY_A),
    );
    expect(launchReadinessPolicyDigest(POLICY_B)).not.toBe(launchReadinessPolicyDigest(POLICY_A));
  });

  it("uses an exact versioned allowlist for launch-affecting registry state", () => {
    const agent = loadAgent("openclaw");
    const projection = buildLaunchReadinessRegistryProjection(sandbox, agent) as Record<
      string,
      unknown
    >;
    expect(Object.keys(projection).sort()).toEqual(
      [
        "agent",
        "agentVersion",
        "baselineExclusions",
        "cuaRuntimeReadinessSha256",
        "customPolicies",
        "dashboardPort",
        "dashboardRemoteBindPrepared",
        "dcodeAutoApprovalMode",
        "fromDockerfile",
        "gatewayName",
        "gatewayPort",
        "hermesDashboardEnabled",
        "hermesDashboardInternalPort",
        "hermesDashboardPort",
        "hermesDashboardTui",
        "hermesInferenceProvider",
        "hermesToolGateways",
        "imageTag",
        "inference",
        "interactiveCommand",
        "lifecycleGeneration",
        "lifecycleLiveIdentityFingerprint",
        "mcpSha256",
        "messagingSha256",
        "name",
        "nemoclawVersion",
        "observabilityEnabled",
        "openclawImagePluginInstalls",
        "openshellDriver",
        "openshellVersion",
        "policies",
        "policyPresetsFinalized",
        "policyTier",
        "sandboxGpuProof",
        "toolDisclosure",
        "version",
        "webSearchEnabled",
        "webSearchProvider",
        "workloadIdentitySha256",
      ].sort(),
    );
    const original = launchReadinessDigest(projection);
    const mutations: SandboxEntry[] = [
      { ...sandbox, nemoclawVersion: "changed" },
      { ...sandbox, policies: ["managed_inference", "slack"] },
      {
        ...sandbox,
        customPolicies: [{ name: "custom", content: POLICY_A, pendingContent: POLICY_B }],
      },
      {
        ...sandbox,
        baselineExclusions: [
          {
            version: 1,
            agent: "openclaw",
            key: "phone_home",
            digest: DIGEST,
            appliedAgentVersion: "1.0.0",
          },
        ],
      },
      { ...sandbox, webSearchEnabled: true, webSearchProvider: "brave" },
      { ...sandbox, observabilityEnabled: true },
      { ...sandbox, hermesDashboardEnabled: true, hermesDashboardPort: 3000 },
      { ...sandbox, dashboardRemoteBindPrepared: true },
      {
        ...sandbox,
        sandboxGpuProof: {
          status: "verified",
          cudaVerified: true,
          label: "cuda",
          at: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        ...sandbox,
        openclawImagePluginInstalls: [
          { id: "plugin", installPath: "/sandbox/.openclaw/extensions/plugin", loadPaths: [] },
        ],
      },
    ];
    for (const mutation of mutations) {
      expect(
        launchReadinessDigest(buildLaunchReadinessRegistryProjection(mutation, agent)),
      ).not.toBe(original);
    }
  });

  it("excludes diagnostic timestamps, source paths, and GPU detail from the projection", () => {
    const agent = loadAgent("openclaw");
    const first: SandboxEntry = {
      ...sandbox,
      createdAt: "2026-01-01T00:00:00.000Z",
      customPolicies: [
        {
          name: "custom",
          content: POLICY_A,
          sourcePath: "/first/policy.yaml",
          appliedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      baselineExclusions: [
        {
          version: 1,
          agent: "openclaw",
          key: "phone_home",
          digest: DIGEST,
          acknowledgedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sandboxGpuProof: {
        status: "verified",
        cudaVerified: true,
        label: "cuda",
        detail: "first diagnostic",
        at: "2026-01-01T00:00:00.000Z",
      },
    };
    const second: SandboxEntry = {
      ...first,
      createdAt: "2026-06-01T00:00:00.000Z",
      customPolicies: [
        {
          ...first.customPolicies?.[0],
          name: "custom",
          content: POLICY_A,
          sourcePath: "/second/policy.yaml",
          appliedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      baselineExclusions: [
        {
          ...first.baselineExclusions?.[0],
          version: 1,
          agent: "openclaw",
          key: "phone_home",
          digest: DIGEST,
          acknowledgedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      sandboxGpuProof: {
        ...first.sandboxGpuProof!,
        detail: "second diagnostic",
        at: "2026-06-01T00:00:00.000Z",
      },
    };
    expect(launchReadinessDigest(buildLaunchReadinessRegistryProjection(second, agent))).toBe(
      launchReadinessDigest(buildLaunchReadinessRegistryProjection(first, agent)),
    );
  });

  it("distinguishes authoritative final validation failure from evidence failure", async () => {
    const first = await inspectLaunchReadiness(SANDBOX, deps());
    const publication = publicationFromDecision(SANDBOX, first);

    const invalid = deps();
    invalid.gatewayHealth = async () => false;
    expect(await publishLaunchReadiness(publication, invalid)).toEqual({
      kind: "validation-failed",
      category: "health",
    });

    const changedRoute = deps();
    changedRoute.capture = (args) => ({
      status: 0,
      output:
        args[0] === "policy"
          ? policy
          : "Gateway Inference:\n\n  Provider: nvidia\n  Model: changed\n",
      stdout:
        args[0] === "policy"
          ? policy
          : "Gateway Inference:\n\n  Provider: nvidia\n  Model: changed\n",
      stderr: "",
    });
    expect(await publishLaunchReadiness(publication, changedRoute)).toEqual({
      kind: "validation-failed",
      category: "config",
    });

    const observationUnavailable = deps();
    observationUnavailable.observeSandbox = () => {
      throw new Error("observer unavailable");
    };
    expect(await publishLaunchReadiness(publication, observationUnavailable)).toEqual({
      kind: "evidence-failed",
    });

    const hashUnavailable = deps();
    hashUnavailable.capture = (args) => ({
      status: 0,
      output: args[0] === "policy" ? "version: [" : routeOutput,
      stdout: args[0] === "policy" ? "version: [" : routeOutput,
      stderr: "",
    });
    expect(await publishLaunchReadiness(publication, hashUnavailable)).toEqual({
      kind: "evidence-failed",
    });

    const inferenceObservationUnavailable = deps();
    inferenceObservationUnavailable.capture = (args) => ({
      status: 0,
      output: args[0] === "policy" ? policy : "unexpected inference output",
      stdout: args[0] === "policy" ? policy : "unexpected inference output",
      stderr: "",
    });
    expect(await publishLaunchReadiness(publication, inferenceObservationUnavailable)).toEqual({
      kind: "evidence-failed",
    });

    const unavailable = deps();
    unavailable.publishLease = () => {
      throw new Error("unavailable");
    };
    expect(await publishLaunchReadiness(publication, unavailable)).toEqual({
      kind: "evidence-failed",
    });
  });

  it("rejects in-progress lifecycle and policy mutations", () => {
    const agent = loadAgent("openclaw");
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        { ...sandbox, pendingRouteReservation: true, reservationSessionId: "session" },
        agent,
      ),
    ).toThrow();
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        {
          ...sandbox,
          baselineExclusionTransition: {
            id: "transition",
            operation: "exclude",
            exclusion: {
              version: 1,
              agent: "openclaw",
              key: "phone_home",
              digest: DIGEST,
            },
            targetLiveDigest: null,
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        agent,
      ),
    ).toThrow();
  });
});
