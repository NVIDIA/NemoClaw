// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
  DOCKER_STATE_MUTATION_ACTIVATE_TIMEOUT_MS,
  createDockerStateMutationOwner,
  createDockerStateMutationSurface,
} from "./docker-state-mutation";

const TRANSPORT_BROKER = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "runtime-state-mutation-transport-broker.py",
);

const TRANSPORT_BROKER_HARNESS = String.raw`
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("runtime_state_mutation_transport_broker", sys.argv[1])
broker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = broker
spec.loader.exec_module(broker)
broker.ROOT = sys.argv[2]
broker.EXPECTED_UID = os.getuid()
broker.EXPECTED_GID = os.getgid()
broker.TIMEOUTS = {**broker.TIMEOUTS, "activate": float(sys.argv[3])}
broker.HELPER = sys.argv[4]
raise SystemExit(broker.main([sys.argv[5]]))
`;

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

function finalizeReleasedProviderWithLiveTransport(
  runtime: ReturnType<typeof harness>,
  transactionId: string,
  resultSha256: string,
): void {
  const lease = runtime.lifecycleStore.acquireMutationExecution(transactionId);
  runtime.lifecycleStore.complete(lease, resultSha256);
  runtime.releaseProviderWithoutTransportCleanup();
  runtime.lifecycleStore.finalizeStateMutationRelease(lease, resultSha256);
  runtime.lifecycleStore.releaseMutationExecution(lease);
}

async function waitForPath(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fs.accessSync(filePath);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path.basename(filePath)}`);
}

type BrokerAction =
  | "acquire"
  | "assert"
  | "publish"
  | "recover"
  | "rollback"
  | "activate"
  | "release";

interface BrokerResponse {
  readonly schemaVersion: number;
  readonly action: BrokerAction;
  readonly identity: string;
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function createBrokerRuntime(
  helperSource: (root: string) => string,
  activateTimeoutSeconds = 0.25,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-mutation-broker-"));
  const helper = path.join(root, "helper.py");
  const transaction = randomBytes(32).toString("hex");
  const session = path.join(root, transaction);
  fs.writeFileSync(helper, helperSource(root), { mode: 0o500 });
  const broker = spawn(
    "python3",
    [
      "-I",
      "-c",
      TRANSPORT_BROKER_HARNESS,
      TRANSPORT_BROKER,
      root,
      String(activateTimeoutSeconds),
      helper,
      transaction,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const brokerExit = new Promise<void>((resolve, reject) => {
    broker.once("exit", () => resolve());
    broker.once("error", reject);
  });
  let brokerStderr = "";
  broker.stderr.setEncoding("utf8");
  broker.stderr.on("data", (chunk: string) => {
    brokerStderr += chunk;
  });

  try {
    await waitForPath(path.join(session, "ready"), 2_000);
  } catch (error: unknown) {
    broker.kill("SIGTERM");
    await brokerExit;
    fs.rmSync(root, { force: true, recursive: true });
    throw error;
  }

  return {
    helper,
    root,
    session,
    transaction,
    stderr: () => brokerStderr,
    close: async () => {
      broker.kill("SIGTERM");
      await brokerExit;
      fs.rmSync(root, { force: true, recursive: true });
    },
  };
}

async function sendBrokerRequest(
  runtime: Awaited<ReturnType<typeof createBrokerRuntime>>,
  action: BrokerAction,
): Promise<{ readonly response: BrokerResponse }> {
  const request = Buffer.from(
    `${JSON.stringify({ action, transactionId: runtime.transaction })}\n`,
    "utf8",
  );
  const identity = createHash("sha256").update(request).digest("hex");
  const responsePath = path.join(runtime.session, `${identity}.response`);
  fs.writeFileSync(path.join(runtime.session, `${identity}.${action}.incoming`), request, {
    mode: 0o600,
  });
  await waitForPath(responsePath, 1_500);
  return {
    response: JSON.parse(fs.readFileSync(responsePath, "utf8")) as BrokerResponse,
  };
}

function brokerFailureCode(response: BrokerResponse): string {
  return (JSON.parse(response.stderr) as { code: string }).code;
}

afterEach(() => {
  cleanupDockerStateMutationRoots();
});

describe("Docker runtime-provider state mutation surface", () => {
  it("publishes safe full-broker diagnostics after request validation", async () => {
    const runtime = await createBrokerRuntime(
      () => `import os,sys
action = sys.argv[1]
if action == "acquire":
    os.write(2, b"raw helper failure")
    raise SystemExit(2)
if action == "assert":
    os.write(2, b"unexpected helper stderr")
if action == "publish":
    os.write(2, b'{"schemaVersion":1,"action":"publish","status":"failed","code":"publisher-guard-failed"}\\n')
    raise SystemExit(1)
if action == "rollback":
    os.write(1, b"\\xff")
`,
    );

    try {
      const failed = await sendBrokerRequest(runtime, "acquire");
      expect(brokerFailureCode(failed.response)).toBe("helper-process-failed");

      const protocol = await sendBrokerRequest(runtime, "assert");
      expect(brokerFailureCode(protocol.response)).toBe("helper-protocol-stderr");

      const publisher = await sendBrokerRequest(runtime, "publish");
      expect(brokerFailureCode(publisher.response)).toBe("publisher-guard-failed");

      const encoding = await sendBrokerRequest(runtime, "rollback");
      expect(brokerFailureCode(encoding.response)).toBe("transport-response-encoding-invalid");

      fs.unlinkSync(runtime.helper);
      const missing = await sendBrokerRequest(runtime, "recover");
      expect(brokerFailureCode(missing.response)).toBe("helper-file-missing");
      expect(runtime.stderr(), runtime.stderr()).toBe("");
    } finally {
      await runtime.close();
    }
  });

  it("bounds signal replay and terminates the full helper process group (#10155)", async () => {
    let leakedChildMarker = "";
    const runtime = await createBrokerRuntime((root) => {
      const countPath = path.join(root, "helper-count");
      leakedChildMarker = path.join(root, "leaked-child");
      return `import os,signal,sys,time
count_path = ${JSON.stringify(countPath)}
leaked_child_marker = ${JSON.stringify(leakedChildMarker)}
if sys.argv[1] != "activate":
    raise SystemExit(0)
try:
    with open(count_path, "r", encoding="utf-8") as stream:
        count = int(stream.read())
except FileNotFoundError:
    count = 0
with open(count_path, "w", encoding="utf-8") as stream:
    stream.write(str(count + 1))
if count == 0:
    time.sleep(0.2)
    os.kill(os.getpid(), signal.SIGKILL)
if os.fork() == 0:
    time.sleep(0.35)
    with open(leaked_child_marker, "w", encoding="utf-8") as stream:
        stream.write("helper process group survived")
    os._exit(0)
time.sleep(30)
`;
    });

    try {
      const result = await sendBrokerRequest(runtime, "activate");
      expect(result.response).toMatchObject({ action: "activate", status: 1, stdout: "" });
      expect(brokerFailureCode(result.response)).toBe("helper-timeout");
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(fs.existsSync(leakedChildMarker)).toBe(false);
      expect(runtime.stderr(), runtime.stderr()).toBe("");
    } finally {
      await runtime.close();
    }
  });

  it("uses the remaining response allowance after one Docker copy timeout (#10155)", () => {
    const runtime = harness({ timeoutResponseCopyOnce: true });
    const surface = createDockerStateMutationSurface({
      capture: runtime.capture,
      resolveStateDir: () => runtime.root,
    });

    expect(() => surface.acquire({ ...runtime.context, plan: plan() })).not.toThrow();
    const responseCopies = runtime.capture.mock.calls.filter(([, args]) =>
      args.some((value) => value.endsWith(".response")),
    );
    expect(responseCopies).toHaveLength(2);
    expect(responseCopies.map(([, , timeout]) => timeout)).toEqual([15_000, 15_000]);
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

  it("recovers transport left by a finalized provider release (#10155)", () => {
    const runtime = harness({ failReleaseCleanupInspectionOnce: true });
    const surface = createDockerStateMutationSurface({
      capture: runtime.capture,
      resolveStateDir: () => runtime.root,
    });
    const fence = surface.acquire({ ...runtime.context, plan: plan() });
    surface.activate(runtime.context, fence);
    const completedLedgerSha256 = "e".repeat(64);
    finalizeReleasedProviderWithLiveTransport(runtime, fence.transactionId, completedLedgerSha256);

    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
    expect(runtime.transportBrokerSessionExists(fence.transactionId)).toBe(true);

    expect(() => surface.recover(runtime.context)).toThrow(
      "root helper transport release cleanup verification failed",
    );
    expect(runtime.lifecycleStore.load(fence.transactionId)).toMatchObject({
      phase: "completed",
      resultSha256: completedLedgerSha256,
    });
    expect(runtime.transportBrokerSessionExists(fence.transactionId)).toBe(true);

    expect(surface.recover(runtime.context)).toBeNull();
    expect(runtime.transportBrokerSessionExists(fence.transactionId)).toBe(false);
    expect(runtime.lifecycleStore.isRetired(fence.transactionId, completedLedgerSha256)).toBe(true);
  });

  it("cleans finalized provider transport before the next acquire (#10155)", () => {
    const runtime = harness();
    const surface = createDockerStateMutationSurface({
      capture: runtime.capture,
      resolveStateDir: () => runtime.root,
    });
    const first = surface.acquire({ ...runtime.context, plan: plan() });
    surface.activate(runtime.context, first);
    const completedLedgerSha256 = "e".repeat(64);
    finalizeReleasedProviderWithLiveTransport(runtime, first.transactionId, completedLedgerSha256);

    const second = surface.acquire({ ...runtime.context, plan: plan() });

    expect(second.transactionId).not.toBe(first.transactionId);
    expect(runtime.transportBrokerSessionExists(first.transactionId)).toBe(false);
    expect(runtime.transportBrokerSessionExists(second.transactionId)).toBe(true);
    expect(runtime.lifecycleStore.isRetired(first.transactionId, completedLedgerSha256)).toBe(true);
    expect(runtime.lifecycleStore.listUnfinished()).toMatchObject([
      { phase: "fence-established", transactionId: second.transactionId },
    ]);
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
          args.includes("/usr/local/lib/nemoclaw/runtime-state-mutation-transport-broker.py"),
      ),
    ).toHaveLength(1);
    expect(helperCalls.map(([, args, timeout]) => [args.at(-1), timeout])).toEqual([
      ["acquire", 30_000],
      ["assert", 30_000],
      ["rollback", 15 * 60_000],
      ["activate", DOCKER_STATE_MUTATION_ACTIVATE_TIMEOUT_MS],
      ["activate", DOCKER_STATE_MUTATION_ACTIVATE_TIMEOUT_MS],
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

  it("fully releases transport before a back-to-back provider transition (#10155)", () => {
    const runtime = harness();

    const completeTransition = (completedLedgerSha256: string) => {
      const fence = runtime.owner.acquire({ ...runtime.context, plan: plan() });
      runtime.owner.assertFenced(runtime.context, fence);
      runtime.owner.publish(runtime.context, fence);
      runtime.owner.assertFenced(runtime.context, fence);
      const proof = runtime.owner.activate(runtime.context, fence);
      runtime.owner.release(runtime.context, fence, proof, completedLedgerSha256);
      return fence;
    };

    const first = completeTransition("e".repeat(64));
    expect(runtime.transportBrokerActive()).toBe(false);
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);

    const second = completeTransition("f".repeat(64));

    expect(second.transactionId).not.toBe(first.transactionId);
    expect(runtime.transportBrokerActive()).toBe(false);
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
    expect(runtime.helperActions).toEqual([
      "acquire",
      "assert",
      "publish",
      "assert",
      "activate",
      "activate",
      "release",
      "acquire",
      "assert",
      "publish",
      "assert",
      "activate",
      "activate",
      "release",
    ]);
    expect(runtime.supervisorSignals).toEqual(["SIGSTOP", "SIGCONT", "SIGSTOP", "SIGCONT"]);
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

  it("retains release recovery until Docker broker cleanup completes (#10155)", () => {
    const runtime = harness({ failReleaseCleanupProbeOnce: true });
    const fence = runtime.owner.acquire({ ...runtime.context, plan: plan() });
    runtime.owner.rollback(runtime.context, fence);
    const proof = runtime.owner.activate(runtime.context, fence);
    const completedLedgerSha256 = "e".repeat(64);

    expect(() =>
      runtime.owner.release(runtime.context, fence, proof, completedLedgerSha256),
    ).toThrow("root helper transport release cleanup remains incomplete");
    expect(runtime.transportBrokerActive()).toBe(true);
    expect(runtime.transportBrokerSessionExists()).toBe(true);
    expect(runtime.lifecycleStore.listUnfinished()[0]).toMatchObject({
      phase: "completed",
      resultSha256: completedLedgerSha256,
    });

    expect(runtime.owner.recover(runtime.context)).toBeNull();
    expect(runtime.transportBrokerActive()).toBe(false);
    expect(runtime.transportBrokerSessionExists()).toBe(false);
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
