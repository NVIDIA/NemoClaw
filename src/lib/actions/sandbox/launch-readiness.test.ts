// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import type {
  LaunchReadinessFence,
  LaunchReadinessIdentity,
  LaunchReadinessLease,
  LaunchReadinessOpenClawSessionQualification,
} from "../../state/launch-readiness-lease";
import { LaunchReadinessFenceError } from "../../state/launch-readiness-lease";
import type { SandboxEntry } from "../../state/registry";
import {
  buildLaunchReadinessRegistryProjection,
  inspectLaunchReadiness,
  type LaunchReadinessDeps,
  launchReadinessDigest,
  publicationFromDecision,
  publishLaunchReadiness,
  withLaunchReadinessMutationGate,
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

function servingProfile(): NonNullable<SandboxEntry["servingProfileProvenance"]> {
  return {
    schemaVersion: 1,
    catalogDigest: `sha256:${"d".repeat(64)}`,
    preset: {
      id: "local-gpu",
      digest: `sha256:${"e".repeat(64)}`,
      displayName: "Local GPU",
      supportState: "supported",
    },
    recipe: {
      id: "vllm-local",
      digest: `sha256:${"f".repeat(64)}`,
      backend: "vllm",
    },
    model: { id: "model-a", revision: "revision-a" },
    runtimeImage: "example.com/runtime@sha256:immutable",
    estimatedImageDownloadBytes: 1_000,
    estimatedModelDownloadBytes: 2_000,
  };
}

function fence(): LaunchReadinessFence {
  return {
    schemaVersion: 3,
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
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
    publicationState: "ready",
    preservedLeaseStartedWallMs: null,
    preservedLeaseExpiresWallMs: null,
    preservedLeaseElapsedMs: null,
  };
}

function lease(identity: LaunchReadinessIdentity): LaunchReadinessLease {
  return {
    schemaVersion: 3,
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
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
    identity,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function serialTestLock(
  events: string[],
  label: string,
): NonNullable<LaunchReadinessDeps["withSandboxLock"]> {
  let tail = Promise.resolve();
  return async <T>(_name: string, operation: () => Promise<T> | T): Promise<T> => {
    const previous = tail;
    const release = deferred();
    tail = previous.then(() => release.promise);
    await previous;
    events.push(`${label}:start`);
    try {
      return await operation();
    } finally {
      events.push(`${label}:end`);
      release.resolve();
    }
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
  let pairingStateSha256: string;
  let lockEvents: string[];
  let externalEvents: string[];
  let observationRequests: Array<{
    sandboxName: string;
    gatewayName: string;
    gatewayPort: number;
  }>;
  let captureRequests: string[][];
  let gatewayHealthRequests: Array<[string, string]>;
  let forwardRequests: Array<[string, string]>;
  let inferenceHealthRequests: Array<[string, string]>;

  beforeEach(() => {
    sandbox = entry();
    policy = POLICY_A;
    routeOutput = "Gateway Inference:\n\n  Not configured\n";
    readKind = "missing";
    publishedIdentity = null;
    runtimeHealthy = true;
    forwardsHealthy = true;
    observedFingerprint = FINGERPRINT;
    pairingStateSha256 = "d".repeat(64);
    lockEvents = [];
    externalEvents = [];
    observationRequests = [];
    captureRequests = [];
    gatewayHealthRequests = [];
    forwardRequests = [];
    inferenceHealthRequests = [];
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
      listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
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
      gatewayHealth: async (sandboxName, gatewayName) => {
        externalEvents.push("gateway-health");
        gatewayHealthRequests.push([sandboxName, gatewayName]);
        return runtimeHealthy;
      },
      forwardsHealthy: (sandboxName, gatewayName) => {
        externalEvents.push("forward-list");
        forwardRequests.push([sandboxName, gatewayName]);
        return forwardsHealthy;
      },
      smoke: () => ({ ok: true }),
      inferenceProbe: (sandboxName, _agent, gatewayName) => {
        externalEvents.push("inference-health");
        inferenceHealthRequests.push([sandboxName, gatewayName]);
        return { healthy: true, broken: false, httpStatus: 200, detail: "OK 200" };
      },
      observeOpenClawPairingQualification: (
        sandboxName,
        gatewayName,
        openclawVersion,
        stateDirectory,
      ) => {
        externalEvents.push("pairing-qualification");
        expect({ sandboxName, gatewayName, openclawVersion, stateDirectory }).toEqual({
          sandboxName: SANDBOX,
          gatewayName: GATEWAY_NAME,
          openclawVersion: "1.0.0",
          stateDirectory: "/sandbox/.openclaw",
        });
        return {
          schemaVersion: 1,
          kind: "openclaw-pairing",
          openclawVersion,
          deviceIdentitySha256: DIGEST,
          pairingStateSha256,
          requiredRoles: ["operator"],
          requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
        };
      },
      classifyPortableLifecycleReceipt: () => ({ kind: "absent" }),
      readLease: () =>
        readKind === "valid" && publishedIdentity
          ? { kind: "valid", lease: lease(publishedIdentity) }
          : { kind: "missing" },
      fenceLease: () => fence(),
      publishLease: (_name, _gateway, _port, _epoch, identity) => {
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
      "pairing-qualification",
    ]);
    expect(publishedIdentity?.session).toMatchObject({
      kind: "openclaw-pairing",
      openclawVersion: "1.0.0",
      pairingStateSha256,
      requiredRoles: ["operator"],
      requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
    });
  });

  it("fences a concurrent OpenClaw pairing change before launch acceptance (#9023)", async () => {
    const currentDeps = await createAcceptedLease();
    pairingStateSha256 = "e".repeat(64);

    await expect(inspectLaunchReadiness(SANDBOX, currentDeps)).resolves.toMatchObject({
      kind: "fallback",
      category: "session",
      fence: { epochId: EPOCH },
      recoveryBlocked: false,
    });
  });

  it("falls back when the stored OpenClaw identity lacks pairing qualification (#9023)", async () => {
    const currentDeps = await createAcceptedLease();
    expect(publishedIdentity).not.toBeNull();
    publishedIdentity = { ...publishedIdentity!, session: null };

    await expect(inspectLaunchReadiness(SANDBOX, currentDeps)).resolves.toMatchObject({
      kind: "fallback",
      category: "session",
      fence: { epochId: EPOCH },
      recoveryBlocked: false,
    });
  });

  it.each([
    {
      field: "OpenClaw version",
      change: (qualification: LaunchReadinessOpenClawSessionQualification) => ({
        ...qualification,
        openclawVersion: "1.0.1",
      }),
    },
    {
      field: "device identity",
      change: (qualification: LaunchReadinessOpenClawSessionQualification) => ({
        ...qualification,
        deviceIdentitySha256: "2".repeat(64),
      }),
    },
    {
      field: "pairing state",
      change: (qualification: LaunchReadinessOpenClawSessionQualification) => ({
        ...qualification,
        pairingStateSha256: "3".repeat(64),
      }),
    },
  ])("falls back when the OpenClaw $field qualification changes (#9023)", async ({ change }) => {
    const currentDeps = await createAcceptedLease();
    const stored = publishedIdentity?.session;
    expect(stored).toMatchObject({ kind: "openclaw-pairing" });
    const qualification = stored as LaunchReadinessOpenClawSessionQualification;
    currentDeps.observeOpenClawPairingQualification = () => change(qualification);

    await expect(inspectLaunchReadiness(SANDBOX, currentDeps)).resolves.toMatchObject({
      kind: "fallback",
      category: "session",
      fence: { epochId: EPOCH },
      recoveryBlocked: false,
    });
  });

  it.each([
    { scenario: "gateway binding" },
    { scenario: "lifecycle generation" },
    { scenario: "live identity fingerprint" },
  ])(
    "falls back when the OpenClaw gateway or lifecycle binding changes [$scenario] (#9023)",
    async ({ scenario }) => {
      const currentDeps = await createAcceptedLease();
      const stored = publishedIdentity?.session;
      expect(stored).toMatchObject({ kind: "openclaw-pairing" });
      const qualification = stored as LaunchReadinessOpenClawSessionQualification;
      currentDeps.observeOpenClawPairingQualification = () => qualification;
      currentDeps.fenceLease = () => ({
        ...fence(),
        gatewayName: sandbox.gatewayName ?? GATEWAY_NAME,
        gatewayPort: sandbox.gatewayPort ?? GATEWAY_PORT,
      });
      currentDeps.readLease = (_sandboxName, gatewayName) => ({
        kind: gatewayName === GATEWAY_NAME ? "valid" : "identity",
        lease: lease(publishedIdentity!),
      });
      const original = sandbox;

      const { changed, category } = (
        {
          "gateway binding": {
            changed: { ...original, gatewayName: "nemoclaw-8081", gatewayPort: 8081 },
            category: "identity",
          },
          "lifecycle generation": {
            changed: { ...original, lifecycleGeneration: "generation-2" },
            category: "config",
          },
          "live identity fingerprint": {
            changed: { ...original, lifecycleLiveIdentityFingerprint: "5".repeat(64) },
            category: "identity",
          },
        } as const
      )[scenario]!;
      sandbox = changed;
      await expect(inspectLaunchReadiness(SANDBOX, currentDeps)).resolves.toMatchObject({
        kind: "fallback",
        category,
        fence: { epochId: EPOCH },
        recoveryBlocked: false,
      });

      sandbox = original;
    },
  );

  it("uses the complete fallback when current OpenClaw pairing observation fails (#9023)", async () => {
    const currentDeps = await createAcceptedLease();
    currentDeps.observeOpenClawPairingQualification = () => {
      throw new Error("observation failed");
    };

    await expect(inspectLaunchReadiness(SANDBOX, currentDeps)).resolves.toMatchObject({
      kind: "fallback",
      category: "session",
      fence: { epochId: EPOCH },
      recoveryBlocked: false,
    });
  });

  it("uses a fenced CAS epoch when secure authority is available (#8942)", async () => {
    const decision = await inspectLaunchReadiness(SANDBOX, deps());

    expect(decision).toMatchObject({
      kind: "fallback",
      fence: { epochId: EPOCH },
      fenceFailed: false,
      recoveryBlocked: false,
    });
    expect(decision).not.toHaveProperty("authorityUnsupported");
    expect(publicationFromDecision(SANDBOX, decision)).toMatchObject({ epochId: EPOCH });
  });

  it("revalidates the producer epoch under both canonical locks before mutation", async () => {
    const currentDeps = deps();
    const checkMutationAuthority = vi.fn(() => "current" as const);
    currentDeps.checkMutationAuthority = checkMutationAuthority;
    lockEvents = [];

    const result = await withLaunchReadinessMutationGate(
      {
        sandboxName: SANDBOX,
        gatewayName: GATEWAY_NAME,
        gatewayPort: GATEWAY_PORT,
        epochId: EPOCH,
      },
      () => {
        lockEvents.push("mutation");
        return "complete";
      },
      currentDeps,
    );

    expect(result).toEqual({ kind: "entered", value: "complete" });
    expect(checkMutationAuthority).toHaveBeenCalledWith(
      SANDBOX,
      GATEWAY_NAME,
      GATEWAY_PORT,
      EPOCH,
      undefined,
    );
    expect(lockEvents).toEqual([
      "sandbox:start",
      "gateway:start",
      "mutation",
      "gateway:end",
      "sandbox:end",
    ]);
  });

  it("rejects a stale fenced epoch before entering the mutation callback (#8942)", async () => {
    const currentDeps = deps();
    const checkMutationAuthority = vi.fn(() => "changed" as const);
    const mutation = vi.fn();
    currentDeps.checkMutationAuthority = checkMutationAuthority;

    await expect(
      withLaunchReadinessMutationGate(
        {
          sandboxName: SANDBOX,
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
          epochId: EPOCH,
        },
        mutation,
        currentDeps,
      ),
    ).resolves.toEqual({ kind: "changed" });
    expect(checkMutationAuthority).toHaveBeenCalledWith(
      SANDBOX,
      GATEWAY_NAME,
      GATEWAY_PORT,
      EPOCH,
      undefined,
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("delays a later producer's epoch rotation until the current producer releases the mutation locks", async () => {
    const events: string[] = [];
    const sandboxLock = serialTestLock(events, "sandbox");
    const gatewayLock = serialTestLock(events, "gateway");
    const mutationEntered = deferred();
    const releaseMutation = deferred();
    const fenceB = vi.fn(() => {
      events.push("producer-b:rotate");
      return { ...fence(), epochId: "b".repeat(64) };
    });
    const producerA = withLaunchReadinessMutationGate(
      {
        sandboxName: SANDBOX,
        gatewayName: GATEWAY_NAME,
        gatewayPort: GATEWAY_PORT,
        epochId: EPOCH,
      },
      async () => {
        events.push("producer-a:mutation-start");
        mutationEntered.resolve();
        await releaseMutation.promise;
        events.push("producer-a:mutation-end");
      },
      {
        ...deps(),
        checkMutationAuthority: () => "current",
        withSandboxLock: sandboxLock,
        withGatewayLock: gatewayLock,
      },
    );
    await mutationEntered.promise;

    const producerB = inspectLaunchReadiness(SANDBOX, {
      ...deps(),
      readLease: () => ({ kind: "missing" }),
      fenceLease: fenceB,
      withSandboxLock: sandboxLock,
      withGatewayLock: gatewayLock,
    });
    await Promise.resolve();
    expect(fenceB).not.toHaveBeenCalled();

    releaseMutation.resolve();
    await expect(producerA).resolves.toMatchObject({ kind: "entered" });
    await expect(producerB).resolves.toMatchObject({
      kind: "fallback",
      fence: { epochId: "b".repeat(64) },
    });
    expect(events.indexOf("producer-a:mutation-end")).toBeLessThan(
      events.indexOf("producer-b:rotate"),
    );
  });

  it("distinguishes blocking authority failures from evidence-free storage failure", async () => {
    const blockedDeps = deps();
    blockedDeps.fenceLease = () => {
      throw new LaunchReadinessFenceError(true, false);
    };
    await expect(inspectLaunchReadiness(SANDBOX, blockedDeps)).resolves.toMatchObject({
      kind: "fallback",
      fenceFailed: true,
      recoveryBlocked: true,
    });

    const unavailableDeps = deps();
    unavailableDeps.fenceLease = () => {
      throw new LaunchReadinessFenceError(false, false);
    };
    await expect(inspectLaunchReadiness(SANDBOX, unavailableDeps)).resolves.toMatchObject({
      kind: "fallback",
      fenceFailed: true,
      recoveryBlocked: false,
    });
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

  it.each([
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
  ])("fences live identity and health changes before fallback [case %#]", async (testCase) => {
    const currentDeps = await createAcceptedLease();

    testCase.mutate();
    const decision = await inspectLaunchReadiness(SANDBOX, currentDeps);
    expect(decision).toMatchObject({
      kind: "fallback",
      category: testCase.category,
      fence: { epochId: EPOCH },
      fenceFailed: false,
    });
    testCase.restore();
  });

  it("accepts an externally changed valid OpenShell policy without shadow identity state", async () => {
    const currentDeps = await createAcceptedLease();
    policy = POLICY_B;

    await expect(inspectLaunchReadiness(SANDBOX, currentDeps)).resolves.toMatchObject({
      kind: "accepted",
    });
  });

  it("requires exact owning-gateway policy, inference route, and semantic health", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-sibling");
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
      "pairing-qualification",
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
    expect(gatewayHealthRequests).toContainEqual([SANDBOX, GATEWAY_NAME]);
    expect(forwardRequests).toContainEqual([SANDBOX, GATEWAY_NAME]);
    expect(inferenceHealthRequests).toContainEqual([SANDBOX, GATEWAY_NAME]);
    expect(process.env.OPENSHELL_GATEWAY).toBe("ambient-sibling");
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

  it.each([300, 401, 403, 404, 503])(
    "rejects HTTP %i from the owning OpenShell gateway inference probe during inspection and publication (#8942)",
    async (httpStatus) => {
      sandbox = {
        ...sandbox,
        provider: "nvidia",
        model: "model-a",
        credentialEnv: "NVIDIA_API_KEY",
      };
      routeOutput = "Gateway Inference:\n\n  Provider: nvidia\n  Model: model-a\n";
      const currentDeps = await createAcceptedLease();
      currentDeps.inferenceProbe = vi.fn((_sandboxName, _agent, _gatewayName) => ({
        healthy: httpStatus < 500,
        broken: httpStatus >= 500,
        httpStatus,
        detail: `${httpStatus < 500 ? "OK" : "BROKEN"} ${httpStatus}`,
      }));

      await expect(inspectLaunchReadiness(SANDBOX, currentDeps)).resolves.toMatchObject({
        kind: "fallback",
        category: "health",
      });
      await expect(
        publishLaunchReadiness(
          {
            sandboxName: SANDBOX,
            gatewayName: GATEWAY_NAME,
            gatewayPort: GATEWAY_PORT,
            epochId: EPOCH,
          },
          currentDeps,
        ),
      ).resolves.toEqual({ kind: "validation-failed", category: "health" });
      expect(currentDeps.inferenceProbe).toHaveBeenCalledWith(
        SANDBOX,
        expect.objectContaining({ name: "openclaw" }),
        GATEWAY_NAME,
      );
    },
  );

  it("accepts strict HTTP 2xx inference evidence from the owning OpenShell gateway (#8942)", async () => {
    sandbox = {
      ...sandbox,
      provider: "nvidia",
      model: "model-a",
      credentialEnv: "NVIDIA_API_KEY",
    };
    routeOutput = "Gateway Inference:\n\n  Provider: nvidia\n  Model: model-a\n";
    const currentDeps = await createAcceptedLease();
    currentDeps.inferenceProbe = vi.fn((_sandboxName, _agent, gatewayName) => ({
      healthy: true,
      broken: false,
      httpStatus: 299,
      detail: "OK 299",
    }));

    await expect(inspectLaunchReadiness(SANDBOX, currentDeps)).resolves.toMatchObject({
      kind: "accepted",
      category: "accepted",
    });
    await expect(
      publishLaunchReadiness(
        {
          sandboxName: SANDBOX,
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
          epochId: EPOCH,
        },
        currentDeps,
      ),
    ).resolves.toEqual({ kind: "published" });
    expect(currentDeps.inferenceProbe).toHaveBeenCalledWith(
      SANDBOX,
      expect.objectContaining({ name: "openclaw" }),
      GATEWAY_NAME,
    );
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
    externalEvents = [];
    expect(await inspectLaunchReadiness(SANDBOX, currentDeps)).toMatchObject({ kind: "accepted" });
    expect(smoke).toHaveBeenCalledWith(
      SANDBOX,
      expect.objectContaining({ name: "langchain-deepagents-code" }),
      expect.any(Function),
      GATEWAY_NAME,
    );
    expect(gatewayHealth).not.toHaveBeenCalled();
    expect(externalEvents).not.toContain("pairing-qualification");
    expect(publishedIdentity?.session).toBeNull();
  });

  it("uses ordinary terminal smoke health for feature-gated NemoCUA (#9649)", async () => {
    sandbox = entry(" nemocua ");
    const currentDeps = deps();
    const gatewayHealth = vi.fn(async () => true);
    const smoke = vi.fn(() => ({ ok: true }) as const);
    const cuaAgent = {
      ...loadAgent("hermes"),
      name: "nemocua",
      runtime: {
        kind: "terminal" as const,
        interactive_command: "/bin/bash",
        headless_command: "python3 /app/run_with_harness.py",
      },
    };
    currentDeps.listAgents = () => ["nemocua"];
    currentDeps.loadAgent = () => cuaAgent;
    currentDeps.gatewayHealth = gatewayHealth;
    currentDeps.smoke = smoke;

    await createAcceptedLease(currentDeps);
    expect(await inspectLaunchReadiness(SANDBOX, currentDeps)).toMatchObject({ kind: "accepted" });
    expect(smoke).toHaveBeenCalled();
    expect(gatewayHealth).not.toHaveBeenCalled();
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
        "dashboardPort",
        "dashboardRemoteBindPrepared",
        "dcodeAutoApprovalMode",
        "fromDockerfile",
        "gatewayName",
        "gatewayPort",
        "gpuEnabled",
        "hermesAuthMethod",
        "hermesDashboardEnabled",
        "hermesDashboardInternalPort",
        "hermesDashboardPort",
        "hermesDashboardTui",
        "hermesInferenceProvider",
        "hermesToolGateways",
        "hostGpuDetected",
        "hostMounts",
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
        "sandboxGpuDevice",
        "sandboxGpuEnabled",
        "sandboxGpuMode",
        "sandboxGpuProof",
        "servingProfileProvenance",
        "toolDisclosure",
        "version",
        "webSearchEnabled",
        "webSearchProvider",
        "workloadIdentitySha256",
      ].sort(),
    );
    expect(projection.version).toBe(2);
    expect(projection.portableLifecycleReceipt).toBeUndefined();
    expect(
      launchReadinessDigest(buildLaunchReadinessRegistryProjection(sandbox, agent, DIGEST)),
    ).not.toBe(launchReadinessDigest(projection));
    const original = launchReadinessDigest(projection);
    const mutations: SandboxEntry[] = [
      { ...sandbox, agentVersion: "1.0.1" },
      { ...sandbox, nemoclawVersion: "changed" },
      {
        ...sandbox,
        hostMounts: [
          {
            source: "/private/host/project",
            target: "/sandbox/project",
            readOnly: true,
            sourceIdentity: { device: "1", inode: "2" },
          },
        ],
      },
      { ...sandbox, gpuEnabled: true },
      { ...sandbox, hostGpuDetected: true },
      { ...sandbox, sandboxGpuEnabled: true },
      { ...sandbox, sandboxGpuMode: "1" },
      { ...sandbox, sandboxGpuDevice: "0" },
      { ...sandbox, servingProfileProvenance: servingProfile() },
      { ...sandbox, hermesAuthMethod: "oauth" },
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
    expect(
      mutations.every(
        (mutation) =>
          !Object.is(
            launchReadinessDigest(buildLaunchReadinessRegistryProjection(mutation, agent)),
            original,
          ),
      ),
    ).toBe(true);
  });

  it("binds current Portable lifecycle state into final readiness publication (#9207)", async () => {
    const currentDeps = deps();
    const runtimeAuthority = {
      schemaVersion: 1 as const,
      kind: "podman" as const,
      ownership: "current-user" as const,
      uid: 1001,
      homeDir: "/home/operator",
      configHome: "/home/operator/.config",
      runtimeDir: "/run/user/1001",
      socketPath: "/run/user/1001/podman/podman.sock",
    };
    currentDeps.classifyPortableLifecycleReceipt = () => ({
      kind: "current",
      registryGeneration: "generation-1",
      runtimeAuthority,
    });
    const decision = await inspectLaunchReadiness(SANDBOX, currentDeps);

    expect(decision.kind).toBe("fallback");
    await expect(
      publishLaunchReadiness(publicationFromDecision(SANDBOX, decision), currentDeps),
    ).resolves.toEqual({ kind: "published" });
    expect(publishedIdentity?.registry).toBe(
      launchReadinessDigest(
        buildLaunchReadinessRegistryProjection(
          sandbox,
          loadAgent("openclaw"),
          launchReadinessDigest(runtimeAuthority),
        ),
      ),
    );
  });

  it("invalidates a Portable OpenClaw lease when runtime authority changes (#9207)", async () => {
    let socketPath = "/run/user/1001/podman/podman.sock";
    const currentDeps = deps();
    currentDeps.classifyPortableLifecycleReceipt = () => ({
      kind: "current",
      registryGeneration: "generation-1",
      runtimeAuthority: {
        schemaVersion: 1,
        kind: "podman",
        ownership: "current-user",
        uid: 1001,
        homeDir: "/home/operator",
        configHome: "/home/operator/.config",
        runtimeDir: "/run/user/1001",
        socketPath,
      },
    });
    await createAcceptedLease(currentDeps);

    socketPath = "/run/user/1001/podman/changed.sock";

    await expect(inspectLaunchReadiness(SANDBOX, currentDeps)).resolves.toMatchObject({
      kind: "fallback",
      category: "config",
    });
  });

  it("keeps Portable Hermes outside the receipt digest and pairing observer (#9207)", async () => {
    sandbox = { ...sandbox, agent: "hermes" };
    const currentDeps = deps();
    currentDeps.classifyPortableLifecycleReceipt = () => ({
      kind: "current",
      registryGeneration: "generation-1",
      runtimeAuthority: {
        schemaVersion: 1,
        kind: "podman",
        ownership: "current-user",
        uid: 1001,
        homeDir: "/home/operator",
        configHome: "/home/operator/.config",
        runtimeDir: "/run/user/1001",
        socketPath: "/run/user/1001/podman/podman.sock",
      },
    });
    const decision = await inspectLaunchReadiness(SANDBOX, currentDeps);

    await expect(
      publishLaunchReadiness(publicationFromDecision(SANDBOX, decision), currentDeps),
    ).resolves.toEqual({ kind: "published" });
    expect(publishedIdentity?.registry).toBe(
      launchReadinessDigest(buildLaunchReadinessRegistryProjection(sandbox, loadAgent("hermes"))),
    );
    expect(externalEvents).not.toContain("pairing-qualification");
  });

  it("fails closed when a Portable receipt has no explicit registry agent (#9207)", async () => {
    sandbox = { ...sandbox, agent: undefined };
    const currentDeps = deps();
    currentDeps.classifyPortableLifecycleReceipt = () => ({
      kind: "current",
      registryGeneration: "generation-1",
      runtimeAuthority: {
        schemaVersion: 1,
        kind: "podman",
        ownership: "current-user",
        uid: 1001,
        homeDir: "/home/operator",
        configHome: "/home/operator/.config",
        runtimeDir: "/run/user/1001",
        socketPath: "/run/user/1001/podman/podman.sock",
      },
    });

    const publishLease = vi.fn();
    currentDeps.publishLease = publishLease;
    const decision = await inspectLaunchReadiness(SANDBOX, currentDeps);

    await expect(
      publishLaunchReadiness(publicationFromDecision(SANDBOX, decision), currentDeps),
    ).resolves.toEqual({ kind: "validation-failed", category: "config" });
    expect(publishLease).not.toHaveBeenCalled();
  });

  it("binds every host mount field without projecting the host source path (#8942)", () => {
    const agent = loadAgent("openclaw");
    const source = "/private/host/customer-project";
    const mounted: SandboxEntry = {
      ...sandbox,
      hostMounts: [
        {
          source,
          target: "/sandbox/project",
          readOnly: true,
          sourceIdentity: { device: "11", inode: "22" },
        },
      ],
    };
    const projection = buildLaunchReadinessRegistryProjection(mounted, agent) as {
      hostMounts: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(projection)).not.toContain(source);
    expect(projection.hostMounts).toEqual([
      {
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        target: "/sandbox/project",
        readOnly: true,
        sourceIdentity: { device: "11", inode: "22" },
      },
    ]);

    const original = launchReadinessDigest(projection);
    const mutations: SandboxEntry[] = [
      {
        ...mounted,
        hostMounts: [{ ...mounted.hostMounts![0]!, source: `${source}-changed` }],
      },
      {
        ...mounted,
        hostMounts: [{ ...mounted.hostMounts![0]!, target: "/sandbox/changed" }],
      },
      {
        ...mounted,
        hostMounts: [
          {
            ...mounted.hostMounts![0]!,
            sourceIdentity: { device: "12", inode: "22" },
          },
        ],
      },
      {
        ...mounted,
        hostMounts: [
          {
            ...mounted.hostMounts![0]!,
            sourceIdentity: { device: "11", inode: "23" },
          },
        ],
      },
    ];
    expect(
      mutations.every(
        (mutation) =>
          !Object.is(
            launchReadinessDigest(buildLaunchReadinessRegistryProjection(mutation, agent)),
            original,
          ),
      ),
    ).toBe(true);
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        {
          ...mounted,
          hostMounts: [{ ...mounted.hostMounts![0]!, readOnly: false as true }],
        },
        agent,
      ),
    ).toThrow();
  });

  it("binds every semantic serving profile provenance field (#8942)", () => {
    const agent = loadAgent("openclaw");
    const originalProfile = servingProfile();
    const original = launchReadinessDigest(
      buildLaunchReadinessRegistryProjection(
        { ...sandbox, servingProfileProvenance: originalProfile },
        agent,
      ),
    );
    const mutations: NonNullable<SandboxEntry["servingProfileProvenance"]>[] = [
      { ...originalProfile, catalogDigest: `sha256:${"a".repeat(64)}` },
      { ...originalProfile, preset: { ...originalProfile.preset, id: "changed" } },
      {
        ...originalProfile,
        preset: { ...originalProfile.preset, digest: `sha256:${"a".repeat(64)}` },
      },
      { ...originalProfile, preset: { ...originalProfile.preset, displayName: "Changed" } },
      {
        ...originalProfile,
        preset: { ...originalProfile.preset, supportState: "experimental" },
      },
      { ...originalProfile, recipe: { ...originalProfile.recipe, id: "changed" } },
      {
        ...originalProfile,
        recipe: { ...originalProfile.recipe, digest: `sha256:${"a".repeat(64)}` },
      },
      { ...originalProfile, recipe: { ...originalProfile.recipe, backend: "changed" } },
      { ...originalProfile, model: { ...originalProfile.model, id: "changed" } },
      { ...originalProfile, model: { ...originalProfile.model, revision: "changed" } },
      { ...originalProfile, runtimeImage: "example.com/changed@sha256:immutable" },
      { ...originalProfile, estimatedImageDownloadBytes: 1_001 },
      { ...originalProfile, estimatedModelDownloadBytes: 2_001 },
    ];
    expect(
      mutations.every(
        (mutation) =>
          !Object.is(
            launchReadinessDigest(
              buildLaunchReadinessRegistryProjection(
                { ...sandbox, servingProfileProvenance: mutation },
                agent,
              ),
            ),
            original,
          ),
      ),
    ).toBe(true);
  });

  it("excludes diagnostic timestamps, source paths, and GPU detail from the projection", () => {
    const agent = loadAgent("openclaw");
    const first: SandboxEntry = {
      ...sandbox,
      createdAt: "2026-01-01T00:00:00.000Z",
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

    const pairingObservationUnavailable = deps();
    pairingObservationUnavailable.observeOpenClawPairingQualification = () => {
      throw new Error("pairing observation unavailable");
    };
    expect(await publishLaunchReadiness(publication, pairingObservationUnavailable)).toEqual({
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

  it("never validates or publishes evidence without a fenced epoch (#8942)", async () => {
    const currentDeps = deps();
    const publishLease = vi.fn();
    currentDeps.publishLease = publishLease;

    await expect(
      publishLaunchReadiness(
        {
          sandboxName: SANDBOX,
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
          epochId: null,
        },
        currentDeps,
      ),
    ).resolves.toEqual({ kind: "evidence-failed" });
    expect(publishLease).not.toHaveBeenCalled();
  });

  it("rejects in-progress lifecycle and policy mutations", () => {
    const agent = loadAgent("openclaw");
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        { ...sandbox, pendingRouteReservation: true, reservationSessionId: "session" },
        agent,
      ),
    ).toThrow();
  });
});
