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
        scope.captureExact(role, (runtimeId) => ["inspect", "--exact", runtimeId]),
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

  it("publishes prepared authority before the exact runtime mutation", async () => {
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
      scope.captureExact("source", (runtimeId) => ["stop", runtimeId]);
      return { resultSha256: RESULT_SHA256, value: undefined };
    });

    expect(events).toEqual(["ledger:mutation-authorized", "engine:mutate"]);
  });

  it("reconstructs mutation-authorized recovery in a fresh process", async () => {
    const firstCapture = vi.fn(() => {
      throw new Error("injected process crash after exact stop");
    });
    const first = harness({ action: "recovery", capture: firstCapture });
    preparePersistedEngineLifecycle(first.input);

    await expect(
      executePersistedEngineLifecycle(first.input, (scope) => {
        scope.captureExact("target", (runtimeId) => ["recover", runtimeId]);
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
      scope.captureExact("target", (runtimeId) => ["recover", runtimeId]);
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
        scope.captureExact("source", (runtimeId) => ["stop", runtimeId]);
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
        scope.captureExact("source", () => ["rm", "alpha"]);
        return { resultSha256: RESULT_SHA256, value: undefined };
      }),
    ).rejects.toThrow("persisted runtime ID exactly once");
    expect(capture).not.toHaveBeenCalled();
    expect(runtime.lifecycleStore.load(TRANSACTION_ID)?.phase).toBe("mutation-authorized");
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
