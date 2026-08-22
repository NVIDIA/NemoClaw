// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDockerStateMutationRoots,
  createAmbiguousRuntimeCapture,
  createOneTimeAcquireMountDrift,
  createDockerStateMutationHarness as harness,
  DOCKER_STATE_MUTATION_LIFECYCLE_GENERATION as LIFECYCLE_GENERATION,
  DOCKER_STATE_MUTATION_PROJECTION_SHA256 as PROJECTION_SHA256,
  persistedDockerStateMutationIntentPath as persistedIntentPath,
  persistedDockerStateMutationRuntimeClaimPath as persistedRuntimeClaimPath,
  dockerStateMutationPlan as plan,
  DOCKER_STATE_MUTATION_RUNTIME_ID as RUNTIME_ID,
  DOCKER_STATE_MUTATION_SANDBOX_FINGERPRINT as SANDBOX_FINGERPRINT,
  DOCKER_STATE_MUTATION_STATE_ROOT as STATE_ROOT,
  throwBeforeClaimUnlink,
} from "../../../../test/helpers/docker-state-mutation-harness";
import { createDockerOperationAuthority } from "./docker-operation-authority";
import {
  DOCKER_STATE_MUTATION_HELPER_TRANSPORT_BROKER_SOURCE,
  createDockerStateMutationOwner,
  createDockerStateMutationSurface,
} from "./docker-state-mutation";

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
      hostTransportRoot: runtime.root,
      authority: runtime.authority as ReturnType<typeof createDockerOperationAuthority>,
      engineAuthorityStore: runtime.engineAuthorityStore,
      lifecycleStore: {
        ...runtime.lifecycleStore,
        acquireMutationExecution,
      },
    }),
  };
}

afterEach(() => {
  cleanupDockerStateMutationRoots();
});

describe("Docker runtime-provider state mutation surface", () => {
  it("preserves safe broker diagnostics after request validation", () => {
    const definitionsEnd = DOCKER_STATE_MUTATION_HELPER_TRANSPORT_BROKER_SOURCE.indexOf(
      "\nhelper = sys.argv[1]\n",
    );
    expect(definitionsEnd).toBeGreaterThan(0);
    const definitions = DOCKER_STATE_MUTATION_HELPER_TRANSPORT_BROKER_SOURCE.slice(
      0,
      definitionsEnd,
    );
    const probe = `${definitions}
helper = "/definitely-missing/nemoclaw-runtime-state-mutation-control.py"
try:
    run_helper("acquire", b"{}\\n")
except (OSError, RuntimeError, UnicodeError, ValueError) as error:
    missing_helper = post_validation_failure_code(error)
print(json.dumps({
    "missingHelper": missing_helper,
    "permission": post_validation_failure_code(PermissionError()),
    "encoding": post_validation_failure_code(UnicodeDecodeError("utf-8", b"x", 0, 1, "invalid")),
    "invalidResponse": post_validation_failure_code(ValueError()),
    "helperProcess": json.loads(normalize_helper_stderr("acquire", 2, b"raw python error"))["code"],
    "helperProtocol": json.loads(normalize_helper_stderr("acquire", 0, b"unexpected stderr"))["code"],
    "timeout": json.loads(failure_stderr("acquire", "helper-timeout"))["code"],
}, separators=(",", ":")))
`;

    expect(
      JSON.parse(
        execFileSync("python3", ["-I", "-c", probe], {
          encoding: "utf8",
          timeout: 5_000,
        }),
      ),
    ).toEqual({
      missingHelper: "helper-file-missing",
      permission: "transport-permission-denied",
      encoding: "transport-response-encoding-invalid",
      invalidResponse: "transport-response-invalid",
      helperProcess: "helper-process-failed",
      helperProtocol: "helper-protocol-stderr",
      timeout: "helper-timeout",
    });
  });

  it("uses one harness-owned absolute Docker executable", () => {
    const runtime = harness();
    runtime.authority.engine.capture(["version"]);
    const executable = runtime.capture.mock.calls[0]?.[0] as string;

    expect(path.isAbsolute(executable)).toBe(true);
    expect(executable).toBe(fs.realpathSync(path.join(runtime.root, "bin", "docker")));
    expect(runtime.context.environment).toMatchObject({ PATH: path.join(runtime.root, "bin") });
  });

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
    const ambiguous = createAmbiguousRuntimeCapture(runtime);
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
    expect(runtime.supervisorSignals).toEqual(["SIGSTOP", "SIGCONT"]);
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
    const helperCalls = runtime.capture.mock.calls.filter(([, args]) =>
      args.includes("--nemoclaw-broker"),
    );
    expect(helperCalls.map(([, args]) => args.at(-1))).toEqual([
      "acquire",
      "assert",
      "rollback",
      "activate",
      "activate",
      "release",
    ]);
    expect(
      runtime.capture.mock.calls.filter(
        ([, args]) =>
          args.includes("--interactive") &&
          args.includes("/usr/local/lib/nemoclaw/runtime-state-mutation-control.py"),
      ),
    ).toEqual([]);
    expect(
      runtime.capture.mock.calls.filter(
        ([, args]) =>
          args.includes("--detach") &&
          args.includes("/usr/local/lib/nemoclaw/runtime-state-mutation-control.py"),
      ),
    ).toHaveLength(1);
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

  it("keeps recovery transport alive until a stopped supervisor is durably resumed", () => {
    const runtime = harness({ failResumeOnce: true });
    const fence = runtime.owner.acquire({ ...runtime.context, plan: plan() });
    runtime.owner.rollback(runtime.context, fence);
    const proof = runtime.owner.activate(runtime.context, fence);
    const completedLedgerSha256 = "e".repeat(64);

    expect(() =>
      runtime.owner.release(runtime.context, fence, proof, completedLedgerSha256),
    ).toThrow("Docker host supervisor resume did not complete successfully");
    expect(runtime.state.supervisorStopped).toBe(true);
    expect(runtime.transportBrokerActive()).toBe(true);
    expect(runtime.lifecycleStore.listUnfinished()[0]).toMatchObject({
      phase: "completed",
      resultSha256: completedLedgerSha256,
    });

    expect(runtime.owner.recover(runtime.context)).toBeNull();
    expect(runtime.supervisorSignals).toEqual(["SIGSTOP", "SIGCONT", "SIGCONT"]);
    expect(runtime.state.supervisorStopped).toBe(false);
    expect(runtime.transportBrokerActive()).toBe(false);
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
  });

  it("recovers a durable provider-release receipt without requiring the removed marker", () => {
    const runtime = harness();
    const fence = runtime.owner.acquire({ ...runtime.context, plan: plan() });
    runtime.owner.rollback(runtime.context, fence);
    const proof = runtime.owner.activate(runtime.context, fence);
    const completedLedgerSha256 = "e".repeat(64);
    const claimPath = persistedRuntimeClaimPath(runtime.root);
    const originalUnlink = fs.unlinkSync.bind(fs);
    const unlink = vi
      .spyOn(fs, "unlinkSync")
      .mockImplementation((target) => throwBeforeClaimUnlink(originalUnlink, claimPath, target));

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
    const runtime = harness({
      afterHelper: createOneTimeAcquireMountDrift(),
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

  it("publishes one content-addressed request after it host-stops managed Hermes (#9485)", () => {
    const runtime = harness({ stateMountType: "volume" });

    const acquired = runtime.owner.acquire({ ...runtime.context, plan: plan() });

    expect(acquired.providerHandle).toMatch(/^docker-state-mutation-v1:/u);
    expect(runtime.state).toMatchObject({
      mountDriver: "local",
      mountName: "nemoclaw-hermes-alpha-state",
      mountType: "volume",
      supervisorStopped: true,
    });
    expect(runtime.supervisorSignals).toEqual(["SIGSTOP"]);
    const commands = runtime.capture.mock.calls.map(([, args]) => {
      const start = args.findIndex((value) => value === "container");
      return start < 0 ? [] : args.slice(start);
    });
    const stop = commands.findIndex((args) => args[1] === "kill");
    const broker = commands.findIndex((args) => args[1] === "exec" && args.includes("--detach"));
    const publications = commands.filter(
      (args) => args[1] === "cp" && args.at(-1)?.endsWith(".acquire.incoming"),
    );
    const request = commands.indexOf(publications[0] ?? []);
    expect(commands[stop]).toEqual(["container", "kill", "--signal", "SIGSTOP", RUNTIME_ID]);
    expect(runtime.capture.mock.calls.find(([, args]) => args[5] === "kill")?.[1]).toEqual([
      "--config",
      "/tmp/nemoclaw-docker",
      "--host",
      "unix:///tmp/nemoclaw-docker.sock",
      "container",
      "kill",
      "--signal",
      "SIGSTOP",
      RUNTIME_ID,
    ]);
    expect(broker).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(broker);
    expect(publications).toHaveLength(1);
    expect(request).toBeGreaterThan(stop);
    expect(runtime.transportCopySourceModes).toEqual([0o644, 0o644]);
    expect(
      commands.some(
        (args) =>
          args[1] === "cp" &&
          (args.at(-1)?.endsWith(".request") || args.at(-1)?.endsWith(".ready")),
      ),
    ).toBe(false);
    expect(
      commands.some(
        (args) =>
          args[1] === "exec" &&
          args.includes("--interactive") &&
          args.includes("/usr/local/lib/nemoclaw/runtime-state-mutation-control.py"),
      ),
    ).toBe(false);
  });

  it("replays one signal-terminated helper invocation through the established transport", () => {
    const runtime = harness({ signalHelperOnce: true, stateMountType: "volume" });

    const acquired = runtime.owner.acquire({ ...runtime.context, plan: plan() });

    expect(acquired.providerHandle).toMatch(/^docker-state-mutation-v1:/u);
    expect(runtime.helperActions).toEqual(["acquire", "acquire"]);
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("fence-established");
  });

  it("recovers a durable-volume fence when acquire succeeds after its response is lost (#9485)", () => {
    const runtime = harness({ loseAcquireResponseOnce: true, stateMountType: "volume" });
    expect(runtime.state).toMatchObject({
      mountDriver: "local",
      mountName: "nemoclaw-hermes-alpha-state",
      mountType: "volume",
    });

    expect(() => runtime.owner.acquire({ ...runtime.context, plan: plan() })).toThrow(
      "root helper acquire did not complete successfully",
    );
    expect(runtime.lifecycleStore.listUnfinished()[0]?.phase).toBe("prepared");

    const recovered = runtime.owner.recover(runtime.context);

    expect(recovered?.providerHandle).toMatch(/^docker-state-mutation-v1:/u);
    expect(runtime.helperActions).toEqual(["acquire", "acquire"]);
    expect(runtime.supervisorSignals).toEqual(["SIGSTOP", "SIGSTOP"]);
    expect(runtime.state.supervisorStopped).toBe(true);
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
      hostTransportRoot: runtime.root,
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
