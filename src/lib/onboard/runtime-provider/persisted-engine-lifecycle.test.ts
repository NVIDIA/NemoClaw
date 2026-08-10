// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  createFilePersistedEngineLifecycleStore,
  executePersistedEngineLifecycle,
  normalizePersistedEngineLifecycleRecord,
  PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
  type PersistedEngineLifecycleAction,
  type PersistedEngineLifecycleResource,
  parsePersistedEngineLifecycleRecord,
  preparePersistedEngineLifecycle,
  serializePersistedEngineLifecycleRecord,
} from "./persisted-engine-lifecycle";

const TRANSACTION_ID = "1".repeat(64);
const BINDING_SHA256 = "2".repeat(64);
const RUNTIME_STATE_SHA256 = "3".repeat(64);
const RESULT_SHA256 = "4".repeat(64);
const SOURCE_ID = `mxc-session:${"5".repeat(64)}`;
const TARGET_ID = `mxc-session:${"6".repeat(64)}`;
const AUTHORITY_ID = `mxc-endpoint:${"7".repeat(64)}`;
const roots: string[] = [];

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
): readonly PersistedEngineLifecycleResource[] {
  switch (action) {
    case "snapshot-create":
    case "backup":
      return [{ role: "source", runtimeId: SOURCE_ID }];
    case "recovery":
      return [{ role: "target", runtimeId: TARGET_ID }];
    case "snapshot-clone":
    case "rebuild":
    case "restore":
      return [
        { role: "source", runtimeId: SOURCE_ID },
        { role: "target", runtimeId: TARGET_ID },
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
      sandboxName: "alpha",
      resources: resources(action),
      runtimeStateSha256: options.runtimeStateSha256 ?? RUNTIME_STATE_SHA256,
      providerId: "mxc",
      bindingSha256: BINDING_SHA256,
      engine,
      engineAuthorityStore,
      lifecycleStore,
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
          args: ["rm", "other-runtime", "--authorized-id", runtimeId],
          targetIndex: 1,
        }));
        return { resultSha256: RESULT_SHA256, value: undefined };
      }),
    ).rejects.toThrow("target must be its persisted runtime ID");
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
