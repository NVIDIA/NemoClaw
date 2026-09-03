// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDurableReceiptUnlinkInterruption } from "../../../../test/helpers/docker-state-mutation-harness";

import {
  type ContainerEngineCommandCapture,
  createContainerEngineCommand,
} from "../../adapters/container-engine";
import {
  createFilePersistedEngineAuthorityStore,
  createPersistedEngineAuthority,
  type PersistedEngineAuthorityStore,
} from "./persisted-engine-authority";
import {
  assertActivePersistedEngineStateMutation,
  completePersistedEngineStateMutation,
  createFilePersistedEngineLifecycleStore,
  executePersistedEngineLifecycle,
  executePersistedEngineStateMutation,
  hasActivePersistedEngineStateMutationTarget,
  loadPersistedEngineStateMutationIntent,
  normalizePersistedEngineLifecycleRecord,
  normalizePersistedEngineStateMutationIntent,
  PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
  PERSISTED_ENGINE_STATE_MUTATION_INTENT_FILE,
  PERSISTED_ENGINE_STATE_MUTATION_INTENT_SCHEMA_VERSION,
  PERSISTED_ENGINE_STATE_MUTATION_RELEASE_FILE,
  type PersistedEngineLifecycleAction,
  type PersistedEngineLifecycleResource,
  parsePersistedEngineLifecycleRecord,
  parsePersistedEngineStateMutationIntent,
  preparePersistedEngineLifecycle,
  releaseCompletedPersistedEngineStateMutation,
  serializePersistedEngineLifecycleRecord,
  serializePersistedEngineStateMutationIntent,
} from "./persisted-engine-lifecycle";

const TRANSACTION_ID = "1".repeat(64);
const BINDING_SHA256 = "2".repeat(64);
const RUNTIME_STATE_SHA256 = "3".repeat(64);
const RESULT_SHA256 = "4".repeat(64);
const SOURCE_ID = `mxc-session:${"5".repeat(64)}`;
const TARGET_ID = `mxc-session:${"6".repeat(64)}`;
const AUTHORITY_ID = `mxc-endpoint:${"7".repeat(64)}`;
const SERIALIZED_STATE_MUTATION_PLAN = '{"schemaVersion":1,"intent":"protection-transition"}';
const STATE_MUTATION_PLAN_SHA256 = createHash("sha256")
  .update(SERIALIZED_STATE_MUTATION_PLAN, "utf8")
  .digest("hex");
const STATE_MUTATION_PROJECTION_SHA256 = "8".repeat(64);
const STATE_MUTATION_NONCE = "9".repeat(64);
const roots: string[] = [];

function stateMutationIntent(serializedPlan = SERIALIZED_STATE_MUTATION_PLAN) {
  return {
    serializedPlan,
    planSha256: createHash("sha256").update(serializedPlan, "utf8").digest("hex"),
    projectionSha256: STATE_MUTATION_PROJECTION_SHA256,
    nonce: STATE_MUTATION_NONCE,
  };
}

function runtimeTargetClaimPath(root: string, targetId = TARGET_ID): string {
  const identity = createHash("sha256")
    .update("mxc", "utf8")
    .update("\0", "utf8")
    .update(targetId, "utf8")
    .digest("hex");
  return path.join(root, PERSISTED_ENGINE_LIFECYCLE_DIRECTORY, "runtime-target-claims", identity);
}

function stateMutationIntentPath(root: string, transactionId = TRANSACTION_ID): string {
  return path.join(
    root,
    PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
    transactionId,
    PERSISTED_ENGINE_STATE_MUTATION_INTENT_FILE,
  );
}

function stateMutationReleasePath(root: string, transactionId = TRANSACTION_ID): string {
  return path.join(
    root,
    PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
    transactionId,
    PERSISTED_ENGINE_STATE_MUTATION_RELEASE_FILE,
  );
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-engine-lifecycle-"));
  roots.push(root);
  return root;
}

function lifecycleEngine(
  capture: ContainerEngineCommandCapture = vi.fn(() => ({
    status: 0,
    stdout: "ok",
    stderr: "",
  })),
  authorityId = AUTHORITY_ID,
) {
  return createContainerEngineCommand({
    operation: "sandbox-lifecycle",
    engineId: "mxc",
    displayName: "MXC test engine",
    authorityId,
    executable: "mxcctl",
    endpointArgs: ["--endpoint", "unix:///run/mxc/runtime.sock"],
    capture,
  });
}

function resources(
  action: PersistedEngineLifecycleAction,
  targetId = TARGET_ID,
): readonly PersistedEngineLifecycleResource[] {
  switch (action) {
    case "snapshot-create":
    case "backup":
      return [{ role: "source", runtimeId: SOURCE_ID }];
    case "recovery":
    case "state-mutation":
      return [{ role: "target", runtimeId: targetId }];
    case "snapshot-clone":
    case "rebuild":
    case "restore":
      return [
        { role: "source", runtimeId: SOURCE_ID },
        { role: "target", runtimeId: targetId },
      ];
  }
}

function harness(
  options: {
    readonly root?: string;
    readonly action?: PersistedEngineLifecycleAction;
    readonly capture?: ContainerEngineCommandCapture;
    readonly authorityId?: string;
    readonly transactionId?: string;
    readonly runtimeStateSha256?: string;
    readonly sandboxName?: string;
    readonly targetId?: string;
  } = {},
) {
  const root = options.root ?? temporaryRoot();
  const action = options.action ?? "rebuild";
  const engine = lifecycleEngine(options.capture, options.authorityId);
  const engineAuthorityStore = createFilePersistedEngineAuthorityStore(root);
  const authority = createPersistedEngineAuthority("mxc", engine, BINDING_SHA256);
  engineAuthorityStore.load("sandbox-lifecycle") ?? engineAuthorityStore.record(authority);
  const lifecycleStore = createFilePersistedEngineLifecycleStore(root);
  return {
    action,
    authority,
    engine,
    engineAuthorityStore,
    lifecycleStore,
    root,
    input: {
      transactionId: options.transactionId ?? TRANSACTION_ID,
      action,
      sandboxName: options.sandboxName ?? "alpha",
      resources: resources(action, options.targetId),
      runtimeStateSha256: options.runtimeStateSha256 ?? RUNTIME_STATE_SHA256,
      providerId: "mxc",
      bindingSha256: BINDING_SHA256,
      engine,
      engineAuthorityStore,
      lifecycleStore,
      ...(action === "state-mutation" ? { stateMutationIntent: stateMutationIntent() } : {}),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("persisted engine lifecycle", () => {
  it.each([
    "snapshot-create",
    "snapshot-clone",
    "rebuild",
    "backup",
    "restore",
    "recovery",
  ] as const)("enforces exact persisted engine authority for %s", async (action) => {
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const runtime = harness({ action, capture });
    const prepared = preparePersistedEngineLifecycle(runtime.input);
    const role = resources(action).some((resource) => resource.role === "target")
      ? "target"
      : "source";
    const expectedId = role === "target" ? TARGET_ID : SOURCE_ID;

    const completed = await executePersistedEngineLifecycle(runtime.input, (scope) => {
      expect(scope.record.phase).toBe("mutation-authorized");
      expect(scope.record.engineAuthority).toEqual(runtime.authority);
      expect(
        scope.captureExact(role, (runtimeId) => ({
          args: ["inspect", "--exact", runtimeId],
          targetIndex: 2,
        })),
      ).toMatchObject({ status: 0 });
      return { resultSha256: RESULT_SHA256, value: action };
    });

    expect(prepared.phase).toBe("prepared");
    expect(completed.value).toBe(action);
    expect(completed.record).toMatchObject({ phase: "completed", resultSha256: RESULT_SHA256 });
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      "mxcctl",
      ["--endpoint", "unix:///run/mxc/runtime.sock", "inspect", "--exact", expectedId],
      15_000,
    );
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
  });

  it("publishes mutation authorization before the exact runtime mutation", async () => {
    const events: string[] = [];
    const runtime = harness({
      capture: vi.fn(() => {
        events.push("engine:mutate");
        return { status: 0, stdout: "", stderr: "" };
      }),
    });
    preparePersistedEngineLifecycle(runtime.input);
    const originalAuthorize = runtime.lifecycleStore.authorizeMutation;
    const lifecycleStore = {
      ...runtime.lifecycleStore,
      authorizeMutation(transactionId: string) {
        const record = originalAuthorize(transactionId);
        events.push("ledger:mutation-authorized");
        return record;
      },
    };

    await executePersistedEngineLifecycle({ ...runtime.input, lifecycleStore }, (scope) => {
      scope.captureExact("source", (runtimeId) => ({
        args: ["stop", runtimeId],
        targetIndex: 1,
      }));
      return { resultSha256: RESULT_SHA256, value: undefined };
    });

    expect(events).toEqual(["ledger:mutation-authorized", "engine:mutate"]);
  });

  it("admits only one concurrent executor for a lifecycle transaction", async () => {
    const runtime = harness();
    preparePersistedEngineLifecycle(runtime.input);
    let releaseFirst: (() => void) | undefined;
    let announceFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstMutation = vi.fn(async () => {
      announceFirst?.();
      await holdFirst;
      return { resultSha256: RESULT_SHA256, value: "first" };
    });
    const competingMutation = vi.fn(() => ({
      resultSha256: RESULT_SHA256,
      value: "competing",
    }));

    const first = executePersistedEngineLifecycle(runtime.input, firstMutation);
    await firstEntered;
    await expect(executePersistedEngineLifecycle(runtime.input, competingMutation)).rejects.toThrow(
      "already owned by a live process",
    );
    expect(firstMutation).toHaveBeenCalledOnce();
    expect(competingMutation).not.toHaveBeenCalled();

    releaseFirst?.();
    await expect(first).resolves.toMatchObject({ value: "first" });
  });

  it("keeps an active state mutation durable across restarted stores", async () => {
    const capture = vi.fn(() => ({ status: 0, stdout: "fenced", stderr: "" }));
    const runtime = harness({ action: "state-mutation", capture });
    const prepared = preparePersistedEngineLifecycle(runtime.input);
    expect(
      hasActivePersistedEngineStateMutationTarget(
        runtime.lifecycleStore,
        runtime.input.sandboxName,
        TARGET_ID,
      ),
    ).toBe(true);

    const result = await executePersistedEngineStateMutation(runtime.input, (scope) => {
      expect(scope.record).toMatchObject({
        action: "state-mutation",
        phase: "prepared",
      });
      scope.captureExact("target", (runtimeId) => ({
        args: ["fence", "--runtime", runtimeId],
        targetIndex: 2,
      }));
      return "active";
    });

    expect(prepared.phase).toBe("prepared");
    expect(result).toMatchObject({
      value: "active",
      record: { action: "state-mutation", phase: "fence-established", resultSha256: null },
    });
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([result.record]);
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      "mxcctl",
      ["--endpoint", "unix:///run/mxc/runtime.sock", "fence", "--runtime", TARGET_ID],
      15_000,
    );

    const restartedInput = {
      ...runtime.input,
      engine: lifecycleEngine(),
      engineAuthorityStore: createFilePersistedEngineAuthorityStore(runtime.root),
      lifecycleStore: createFilePersistedEngineLifecycleStore(runtime.root),
    };
    expect(assertActivePersistedEngineStateMutation(restartedInput)).toEqual(result.record);
    expect(
      hasActivePersistedEngineStateMutationTarget(
        restartedInput.lifecycleStore,
        runtime.input.sandboxName,
      ),
    ).toBe(true);
  });

  it("streams a bounded plan to a fixed helper under exact-runtime authority", async () => {
    const capture = vi.fn(() => ({ status: 0, stdout: "accepted", stderr: "" }));
    const runtime = harness({ action: "state-mutation", capture });
    const serializedPlan = Buffer.from('{"schemaVersion":2}\n', "utf8");
    preparePersistedEngineLifecycle(runtime.input);

    await executePersistedEngineStateMutation(runtime.input, (scope) => {
      scope.captureExact(
        "target",
        (runtimeId) => ({
          args: ["exec", "-i", "--user", "root", runtimeId, "fixed-state-helper", "acquire"],
          targetIndex: 4,
        }),
        30_000,
        serializedPlan,
      );
    });

    expect(capture).toHaveBeenCalledExactlyOnceWith(
      "mxcctl",
      [
        "--endpoint",
        "unix:///run/mxc/runtime.sock",
        "exec",
        "-i",
        "--user",
        "root",
        TARGET_ID,
        "fixed-state-helper",
        "acquire",
      ],
      30_000,
      serializedPlan,
    );
  });

  it("publishes the state-mutation intent before prepared authority and retries an interruption", () => {
    const runtime = harness({ action: "state-mutation" });
    const events: string[] = [];
    const recordStateMutationIntent = runtime.lifecycleStore.recordStateMutationIntent;
    const interruptedStore = {
      ...runtime.lifecycleStore,
      recordStateMutationIntent(intent: Parameters<typeof recordStateMutationIntent>[0]) {
        const recorded = recordStateMutationIntent(intent);
        events.push("ledger:intent");
        return recorded;
      },
      create: vi.fn(() => {
        events.push("ledger:prepared");
        throw new Error("injected exit before prepared publication");
      }),
    };

    expect(() =>
      preparePersistedEngineLifecycle({ ...runtime.input, lifecycleStore: interruptedStore }),
    ).toThrow("before prepared publication");
    expect(events).toEqual(["ledger:intent", "ledger:prepared"]);
    expect(runtime.lifecycleStore.load(TRANSACTION_ID)).toBeNull();
    expect(fs.existsSync(runtimeTargetClaimPath(runtime.root))).toBe(false);

    const expectedIntent = normalizePersistedEngineStateMutationIntent({
      schemaVersion: PERSISTED_ENGINE_STATE_MUTATION_INTENT_SCHEMA_VERSION,
      transactionId: TRANSACTION_ID,
      ...stateMutationIntent(),
    });
    const restarted = createFilePersistedEngineLifecycleStore(runtime.root);
    expect(restarted.loadStateMutationIntent(TRANSACTION_ID)).toEqual(expectedIntent);

    const prepared = preparePersistedEngineLifecycle({
      ...runtime.input,
      lifecycleStore: restarted,
    });
    expect(prepared).toMatchObject({ action: "state-mutation", phase: "prepared" });
    expect(restarted.loadStateMutationIntent(TRANSACTION_ID)).toEqual(expectedIntent);
    expect(fs.existsSync(runtimeTargetClaimPath(runtime.root))).toBe(true);
  });

  it("records one canonical state-mutation intent without changing lifecycle record schema v1", () => {
    const runtime = harness({ action: "state-mutation" });
    const first = preparePersistedEngineLifecycle(runtime.input);
    const second = preparePersistedEngineLifecycle(runtime.input);
    const intent = loadPersistedEngineStateMutationIntent(runtime.input);
    const serialized = serializePersistedEngineStateMutationIntent(intent);

    expect(second).toEqual(first);
    expect(intent).toEqual({
      schemaVersion: PERSISTED_ENGINE_STATE_MUTATION_INTENT_SCHEMA_VERSION,
      transactionId: TRANSACTION_ID,
      serializedPlan: SERIALIZED_STATE_MUTATION_PLAN,
      planSha256: STATE_MUTATION_PLAN_SHA256,
      projectionSha256: STATE_MUTATION_PROJECTION_SHA256,
      nonce: STATE_MUTATION_NONCE,
    });
    expect(fs.readFileSync(stateMutationIntentPath(runtime.root), "utf8")).toBe(serialized);
    expect(parsePersistedEngineStateMutationIntent(serialized)).toEqual(intent);
    expect(() => parsePersistedEngineStateMutationIntent(serialized.trim())).toThrow(
      "not canonical",
    );
    expect(first.schemaVersion).toBe(1);
    expect(Object.keys(first).sort()).toEqual([
      "action",
      "engineAuthority",
      "phase",
      "resources",
      "resultSha256",
      "runtimeStateSha256",
      "sandboxName",
      "schemaVersion",
      "transactionId",
    ]);
    expect(serializePersistedEngineLifecycleRecord(first)).not.toMatch(
      /nonce|planSha256|serializedPlan/u,
    );

    expect(() =>
      preparePersistedEngineLifecycle({
        ...runtime.input,
        stateMutationIntent: stateMutationIntent(
          '{"schemaVersion":1,"intent":"protection-transition","changed":true}',
        ),
      }),
    ).toThrow("intent already exists with different content");
    expect(loadPersistedEngineStateMutationIntent(runtime.input)).toEqual(intent);
  });

  it("loads a state-mutation intent only under the exact lifecycle authority", () => {
    const runtime = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(runtime.input);

    expect(loadPersistedEngineStateMutationIntent(runtime.input).transactionId).toBe(
      TRANSACTION_ID,
    );
    expect(() =>
      loadPersistedEngineStateMutationIntent({
        ...runtime.input,
        runtimeStateSha256: "a".repeat(64),
      }),
    ).toThrow("do not describe the same lifecycle authority");
    expect(() =>
      loadPersistedEngineStateMutationIntent({ ...runtime.input, providerId: "other" }),
    ).toThrow("provider does not match");
  });

  it("rejects private-file control violations for a state-mutation intent", () => {
    const wrongMode = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(wrongMode.input);
    fs.chmodSync(stateMutationIntentPath(wrongMode.root), 0o644);
    expect(() => wrongMode.lifecycleStore.loadStateMutationIntent(TRANSACTION_ID)).toThrow(
      "mode, link, or size checks",
    );

    const symlink = harness({ action: "state-mutation", transactionId: "a".repeat(64) });
    preparePersistedEngineLifecycle(symlink.input);
    const intentPath = stateMutationIntentPath(symlink.root, "a".repeat(64));
    const outside = path.join(symlink.root, "outside-intent.json");
    fs.renameSync(intentPath, outside);
    fs.symlinkSync(outside, intentPath);
    expect(() => symlink.lifecycleStore.loadStateMutationIntent("a".repeat(64))).toThrow(
      "must not be a symbolic link",
    );
  });

  it("rejects tampered and oversized state-mutation intent artifacts", () => {
    const tampered = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(tampered.input);
    const intentPath = stateMutationIntentPath(tampered.root);
    const durable = JSON.parse(fs.readFileSync(intentPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      intentPath,
      `${JSON.stringify({ ...durable, serializedPlan: `${SERIALIZED_STATE_MUTATION_PLAN} ` })}\n`,
      { mode: 0o600 },
    );
    expect(() => tampered.lifecycleStore.loadStateMutationIntent(TRANSACTION_ID)).toThrow(
      "plan digest does not match",
    );

    const oversized = harness({ action: "state-mutation", transactionId: "b".repeat(64) });
    const oversizedDirectory = path.dirname(
      stateMutationIntentPath(oversized.root, "b".repeat(64)),
    );
    fs.mkdirSync(oversizedDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      stateMutationIntentPath(oversized.root, "b".repeat(64)),
      "x".repeat(128 * 1024 + 1),
      { mode: 0o600 },
    );
    expect(() => oversized.lifecycleStore.loadStateMutationIntent("b".repeat(64))).toThrow(
      "mode, link, or size checks",
    );
  });

  it("rejects prepared state-mutation authority without a durable intent", () => {
    const runtime = harness({ action: "state-mutation" });
    const prepared = normalizePersistedEngineLifecycleRecord({
      schemaVersion: 1,
      transactionId: TRANSACTION_ID,
      action: "state-mutation",
      phase: "prepared",
      sandboxName: runtime.input.sandboxName,
      resources: runtime.input.resources,
      runtimeStateSha256: runtime.input.runtimeStateSha256,
      engineAuthority: runtime.authority,
      resultSha256: null,
    });

    expect(() => runtime.lifecycleStore.create(prepared)).toThrow(
      "preparation requires its exact durable intent",
    );
    expect(fs.existsSync(runtimeTargetClaimPath(runtime.root))).toBe(false);

    const directory = path.dirname(stateMutationIntentPath(runtime.root));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(directory, "prepared.json"),
      serializePersistedEngineLifecycleRecord(prepared),
      {
        mode: 0o600,
      },
    );
    expect(() => runtime.lifecycleStore.load(TRANSACTION_ID)).toThrow(
      "prepared state mutation is missing its exact intent",
    );
  });

  it("does not treat an interrupted fence callback as an established external fence", async () => {
    const runtime = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(runtime.input);

    expect(() =>
      executePersistedEngineStateMutation(runtime.input, () => {
        throw new Error("injected controller exit before fence proof");
      }),
    ).toThrow("before fence proof");

    expect(runtime.lifecycleStore.load(TRANSACTION_ID)?.phase).toBe("prepared");
    expect(() => assertActivePersistedEngineStateMutation(runtime.input)).toThrow(
      "fence is not established",
    );

    expect(executePersistedEngineStateMutation(runtime.input, () => "revalidated")).toMatchObject({
      value: "revalidated",
      record: { phase: "fence-established" },
    });
  });

  it("requires explicit activation completion before retiring a state mutation", async () => {
    const runtime = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(runtime.input);

    expect(() =>
      completePersistedEngineStateMutation(
        runtime.input,
        () => ({
          resultSha256: RESULT_SHA256,
          value: "unsafe",
        }),
        () => undefined,
      ),
    ).toThrow("requires an established fence");

    await expect(
      executePersistedEngineLifecycle(runtime.input, () => ({
        resultSha256: RESULT_SHA256,
        value: "unsafe",
      })),
    ).rejects.toThrow("must remain active until explicit activation completion");

    await executePersistedEngineStateMutation(runtime.input, () => "published");
    const release = vi.fn((_scope, receipt) => {
      expect(receipt).toMatchObject({ phase: "completed", resultSha256: RESULT_SHA256 });
    });
    const completed = await completePersistedEngineStateMutation(
      runtime.input,
      (scope) => {
        expect(scope.record.phase).toBe("fence-established");
        return { resultSha256: RESULT_SHA256, value: "activated" };
      },
      release,
    );

    expect(completed).toMatchObject({
      value: "activated",
      record: { action: "state-mutation", phase: "completed", resultSha256: RESULT_SHA256 },
    });
    expect(release).toHaveBeenCalledOnce();
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
  });

  it("keeps the exact target claimed until a completed activation releases its provider fence", async () => {
    const runtime = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(runtime.input);
    await executePersistedEngineStateMutation(runtime.input, () => "published");

    expect(() =>
      completePersistedEngineStateMutation(
        runtime.input,
        () => ({ resultSha256: RESULT_SHA256, value: "activated" }),
        () => {
          throw new Error("injected controller exit before provider fence release");
        },
      ),
    ).toThrow("before provider fence release");
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([
      expect.objectContaining({ phase: "completed", resultSha256: RESULT_SHA256 }),
    ]);
    expect(() => runtime.lifecycleStore.retire(TRANSACTION_ID, RESULT_SHA256)).toThrow(
      "finalized provider release receipt",
    );

    const competing = harness({
      root: runtime.root,
      action: "recovery",
      transactionId: "8".repeat(64),
    });
    expect(() => preparePersistedEngineLifecycle(competing.input)).toThrow(
      "exact runtime target already has an unfinished transaction",
    );

    const released = await releaseCompletedPersistedEngineStateMutation(
      runtime.input,
      (scope, receipt) => {
        expect(scope.record).toEqual(receipt);
        return Promise.resolve("released");
      },
    );
    expectTypeOf(released.value).toEqualTypeOf<string | undefined>();
    expect(released).toMatchObject({ value: "released", record: { phase: "completed" } });
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([]);
    expect(
      hasActivePersistedEngineStateMutationTarget(
        runtime.lifecycleStore,
        runtime.input.sandboxName,
        TARGET_ID,
      ),
    ).toBe(false);
    runtime.lifecycleStore.retire(TRANSACTION_ID, RESULT_SHA256);
    expect(runtime.lifecycleStore.load(TRANSACTION_ID)).toBeNull();
  });

  it("reacquires a missing prepared claim before replaying the exact helper", () => {
    const runtime = harness({ action: "state-mutation" });
    const prepared = preparePersistedEngineLifecycle(runtime.input);
    fs.unlinkSync(runtimeTargetClaimPath(runtime.root));

    expect(runtime.lifecycleStore.listUnfinished()).toEqual([prepared]);
    const replay = vi.fn(() => {
      expect(fs.existsSync(runtimeTargetClaimPath(runtime.root))).toBe(true);
      return "replayed";
    });

    expect(executePersistedEngineStateMutation(runtime.input, replay)).toMatchObject({
      value: "replayed",
      record: { phase: "fence-established" },
    });
    expect(replay).toHaveBeenCalledOnce();
  });

  it("reacquires a missing completed claim before retrying provider release", () => {
    const runtime = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(runtime.input);
    executePersistedEngineStateMutation(runtime.input, () => "fenced");
    expect(() =>
      completePersistedEngineStateMutation(
        runtime.input,
        () => ({ resultSha256: RESULT_SHA256, value: "activated" }),
        () => {
          throw new Error("injected provider release interruption");
        },
      ),
    ).toThrow("provider release interruption");
    fs.unlinkSync(runtimeTargetClaimPath(runtime.root));

    const release = vi.fn(() => {
      expect(fs.existsSync(runtimeTargetClaimPath(runtime.root))).toBe(true);
      return "released";
    });
    expect(releaseCompletedPersistedEngineStateMutation(runtime.input, release)).toMatchObject({
      value: "released",
      record: { phase: "completed", resultSha256: RESULT_SHA256 },
    });
    expect(release).toHaveBeenCalledOnce();
    expect(fs.existsSync(stateMutationReleasePath(runtime.root))).toBe(true);
    expect(fs.existsSync(runtimeTargetClaimPath(runtime.root))).toBe(false);
  });

  it("uses a durable release receipt to unlink a retained claim without another provider callback", () => {
    const runtime = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(runtime.input);
    executePersistedEngineStateMutation(runtime.input, () => "fenced");
    const claimPath = runtimeTargetClaimPath(runtime.root);
    const originalUnlink = fs.unlinkSync.bind(fs);
    const interruption = createDurableReceiptUnlinkInterruption(
      originalUnlink,
      claimPath,
      stateMutationReleasePath(runtime.root),
    );
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(interruption.unlink);

    expect(() =>
      completePersistedEngineStateMutation(
        runtime.input,
        () => ({ resultSha256: RESULT_SHA256, value: "activated" }),
        () => undefined,
      ),
    ).toThrow("before claim unlink");
    unlink.mockRestore();

    expect(fs.existsSync(stateMutationReleasePath(runtime.root))).toBe(true);
    expect(interruption.receiptWasDurable()).toBe(true);
    expect(fs.existsSync(claimPath)).toBe(true);
    const duplicateRelease = vi.fn(() => {
      throw new Error("provider callback must not be retried");
    });
    expect(
      releaseCompletedPersistedEngineStateMutation(runtime.input, duplicateRelease),
    ).toMatchObject({ record: { phase: "completed" }, value: undefined });
    expect(duplicateRelease).not.toHaveBeenCalled();
    expect(fs.existsSync(claimPath)).toBe(false);

    runtime.lifecycleStore.retire(TRANSACTION_ID, RESULT_SHA256);
    expect(runtime.lifecycleStore.isRetired(TRANSACTION_ID, RESULT_SHA256)).toBe(true);
    expect(runtime.lifecycleStore.load(TRANSACTION_ID)).toBeNull();
    expect(() => runtime.lifecycleStore.retire(TRANSACTION_ID, RESULT_SHA256)).not.toThrow();
  });

  it("fails closed when the provider release receipt is tampered", () => {
    const runtime = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(runtime.input);
    executePersistedEngineStateMutation(runtime.input, () => "fenced");
    completePersistedEngineStateMutation(
      runtime.input,
      () => ({ resultSha256: RESULT_SHA256, value: "activated" }),
      () => undefined,
    );
    const releasePath = stateMutationReleasePath(runtime.root);
    const receipt = JSON.parse(fs.readFileSync(releasePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      releasePath,
      `${JSON.stringify({ ...receipt, completedRecordSha256: "f".repeat(64) })}\n`,
      { mode: 0o600 },
    );

    expect(() => createFilePersistedEngineLifecycleStore(runtime.root).listUnfinished()).toThrow(
      "provider release receipt does not match",
    );
  });

  it("retires only after finalized provider release gives up execution ownership", () => {
    const runtime = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(runtime.input);
    executePersistedEngineStateMutation(runtime.input, () => "fenced");
    const lease = runtime.lifecycleStore.acquireMutationExecution(TRANSACTION_ID);
    runtime.lifecycleStore.complete(lease, RESULT_SHA256);
    runtime.lifecycleStore.finalizeStateMutationRelease(lease, RESULT_SHA256);

    expect(() => runtime.lifecycleStore.retire(TRANSACTION_ID, RESULT_SHA256)).toThrow(
      "released mutation execution ownership",
    );
    runtime.lifecycleStore.releaseMutationExecution(lease);
    runtime.lifecycleStore.retire(TRANSACTION_ID, RESULT_SHA256);
    expect(runtime.lifecycleStore.isRetired(TRANSACTION_ID, RESULT_SHA256)).toBe(true);
  });

  it("rejects drift from an active state mutation's exact authority and runtime identity", async () => {
    const runtime = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(runtime.input);
    await executePersistedEngineStateMutation(runtime.input, () => undefined);
    const restartedInput = {
      ...runtime.input,
      engineAuthorityStore: createFilePersistedEngineAuthorityStore(runtime.root),
      lifecycleStore: createFilePersistedEngineLifecycleStore(runtime.root),
    };

    expect(() =>
      assertActivePersistedEngineStateMutation({ ...restartedInput, providerId: "other" }),
    ).toThrow("provider does not match");
    expect(() =>
      assertActivePersistedEngineStateMutation({
        ...restartedInput,
        resources: [{ role: "target", runtimeId: `mxc-session:${"8".repeat(64)}` }],
      }),
    ).toThrow("do not describe the same lifecycle authority");
  });

  it("admits only one concurrent executor for an active state mutation", async () => {
    const runtime = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(runtime.input);
    let releaseFirst: (() => void) | undefined;
    let announceFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstMutation = vi.fn(async () => {
      announceFirst?.();
      await holdFirst;
      return "first";
    });
    const competingMutation = vi.fn(() => "competing");

    const first = executePersistedEngineStateMutation(runtime.input, firstMutation);
    await firstEntered;
    expect(() => executePersistedEngineStateMutation(runtime.input, competingMutation)).toThrow(
      "already owned by a live process",
    );
    expect(firstMutation).toHaveBeenCalledOnce();
    expect(competingMutation).not.toHaveBeenCalled();

    releaseFirst?.();
    await expect(first).resolves.toMatchObject({
      value: "first",
      record: { phase: "fence-established" },
    });
  });

  it("rejects a second unfinished state mutation for the same exact target", async () => {
    const first = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(first.input);
    await executePersistedEngineStateMutation(first.input, () => undefined);
    const second = harness({
      root: first.root,
      action: "state-mutation",
      transactionId: "8".repeat(64),
    });

    expect(() => preparePersistedEngineLifecycle(second.input)).toThrow(
      "exact runtime target already has an unfinished transaction",
    );
    expect(
      fs.existsSync(
        path.join(
          first.root,
          PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
          "8".repeat(64),
          "prepared.json",
        ),
      ),
    ).toBe(false);
    expect(() => second.lifecycleStore.authorizeMutation("8".repeat(64))).toThrow(
      "mutation authorization requires prepared authority",
    );
    const renamedAlias = harness({
      root: first.root,
      action: "state-mutation",
      transactionId: "9".repeat(64),
      sandboxName: "renamed-alpha",
    });
    expect(() => preparePersistedEngineLifecycle(renamedAlias.input)).toThrow(
      "exact runtime target already has an unfinished transaction",
    );
    expect(second.lifecycleStore.listUnfinished()).toEqual([
      expect.objectContaining({ transactionId: TRANSACTION_ID, phase: "fence-established" }),
    ]);
  });

  it("does not let inherited JSON hooks alias distinct runtime target claims", () => {
    const root = temporaryRoot();
    const first = harness({ root, action: "state-mutation" });
    const second = harness({
      root,
      action: "state-mutation",
      transactionId: "8".repeat(64),
      targetId: `mxc-session:${"9".repeat(64)}`,
    });
    const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value(this: Record<string, unknown>) {
          return Object.keys(this).sort().join(",") === "providerId,runtimeId"
            ? "polluted-target-claim"
            : this;
        },
      });
      expect(preparePersistedEngineLifecycle(first.input).phase).toBe("prepared");
      expect(preparePersistedEngineLifecycle(second.input).phase).toBe("prepared");
      expect(first.lifecycleStore.listUnfinished()).toEqual([
        expect.objectContaining({ transactionId: TRANSACTION_ID }),
        expect.objectContaining({ transactionId: "8".repeat(64) }),
      ]);
    } finally {
      objectToJson === undefined
        ? Reflect.deleteProperty(Object.prototype, "toJSON")
        : Object.defineProperty(Object.prototype, "toJSON", objectToJson);
    }
  });

  it("excludes recovery and state mutation in both exact-target orderings", async () => {
    const mutationFirst = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(mutationFirst.input);
    await executePersistedEngineStateMutation(mutationFirst.input, () => undefined);
    const recoverySecond = harness({
      root: mutationFirst.root,
      action: "recovery",
      transactionId: "8".repeat(64),
    });
    expect(() => preparePersistedEngineLifecycle(recoverySecond.input)).toThrow(
      "exact runtime target already has an unfinished transaction",
    );

    const recoveryFirst = harness({ action: "recovery", transactionId: "9".repeat(64) });
    preparePersistedEngineLifecycle(recoveryFirst.input);
    const mutationSecond = harness({
      root: recoveryFirst.root,
      action: "state-mutation",
      transactionId: "a".repeat(64),
    });
    expect(() => preparePersistedEngineLifecycle(mutationSecond.input)).toThrow(
      "exact runtime target already has an unfinished transaction",
    );
  });

  it("recovers an exact-target claim when its prepared phase was interrupted", () => {
    const first = harness({ action: "state-mutation" });
    const prepared = preparePersistedEngineLifecycle(first.input);
    fs.rmSync(path.join(first.root, PERSISTED_ENGINE_LIFECYCLE_DIRECTORY, TRANSACTION_ID), {
      recursive: true,
    });
    const restartedStore = createFilePersistedEngineLifecycleStore(first.root);

    expect(restartedStore.listUnfinished()).toEqual([prepared]);
    expect(
      preparePersistedEngineLifecycle({ ...first.input, lifecycleStore: restartedStore }),
    ).toEqual(prepared);

    const competing = harness({
      root: first.root,
      action: "state-mutation",
      transactionId: "8".repeat(64),
    });
    expect(() => preparePersistedEngineLifecycle(competing.input)).toThrow(
      "exact runtime target already has an unfinished transaction",
    );
  });

  it("never lets a competitor reclaim a claim-only interrupted transaction", () => {
    const crashed = harness({ action: "state-mutation" });
    const prepared = preparePersistedEngineLifecycle(crashed.input);
    fs.rmSync(path.join(crashed.root, PERSISTED_ENGINE_LIFECYCLE_DIRECTORY, TRANSACTION_ID), {
      recursive: true,
    });
    const replacement = harness({
      root: crashed.root,
      action: "state-mutation",
      transactionId: "8".repeat(64),
    });

    expect(() => preparePersistedEngineLifecycle(replacement.input)).toThrow(
      "runtime target claim is missing its prepared authority",
    );
    expect(() => replacement.lifecycleStore.authorizeMutation("8".repeat(64))).toThrow(
      "mutation authorization requires prepared authority",
    );
    expect(preparePersistedEngineLifecycle(crashed.input)).toEqual(prepared);
    expect(replacement.lifecycleStore.listUnfinished()).toEqual([prepared]);
  });

  it("requires the exact target claim for authorization and execution", () => {
    const authorization = harness({ action: "state-mutation" });
    preparePersistedEngineLifecycle(authorization.input);
    fs.unlinkSync(runtimeTargetClaimPath(authorization.root));

    expect(() => authorization.lifecycleStore.authorizeMutation(TRANSACTION_ID)).toThrow(
      "mutation authorization requires the exact runtime target claim",
    );
    expect(authorization.lifecycleStore.listUnfinished()).toEqual([
      expect.objectContaining({ transactionId: TRANSACTION_ID, phase: "prepared" }),
    ]);

    const execution = harness({ action: "state-mutation", transactionId: "8".repeat(64) });
    preparePersistedEngineLifecycle(execution.input);
    execution.lifecycleStore.authorizeMutation("8".repeat(64));
    const lease = execution.lifecycleStore.acquireMutationExecution("8".repeat(64));
    fs.unlinkSync(runtimeTargetClaimPath(execution.root));

    expect(() => execution.lifecycleStore.acquireMutationExecution("8".repeat(64))).toThrow(
      "mutation execution requires the exact runtime target claim",
    );
    expect(() => execution.lifecycleStore.assertMutationExecution(lease)).toThrow(
      "mutation execution requires the exact runtime target claim",
    );
    expect(() => execution.lifecycleStore.establishStateMutationFence(lease)).toThrow(
      "external fence establishment requires the exact runtime target claim",
    );
    execution.lifecycleStore.releaseMutationExecution(lease);

    const completion = harness({ action: "state-mutation", transactionId: "9".repeat(64) });
    preparePersistedEngineLifecycle(completion.input);
    completion.lifecycleStore.authorizeMutation("9".repeat(64));
    const completionLease = completion.lifecycleStore.acquireMutationExecution("9".repeat(64));
    completion.lifecycleStore.establishStateMutationFence(completionLease);
    fs.unlinkSync(runtimeTargetClaimPath(completion.root));

    expect(() => assertActivePersistedEngineStateMutation(completion.input)).toThrow(
      "active state mutation requires the exact runtime target claim",
    );
    expect(() => completion.lifecycleStore.complete(completionLease, RESULT_SHA256)).toThrow(
      "completion requires the exact runtime target claim",
    );
    completion.lifecycleStore.releaseMutationExecution(completionLease);
  });

  it("reconstructs mutation-authorized recovery after process-local state is rebuilt", async () => {
    const firstCapture = vi.fn(() => {
      throw new Error("injected process crash after exact stop");
    });
    const first = harness({ action: "recovery", capture: firstCapture });
    preparePersistedEngineLifecycle(first.input);

    await expect(
      executePersistedEngineLifecycle(first.input, (scope) => {
        scope.captureExact("target", (runtimeId) => ({
          args: ["recover", runtimeId],
          targetIndex: 1,
        }));
        return { resultSha256: RESULT_SHA256, value: undefined };
      }),
    ).rejects.toThrow("injected process crash");
    expect(first.lifecycleStore.load(TRANSACTION_ID)?.phase).toBe("mutation-authorized");
    expect(preparePersistedEngineLifecycle(first.input).phase).toBe("mutation-authorized");

    const recoveredCapture = vi.fn(() => ({ status: 0, stdout: "recovered", stderr: "" }));
    const recoveredEngine = lifecycleEngine(recoveredCapture);
    const recoveredInput = {
      ...first.input,
      engine: recoveredEngine,
      engineAuthorityStore: createFilePersistedEngineAuthorityStore(first.root),
      lifecycleStore: createFilePersistedEngineLifecycleStore(first.root),
    };
    const recovered = await executePersistedEngineLifecycle(recoveredInput, (scope) => {
      scope.captureExact("target", (runtimeId) => ({
        args: ["recover", runtimeId],
        targetIndex: 1,
      }));
      return { resultSha256: RESULT_SHA256, value: "recovered" };
    });

    expect(recovered.value).toBe("recovered");
    expect(recovered.record.phase).toBe("completed");
    expect(recoveredCapture).toHaveBeenCalledExactlyOnceWith(
      "mxcctl",
      ["--endpoint", "unix:///run/mxc/runtime.sock", "recover", TARGET_ID],
      15_000,
    );
  });

  it("recovers a durable execution lease only after its process owner is dead", async () => {
    const transactionId = "b".repeat(64);
    const first = harness({ action: "recovery", transactionId });
    preparePersistedEngineLifecycle(first.input);
    first.lifecycleStore.authorizeMutation(transactionId);
    first.lifecycleStore.acquireMutationExecution(transactionId);
    const leasePath = path.join(
      first.root,
      PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
      transactionId,
      "mutation-execution.json",
    );
    const abandoned = JSON.parse(fs.readFileSync(leasePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(leasePath, `${JSON.stringify({ ...abandoned, ownerPid: 0x7fffffff })}\n`, {
      mode: 0o600,
    });

    const restartedStore = createFilePersistedEngineLifecycleStore(first.root);
    const recovered = await executePersistedEngineLifecycle(
      { ...first.input, lifecycleStore: restartedStore },
      (scope) => {
        scope.captureExact("target", (runtimeId) => ({
          args: ["recover", runtimeId],
          targetIndex: 1,
        }));
        return { resultSha256: RESULT_SHA256, value: "recovered-dead-owner" };
      },
    );

    expect(recovered.value).toBe("recovered-dead-owner");
    expect(fs.existsSync(leasePath)).toBe(false);
  });

  it("recovers a durable execution lease after its live PID is reused", () => {
    const transactionId = "d".repeat(64);
    const runtime = harness({ action: "recovery", transactionId });
    preparePersistedEngineLifecycle(runtime.input);
    runtime.lifecycleStore.authorizeMutation(transactionId);
    runtime.lifecycleStore.acquireMutationExecution(transactionId);
    const leasePath = path.join(
      runtime.root,
      PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
      transactionId,
      "mutation-execution.json",
    );
    const abandoned = JSON.parse(fs.readFileSync(leasePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      leasePath,
      `${JSON.stringify({ ...abandoned, ownerStartIdentity: "linux:reused-process:1" })}\n`,
      { mode: 0o600 },
    );

    const restarted = createFilePersistedEngineLifecycleStore(runtime.root);
    const recovered = restarted.acquireMutationExecution(transactionId);

    expect(recovered.ownerPid).toBe(process.pid);
    expect(recovered.ownerStartIdentity).not.toBe("linux:reused-process:1");
    restarted.releaseMutationExecution(recovered);
  });

  it("reclaims a crash-left recovery marker only after its process owner is dead", () => {
    const transactionId = "c".repeat(64);
    const runtime = harness({ action: "recovery", transactionId });
    preparePersistedEngineLifecycle(runtime.input);
    runtime.lifecycleStore.authorizeMutation(transactionId);
    runtime.lifecycleStore.acquireMutationExecution(transactionId);
    const transactionDirectory = path.join(
      runtime.root,
      PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
      transactionId,
    );
    const leasePath = path.join(transactionDirectory, "mutation-execution.json");
    const recoveryPath = path.join(transactionDirectory, ".mutation-execution-recovery");
    const abandoned = JSON.parse(fs.readFileSync(leasePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(leasePath, `${JSON.stringify({ ...abandoned, ownerPid: 0x7fffffff })}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(
      recoveryPath,
      `${JSON.stringify({
        schemaVersion: 1,
        transactionId,
        ownerId: "01234567-89ab-4cde-8fab-0123456789ab",
        ownerPid: 0x7fffffff,
        ownerStartIdentity: abandoned.ownerStartIdentity,
      })}\n`,
      { mode: 0o600 },
    );

    const restarted = createFilePersistedEngineLifecycleStore(runtime.root);
    const recovered = restarted.acquireMutationExecution(transactionId);

    expect(recovered.ownerPid).toBe(process.pid);
    expect(fs.existsSync(recoveryPath)).toBe(false);
    restarted.releaseMutationExecution(recovered);
  });

  it("ignores crash-left exclusive-publication temporary files", () => {
    const runtime = harness({ action: "backup" });
    const prepared = preparePersistedEngineLifecycle(runtime.input);
    const ledgerRoot = path.join(runtime.root, PERSISTED_ENGINE_LIFECYCLE_DIRECTORY);
    const transactionDirectory = path.join(ledgerRoot, TRANSACTION_ID);
    const temporaryIdentity = "01234567-89ab-4cde-8fab-0123456789ab";
    fs.writeFileSync(
      path.join(transactionDirectory, `.prepared.json.${temporaryIdentity}.tmp`),
      "x",
      {
        mode: 0o600,
      },
    );
    fs.writeFileSync(
      path.join(ledgerRoot, `.${TRANSACTION_ID}.retired.${temporaryIdentity}.tmp`),
      "x",
      { mode: 0o600 },
    );

    expect(runtime.lifecycleStore.load(TRANSACTION_ID)).toEqual(prepared);
    expect(runtime.lifecycleStore.listUnfinished()).toEqual([prepared]);
  });

  it("repairs crash-left post-link phase and target-claim publications", () => {
    const runtime = harness({ action: "state-mutation" });
    const prepared = preparePersistedEngineLifecycle(runtime.input);
    const transactionDirectory = path.join(
      runtime.root,
      PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
      TRANSACTION_ID,
    );
    const preparedPath = path.join(transactionDirectory, "prepared.json");
    const claimPath = runtimeTargetClaimPath(runtime.root);
    const temporaryIdentity = "01234567-89ab-4cde-8fab-0123456789ab";
    const preparedTemporary = path.join(
      transactionDirectory,
      `.prepared.json.${temporaryIdentity}.tmp`,
    );
    const claimTemporary = path.join(
      path.dirname(claimPath),
      `.${path.basename(claimPath)}.${temporaryIdentity}.tmp`,
    );
    fs.linkSync(preparedPath, preparedTemporary);
    fs.linkSync(claimPath, claimTemporary);
    expect(fs.lstatSync(preparedPath).nlink).toBe(2);
    expect(fs.lstatSync(claimPath).nlink).toBe(2);

    const restarted = createFilePersistedEngineLifecycleStore(runtime.root);
    expect(restarted.load(TRANSACTION_ID)).toEqual(prepared);
    expect(restarted.listUnfinished()).toEqual([prepared]);
    expect(fs.existsSync(preparedTemporary)).toBe(false);
    expect(fs.existsSync(claimTemporary)).toBe(false);
    expect(fs.lstatSync(preparedPath).nlink).toBe(1);
    expect(fs.lstatSync(claimPath).nlink).toBe(1);
  });

  it("preserves a mutation failure when execution-lease release also fails", async () => {
    const runtime = harness();
    preparePersistedEngineLifecycle(runtime.input);
    const releaseMutationExecution = vi.fn(runtime.lifecycleStore.releaseMutationExecution);
    const lifecycleStore = {
      ...runtime.lifecycleStore,
      releaseMutationExecution: vi.fn((lease) => {
        releaseMutationExecution(lease);
        throw new Error("injected release failure");
      }),
    };

    await expect(
      executePersistedEngineLifecycle({ ...runtime.input, lifecycleStore }, () => {
        throw new Error("primary mutation failure");
      }),
    ).rejects.toThrow("primary mutation failure");
    expect(releaseMutationExecution).toHaveBeenCalledOnce();
  });

  it("returns a durable completion when execution-lease release reports a failure", async () => {
    const runtime = harness({ action: "backup" });
    preparePersistedEngineLifecycle(runtime.input);
    const releaseMutationExecution = vi.fn(runtime.lifecycleStore.releaseMutationExecution);
    const lifecycleStore = {
      ...runtime.lifecycleStore,
      releaseMutationExecution: vi.fn((lease) => {
        releaseMutationExecution(lease);
        throw new Error("injected release failure");
      }),
    };

    await expect(
      executePersistedEngineLifecycle({ ...runtime.input, lifecycleStore }, () => ({
        resultSha256: RESULT_SHA256,
        value: "completed",
      })),
    ).resolves.toMatchObject({ value: "completed", record: { phase: "completed" } });
    expect(releaseMutationExecution).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "provider",
      input: { providerId: "other" },
      message: "provider does not match",
    },
    {
      label: "binding",
      input: { bindingSha256: "8".repeat(64) },
      message: "binding does not match",
    },
    {
      label: "runtime state",
      input: { runtimeStateSha256: "9".repeat(64) },
      message: "do not describe the same lifecycle authority",
    },
  ])("fails closed before recovery when persisted $label changes", async ({ input, message }) => {
    const capture = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const runtime = harness({ capture });
    preparePersistedEngineLifecycle(runtime.input);

    await expect(
      executePersistedEngineLifecycle({ ...runtime.input, ...input }, () => ({
        resultSha256: RESULT_SHA256,
        value: undefined,
      })),
    ).rejects.toThrow(message);
    expect(capture).not.toHaveBeenCalled();
    expect(runtime.lifecycleStore.load(TRANSACTION_ID)?.phase).toBe("prepared");
  });

  it("rejects endpoint rotation before and after an exact command", async () => {
    const runtime = harness();
    preparePersistedEngineLifecycle(runtime.input);
    const rotatedEngine = lifecycleEngine(
      vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      `mxc-endpoint:${"8".repeat(64)}`,
    );
    await expect(
      executePersistedEngineLifecycle({ ...runtime.input, engine: rotatedEngine }, () => ({
        resultSha256: RESULT_SHA256,
        value: undefined,
      })),
    ).rejects.toThrow("endpoint does not match");
    expect(runtime.lifecycleStore.load(TRANSACTION_ID)?.phase).toBe("prepared");

    let guardReads = 0;
    const authorityStore: PersistedEngineAuthorityStore = {
      record: runtime.engineAuthorityStore.record,
      load: () => {
        guardReads += 1;
        return guardReads < 6
          ? runtime.authority
          : { ...runtime.authority, authorityId: `mxc-endpoint:${"9".repeat(64)}` };
      },
    };
    const capture = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const guarded = harness({
      root: temporaryRoot(),
      capture,
      transactionId: "a".repeat(64),
    });
    const guardedInput = { ...guarded.input, engineAuthorityStore: authorityStore };
    preparePersistedEngineLifecycle(guardedInput);

    await expect(
      executePersistedEngineLifecycle(guardedInput, (scope) => {
        scope.captureExact("source", (runtimeId) => ({
          args: ["stop", runtimeId],
          targetIndex: 1,
        }));
        return { resultSha256: RESULT_SHA256, value: undefined };
      }),
    ).rejects.toThrow(/authority changed|endpoint does not match/u);
    expect(capture).toHaveBeenCalledOnce();
    expect(guarded.lifecycleStore.load("a".repeat(64))?.phase).toBe("mutation-authorized");
  });

  it("refuses mutable-name and missing-ID commands", async () => {
    const capture = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const runtime = harness({ capture });
    preparePersistedEngineLifecycle(runtime.input);

    await expect(
      executePersistedEngineLifecycle(runtime.input, (scope) => {
        scope.captureExact("source", () => ({ args: ["rm", "alpha"], targetIndex: 1 }));
        return { resultSha256: RESULT_SHA256, value: undefined };
      }),
    ).rejects.toThrow("persisted runtime ID exactly once");
    expect(capture).not.toHaveBeenCalled();
    expect(runtime.lifecycleStore.load(TRANSACTION_ID)?.phase).toBe("mutation-authorized");

    await expect(
      executePersistedEngineLifecycle(runtime.input, (scope) => {
        scope.captureExact("source", (runtimeId) => ({
          args: ["container", "cp", `${runtimeId}:/run/nemoclaw/other`, "/tmp/receipt"],
          targetIndex: 2,
          targetPath: "/run/nemoclaw/receipt",
        }));
        return { resultSha256: RESULT_SHA256, value: undefined };
      }),
    ).rejects.toThrow("another persisted runtime target");
    expect(capture).not.toHaveBeenCalled();
  });

  it("revalidates persisted engine authority before publishing completion", async () => {
    const runtime = harness({ action: "backup" });
    preparePersistedEngineLifecycle(runtime.input);
    let reads = 0;
    const engineAuthorityStore: PersistedEngineAuthorityStore = {
      record: runtime.engineAuthorityStore.record,
      load: () => {
        reads += 1;
        return reads <= 2
          ? runtime.authority
          : { ...runtime.authority, authorityId: `mxc-endpoint:${"8".repeat(64)}` };
      },
    };

    await expect(
      executePersistedEngineLifecycle({ ...runtime.input, engineAuthorityStore }, () => ({
        resultSha256: RESULT_SHA256,
        value: undefined,
      })),
    ).rejects.toThrow(/authority changed|endpoint does not match/u);
    expect(runtime.lifecycleStore.load(TRANSACTION_ID)?.phase).toBe("mutation-authorized");
  });

  it("retains and then retires the exact completion receipt durably", async () => {
    const runtime = harness({ action: "backup" });
    preparePersistedEngineLifecycle(runtime.input);
    await executePersistedEngineLifecycle(runtime.input, () => ({
      resultSha256: RESULT_SHA256,
      value: undefined,
    }));
    const restarted = createFilePersistedEngineLifecycleStore(runtime.root);

    expect(restarted.load(TRANSACTION_ID)).toMatchObject({
      phase: "completed",
      resultSha256: RESULT_SHA256,
    });
    expect(() => restarted.retire(TRANSACTION_ID, "a".repeat(64))).toThrow(
      "exact completed receipt",
    );
    restarted.retire(TRANSACTION_ID, RESULT_SHA256);
    restarted.retire(TRANSACTION_ID, RESULT_SHA256);

    expect(restarted.load(TRANSACTION_ID)).toBeNull();
    expect(() => preparePersistedEngineLifecycle(runtime.input)).toThrow(
      "retired transaction identity cannot be reused",
    );
    expect(
      fs.readFileSync(
        path.join(runtime.root, PERSISTED_ENGINE_LIFECYCLE_DIRECTORY, `${TRANSACTION_ID}.retired`),
        "utf8",
      ),
    ).toBe(`${RESULT_SHA256}\n`);
  });

  it("rejects the file store when current user identity is unavailable", () => {
    vi.stubGlobal("process", { ...process, getuid: undefined });

    expect(() => createFilePersistedEngineLifecycleStore(temporaryRoot())).toThrow(
      "current user identity is unavailable",
    );
  });

  it("rejects malformed resources, noncanonical records, and symlinked phase state", () => {
    const runtime = harness({ action: "restore" });
    const prepared = preparePersistedEngineLifecycle(runtime.input);
    expect(() =>
      normalizePersistedEngineLifecycleRecord({
        ...prepared,
        resources: [{ role: "source", runtimeId: SOURCE_ID }],
      }),
    ).toThrow("source and target authority");
    expect(() => parsePersistedEngineLifecycleRecord(JSON.stringify(prepared))).toThrow(
      "not canonical",
    );
    expect(serializePersistedEngineLifecycleRecord(prepared)).toBe(`${JSON.stringify(prepared)}\n`);

    const preparedPath = path.join(
      runtime.root,
      PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
      TRANSACTION_ID,
      "prepared.json",
    );
    const outside = path.join(runtime.root, "outside.json");
    fs.renameSync(preparedPath, outside);
    fs.symlinkSync(outside, preparedPath);
    expect(() => runtime.lifecycleStore.load(TRANSACTION_ID)).toThrow(
      "must not be a symbolic link",
    );
  });

  it("does not persist an executable, endpoint, environment, credential, or mutable command", () => {
    const runtime = harness();
    preparePersistedEngineLifecycle(runtime.input);
    const persisted = fs.readFileSync(
      path.join(
        runtime.root,
        PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
        TRANSACTION_ID,
        "prepared.json",
      ),
      "utf8",
    );

    expect(persisted).not.toContain("mxcctl");
    expect(persisted).not.toContain("unix://");
    expect(persisted).not.toContain("endpointArgs");
    expect(persisted).not.toMatch(/credential|environment|command/iu);
  });
});
