// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerEngineCommandCapture } from "../../adapters/container-engine";
import type { SandboxEntry } from "../../state/registry/types";
import { RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION } from "./contract";
import { createDockerOperationAuthority } from "./docker-operation-authority";
import {
  createDockerStateMutationOwner,
  createDockerStateMutationSurface,
} from "./docker-state-mutation";
import { createFilePersistedEngineAuthorityStore } from "./persisted-engine-authority";
import {
  createFilePersistedEngineLifecycleStore,
  PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
  PERSISTED_ENGINE_STATE_MUTATION_INTENT_FILE,
} from "./persisted-engine-lifecycle";
import { prepareRuntimeProviderStateMutationPlan } from "./state-mutation";

const RUNTIME_ID = "a".repeat(64);
const PROJECTION_SHA256 = "b".repeat(64);
const STATE_ROOT = "/sandbox/.hermes";
const LIFECYCLE_GENERATION = "generation-7";
const SANDBOX_ID = "sandbox-alpha-id";
const SANDBOX_FINGERPRINT = createHash("sha256").update(SANDBOX_ID).digest("hex");
const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-state-mutation-"));
  roots.push(root);
  return root;
}

function persistedIntentPath(root: string, transactionId: string): string {
  return path.join(
    root,
    PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
    transactionId,
    PERSISTED_ENGINE_STATE_MUTATION_INTENT_FILE,
  );
}

function persistedRuntimeClaimPath(root: string): string {
  const identity = createHash("sha256")
    .update("docker", "utf8")
    .update("\0", "utf8")
    .update(RUNTIME_ID, "utf8")
    .digest("hex");
  return path.join(root, PERSISTED_ENGINE_LIFECYCLE_DIRECTORY, "runtime-target-claims", identity);
}

function plan() {
  return prepareRuntimeProviderStateMutationPlan({
    schemaVersion: RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION,
    intent: "protection-transition",
    target: "mutable",
    rollback: "locked",
    stateRoot: STATE_ROOT,
    selectors: [{ kind: "path", path: "config.yaml" }],
    stateLockPlan: {
      version: 1,
      readOnlyRoots: ["config.yaml"],
      confidentialRoots: [],
      readOnlyPrefixes: [],
      confidentialPrefixes: [],
      writableSubpaths: [],
    },
    projectionSha256: PROJECTION_SHA256,
  });
}

interface HarnessOptions {
  readonly mutateReceipt?: (
    receipt: Readonly<Record<string, unknown>>,
    action: string,
  ) => Readonly<Record<string, unknown>>;
  readonly afterHelper?: (action: string, state: HarnessState) => void;
  readonly deferAcquireOnce?: boolean;
  readonly failAcquire?: boolean;
  readonly failReleaseOnce?: boolean;
  readonly lifecycleGeneration?: string;
  readonly loseAcquireResponseOnce?: boolean;
  readonly loseReleaseResponseOnce?: boolean;
}

interface HarnessState {
  runtimePid: number;
  mountSource: string;
  sandboxId: string;
  pidMode: string;
  privileged: boolean;
  overlayProc: boolean;
}

function harness(options: HarnessOptions = {}) {
  const lifecycleGeneration = options.lifecycleGeneration ?? LIFECYCLE_GENERATION;
  const state: HarnessState = {
    runtimePid: 4812,
    mountSource: "/var/lib/openshell/alpha/hermes",
    sandboxId: SANDBOX_ID,
    pidMode: "",
    privileged: false,
    overlayProc: false,
  };
  const helperActions: string[] = [];
  const acquireRequests: string[] = [];
  let acquireDeferralsRemaining = options.deferAcquireOnce ? 1 : 0;
  let lostAcquireResponsesRemaining = options.loseAcquireResponseOnce ? 1 : 0;
  let releaseFailuresRemaining = options.failReleaseOnce ? 1 : 0;
  let lostReleaseResponsesRemaining = options.loseReleaseResponseOnce ? 1 : 0;
  let marker: Record<string, unknown> | null = null;
  let releasedMarker: Record<string, unknown> | null = null;
  let deferredAcquireRequest: string | null = null;

  const acquireMarker = (request: Record<string, unknown>) => {
    const candidate = {
      schemaVersion: 1,
      phase: "fenced",
      transactionId: request.transactionId,
      providerId: request.providerId,
      sandboxName: request.sandboxName,
      lifecycleGeneration: request.lifecycleGeneration,
      engineBindingSha256: request.engineBindingSha256,
      runtimeId: request.runtimeId,
      runtimePid: request.runtimePid,
      sandboxIdentitySha256: request.sandboxIdentitySha256,
      containerMountsSha256: request.containerMountsSha256,
      stateRoot: request.stateRoot,
      stateRootMountsSha256: request.stateRootMountsSha256,
      mountNamespace: "mnt:[4026533007]",
      stateRootDevice: "2050",
      stateRootInode: "94212",
      planSha256: request.planSha256,
      projectionSha256: request.projectionSha256,
      nonce: request.nonce,
      target: request.target,
      rollback: request.rollback,
    };
    if (marker !== null && JSON.stringify(marker) !== JSON.stringify(candidate)) {
      return { status: 1, stdout: "", stderr: "conflicting acquire request" };
    }
    marker = candidate;
    return null;
  };

  const capture = vi.fn<ContainerEngineCommandCapture>((_executable, args, _timeout, input) => {
    const command = args.slice(4);
    if (command[0] === "ps") {
      return { status: 0, stdout: `${RUNTIME_ID}\n`, stderr: "" };
    }
    if (command[0] === "container" && command[1] === "inspect") {
      return {
        status: 0,
        stdout: JSON.stringify([
          RUNTIME_ID,
          true,
          "running",
          false,
          false,
          false,
          state.runtimePid,
          "openshell",
          "alpha",
          state.sandboxId,
          state.pidMode,
          state.privileged,
          [
            {
              Type: "bind",
              Source: state.mountSource,
              Destination: STATE_ROOT,
              Mode: "",
              RW: true,
              Propagation: "rprivate",
            },
            {
              Type: "bind",
              Source: "/var/lib/openshell/alpha/cache",
              Destination: `${STATE_ROOT}/cache`,
              Mode: "",
              RW: true,
              Propagation: "rprivate",
            },
            ...(state.overlayProc
              ? [
                  {
                    Type: "bind",
                    Source: "/proc",
                    Destination: "/proc",
                    Mode: "",
                    RW: true,
                    Propagation: "rprivate",
                  },
                ]
              : []),
          ],
        ]),
        stderr: "",
      };
    }
    if (command[0] !== "container" || command[1] !== "exec") {
      return { status: 1, stdout: "", stderr: "unexpected command" };
    }
    const action = command.at(-1) ?? "";
    helperActions.push(action);
    const serializedRequest = input?.toString("utf8") ?? "null";
    const request = JSON.parse(serializedRequest) as Record<string, unknown>;
    if (action === "acquire") {
      acquireRequests.push(serializedRequest);
      if (options.failAcquire) {
        return { status: 1, stdout: "", stderr: "helper marker unavailable" };
      }
      if (acquireDeferralsRemaining > 0) {
        acquireDeferralsRemaining -= 1;
        deferredAcquireRequest = serializedRequest;
        return { status: 1, stdout: "", stderr: "in-container acquire is still queued" };
      }
      const conflict = acquireMarker(request);
      if (conflict) return conflict;
    } else if (!marker) {
      if (releasedMarker && (action === "recover" || action === "release")) {
        marker = releasedMarker;
      } else {
        return { status: 1, stdout: "", stderr: "no durable marker" };
      }
    } else if (request.providerHandle !== undefined && action !== "recover") {
      const active: Record<string, unknown> = { ...marker, phase: "fenced" };
      delete active.configurationGeneration;
      delete active.listenerIdentity;
      delete active.healthSha256;
      delete active.activationProviderHandle;
      const expected = `docker-state-mutation-v1:${String(marker.transactionId)}:${createHash("sha256").update(JSON.stringify(active), "utf8").digest("hex")}`;
      if (request.providerHandle !== expected) {
        return { status: 1, stdout: "", stderr: "provider handle mismatch" };
      }
    }
    const activeMarker = marker as Record<string, unknown>;
    if (action === "publish") {
      marker = { ...activeMarker, phase: "published" };
    } else if (action === "rollback") {
      marker = { ...activeMarker, phase: "rolled-back" };
    } else if (action === "activate") {
      const configurationGeneration = "config-generation-8";
      const listenerIdentity = "tcp:18789";
      const healthSha256 = "c".repeat(64);
      const evidence = {
        schemaVersion: 1,
        providerId: activeMarker.providerId,
        sandboxName: activeMarker.sandboxName,
        lifecycleGeneration: activeMarker.lifecycleGeneration,
        runtimeId: activeMarker.runtimeId,
        nonce: activeMarker.nonce,
        configurationGeneration,
        listenerIdentity,
        healthSha256,
        fenceProviderHandle: request.providerHandle,
      };
      marker = {
        ...activeMarker,
        phase: "activation-proven",
        configurationGeneration,
        listenerIdentity,
        healthSha256,
        activationProviderHandle: `docker-state-mutation-activation-v1:${String(
          activeMarker.transactionId,
        )}:${createHash("sha256").update(JSON.stringify(evidence), "utf8").digest("hex")}`,
      };
    } else if (action === "release") {
      if (releaseFailuresRemaining > 0) {
        releaseFailuresRemaining -= 1;
        return { status: 1, stdout: "", stderr: "release unavailable" };
      }
      if (request.activationProviderHandle !== activeMarker.activationProviderHandle) {
        return { status: 1, stdout: "", stderr: "activation handle mismatch" };
      }
    }
    const response = options.mutateReceipt?.(marker as Record<string, unknown>, action) ?? marker;
    options.afterHelper?.(action, state);
    if (action === "acquire" && lostAcquireResponsesRemaining > 0) {
      lostAcquireResponsesRemaining -= 1;
      return { status: 1, stdout: "", stderr: "acquire response lost" };
    }
    if (action === "release") {
      releasedMarker = marker;
      marker = null;
      if (lostReleaseResponsesRemaining > 0) {
        lostReleaseResponsesRemaining -= 1;
        return { status: 1, stdout: "", stderr: "release response lost" };
      }
    } else if (releasedMarker === marker) {
      marker = null;
    }
    return { status: 0, stdout: `${JSON.stringify(response)}\n`, stderr: "" };
  });
  const root = temporaryRoot();
  const authority = createDockerOperationAuthority(
    "sandbox-lifecycle",
    {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_CONFIG: "/tmp/nemoclaw-docker",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
    },
    capture,
  );
  const engineAuthorityStore = createFilePersistedEngineAuthorityStore(root);
  const lifecycleStore = createFilePersistedEngineLifecycleStore(root);
  const owner = createDockerStateMutationOwner({
    sandboxName: "alpha",
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: SANDBOX_FINGERPRINT,
    runtimeId: RUNTIME_ID,
    authority,
    engineAuthorityStore,
    lifecycleStore,
  });
  const sandbox: SandboxEntry = {
    name: "alpha",
    openshellDriver: "docker",
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: SANDBOX_FINGERPRINT,
  };
  const context = {
    environment: {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_CONFIG: "/tmp/nemoclaw-docker",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
    },
    sandbox,
    sandboxName: "alpha",
  };
  const replayDeferredAcquire = () => {
    if (deferredAcquireRequest === null) throw new Error("No deferred acquire request exists.");
    const serializedRequest = deferredAcquireRequest;
    deferredAcquireRequest = null;
    helperActions.push("acquire");
    acquireRequests.push(serializedRequest);
    const request = JSON.parse(serializedRequest) as Record<string, unknown>;
    const conflict = acquireMarker(request);
    if (conflict) throw new Error(conflict.stderr);
    return marker;
  };
  return {
    acquireRequests,
    authority,
    capture,
    context,
    engineAuthorityStore,
    helperActions,
    lifecycleStore,
    lifecycleGeneration,
    owner,
    replayDeferredAcquire,
    root,
    state,
  };
}

function ownerThatStopsAfterPrepare(runtime: ReturnType<typeof harness>) {
  const acquireMutationExecution = vi.fn(() => {
    throw new Error("injected controller exit before helper invocation");
  });
  return {
    acquireMutationExecution,
    owner: createDockerStateMutationOwner({
      sandboxName: runtime.context.sandboxName,
      lifecycleGeneration: runtime.lifecycleGeneration,
      lifecycleLiveIdentityFingerprint: SANDBOX_FINGERPRINT,
      runtimeId: RUNTIME_ID,
      authority: runtime.authority,
      engineAuthorityStore: runtime.engineAuthorityStore,
      lifecycleStore: {
        ...runtime.lifecycleStore,
        acquireMutationExecution,
      },
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("Docker runtime-provider state mutation surface", () => {
  it("resolves one full labeled runtime and records authority only on synchronous acquire", () => {
    const runtime = harness();
    const surface = createDockerStateMutationSurface({
      capture: runtime.capture,
      resolveStateDir: () => runtime.root,
    });

    expect(runtime.engineAuthorityStore.load("sandbox-lifecycle")).toBeNull();
    const fence = surface.acquire({ ...runtime.context, plan: plan() });

    expect(fence.runtimeId).toBe(RUNTIME_ID);
    expect(fence).not.toBeInstanceOf(Promise);
    expect(runtime.engineAuthorityStore.load("sandbox-lifecycle")).toMatchObject({
      providerId: "docker",
      operation: "sandbox-lifecycle",
      engineId: "docker",
    });
    expect(runtime.capture.mock.calls[0]?.[1]).toEqual([
      "--config",
      "/tmp/nemoclaw-docker",
      "--host",
      "unix:///tmp/nemoclaw-docker.sock",
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      "label=openshell.ai/sandbox-name=alpha",
      "--format",
      "{{.ID}}",
    ]);
  });

  it("returns null before first acquire without Docker or engine-authority access", () => {
    const runtime = harness();
    const exclusionCalls: Array<readonly [string, string]> = [];
    const exclusion = <T>(sandbox: string, operation: string, run: () => T): T => {
      exclusionCalls.push([sandbox, operation]);
      return run();
    };
    const surface = createDockerStateMutationSurface({
      capture: runtime.capture,
      resolveStateDir: () => runtime.root,
      withDirectSandboxExecutionExclusion: exclusion,
    });

    expect(surface.recover(runtime.context)).toBeNull();
    expect(runtime.engineAuthorityStore.load("sandbox-lifecycle")).toBeNull();
    expect(runtime.capture).not.toHaveBeenCalled();
    expect(exclusionCalls).toEqual([["alpha", "Docker runtime-provider state mutation recovery"]]);
  });

  it("preserves the isolated Vitest state root from the operation environment", () => {
    const runtime = harness();
    const surface = createDockerStateMutationSurface({ capture: runtime.capture });
    const context = {
      ...runtime.context,
      environment: {
        ...runtime.context.environment,
        VITEST: "true",
        NEMOCLAW_TEST_BASE_HOME: runtime.context.environment.HOME,
        NEMOCLAW_TEST_STATE_DIR: runtime.root,
      },
    };

    surface.acquire({ ...context, plan: plan() });

    expect(runtime.engineAuthorityStore.load("sandbox-lifecycle")).toMatchObject({
      providerId: "docker",
      operation: "sandbox-lifecycle",
    });
  });

  it("rejects a second same-sandbox mutation before another runtime lookup", () => {
    const runtime = harness();
    const exclusionCalls: Array<readonly [string, string]> = [];
    const exclusion = <T>(sandbox: string, operation: string, run: () => T): T => {
      exclusionCalls.push([sandbox, operation]);
      return run();
    };
    const surface = createDockerStateMutationSurface({
      capture: runtime.capture,
      resolveStateDir: () => runtime.root,
      withDirectSandboxExecutionExclusion: exclusion,
    });
    surface.acquire({ ...runtime.context, plan: plan() });
    const callsBeforeCompetingAcquire = runtime.capture.mock.calls.length;

    expect(() => surface.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "already has one unfinished state mutation",
    );
    expect(runtime.capture).toHaveBeenCalledTimes(callsBeforeCompetingAcquire);
    expect(exclusionCalls).toEqual([
      ["alpha", "Docker runtime-provider state mutation acquire"],
      ["alpha", "Docker runtime-provider state mutation acquire"],
    ]);
  });

  it("proves a repeated successful release from its tombstone without Docker access", () => {
    const runtime = harness();
    const surface = createDockerStateMutationSurface({
      capture: runtime.capture,
      resolveStateDir: () => runtime.root,
    });
    const fence = surface.acquire({ ...runtime.context, plan: plan() });
    surface.rollback(runtime.context, fence);
    const proof = surface.activate(runtime.context, fence);
    const completedLedgerSha256 = "e".repeat(64);
    surface.release(runtime.context, fence, proof, completedLedgerSha256);
    const callsAfterRelease = runtime.capture.mock.calls.length;

    runtime.capture.mockImplementation(() => ({
      status: 1,
      stdout: "",
      stderr: "Docker is unavailable",
    }));
    expect(() =>
      surface.release(runtime.context, fence, proof, completedLedgerSha256),
    ).not.toThrow();
    expect(runtime.capture).toHaveBeenCalledTimes(callsAfterRelease);
  });

  it("requires preexisting persisted authority before resolving a later-phase runtime", () => {
    const runtime = harness();
    const surface = createDockerStateMutationSurface({
      capture: runtime.capture,
      resolveStateDir: () => runtime.root,
    });

    expect(() => surface.assertFenced(runtime.context, null as never)).toThrow(
      "persisted sandbox-lifecycle engine authority is missing",
    );
    expect(runtime.capture).not.toHaveBeenCalled();
  });

  it("rejects ambiguous labeled runtime resolution before recording authority", () => {
    const runtime = harness();
    const ambiguous = vi.fn<ContainerEngineCommandCapture>((executable, args, timeout, input) => {
      if (args.slice(4)[0] === "ps") {
        return { status: 0, stdout: `${RUNTIME_ID}\n${"c".repeat(64)}\n`, stderr: "" };
      }
      return runtime.capture(executable, args, timeout, input);
    });
    const surface = createDockerStateMutationSurface({
      capture: ambiguous,
      resolveStateDir: () => runtime.root,
    });

    expect(() => surface.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "requires one exact full container identity",
    );
    expect(runtime.engineAuthorityStore.load("sandbox-lifecycle")).toBeNull();
    expect(runtime.helperActions).toEqual([]);
  });
});

describe("Docker state mutation owner", () => {
  it("uses the exact shared lifecycle-generation wire grammar", () => {
    const plus = harness({ lifecycleGeneration: "generation+7" });
    expect(plus.owner.acquire({ ...plus.context, plan: plan() })).toMatchObject({
      lifecycleGeneration: "generation+7",
    });

    expect(() => harness({ lifecycleGeneration: ":generation" })).toThrow(
      "lifecycle generation is malformed",
    );
  });

  it("keeps the exact Docker fence active through rollback, activation, and release", async () => {
    const runtime = harness();

    const fence = await runtime.owner.acquire({ ...runtime.context, plan: plan() });

    expect(fence).toMatchObject({
      intent: "protection-transition",
      phase: "fenced",
      providerId: "docker",
      sandboxName: "alpha",
      transactionId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      lifecycleGeneration: LIFECYCLE_GENERATION,
      runtimeId: RUNTIME_ID,
      runtimeStateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      engineBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      stateRoot: STATE_ROOT,
      mountNamespaceId: "mnt:[4026533007]",
      stateRootDevice: "2050",
      stateRootInode: "94212",
      projectionSha256: PROJECTION_SHA256,
      target: "mutable",
      rollback: "locked",
      nonce: expect.stringMatching(/^[a-f0-9]{64}$/u),
      providerHandle: expect.stringMatching(/^docker-state-mutation-v1:/u),
    });
    expect(runtime.lifecycleStore.listUnfinished()).toHaveLength(1);
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("fence-established");

    await runtime.owner.assertFenced(runtime.context, fence);
    await runtime.owner.rollback(runtime.context, fence);
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("fence-established");
    const proof = await runtime.owner.activate(runtime.context, fence);
    expect(proof).toMatchObject({
      providerId: "docker",
      nonce: fence.nonce,
      configurationGeneration: "config-generation-8",
      listenerIdentity: "tcp:18789",
      healthSha256: "c".repeat(64),
      providerHandle: expect.stringMatching(/^docker-state-mutation-activation-v1:/u),
    });
    await runtime.owner.release(runtime.context, fence, proof, "e".repeat(64));

    expect(runtime.helperActions).toEqual([
      "acquire",
      "assert",
      "rollback",
      "activate",
      "activate",
      "release",
    ]);
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
    const helperCalls = runtime.capture.mock.calls.filter(([, args]) =>
      args.includes("/usr/local/lib/nemoclaw/runtime-state-mutation-control.py"),
    );
    expect(helperCalls.map(([, args]) => args.slice(-10))).toEqual([
      [
        "container",
        "exec",
        "--interactive",
        "--user",
        "root",
        RUNTIME_ID,
        "/opt/hermes/.venv/bin/python3",
        "-I",
        "/usr/local/lib/nemoclaw/runtime-state-mutation-control.py",
        "acquire",
      ],
      [
        "container",
        "exec",
        "--interactive",
        "--user",
        "root",
        RUNTIME_ID,
        "/opt/hermes/.venv/bin/python3",
        "-I",
        "/usr/local/lib/nemoclaw/runtime-state-mutation-control.py",
        "assert",
      ],
      [
        "container",
        "exec",
        "--interactive",
        "--user",
        "root",
        RUNTIME_ID,
        "/opt/hermes/.venv/bin/python3",
        "-I",
        "/usr/local/lib/nemoclaw/runtime-state-mutation-control.py",
        "rollback",
      ],
      [
        "container",
        "exec",
        "--interactive",
        "--user",
        "root",
        RUNTIME_ID,
        "/opt/hermes/.venv/bin/python3",
        "-I",
        "/usr/local/lib/nemoclaw/runtime-state-mutation-control.py",
        "activate",
      ],
      [
        "container",
        "exec",
        "--interactive",
        "--user",
        "root",
        RUNTIME_ID,
        "/opt/hermes/.venv/bin/python3",
        "-I",
        "/usr/local/lib/nemoclaw/runtime-state-mutation-control.py",
        "activate",
      ],
      [
        "container",
        "exec",
        "--interactive",
        "--user",
        "root",
        RUNTIME_ID,
        "/opt/hermes/.venv/bin/python3",
        "-I",
        "/usr/local/lib/nemoclaw/runtime-state-mutation-control.py",
        "release",
      ],
    ]);
    expect(helperCalls.map(([, args, timeout]) => [args.at(-1), timeout])).toEqual([
      ["acquire", 30_000],
      ["assert", 30_000],
      ["rollback", 15 * 60_000],
      ["activate", 5 * 60_000],
      ["activate", 5 * 60_000],
      ["release", 5 * 60_000],
    ]);
    const acquireRequest = JSON.parse(helperCalls[0]?.[3]?.toString("utf8") ?? "null");
    expect(acquireRequest).toMatchObject({
      action: "acquire",
      providerId: "docker",
      sandboxName: "alpha",
      lifecycleGeneration: LIFECYCLE_GENERATION,
      runtimeId: RUNTIME_ID,
      runtimePid: 4812,
      stateRoot: STATE_ROOT,
      planSha256: fence.planSha256,
      projectionSha256: PROJECTION_SHA256,
      nonce: fence.nonce,
      target: "mutable",
      rollback: "locked",
    });
    expect(JSON.parse(acquireRequest.plan)).toMatchObject({
      intent: "protection-transition",
      stateRoot: STATE_ROOT,
    });
    const inspectFormats = runtime.capture.mock.calls
      .filter(
        ([, args]) => args[4] === "container" && args[5] === "inspect" && args[8] === RUNTIME_ID,
      )
      .map(([, args]) => args[7]);
    expect(inspectFormats.length).toBeGreaterThan(0);
    expect(inspectFormats).not.toContain("{{json .}}");
    expect(inspectFormats.every((format) => !format.includes("Config.Env"))).toBe(true);
  });

  it("publishes without retiring the host lifecycle fence", async () => {
    const runtime = harness();
    const fence = await runtime.owner.acquire({ ...runtime.context, plan: plan() });

    await runtime.owner.publish(runtime.context, fence);

    const recovered = await runtime.owner.recover(runtime.context);

    expect(recovered).toMatchObject({
      intent: "protection-transition",
      phase: "published",
      target: "mutable",
      rollback: "locked",
    });
    expect(runtime.helperActions).toEqual(["acquire", "publish", "recover"]);
    expect(runtime.capture.mock.calls.find(([, args]) => args.at(-1) === "publish")?.[2]).toBe(
      15 * 60_000,
    );
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("fence-established");
  });

  it("recovers release from exact durable completion and keeps final release idempotent", async () => {
    const runtime = harness({ failReleaseOnce: true });
    const fence = await runtime.owner.acquire({ ...runtime.context, plan: plan() });
    await runtime.owner.rollback(runtime.context, fence);
    const proof = await runtime.owner.activate(runtime.context, fence);
    const completedLedgerSha256 = "e".repeat(64);

    expect(() =>
      runtime.owner.release(runtime.context, fence, proof, completedLedgerSha256),
    ).toThrow("root helper release did not complete successfully");
    expect(runtime.lifecycleStore.listUnfinished()[0]).toMatchObject({
      phase: "completed",
      resultSha256: completedLedgerSha256,
    });

    expect(runtime.owner.recover(runtime.context)).toBeNull();
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
    const actionsAfterRecovery = [...runtime.helperActions];

    await runtime.owner.release(runtime.context, fence, proof, completedLedgerSha256);
    expect(runtime.helperActions).toEqual(actionsAfterRecovery);
  });

  it("recovers a successful provider release whose response was lost", async () => {
    const runtime = harness({ loseReleaseResponseOnce: true });
    const fence = await runtime.owner.acquire({ ...runtime.context, plan: plan() });
    await runtime.owner.rollback(runtime.context, fence);
    const proof = await runtime.owner.activate(runtime.context, fence);
    const completedLedgerSha256 = "e".repeat(64);

    expect(() =>
      runtime.owner.release(runtime.context, fence, proof, completedLedgerSha256),
    ).toThrow("root helper release did not complete successfully");
    expect(runtime.lifecycleStore.listUnfinished()[0]).toMatchObject({
      phase: "completed",
      resultSha256: completedLedgerSha256,
    });

    expect(runtime.owner.recover(runtime.context)).toBeNull();
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
    expect(runtime.helperActions.slice(-3)).toEqual(["release", "recover", "release"]);
  });

  it("recovers a durable provider-release receipt without requiring the removed marker", () => {
    const runtime = harness();
    const fence = runtime.owner.acquire({ ...runtime.context, plan: plan() });
    runtime.owner.rollback(runtime.context, fence);
    const proof = runtime.owner.activate(runtime.context, fence);
    const completedLedgerSha256 = "e".repeat(64);
    const claimPath = persistedRuntimeClaimPath(runtime.root);
    const originalUnlink = fs.unlinkSync.bind(fs);
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (String(target) === claimPath) throw new Error("injected exit before claim unlink");
      return originalUnlink(target);
    });

    expect(() =>
      runtime.owner.release(runtime.context, fence, proof, completedLedgerSha256),
    ).toThrow("before claim unlink");
    unlink.mockRestore();
    const actionsAfterProviderRelease = [...runtime.helperActions];

    expect(runtime.owner.recover(runtime.context)).toBeNull();
    expect(runtime.helperActions).toEqual(actionsAfterProviderRelease);
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
    expect(runtime.lifecycleStore.isRetired(fence.transactionId, completedLedgerSha256)).toBe(true);
  });

  it("converges when the first helper acquire wins before ledger publication", async () => {
    let driftOnce = true;
    const runtime = harness({
      afterHelper(action, state) {
        if (action === "acquire" && driftOnce) {
          driftOnce = false;
          state.mountSource = "/var/lib/openshell/replaced/hermes";
        }
      },
    });

    expect(() => runtime.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "Docker runtime changed while the state mutation fence was established",
    );
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("prepared");

    runtime.state.mountSource = "/var/lib/openshell/alpha/hermes";
    const recovered = await runtime.owner.recover(runtime.context);

    expect(recovered?.providerHandle).toMatch(/^docker-state-mutation-v1:/u);
    expect(runtime.helperActions).toEqual(["acquire", "acquire"]);
    expect(runtime.acquireRequests[1]).toBe(runtime.acquireRequests[0]);
    expect(runtime.capture.mock.calls.filter(([, args]) => args.at(-1) === "acquire")[1]?.[2]).toBe(
      30_000,
    );
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("fence-established");
  });

  it("replays the persisted acquire after a controller exit before helper invocation", () => {
    const runtime = harness();
    const interrupted = ownerThatStopsAfterPrepare(runtime);

    expect(() => interrupted.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "controller exit before helper invocation",
    );
    const prepared = runtime.lifecycleStore.listUnfinished()[0];
    expect(prepared).toMatchObject({ action: "state-mutation", phase: "prepared" });
    expect(
      runtime.lifecycleStore.loadStateMutationIntent(prepared?.transactionId as string),
    ).toMatchObject({
      transactionId: prepared?.transactionId,
      planSha256: plan().planSha256,
      projectionSha256: plan().projectionSha256,
    });
    expect(runtime.helperActions).toEqual([]);

    const recovered = runtime.owner.recover(runtime.context);

    expect(recovered).toMatchObject({
      transactionId: prepared?.transactionId,
      phase: "fenced",
    });
    expect(runtime.helperActions).toEqual(["acquire"]);
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("fence-established");
  });

  it("replays the persisted acquire from mutation-authorized recovery", () => {
    const runtime = harness();
    const interrupted = ownerThatStopsAfterPrepare(runtime);
    expect(() => interrupted.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "controller exit before helper invocation",
    );
    const transactionId = runtime.lifecycleStore.listUnfinished()[0]?.transactionId as string;
    runtime.lifecycleStore.authorizeMutation(transactionId);

    const recovered = runtime.owner.recover(runtime.context);

    expect(recovered).toMatchObject({ transactionId, phase: "fenced" });
    expect(runtime.helperActions).toEqual(["acquire"]);
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("fence-established");
  });

  it("converges when an orphan acquire writes its marker before recovery", () => {
    const runtime = harness({ loseAcquireResponseOnce: true });

    expect(() => runtime.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "root helper acquire did not complete successfully",
    );
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("prepared");

    const recovered = runtime.owner.recover(runtime.context);

    expect(recovered?.providerHandle).toMatch(/^docker-state-mutation-v1:/u);
    expect(runtime.helperActions).toEqual(["acquire", "acquire"]);
    expect(runtime.acquireRequests[1]).toBe(runtime.acquireRequests[0]);
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("fence-established");
  });

  it("converges when recovery writes the marker before a delayed orphan acquire", () => {
    const runtime = harness({ deferAcquireOnce: true });

    expect(() => runtime.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "root helper acquire did not complete successfully",
    );
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("prepared");

    const recovered = runtime.owner.recover(runtime.context);
    const orphanReceipt = runtime.replayDeferredAcquire();

    expect(orphanReceipt).toMatchObject({
      transactionId: recovered?.transactionId,
      nonce: recovered?.nonce,
      phase: "fenced",
    });
    expect(runtime.helperActions).toEqual(["acquire", "acquire", "acquire"]);
    expect(new Set(runtime.acquireRequests).size).toBe(1);
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("fence-established");
  });

  it("fails closed when a prepared transaction loses its persisted acquire intent", () => {
    const runtime = harness();
    const interrupted = ownerThatStopsAfterPrepare(runtime);
    expect(() => interrupted.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "controller exit before helper invocation",
    );
    const transactionId = runtime.lifecycleStore.listUnfinished()[0]?.transactionId as string;
    fs.unlinkSync(persistedIntentPath(runtime.root, transactionId));

    expect(() => runtime.owner.recover(runtime.context)).toThrow(
      "prepared state mutation is missing its exact intent",
    );
    expect(runtime.helperActions).toEqual([]);
  });

  it("fails closed when a persisted acquire intent changes", () => {
    const runtime = harness();
    const interrupted = ownerThatStopsAfterPrepare(runtime);
    expect(() => interrupted.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "controller exit before helper invocation",
    );
    const transactionId = runtime.lifecycleStore.listUnfinished()[0]?.transactionId as string;
    const intentPath = persistedIntentPath(runtime.root, transactionId);
    const intent = JSON.parse(fs.readFileSync(intentPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(intentPath, `${JSON.stringify({ ...intent, nonce: "f".repeat(64) })}\n`, {
      mode: 0o600,
    });

    expect(() => runtime.owner.recover(runtime.context)).toThrow(
      "persisted state mutation intent does not match the lifecycle transaction",
    );
    expect(runtime.helperActions).toEqual([]);
  });

  it("fails closed before helper replay when the Docker runtime changes", () => {
    const runtime = harness();
    const interrupted = ownerThatStopsAfterPrepare(runtime);
    expect(() => interrupted.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "controller exit before helper invocation",
    );
    runtime.state.mountSource = "/var/lib/openshell/replaced/hermes";

    expect(() => runtime.owner.recover(runtime.context)).toThrow(
      "Docker runtime changed before the state mutation fence was established",
    );
    expect(runtime.helperActions).toEqual([]);
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("prepared");
  });

  it("fails closed before Docker inspection when engine authority changes", () => {
    const runtime = harness();
    const interrupted = ownerThatStopsAfterPrepare(runtime);
    expect(() => interrupted.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "controller exit before helper invocation",
    );
    const captureCallsBeforeRecovery = runtime.capture.mock.calls.length;
    const changedAuthority = createDockerOperationAuthority(
      "sandbox-lifecycle",
      {
        ...runtime.context.environment,
        DOCKER_HOST: "unix:///tmp/changed-docker.sock",
      },
      runtime.capture,
    );
    const changedOwner = createDockerStateMutationOwner({
      sandboxName: runtime.context.sandboxName,
      lifecycleGeneration: runtime.lifecycleGeneration,
      lifecycleLiveIdentityFingerprint: SANDBOX_FINGERPRINT,
      runtimeId: RUNTIME_ID,
      authority: changedAuthority,
      engineAuthorityStore: runtime.engineAuthorityStore,
      lifecycleStore: runtime.lifecycleStore,
    });

    expect(() => changedOwner.recover(runtime.context)).toThrow(
      /binding does not match|endpoint does not match/u,
    );
    expect(runtime.capture).toHaveBeenCalledTimes(captureCallsBeforeRecovery);
    expect(runtime.helperActions).toEqual([]);
  });

  it("rejects mount drift before asking the root helper to assert an established fence", async () => {
    const runtime = harness();
    const fence = await runtime.owner.acquire({ ...runtime.context, plan: plan() });
    runtime.state.mountSource = "/var/lib/openshell/replaced/hermes";

    expect(() => runtime.owner.assertFenced(runtime.context, fence)).toThrow(
      "Docker runtime changed after the state mutation fence was established",
    );

    expect(runtime.helperActions).toEqual(["acquire"]);
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("fence-established");
  });

  it("rejects registry-to-label sandbox identity drift before helper invocation", () => {
    const runtime = harness();
    runtime.state.sandboxId = "replacement-sandbox-id";

    expect(() => runtime.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "does not match the registered live identity",
    );
    expect(runtime.helperActions).toEqual([]);
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
  });

  it("rejects unsafe PID and procfs authority before invoking the root helper", async () => {
    const hostPid = harness();
    hostPid.state.pidMode = "host";

    expect(() => hostPid.owner.acquire({ ...hostPid.context, plan: plan() })).toThrow(
      "private unprivileged PID namespace",
    );
    expect(hostPid.helperActions).toEqual([]);

    const privileged = harness();
    privileged.state.privileged = true;
    expect(() => privileged.owner.acquire({ ...privileged.context, plan: plan() })).toThrow(
      "private unprivileged PID namespace",
    );
    expect(privileged.helperActions).toEqual([]);

    const procOverlay = harness();
    procOverlay.state.overlayProc = true;
    expect(() => procOverlay.owner.acquire({ ...procOverlay.context, plan: plan() })).toThrow(
      "overlays the trusted private procfs",
    );
    expect(procOverlay.helperActions).toEqual([]);
  });

  it("does not publish a fence when the helper changes the provider nonce", async () => {
    const runtime = harness({
      mutateReceipt(receipt, action) {
        return action === "acquire" ? { ...receipt, nonce: "f".repeat(64) } : receipt;
      },
    });

    expect(() => runtime.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "root helper receipt changed the prepared state mutation plan",
    );

    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("prepared");
  });

  it("rejects a non-canonical provider receipt even when its fields are equivalent", async () => {
    const runtime = harness({
      mutateReceipt(receipt, action) {
        return action === "acquire"
          ? Object.fromEntries(Object.entries(receipt).reverse())
          : receipt;
      },
    });

    expect(() => runtime.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "root helper receipt is not canonical",
    );
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("prepared");
  });

  it("keeps prepared authority when exact acquire replay fails", async () => {
    const runtime = harness({ failAcquire: true });

    expect(() => runtime.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "root helper acquire did not complete successfully",
    );
    expect(() => runtime.owner.recover(runtime.context)).toThrow(
      "root helper acquire did not complete successfully",
    );

    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("prepared");
  });

  it("rejects sandbox lifecycle drift before Docker inspection", async () => {
    const runtime = harness();
    const changed = {
      ...runtime.context,
      sandbox: { ...runtime.context.sandbox, lifecycleGeneration: "generation-8" },
    };

    expect(() => runtime.owner.acquire({ ...changed, plan: plan() })).toThrow(
      "sandbox lifecycle generation changed",
    );
    expect(runtime.capture).not.toHaveBeenCalled();
  });
});
