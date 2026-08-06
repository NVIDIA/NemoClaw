// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContainerEngine } from "../../adapters/container-engine";
import type { LlamaCppGgufCachePlan } from "../../inference/llama-cpp/gguf-cache-plan";
/* Test-only reconstruction of the exact immutable command for recovery fixtures. */
import {
  buildLlamaCppHostLocalServerArgv,
  type LlamaCppHostLocalLaunchContract,
  type LlamaCppHostLocalRuntimeBindings,
} from "../../inference/llama-cpp/host-local-runtime";
import {
  createDockerLlamaCppManagedLifecycle,
  type DockerLlamaCppManagedLifecycleOptions,
} from "./docker-llama-cpp-managed-lifecycle";
import type {
  HostLocalCreateJournalExecutionLease,
  HostLocalCreateJournalRecord,
  HostLocalCreateJournalStore,
} from "./host-local-create-journal";
import {
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";
import type { PersistedEngineAuthorityStore } from "./persisted-engine-authority";

const MODEL_DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:${"c".repeat(64)}`;
const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"d".repeat(64)}`;
const RUNTIME_ID = "e".repeat(64);
const NETWORK_ID = "7".repeat(64);
const TRANSACTION_ID = "9".repeat(64);
const MODEL_CONTENT = Buffer.alloc(64, 0x61);
const MODEL_FILENAME = "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
const REVISION = "f".repeat(40);
let temporaryRoot = "";
let cacheRoot = "";
let modelPath = "";
let apiKeyRoot = "";
let apiKeyPath = "";

function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonical(nested)]),
        )
      : value;
}

function invariant(condition: unknown, message: string): asserts condition {
  switch (Boolean(condition)) {
    case false:
      throw new Error(message);
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function rawDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

beforeEach(() => {
  temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-life-")));
  cacheRoot = path.join(temporaryRoot, "cache");
  modelPath = path.join(
    cacheRoot,
    "hub",
    "models--example--model",
    "snapshots",
    REVISION,
    MODEL_FILENAME,
  );
  fs.mkdirSync(path.dirname(modelPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(modelPath, MODEL_CONTENT, { mode: 0o600 });
  apiKeyRoot = path.join(temporaryRoot, "key-root");
  fs.mkdirSync(apiKeyRoot, { mode: 0o700 });
  apiKeyPath = path.join(apiKeyRoot, "api-key");
  fs.writeFileSync(apiKeyPath, "test-only-secret\n", { mode: 0o600 });
});

afterEach(() => fs.rmSync(temporaryRoot, { force: true, recursive: true }));

function contract(): LlamaCppHostLocalLaunchContract {
  return {
    model: {
      servedName: "nvidia-nemotron-3-nano-30b-a3b",
      file: {
        digest: MODEL_DIGEST,
        path: MODEL_FILENAME,
        sizeBytes: MODEL_CONTENT.length,
      },
    },
    policy: {
      egress: "disabled",
      modelDownloads: "disabled",
      modelSource: "verified-local",
    },
    runtime: {
      gpu: {
        count: 1,
        cpuFallback: "reject",
        offload: "full",
        vendor: "nvidia",
      },
      resources: {
        memoryBytes: 51_539_607_552,
        pidsLimit: 256,
        writableStorageBytes: 1024,
      },
    },
    serve: {
      authentication: "bearer",
      batchSize: 2048,
      contextSize: 262_144,
      flashAttention: "enabled",
      idleSleepSeconds: -1,
      kvCache: { key: "f16", value: "f16" },
      limits: { requestTimeoutSeconds: 900 },
      microBatchSize: 512,
      port: 8081,
      protocol: "openai-completions",
      slots: 1,
      speculativeDecoding: "disabled",
    },
    surfaces: {
      agentMode: "disabled",
      mcpProxy: "disabled",
      multimodalProjection: "disabled",
      router: "disabled",
      serverTools: "disabled",
      slotInspection: "disabled",
      ui: "disabled",
    },
  };
}

function plan(): LlamaCppGgufCachePlan {
  const payload = {
    schemaVersion: 1 as const,
    recipeId: "llama-cpp.nemotron.spark.v1",
    acquisition: {
      ref: "hugging-face-exact-file/v1" as const,
      url: `https://huggingface.co/example/model/resolve/${REVISION}/${MODEL_FILENAME}`,
      authentication: {
        mode: "optional" as const,
        environment: "HF_TOKEN" as const,
      },
      source: {
        repository: "example/model",
        revision: REVISION,
        file: {
          path: MODEL_FILENAME,
          digest: MODEL_DIGEST,
          sizeBytes: MODEL_CONTENT.length,
        },
      },
    },
    cache: {
      ref: "llama-cpp.gguf-content-addressed/v1" as const,
      receiptRef: "llama-cpp.gguf-cache-entry.receipt/v1" as const,
      root: "user-cache" as const,
      key: "sha256-model",
      quotaBytes: 1024,
      stagingHeadroomBytes: 128,
      staging: "same-filesystem" as const,
      publication: "atomic-no-clobber" as const,
      reuse: "verified-only-offline" as const,
      sharing: "owner-only" as const,
      cleanup: "receipt-owner-only" as const,
    },
  };
  return { ...payload, planDigest: digest(payload) };
}

function identity() {
  const status = fs.lstatSync(modelPath, { bigint: true });
  return {
    ctimeNs: status.ctimeNs,
    dev: status.dev,
    ino: status.ino,
    mtimeNs: status.mtimeNs,
    size: status.size,
  };
}

function keyRootIdentitySha256(): string {
  const status = fs.lstatSync(apiKeyRoot, { bigint: true });
  return rawDigest({
    schemaVersion: 1,
    identities: [
      {
        dev: status.dev.toString(),
        ino: status.ino.toString(),
        uid: status.uid.toString(),
        gid: status.gid.toString(),
        nlink: status.nlink.toString(),
        mode: (status.mode & 0o777n).toString(8),
        mtimeNs: status.mtimeNs.toString(),
        ctimeNs: status.ctimeNs.toString(),
      },
    ],
  });
}

function bindings(): LlamaCppHostLocalRuntimeBindings {
  return {
    apiKeyHostPath: apiKeyPath,
    containerName: "nemoclaw-llama-cpp",
    imageReference: IMAGE,
    model: {
      digest: MODEL_DIGEST,
      filesystemIdentity: identity(),
      hostPath: modelPath,
      sizeBytes: MODEL_CONTENT.length,
    },
    network: {
      isolation: "docker-internal",
      name: "nemoclaw-llama-cpp-internal",
    },
    ownerLabel: {
      name: "io.nvidia.nemoclaw.llama-cpp-owner",
      value: "gateway.primary",
    },
    runtimeGid: 1001,
    runtimeUid: 1001,
  };
}

function authorityStore(): PersistedEngineAuthorityStore {
  let authority: ReturnType<PersistedEngineAuthorityStore["record"]> | null = null;
  return {
    load: () => authority,
    record: (next) => (authority = next),
  };
}

interface TestJournalStore extends HostLocalCreateJournalStore {
  readonly abandonExecution: () => void;
  readonly hasExecution: () => boolean;
}

function journalStore(): TestJournalStore {
  const records = new Map<string, HostLocalCreateJournalRecord>();
  let activeLease: HostLocalCreateJournalExecutionLease | null = null;
  const update = (
    id: string,
    mutate: (value: HostLocalCreateJournalRecord) => HostLocalCreateJournalRecord,
  ) => {
    const current = records.get(id);
    invariant(current, "missing journal");
    const next = Object.freeze(mutate(current));
    records.set(id, next);
    return next;
  };
  return {
    load: (id) => records.get(id) ?? null,
    list: () => [...records.values()],
    create: (record) => {
      records.set(record.transactionId, Object.freeze(record));
      return record;
    },
    recordCreating: (id, createIntentUnixMs) =>
      update(id, (record) => ({ ...record, phase: "creating", createIntentUnixMs })),
    recordCreated: (id, runtimeId) =>
      update(id, (record) => ({ ...record, phase: "created", runtimeId })),
    recordStarted: (id) => update(id, (record) => ({ ...record, phase: "started" })),
    finalize: (id, receiptSha256) =>
      update(id, (record) => ({
        ...record,
        phase: "finalized",
        receiptSha256,
      })),
    retire: (id) => void records.delete(id),
    acquireExecution: (transactionId) => {
      invariant(activeLease === null, "execution is already owned by a live process");
      activeLease = Object.freeze({
        schemaVersion: 1,
        transactionId,
        ownerId: "12345678-1234-4123-8123-123456789abc",
        ownerPid: process.pid,
      });
      return activeLease;
    },
    assertExecution: (lease) => {
      invariant(activeLease === lease, "execution ownership changed");
    },
    releaseExecution: (lease) => {
      invariant(activeLease === lease, "execution ownership changed");
      activeLease = null;
    },
    abandonExecution: () => (activeLease = null),
    hasExecution: () => activeLease !== null,
  };
}

interface DockerFixture {
  readonly engine: ContainerEngine;
  readonly capture: ReturnType<typeof vi.fn>;
  readonly setNetworkId: (value: string) => void;
  readonly removeNetwork: () => void;
  readonly setCreateStdout: (value: string) => void;
  readonly failCreateUncertain: () => void;
  readonly failProbe: () => void;
  readonly driftHardening: () => void;
  readonly dropTmpfs: () => void;
  readonly driftGpuRequest: (driver: string | undefined, count: number) => void;
  readonly driftExtraDeviceAuthority: (kind: "cap-add" | "legacy-device") => void;
  readonly failInspectWithDaemonError: () => void;
  readonly onAbsentInspect: (callback: () => void) => void;
  readonly onStart: (callback: () => void) => void;
  readonly onCreate: (callback: () => void) => void;
  readonly seed: (journal: HostLocalCreateJournalRecord, running: boolean) => void;
}

function dockerFixture(): DockerFixture {
  let networkId = NETWORK_ID;
  let networkPresent = true;
  let createStdout = `${RUNTIME_ID}\n`;
  let createUncertain = false;
  let probeFails = false;
  let hardeningDrift = false;
  let tmpfs: Record<string, string> | null = {
    "/tmp": "rw,noexec,nosuid,nodev,size=1024,uid=1001,gid=1001,mode=1777",
  };
  let gpuDriver: string | undefined = "nvidia";
  let gpuCount = 1;
  let capAdd: null | string[] = null;
  let legacyDevices: null | object[] = null;
  let inspectDaemonError = false;
  let absentInspectHook: (() => void) | undefined;
  let startHook: (() => void) | undefined;
  let createHook: (() => void) | undefined;
  let startedOnce = false;
  let container:
    | {
        labels: Record<string, string>;
        running: boolean;
        status: string;
        transactionId: string;
        command: string[];
      }
    | undefined;

  const inspection = () => [
    {
      Id: RUNTIME_ID,
      Name: "/nemoclaw-llama-cpp",
      Config: {
        Image: IMAGE,
        User: "1001:1001",
        Cmd: container?.command ?? [],
        Labels: container?.labels ?? {},
      },
      HostConfig: {
        NetworkMode: "nemoclaw-llama-cpp-internal",
        PortBindings: { "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
        ReadonlyRootfs: !hardeningDrift,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 51_539_607_552,
        MemorySwap: 51_539_607_552,
        PidsLimit: 256,
        DeviceRequests: [
          {
            ...(gpuDriver === undefined ? {} : { Driver: gpuDriver }),
            Count: gpuCount,
            DeviceIDs: null,
            Capabilities: [["gpu"]],
            Options: {},
          },
        ],
        CapAdd: capAdd,
        Devices: legacyDevices,
        Privileged: false,
        Tmpfs: tmpfs,
      },
      State: {
        Running: container?.running ?? false,
        Status: container?.status ?? "created",
      },
      NetworkSettings: {
        Networks: { "nemoclaw-llama-cpp-internal": { NetworkID: networkId } },
        Ports: {
          "8081/tcp": startedOnce ? [{ HostIp: "127.0.0.1", HostPort: "49152" }] : null,
        },
      },
      Mounts: [
        {
          Type: "bind",
          Source: modelPath,
          Destination: `/models/${MODEL_FILENAME}`,
          RW: false,
        },
        {
          Type: "bind",
          Source: apiKeyPath,
          Destination: "/run/secrets/llama-cpp-api-key",
          RW: false,
        },
      ],
    },
  ];

  const capture = vi.fn((args: readonly string[]) => {
    const unexpected = `unexpected Docker command: ${args.join(" ")}`;
    switch (args[0]) {
      case "network":
        invariant(args[1] === "inspect", unexpected);
        return networkPresent
          ? {
              status: 0,
              stdout: JSON.stringify([{ Id: networkId, Name: args[2], Internal: true }]),
              stderr: "",
            }
          : {
              status: 1,
              stdout: "",
              stderr: `Error response from daemon: No such network: ${String(args[2])}`,
            };
      case "container": {
        invariant(args[1] === "inspect", unexpected);
        switch (inspectDaemonError) {
          case true:
            return { status: 1, stdout: "", stderr: "daemon unavailable" };
        }
        const target = args[2];
        switch (Boolean(container && (target === RUNTIME_ID || target === "nemoclaw-llama-cpp"))) {
          case true:
            return { status: 0, stdout: JSON.stringify(inspection()), stderr: "" };
        }
        absentInspectHook?.();
        return {
          status: 1,
          stdout: "",
          stderr: `Error response from daemon: No such container: ${String(target)}`,
        };
      }
      case "create": {
        switch (createUncertain) {
          case true:
            return {
              status: 1,
              stdout: "",
              stderr: "",
              error: new Error("Docker create capture timed out"),
            };
        }
        const labels = Object.fromEntries(
          args
            .flatMap((argument, index) =>
              argument === "--label" ? [String(args[index + 1]).split("=")] : [],
            )
            .filter(([name, value]) => Boolean(name && value)),
        );
        container = {
          labels,
          running: false,
          status: "created",
          transactionId: labels["io.nvidia.nemoclaw.host-local-inference.transaction-sha256"] ?? "",
          command: args.slice(args.indexOf(IMAGE) + 1),
        };
        createHook?.();
        return { status: 0, stdout: createStdout, stderr: "" };
      }
      case "start":
        startHook?.();
        switch (container) {
          case undefined:
            break;
          default:
            startedOnce = true;
            container.running = true;
            container.status = "running";
        }
        return { status: 0, stdout: `${RUNTIME_ID}\n`, stderr: "" };
      case "stop":
        switch (container) {
          case undefined:
            break;
          default:
            container.running = false;
            container.status = "exited";
        }
        return { status: 0, stdout: RUNTIME_ID, stderr: "" };
      case "rm":
        invariant(args[1] === "--force", unexpected);
        container = undefined;
        return { status: 0, stdout: RUNTIME_ID, stderr: "" };
      case "run":
        invariant(args[1] === "--rm", unexpected);
        return probeFails
          ? { status: 1, stdout: "", stderr: "not ready" }
          : { status: 0, stdout: "ok", stderr: "" };
      default:
        throw new Error(unexpected);
    }
  });
  return {
    engine: {
      operation: "host-local-inference",
      engineId: "docker",
      displayName: "Docker",
      authorityId: "docker:local",
      capture,
      captureHost: capture,
    },
    capture,
    setNetworkId: (value) => (networkId = value),
    removeNetwork: () => (networkPresent = false),
    setCreateStdout: (value) => (createStdout = value),
    failCreateUncertain: () => (createUncertain = true),
    failProbe: () => (probeFails = true),
    driftHardening: () => (hardeningDrift = true),
    dropTmpfs: () => (tmpfs = null),
    driftGpuRequest: (driver, count) => {
      gpuDriver = driver;
      gpuCount = count;
    },
    driftExtraDeviceAuthority: (kind) => {
      kind === "cap-add"
        ? (capAdd = ["SYS_ADMIN"])
        : (legacyDevices = [{ PathOnHost: "/dev/nvidia0" }]);
    },
    failInspectWithDaemonError: () => (inspectDaemonError = true),
    onAbsentInspect: (callback) => (absentInspectHook = callback),
    onStart: (callback) => (startHook = callback),
    onCreate: (callback) => (createHook = callback),
    seed: (journal, running) => {
      container = {
        labels: {
          "io.nvidia.nemoclaw.host-local-inference.managed": "true",
          "io.nvidia.nemoclaw.host-local-inference.provider": "docker",
          "io.nvidia.nemoclaw.host-local-inference.service": "llama-cpp",
          "io.nvidia.nemoclaw.host-local-inference.spec-sha256": journal.specSha256,
          "io.nvidia.nemoclaw.host-local-inference.transaction-sha256": journal.transactionId,
          "io.nvidia.nemoclaw.llama-cpp-owner": "gateway.primary",
        },
        running,
        status: running ? "running" : "created",
        transactionId: journal.transactionId,
        command: [...buildLlamaCppHostLocalServerArgv(contract())],
      };
    },
  };
}

function options(
  fixture: DockerFixture,
  store = journalStore(),
  runtimeBindings = bindings(),
  persistedAuthorityStore = authorityStore(),
): DockerLlamaCppManagedLifecycleOptions {
  return {
    authorityStore: persistedAuthorityStore,
    apiKeyRootHostPath: apiKeyRoot,
    bindingSha256: "1".repeat(64),
    bindings: runtimeBindings,
    cacheRootHostPath: cacheRoot,
    contract: contract(),
    engine: fixture.engine,
    journalStore: store,
    plan: plan(),
    probeImageReference: PROBE_IMAGE,
  };
}

function controller(fixture: DockerFixture, store = journalStore(), now: () => number = Date.now) {
  return createDockerLlamaCppManagedLifecycle(options(fixture, store), {
    createTransactionId: () => TRANSACTION_ID,
    now,
  });
}

function preparedJournal(): HostLocalCreateJournalRecord {
  return {
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    phase: "prepared",
    providerId: "docker",
    service: "llama-cpp",
    containerName: "nemoclaw-llama-cpp",
    runtimeId: null,
    createIntentUnixMs: null,
    specSha256: rawDigest({
      contract: contract(),
      apiKeyRootIdentitySha256: keyRootIdentitySha256(),
      containerName: "nemoclaw-llama-cpp",
      imageReference: IMAGE,
      model: {
        planDigest: plan().planDigest,
        recipeId: plan().recipeId,
        digest: MODEL_DIGEST,
        sizeBytes: MODEL_CONTENT.length,
      },
      network: { id: NETWORK_ID, name: "nemoclaw-llama-cpp-internal" },
      ownerLabel: {
        name: "io.nvidia.nemoclaw.llama-cpp-owner",
        value: "gateway.primary",
      },
      probeImageReference: PROBE_IMAGE,
      runtimeGid: 1001,
      runtimeUid: 1001,
    }),
    networkId: NETWORK_ID,
    engineAuthority: {
      schemaVersion: 1,
      providerId: "docker",
      operation: "host-local-inference",
      engineId: "docker",
      authorityId: "docker:local",
      bindingSha256: "1".repeat(64),
    },
    apiKeyIdentitySha256: "3".repeat(64),
    apiKeyRootIdentitySha256: keyRootIdentitySha256(),
    receiptSha256: null,
  };
}

describe("dormant Docker llama.cpp managed lifecycle", () => {
  it("journals create/start/finalize and serves the provider-neutral lifecycle in a test-only bundle (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const lifecycle = controller(fixture, store);
    const persist = vi.fn();
    const receipt = lifecycle.start(persist);
    const serialized = serializeHostLocalInferenceReceipt(receipt);

    expect(receipt.endpoint.port).toBe(49152);
    expect(receipt.runtime).toMatchObject({
      kind: "container",
      runtimeId: RUNTIME_ID,
      model: { generation: TRANSACTION_ID, planDigest: plan().planDigest },
    });
    expect(store.load(TRANSACTION_ID)).toMatchObject({
      phase: "finalized",
      runtimeId: RUNTIME_ID,
      networkId: NETWORK_ID,
    });
    expect(persist).toHaveBeenCalledExactlyOnceWith(serialized);
    expect(serialized).not.toContain(modelPath);
    expect(serialized).not.toContain(apiKeyPath);
    expect(serialized).not.toContain("filesystemIdentity");
    expect(serialized).not.toContain("test-only-secret");

    expect(serializeHostLocalInferenceReceipt(parseHostLocalInferenceReceipt(serialized))).toBe(
      serialized,
    );
    expect(lifecycle.runtime.inspectManaged(receipt).running).toBe(true);
    expect(lifecycle.runtime.stopManaged(receipt).running).toBe(false);
    expect(lifecycle.runtime.prepareDestroy(receipt)).toEqual(receipt);
    expect(lifecycle.runtime.destroy(receipt).status).toBe("removed");
    expect(lifecycle.runtime.destroy(receipt).status).toBe("already-absent");
  });

  it("keeps already-absent destroy idempotent after its Docker network is removed (#8395)", () => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(vi.fn());
    expect(lifecycle.runtime.destroy(receipt).status).toBe("removed");
    fixture.removeNetwork();
    expect(lifecycle.runtime.destroy(receipt).status).toBe("already-absent");
  });

  it("rejects canonical plan-digest drift before Docker or journal mutation (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const invalid = {
      ...options(fixture, store),
      plan: { ...plan(), planDigest: `sha256:${"0".repeat(64)}` },
    };
    expect(() => createDockerLlamaCppManagedLifecycle(invalid)).toThrow("canonical payload");
    expect(store.list()).toEqual([]);
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it("rejects a self-consistent plan for another GGUF before any mutation (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const persist = vi.fn();
    const original = plan();
    const changedPayload = {
      schemaVersion: original.schemaVersion,
      recipeId: original.recipeId,
      acquisition: {
        ...original.acquisition,
        source: {
          ...original.acquisition.source,
          file: {
            path: "Different-Nemotron.gguf",
            digest: `sha256:${"6".repeat(64)}`,
            sizeBytes: MODEL_CONTENT.length + 1,
          },
        },
      },
      cache: original.cache,
    };
    const changedPlan: LlamaCppGgufCachePlan = {
      ...changedPayload,
      planDigest: digest(changedPayload),
    };
    const lifecycle = createDockerLlamaCppManagedLifecycle(
      { ...options(fixture, store), plan: changedPlan },
      { createTransactionId: () => TRANSACTION_ID },
    );

    expect(() => lifecycle.start(persist)).toThrow(
      "plan, launch contract, and verified artifact disagree",
    );
    expect(fixture.capture).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });

  it("accepts the canonical blob resolved by the plan's exact snapshot entry (#8395)", () => {
    const snapshotEntry = modelPath;
    const blobPath = path.join(cacheRoot, "hub", "models--example--model", "blobs", "model-blob");
    fs.mkdirSync(path.dirname(blobPath), { recursive: true, mode: 0o700 });
    fs.renameSync(snapshotEntry, blobPath);
    fs.symlinkSync(path.relative(path.dirname(snapshotEntry), blobPath), snapshotEntry);
    modelPath = fs.realpathSync(snapshotEntry);

    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(vi.fn());
    expect(receipt.runtime).toMatchObject({
      kind: "container",
      runtimeId: RUNTIME_ID,
    });
    expect(lifecycle.runtime.destroy(receipt).status).toBe("removed");
  });

  it("rejects writable cache authority and non-private API-key authority (#8395)", () => {
    fs.chmodSync(path.dirname(modelPath), 0o777);
    expect(() => controller(dockerFixture()).start(vi.fn())).toThrow("owner-controlled");
    fs.chmodSync(path.dirname(modelPath), 0o700);
    fs.chmodSync(apiKeyPath, 0o644);
    expect(() => controller(dockerFixture()).start(vi.fn())).toThrow("private-file authority");
    fs.chmodSync(apiKeyPath, 0o600);
    fs.chmodSync(apiKeyRoot, 0o777);
    const unsafeParentFixture = dockerFixture();
    expect(() => controller(unsafeParentFixture).start(vi.fn())).toThrow("owner-controlled");
    expect(unsafeParentFixture.capture).not.toHaveBeenCalled();
  });

  it("rolls back exact ownership when the GGUF changes inside Docker start capture (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    fixture.onStart(() => {
      fs.writeFileSync(modelPath, Buffer.alloc(MODEL_CONTENT.length, 0x62));
      const future = new Date(Date.now() + 10_000);
      fs.utimesSync(modelPath, future, future);
    });
    expect(() => controller(fixture, store).start(vi.fn())).toThrow("filesystem identity");
    expect(store.list()).toEqual([]);
    expect(fixture.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).toContainEqual([
      "rm",
      "--force",
    ]);
  });

  it("rolls back pathname replacement from inside Docker create capture before persistence (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const persist = vi.fn();
    fixture.onCreate(() => {
      fs.renameSync(modelPath, `${modelPath}.verified`);
      fs.writeFileSync(modelPath, MODEL_CONTENT, { mode: 0o600 });
    });
    expect(() => controller(fixture, store).start(persist)).toThrow("filesystem identity");
    expect(persist).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(fixture.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).toContainEqual([
      "rm",
      "--force",
    ]);
  });

  it("rolls back an API-key root swap-and-restore inside Docker create capture (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const persist = vi.fn();
    fixture.onCreate(() => {
      const retained = `${apiKeyRoot}.retained`;
      fs.renameSync(apiKeyRoot, retained);
      fs.mkdirSync(apiKeyRoot, { mode: 0o700 });
      fs.writeFileSync(path.join(apiKeyRoot, "api-key"), "attacker-key\n", {
        mode: 0o600,
      });
      fs.rmSync(apiKeyRoot, { recursive: true });
      fs.renameSync(retained, apiKeyRoot);
      const future = new Date(Date.now() + 10_000);
      fs.utimesSync(apiKeyRoot, future, future);
    });
    expect(() => controller(fixture, store).start(persist)).toThrow("API-key file changed");
    expect(persist).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(fixture.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).toContainEqual([
      "rm",
      "--force",
    ]);
  });

  it("rolls back malformed create output, readiness failure, and receipt persistence failure (#8395)", () => {
    const arrangeFailure = {
      stdout: (fixture: DockerFixture) => fixture.setCreateStdout("short-id\n"),
      probe: (fixture: DockerFixture) => fixture.failProbe(),
      persist: (_fixture: DockerFixture) => undefined,
    } as const;
    for (const failure of ["stdout", "probe", "persist"] as const) {
      const fixture = dockerFixture();
      const store = journalStore();
      arrangeFailure[failure](fixture);
      const persist =
        failure === "persist"
          ? () => {
              throw new Error("persist failed");
            }
          : vi.fn();
      expect(() => controller(fixture, store).start(persist)).toThrow();
      expect(store.list()).toEqual([]);
      expect(fixture.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).toContainEqual([
        "rm",
        "--force",
      ]);
    }
  });

  it("holds execution authority after an uncertain create and recovers a late exact container (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    let now = 1_000;
    const lifecycle = controller(fixture, store, () => now);
    fixture.failCreateUncertain();

    expect(() => lifecycle.start(vi.fn())).toThrow("container create failed");
    const creating = store.load(TRANSACTION_ID);
    expect(creating).toMatchObject({
      phase: "creating",
      runtimeId: null,
      createIntentUnixMs: now,
    });
    expect(store.hasExecution()).toBe(true);

    const concurrent = lifecycle.recoverUnfinished();
    expect(concurrent.recovered).toEqual([]);
    expect(concurrent.failures[0]?.message).toContain("already owned");
    expect(store.load(TRANSACTION_ID)).not.toBeNull();

    store.abandonExecution();
    const insideGrace = lifecycle.recoverUnfinished();
    expect(insideGrace.recovered).toEqual([]);
    expect(insideGrace.failures[0]?.message).toContain("absence grace period");
    expect(store.load(TRANSACTION_ID)).not.toBeNull();

    invariant(creating, "expected creating journal");
    now += 31 * 60 * 1_000;
    let appeared = false;
    fixture.onAbsentInspect(() => {
      switch (appeared) {
        case false:
          appeared = true;
          fixture.seed(creating, false);
      }
    });
    expect(lifecycle.recoverUnfinished()).toEqual({
      recovered: [TRANSACTION_ID],
      failures: [],
    });
    expect(appeared).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("recovers prepared and exact creating/created/started journals without touching finalized ownership (#8395)", () => {
    for (const phase of ["prepared", "creating", "created", "started"] as const) {
      const fixture = dockerFixture();
      const store = journalStore();
      const base = preparedJournal();
      store.create(base);
      const arrangePhase = {
        prepared: () => undefined,
        creating: () => void store.recordCreating(TRANSACTION_ID, 1_000),
        created: () => {
          store.recordCreating(TRANSACTION_ID, 1_000);
          fixture.seed(store.recordCreated(TRANSACTION_ID, RUNTIME_ID), false);
        },
        started: () => {
          store.recordCreating(TRANSACTION_ID, 1_000);
          store.recordCreated(TRANSACTION_ID, RUNTIME_ID);
          fixture.seed(store.recordStarted(TRANSACTION_ID), true);
        },
      } as const;
      arrangePhase[phase]();
      const persistedAuthority = authorityStore();
      persistedAuthority.record(base.engineAuthority);
      const recovery = createDockerLlamaCppManagedLifecycle(
        options(fixture, store, bindings(), persistedAuthority),
        { now: () => 31 * 60 * 1_000 },
      ).recoverUnfinished();
      expect(recovery).toEqual({ recovered: [TRANSACTION_ID], failures: [] });
      expect(store.list()).toEqual([]);
    }
  });

  it("refuses unfinished recovery when protected engine authority is missing or drifted (#8395)", () => {
    for (const state of ["missing", "drifted"] as const) {
      const fixture = dockerFixture();
      const store = journalStore();
      const base = preparedJournal();
      store.create(base);
      store.recordCreating(base.transactionId, 1_000);
      const created = store.recordCreated(base.transactionId, RUNTIME_ID);
      fixture.seed(created, false);
      const persistedAuthority = authorityStore();
      const arrangeAuthority = {
        missing: () => undefined,
        drifted: () =>
          persistedAuthority.record({
            ...base.engineAuthority,
            bindingSha256: "2".repeat(64),
          }),
      } as const;
      arrangeAuthority[state]();
      const recovery = createDockerLlamaCppManagedLifecycle(
        options(fixture, store, bindings(), persistedAuthority),
      ).recoverUnfinished();
      expect(recovery.recovered).toEqual([]);
      expect(recovery.failures).toHaveLength(1);
      expect(store.load(TRANSACTION_ID)).not.toBeNull();
      expect(fixture.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).not.toContainEqual([
        "rm",
        "--force",
      ]);
    }
  });

  it("fails re-prove on Docker network identity drift (#8395)", () => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(vi.fn());
    fixture.setNetworkId("8".repeat(64));
    expect(() => lifecycle.runtime.preserveForRebuild(receipt)).toThrow(
      "internal network identity changed",
    );
  });

  it("rejects effective hardening drift after creation (#8395)", () => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(vi.fn());
    fixture.driftHardening();
    expect(() => lifecycle.runtime.inspectManaged(receipt)).toThrow("exact journal authority");

    for (const mutate of [
      (candidate: DockerFixture) => candidate.driftGpuRequest(undefined, 1),
      (candidate: DockerFixture) => candidate.driftGpuRequest("nvidia", 2),
      (candidate: DockerFixture) => candidate.driftExtraDeviceAuthority("cap-add"),
      (candidate: DockerFixture) => candidate.driftExtraDeviceAuthority("legacy-device"),
      (candidate: DockerFixture) => candidate.dropTmpfs(),
    ]) {
      const candidate = dockerFixture();
      const candidateLifecycle = controller(candidate);
      const candidateReceipt = candidateLifecycle.start(vi.fn());
      mutate(candidate);
      expect(() => candidateLifecycle.runtime.inspectManaged(candidateReceipt)).toThrow(
        "exact journal authority",
      );
    }
  });

  it("fails closed on crafted absent destroy authority and status-one daemon errors (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const lifecycle = controller(fixture, store);
    const receipt = lifecycle.start(vi.fn());
    invariant(receipt.runtime.kind === "container", "expected container receipt");
    const crafted = {
      ...receipt,
      runtime: { ...receipt.runtime, runtimeId: "a".repeat(64) },
    };
    expect(() => lifecycle.runtime.destroy(crafted)).toThrow("durable create journal");
    expect(store.load(TRANSACTION_ID)).not.toBeNull();

    const unavailable = dockerFixture();
    const unavailableStore = journalStore();
    unavailable.failInspectWithDaemonError();
    expect(() => controller(unavailable, unavailableStore).start(vi.fn())).toThrow(
      "container inspection failed",
    );
    expect(unavailableStore.list()).toEqual([]);
  });
});
