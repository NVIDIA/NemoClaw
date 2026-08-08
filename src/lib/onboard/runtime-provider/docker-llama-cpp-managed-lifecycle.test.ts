// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContainerEngine } from "../../adapters/container-engine";
import { LLAMA_CPP_PORT } from "../../inference/llama-cpp/contract";
import type { LlamaCppGgufCachePlan } from "../../inference/llama-cpp/gguf-cache-plan";
import { buildLlamaCppHostLocalServerArgv } from "../../inference/llama-cpp/host-local-runtime";
import {
  createDockerLlamaCppManagedLifecycle,
  type DockerLlamaCppManagedLifecycleOptions,
} from "./docker-llama-cpp-managed-lifecycle";
import {
  contract,
  digest,
  HOST_PORT,
  IMAGE,
  invariant,
  MODEL_CONTENT,
  MODEL_DIGEST,
  MODEL_FILENAME,
  NETWORK_ID,
  PROBE_IMAGE,
  RECEIPT_TARGET_SHA256,
  REVISION,
  RUNTIME_ID,
  rawDigest,
  TRANSACTION_ID,
} from "./docker-llama-cpp-managed-lifecycle.test-support";
import type {
  HostLocalCreateJournalExecutionLease,
  HostLocalCreateJournalRecord,
  HostLocalCreateJournalStore,
} from "./host-local-create-journal";
import {
  type HostLocalInferenceReceiptWriter,
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";
import type { PersistedEngineAuthorityStore } from "./persisted-engine-authority";

let temporaryRoot = "";
let cacheRoot = "";
let modelPath = "";
let apiKeyRoot = "";
let apiKeyPath = "";

function receiptWriter(
  writeExact: (serializedReceipt: string) => string = (serializedReceipt) => serializedReceipt,
  overrides: Partial<Pick<HostLocalInferenceReceiptWriter, "targetSha256" | "transactionId">> = {},
): HostLocalInferenceReceiptWriter & { readonly writeExact: ReturnType<typeof vi.fn> } {
  return {
    transactionId: overrides.transactionId ?? TRANSACTION_ID,
    targetSha256: overrides.targetSha256 ?? RECEIPT_TARGET_SHA256,
    writeExact: vi.fn(writeExact),
  };
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

function plan(): LlamaCppGgufCachePlan {
  const payload = {
    schemaVersion: 1 as const,
    recipeId: "llama-cpp.nemotron.spark.v1",
    acquisition: {
      ref: "hugging-face-exact-file/v1" as const,
      downloaderImage: `nvcr.io/nvidia/vllm@sha256:${"d".repeat(64)}`,
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
      ref: "hugging-face-shared-cache/v1" as const,
      root: "user-cache" as const,
      key: "sha256-model",
      reuse: "verify-exact-file" as const,
      sharing: "host-user" as const,
      cleanup: "preserve" as const,
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

function bindings(): DockerLlamaCppManagedLifecycleOptions["bindings"] {
  return {
    apiKeyHostPath: apiKeyPath,
    containerName: "nemoclaw-llama-cpp",
    hostPort: LLAMA_CPP_PORT,
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
  readonly failNextPrepareReceipt: () => void;
  readonly failNextPrepareReceiptAfterCommit: () => void;
  readonly failNextFinalize: () => void;
}

function journalStore(): TestJournalStore {
  const records = new Map<string, HostLocalCreateJournalRecord>();
  let activeLease: HostLocalCreateJournalExecutionLease | null = null;
  let prepareReceiptFails = false;
  let prepareReceiptFailsAfterCommit = false;
  let finalizeFails = false;
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
    recordNetworkCreated: (id, networkId) =>
      update(id, (record) => ({
        ...record,
        phase: "prepared",
        networkId,
        createIntentUnixMs: null,
      })),
    recordCreating: (id, createIntentUnixMs) =>
      update(id, (record) => ({ ...record, phase: "creating", createIntentUnixMs })),
    recordCreated: (id, runtimeId) =>
      update(id, (record) => ({ ...record, phase: "created", runtimeId })),
    recordStarted: (id) => update(id, (record) => ({ ...record, phase: "started" })),
    prepareReceipt: (id, serializedReceipt) => {
      switch (prepareReceiptFails) {
        case true:
          prepareReceiptFails = false;
          throw new Error("prepare receipt failed");
      }
      const prepared = update(id, (record) => ({
        ...record,
        phase: "receipt-prepared",
        serializedReceipt,
        receiptSha256: createHash("sha256").update(serializedReceipt).digest("hex"),
      }));
      switch (prepareReceiptFailsAfterCommit) {
        case true:
          prepareReceiptFailsAfterCommit = false;
          throw new Error("prepare receipt outcome unknown");
      }
      return prepared;
    },
    finalize: (id) => {
      switch (finalizeFails) {
        case true:
          finalizeFails = false;
          throw new Error("finalize failed");
      }
      return update(id, (record) => ({
        ...record,
        phase: "finalized",
      }));
    },
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
    failNextPrepareReceipt: () => (prepareReceiptFails = true),
    failNextPrepareReceiptAfterCommit: () => (prepareReceiptFailsAfterCommit = true),
    failNextFinalize: () => (finalizeFails = true),
  };
}

interface DockerFixture {
  readonly engine: ContainerEngine;
  readonly capture: ReturnType<typeof vi.fn>;
  readonly setNetworkId: (value: string) => void;
  readonly setNetworkTransactionId: (value: string) => void;
  readonly removeNetwork: () => void;
  readonly failNetworkCreateUncertain: (networkAppears: boolean) => void;
  readonly setCreateStdout: (value: string) => void;
  readonly failCreateUncertain: () => void;
  readonly failProbe: () => void;
  readonly driftHardening: () => void;
  readonly dropTmpfs: () => void;
  readonly driftGpuRequest: (driver: string | undefined, count: number) => void;
  readonly driftExtraDeviceAuthority: (kind: "cap-add" | "legacy-device") => void;
  readonly failInspectWithDaemonError: () => void;
  readonly setAbsentNetworkInspectError: (value: string) => void;
  readonly onAbsentInspect: (callback: () => void) => void;
  readonly onAbsentNetworkInspect: (callback: () => void) => void;
  readonly onNetworkCreate: (callback: () => void) => void;
  readonly onStart: (callback: () => void) => void;
  readonly onProbe: (callback: () => void) => void;
  readonly onCreate: (callback: () => void) => void;
  readonly setContainerState: (running: boolean, status: string) => void;
  readonly seedNetwork: (journal: HostLocalCreateJournalRecord) => void;
  readonly seed: (journal: HostLocalCreateJournalRecord, running: boolean) => void;
}

function dockerFixture(
  configuredHostPort = HOST_PORT,
  publishedHostPort?: string,
  publishedHostIp = "127.0.0.1",
  publishedBindingCount = 1,
): DockerFixture {
  const effectivePublishedHostPort = publishedHostPort ?? (configuredHostPort || "49152");
  let networkId = NETWORK_ID;
  let networkPresent = false;
  let networkTransactionId = TRANSACTION_ID;
  let networkCreateUncertain = false;
  let uncertainNetworkAppears = false;
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
  let absentNetworkInspectError: string | null = null;
  let absentInspectHook: (() => void) | undefined;
  let absentNetworkInspectHook: (() => void) | undefined;
  let networkCreateHook: (() => void) | undefined;
  let startHook: (() => void) | undefined;
  let probeHook: (() => void) | undefined;
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
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
        PortBindings: {
          "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: configuredHostPort }],
        },
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
          "8081/tcp": startedOnce
            ? Array.from({ length: publishedBindingCount }, () => ({
                HostIp: publishedHostIp,
                HostPort: effectivePublishedHostPort,
              }))
            : null,
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
        switch (args[1]) {
          case "inspect":
            switch (networkPresent) {
              case false:
                absentNetworkInspectHook?.();
            }
            return networkPresent
              ? {
                  status: 0,
                  stdout: JSON.stringify([
                    {
                      Id: networkId,
                      Name: args[2],
                      Internal: true,
                      Driver: "bridge",
                      Scope: "local",
                      Labels: {
                        "io.nvidia.nemoclaw.llama-cpp-owner": "gateway.primary",
                        "io.nvidia.nemoclaw.host-local-inference.network-transaction-sha256":
                          networkTransactionId,
                      },
                    },
                  ]),
                  stderr: "",
                }
              : {
                  status: 1,
                  stdout: "",
                  stderr:
                    absentNetworkInspectError ??
                    `Error response from daemon: No such network: ${String(args[2])}`,
                };
          case "create": {
            networkCreateHook?.();
            const labelIndex = args.lastIndexOf("--label");
            networkTransactionId = String(args[labelIndex + 1]).split("=")[1] ?? "";
            networkPresent = !networkCreateUncertain || uncertainNetworkAppears;
            switch (networkCreateUncertain) {
              case true:
                return {
                  status: 1,
                  stdout: "",
                  stderr: "",
                  error: new Error("Docker network create capture timed out"),
                };
            }
            return { status: 0, stdout: `${networkId}\n`, stderr: "" };
          }
          case "rm":
            invariant(args[2] === networkId, unexpected);
            networkPresent = false;
            return { status: 0, stdout: `${networkId}\n`, stderr: "" };
          default:
            throw new Error(unexpected);
        }
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
        probeHook?.();
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
    setNetworkTransactionId: (value) => (networkTransactionId = value),
    removeNetwork: () => (networkPresent = false),
    failNetworkCreateUncertain: (networkAppears) => {
      networkCreateUncertain = true;
      uncertainNetworkAppears = networkAppears;
    },
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
    setAbsentNetworkInspectError: (value) => (absentNetworkInspectError = value),
    onAbsentInspect: (callback) => (absentInspectHook = callback),
    onAbsentNetworkInspect: (callback) => (absentNetworkInspectHook = callback),
    onNetworkCreate: (callback) => (networkCreateHook = callback),
    onStart: (callback) => (startHook = callback),
    onProbe: (callback) => (probeHook = callback),
    onCreate: (callback) => (createHook = callback),
    setContainerState: (running, status) => {
      invariant(container !== undefined, "cannot change an absent fixture container");
      container.running = running;
      container.status = status;
    },
    seedNetwork: (journal) => {
      invariant(journal.networkId !== null, "seeded network identity is missing");
      networkId = journal.networkId;
      networkTransactionId = journal.transactionId;
      networkPresent = true;
    },
    seed: (journal, running) => {
      invariant(journal.networkId !== null, "seeded network identity is missing");
      networkId = journal.networkId;
      networkTransactionId = journal.transactionId;
      networkPresent = true;
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

function dockerCommandPrefixes(fixture: DockerFixture): unknown[] {
  return fixture.capture.mock.calls.map((call) => call[0]?.slice(0, 2));
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
    readinessTimeoutSeconds: 1_800,
  };
}

function controller(fixture: DockerFixture, store = journalStore(), now: () => number = Date.now) {
  return createDockerLlamaCppManagedLifecycle(options(fixture, store), {
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
        filesystemIdentitySha256: rawDigest({
          dev: identity().dev.toString(),
          ino: identity().ino.toString(),
          size: identity().size.toString(),
          mtimeNs: identity().mtimeNs.toString(),
          ctimeNs: identity().ctimeNs.toString(),
        }),
        sizeBytes: MODEL_CONTENT.length,
      },
      network: { isolation: "docker-internal", name: "nemoclaw-llama-cpp-internal" },
      ownerLabel: {
        name: "io.nvidia.nemoclaw.llama-cpp-owner",
        value: "gateway.primary",
      },
      probeImageReference: PROBE_IMAGE,
      readinessTimeoutSeconds: 1_800,
      receiptTargetSha256: RECEIPT_TARGET_SHA256,
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
    receiptTargetSha256: RECEIPT_TARGET_SHA256,
    serializedReceipt: null,
    receiptSha256: null,
  };
}

describe("dormant Docker llama.cpp managed lifecycle", () => {
  it("journals a product install on its declared loopback host port (#8544)", () => {
    const fixture = dockerFixture("8081");
    const store = journalStore();
    const lifecycle = createDockerLlamaCppManagedLifecycle(
      options(fixture, store, { ...bindings(), hostPort: 8081 }),
    );
    const writer = receiptWriter();
    const receipt = lifecycle.start(writer);
    const serialized = serializeHostLocalInferenceReceipt(receipt);
    expect(receipt.endpoint.port).toBe(8081);
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
    expect(writer.writeExact).toHaveBeenCalledExactlyOnceWith(serialized);
    expect(serialized).not.toContain(modelPath);
    expect(serialized).not.toContain(apiKeyPath);
    expect(serialized).not.toContain("filesystemIdentity");
    expect(serialized).not.toContain("test-only-secret");
    const roundTrip = serializeHostLocalInferenceReceipt(
      parseHostLocalInferenceReceipt(serialized),
    );
    expect(roundTrip).toBe(serialized);
    expect(lifecycle.runtime.inspectManaged(receipt).running).toBe(true);
    expect(lifecycle.runtime.stopManaged(receipt).running).toBe(false);
    expect(lifecycle.runtime.prepareDestroy(receipt)).toEqual(receipt);
    expect(lifecycle.runtime.destroy(receipt).status).toBe("removed");
    expect(lifecycle.runtime.destroy(receipt).status).toBe("already-absent");
  });

  it("resumes an already-running receipt without creating or starting resources (#8144)", () => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(receiptWriter());
    fixture.capture.mockClear();

    expect(lifecycle.resume(receipt)).toEqual(receipt);
    const calls = fixture.capture.mock.calls.map((call) => call[0]);
    expect(calls).toContainEqual(expect.arrayContaining(["container", "inspect", RUNTIME_ID]));
    expect(calls).toContainEqual(expect.arrayContaining(["run", "--rm"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["start"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["create"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["network", "create"]));
  });

  it("resumes only the receipt-bound stopped runtime and rechecks readiness (#8144)", () => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(receiptWriter());
    lifecycle.runtime.stopManaged(receipt);
    fixture.capture.mockClear();

    expect(lifecycle.resume(receipt)).toEqual(receipt);
    const calls = fixture.capture.mock.calls.map((call) => call[0]);
    expect(calls.filter((args) => args[0] === "start")).toEqual([["start", RUNTIME_ID]]);
    expect(calls).toContainEqual(expect.arrayContaining(["run", "--rm"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["create"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["network", "create"]));
  });

  it("rejects a non-resumable exact runtime without lifecycle mutation (#8144)", () => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(receiptWriter());
    fixture.setContainerState(false, "paused");
    fixture.capture.mockClear();

    expect(() => lifecycle.resume(receipt)).toThrow("inconsistent runtime state");
    const calls = fixture.capture.mock.calls.map((call) => call[0]);
    expect(calls).not.toContainEqual(expect.arrayContaining(["start"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["create"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["network", "create"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["run", "--rm"]));
  });

  it.each([
    [
      "model filesystem",
      (fixture: DockerFixture) => fixture.onProbe(() => fs.appendFileSync(modelPath, "drift")),
      /filesystem identity/u,
    ],
    [
      "API-key",
      (fixture: DockerFixture) =>
        fixture.onProbe(() => fs.writeFileSync(apiKeyPath, "changed-test-only-secret\n")),
      /API-key/u,
    ],
    [
      "network",
      (fixture: DockerFixture) => fixture.onProbe(() => fixture.setNetworkId("6".repeat(64))),
      /network identity/u,
    ],
  ] as const)("fails closed on post-readiness %s drift without replacement (#8144)", (_kind, drift, expected) => {
    const fixture = dockerFixture();
    const store = journalStore();
    const lifecycle = controller(fixture, store);
    const receipt = lifecycle.start(receiptWriter());
    lifecycle.runtime.stopManaged(receipt);
    drift(fixture);
    fixture.capture.mockClear();

    expect(() => lifecycle.resume(receipt)).toThrow(expected);
    const calls = fixture.capture.mock.calls.map((call) => call[0]);
    expect(calls.filter((args) => args[0] === "start")).toEqual([["start", RUNTIME_ID]]);
    expect(calls).toContainEqual(expect.arrayContaining(["run", "--rm"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["create"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["network", "create"]));
    expect(store.load(TRANSACTION_ID)).toMatchObject({ phase: "finalized", runtimeId: RUNTIME_ID });
  });
  it.each([
    ["configured", "8082", undefined, /bound host port/u],
    ["published", "8081", "8082", /declared binding/u],
  ] as const)("rolls back exact ownership for %s loopback port drift (#8544)", (_kind, configured, published, expectedError) => {
    const [fixture, store] = [dockerFixture(configured, published), journalStore()];
    const lifecycle = createDockerLlamaCppManagedLifecycle(
      options(fixture, store, { ...bindings(), hostPort: 8081 }),
    );
    expect(() => lifecycle.start(receiptWriter())).toThrow(expectedError);
    const calls = fixture.capture.mock.calls.map((call) => call[0]);
    expect(calls).toContainEqual(["rm", "--force", RUNTIME_ID]);
    expect(calls).toContainEqual(["network", "rm", NETWORK_ID]);
    expect(store.list()).toEqual([]);
  });
  it("rejects and cleans up malformed or non-loopback published bindings (#8544)", () => {
    for (const args of [
      [HOST_PORT, HOST_PORT, "0.0.0.0", 1],
      ["8081", "8082", "0.0.0.0", 1],
      ["8081", "invalid", "127.0.0.1", 1],
      ["8081", "8082", "127.0.0.1", 2],
    ] as const) {
      const [fixture, store] = [dockerFixture(args[0], args[1], args[2], args[3]), journalStore()];
      const lifecycle = createDockerLlamaCppManagedLifecycle(
        options(fixture, store, { ...bindings(), hostPort: 8081 }),
      );
      expect(() => lifecycle.start(receiptWriter())).toThrow(/port|binding/u);
      const calls = fixture.capture.mock.calls.map((call) => call[0]);
      expect(store.list()).toEqual([]);
      expect(calls).toContainEqual(["rm", "--force", RUNTIME_ID]);
      expect(calls).toContainEqual(["network", "rm", NETWORK_ID]);
    }
  });
  it("uses the declarative readiness timeout as both curl retry budget and capture budget", () => {
    const fixture = dockerFixture();
    const lifecycle = createDockerLlamaCppManagedLifecycle({
      ...options(fixture),
      readinessTimeoutSeconds: 37,
    });
    lifecycle.start(receiptWriter());
    const probe = fixture.capture.mock.calls.find(([args]) => args[0] === "run");
    expect(probe).toBeDefined();
    const [args, timeoutMs] = probe!;
    expect(args.slice(args.indexOf("--max-time"), args.indexOf("--max-time") + 2)).toEqual([
      "--max-time",
      "37",
    ]);
    expect(args.slice(args.indexOf("--retry"), args.indexOf("--retry") + 2)).toEqual([
      "--retry",
      "37",
    ]);
    expect(
      args.slice(args.indexOf("--retry-max-time"), args.indexOf("--retry-max-time") + 2),
    ).toEqual(["--retry-max-time", "37"]);
    expect(timeoutMs).toBe(52_000);
  });
  it("rejects an invalid declarative readiness timeout before inspection or mutation", () => {
    const fixture = dockerFixture();
    expect(() =>
      createDockerLlamaCppManagedLifecycle({
        ...options(fixture),
        readinessTimeoutSeconds: 0,
      }),
    ).toThrow("readiness timeout must be 1-86400 seconds");
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it("keeps already-absent destroy idempotent after its Docker network is removed (#8395)", () => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(receiptWriter());
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
    const writer = receiptWriter();
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
    const lifecycle = createDockerLlamaCppManagedLifecycle({
      ...options(fixture, store),
      plan: changedPlan,
    });

    expect(() => lifecycle.start(writer)).toThrow(
      "plan, launch contract, and verified artifact disagree",
    );
    expect(fixture.capture).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(writer.writeExact).not.toHaveBeenCalled();
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
    const receipt = lifecycle.start(receiptWriter());
    expect(receipt.runtime).toMatchObject({
      kind: "container",
      runtimeId: RUNTIME_ID,
    });
    expect(lifecycle.runtime.destroy(receipt).status).toBe("removed");
  });

  it("rejects writable cache authority and non-private API-key authority (#8395)", () => {
    fs.chmodSync(path.dirname(modelPath), 0o777);
    expect(() => controller(dockerFixture()).start(receiptWriter())).toThrow("owner-controlled");
    fs.chmodSync(path.dirname(modelPath), 0o700);
    fs.chmodSync(apiKeyPath, 0o644);
    expect(() => controller(dockerFixture()).start(receiptWriter())).toThrow(
      "private-file authority",
    );
    fs.chmodSync(apiKeyPath, 0o600);
    fs.chmodSync(apiKeyRoot, 0o777);
    const unsafeParentFixture = dockerFixture();
    expect(() => controller(unsafeParentFixture).start(receiptWriter())).toThrow(
      "owner-controlled",
    );
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
    expect(() => controller(fixture, store).start(receiptWriter())).toThrow("filesystem identity");
    expect(store.list()).toEqual([]);
    expect(dockerCommandPrefixes(fixture)).toContainEqual(["rm", "--force"]);
  });

  it("rolls back pathname replacement from inside Docker create capture before persistence (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const writer = receiptWriter();
    fixture.onCreate(() => {
      fs.renameSync(modelPath, `${modelPath}.verified`);
      fs.writeFileSync(modelPath, MODEL_CONTENT, { mode: 0o600 });
    });
    expect(() => controller(fixture, store).start(writer)).toThrow("filesystem identity");
    expect(writer.writeExact).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(dockerCommandPrefixes(fixture)).toContainEqual(["rm", "--force"]);
  });

  it("rolls back an API-key root swap-and-restore inside Docker create capture (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const writer = receiptWriter();
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
    expect(() => controller(fixture, store).start(writer)).toThrow("API-key file changed");
    expect(writer.writeExact).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(dockerCommandPrefixes(fixture)).toContainEqual(["rm", "--force"]);
  });

  it("rolls back malformed create output and readiness failure before receipt prepare (#8395)", () => {
    const arrangeFailure = {
      stdout: (fixture: DockerFixture) => fixture.setCreateStdout("short-id\n"),
      probe: (fixture: DockerFixture) => fixture.failProbe(),
    } as const;
    for (const failure of ["stdout", "probe"] as const) {
      const fixture = dockerFixture();
      const store = journalStore();
      arrangeFailure[failure](fixture);
      expect(() => controller(fixture, store).start(receiptWriter())).toThrow();
      expect(store.list()).toEqual([]);
      expect(dockerCommandPrefixes(fixture)).toContainEqual(["rm", "--force"]);
    }
  });

  it("rolls back when durable receipt preparation fails before publication is possible (#8414)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    store.failNextPrepareReceipt();

    expect(() => controller(fixture, store).start(receiptWriter())).toThrow(
      "prepare receipt failed",
    );
    expect(store.list()).toEqual([]);
    expect(dockerCommandPrefixes(fixture)).toContainEqual(["rm", "--force"]);
  });

  it("preserves and replays when receipt preparation commits then throws (#8414)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const writer = receiptWriter();
    const lifecycle = controller(fixture, store);
    store.failNextPrepareReceiptAfterCommit();

    expect(() => lifecycle.start(writer)).toThrow("prepare receipt outcome unknown");
    expect(store.load(TRANSACTION_ID)?.phase).toBe("receipt-prepared");
    expect(writer.writeExact).not.toHaveBeenCalled();
    expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["rm", "--force"]);
    expect(lifecycle.recoverUnfinished(writer)).toEqual({
      recovered: [TRANSACTION_ID],
      failures: [],
    });
    expect(store.load(TRANSACTION_ID)?.phase).toBe("finalized");
    expect(writer.writeExact).toHaveBeenCalledTimes(1);
  });

  it("preserves and replays a receipt when the exact writer commits then throws (#8414)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    let committed: string | null = null;
    const writer = receiptWriter((serializedReceipt) => {
      switch (committed) {
        case null:
          committed = serializedReceipt;
          throw new Error("writer outcome unknown");
        default:
          invariant(committed === serializedReceipt, "different receipt");
          return committed;
      }
    });
    const lifecycle = controller(fixture, store);

    expect(() => lifecycle.start(writer)).toThrow("writer outcome unknown");
    expect(store.load(TRANSACTION_ID)).toMatchObject({
      phase: "receipt-prepared",
      serializedReceipt: committed,
    });
    expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["rm", "--force"]);
    expect(lifecycle.recoverUnfinished(writer)).toEqual({
      recovered: [TRANSACTION_ID],
      failures: [],
    });
    expect(store.load(TRANSACTION_ID)?.phase).toBe("finalized");
    expect(writer.writeExact).toHaveBeenCalledTimes(2);
  });

  it("replays an exact committed receipt after journal finalization fails (#8414)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const writer = receiptWriter();
    const lifecycle = controller(fixture, store);
    store.failNextFinalize();

    expect(() => lifecycle.start(writer)).toThrow("finalize failed");
    expect(store.load(TRANSACTION_ID)?.phase).toBe("receipt-prepared");
    expect(lifecycle.recoverUnfinished(writer)).toEqual({
      recovered: [TRANSACTION_ID],
      failures: [],
    });
    expect(store.load(TRANSACTION_ID)?.phase).toBe("finalized");
    expect(writer.writeExact).toHaveBeenCalledTimes(2);
  });

  it("fails closed on receipt writer target or existing-value drift (#8414)", () => {
    for (const drift of ["transaction", "target", "value"] as const) {
      const fixture = dockerFixture();
      const store = journalStore();
      const initialWriter = receiptWriter(() => {
        throw new Error("writer unavailable");
      });
      const lifecycle = controller(fixture, store);
      expect(() => lifecycle.start(initialWriter)).toThrow("writer unavailable");
      const writesBeforeRecovery = fixture.capture.mock.calls.length;
      const recoveryWriter =
        drift === "transaction"
          ? receiptWriter(undefined, { transactionId: "5".repeat(64) })
          : drift === "target"
            ? receiptWriter(undefined, { targetSha256: "6".repeat(64) })
            : receiptWriter(() => {
                throw new Error("different existing receipt");
              });

      const recovery = lifecycle.recoverUnfinished(recoveryWriter);
      expect(recovery.recovered).toEqual([]);
      expect(recovery.failures[0]?.message).toContain(
        drift === "value" ? "different existing receipt" : "publication authority",
      );
      expect(store.load(TRANSACTION_ID)?.phase).toBe("receipt-prepared");
      switch (drift) {
        case "transaction":
        case "target":
          expect(fixture.capture.mock.calls).toHaveLength(writesBeforeRecovery);
      }
    }
  });

  it("rejects a malformed receipt writer before engine or journal mutation (#8414)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const lifecycle = controller(fixture, store);
    const malformedWriter = {
      ...receiptWriter(),
      targetSha256: "not-a-digest",
    };

    expect(() => lifecycle.start(malformedWriter)).toThrow(
      "Docker llama.cpp receipt writer authority is malformed.",
    );
    expect(fixture.capture).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it("re-proves the verified model before replaying a prepared receipt (#8414)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const unavailableWriter = receiptWriter(() => {
      throw new Error("writer unavailable");
    });
    const lifecycle = controller(fixture, store);
    expect(() => lifecycle.start(unavailableWriter)).toThrow("writer unavailable");
    fs.writeFileSync(modelPath, Buffer.alloc(MODEL_CONTENT.length, 0x62));
    const replayWriter = receiptWriter();

    const recovery = lifecycle.recoverUnfinished(replayWriter);
    expect(recovery.recovered).toEqual([]);
    expect(recovery.failures[0]?.message).toContain("filesystem identity");
    expect(replayWriter.writeExact).not.toHaveBeenCalled();
    expect(store.load(TRANSACTION_ID)?.phase).toBe("receipt-prepared");
  });

  it("holds execution authority after an uncertain create and recovers a late exact container (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    let now = 1_000;
    const lifecycle = controller(fixture, store, () => now);
    fixture.failCreateUncertain();

    const writer = receiptWriter();
    expect(() => lifecycle.start(writer)).toThrow("container create failed");
    const creating = store.load(TRANSACTION_ID);
    expect(creating).toMatchObject({
      phase: "creating",
      runtimeId: null,
      createIntentUnixMs: now,
    });
    expect(store.hasExecution()).toBe(true);

    const concurrent = lifecycle.recoverUnfinished(writer);
    expect(concurrent.recovered).toEqual([]);
    expect(concurrent.failures[0]?.message).toContain("already owned");
    expect(store.load(TRANSACTION_ID)).not.toBeNull();

    store.abandonExecution();
    const insideGrace = lifecycle.recoverUnfinished(writer);
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
    expect(lifecycle.recoverUnfinished(writer)).toEqual({
      recovered: [TRANSACTION_ID],
      failures: [],
    });
    expect(appeared).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("durably journals network intent before mutation and recovers only the exact late network", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const lifecycle = controller(fixture, store, () => 1_000);
    fixture.onNetworkCreate(() => {
      expect(store.load(TRANSACTION_ID)).toMatchObject({
        phase: "network-creating",
        networkId: null,
        createIntentUnixMs: 1_000,
      });
    });
    fixture.failNetworkCreateUncertain(true);

    expect(() => lifecycle.start(receiptWriter())).toThrow("network create failed");
    expect(store.hasExecution()).toBe(true);
    store.abandonExecution();

    expect(lifecycle.recoverUnfinished(receiptWriter())).toEqual({
      recovered: [TRANSACTION_ID],
      failures: [],
    });
    expect(store.list()).toEqual([]);
    expect(dockerCommandPrefixes(fixture)).toContainEqual(["network", "rm"]);
    expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["rm", "--force"]);
  });

  it("holds an absent uncertain network intent through grace and refuses another transaction", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    let now = 1_000;
    const lifecycle = controller(fixture, store, () => now);
    fixture.failNetworkCreateUncertain(false);

    expect(() => lifecycle.start(receiptWriter())).toThrow("network create failed");
    store.abandonExecution();
    const insideGrace = lifecycle.recoverUnfinished(receiptWriter());
    expect(insideGrace.recovered).toEqual([]);
    expect(insideGrace.failures[0]?.message).toContain("network create remains inside");

    fixture.seedNetwork({ ...preparedJournal(), transactionId: "8".repeat(64) });
    now += 31 * 60 * 1_000;
    const foreign = lifecycle.recoverUnfinished(receiptWriter());
    expect(foreign.recovered).toEqual([]);
    expect(foreign.failures[0]?.message).toContain("exact internal Docker network");
    expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["network", "rm"]);
    expect(store.load(TRANSACTION_ID)?.phase).toBe("network-creating");
  });

  it.each([
    ["another network name", "Error response from daemon: No such network: unrelated-network"],
    ["an unrelated not-found failure", "registry metadata not found"],
  ])("preserves network-create authority when inspection reports %s", (_case, stderr) => {
    const fixture = dockerFixture();
    const store = journalStore();
    const journal = {
      ...preparedJournal(),
      phase: "network-creating" as const,
      networkId: null,
      createIntentUnixMs: 1_000,
    };
    store.create(journal);
    const persistedAuthority = authorityStore();
    persistedAuthority.record(journal.engineAuthority);
    fixture.setAbsentNetworkInspectError(stderr);

    const recovery = createDockerLlamaCppManagedLifecycle(
      options(fixture, store, bindings(), persistedAuthority),
      { now: () => 31 * 60 * 1_000 },
    ).recoverUnfinished(receiptWriter());

    expect(recovery.recovered).toEqual([]);
    expect(recovery.failures[0]?.message).toContain("network inspection failed");
    expect(store.load(TRANSACTION_ID)).toEqual(journal);
    expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["network", "rm"]);
  });

  it("accepts an exact alternate Docker network-absence response during rollback", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const journal = {
      ...preparedJournal(),
      phase: "network-creating" as const,
      networkId: null,
      createIntentUnixMs: 1_000,
    };
    store.create(journal);
    const persistedAuthority = authorityStore();
    persistedAuthority.record(journal.engineAuthority);
    fixture.setAbsentNetworkInspectError("network nemoclaw-llama-cpp-internal not found");

    expect(
      createDockerLlamaCppManagedLifecycle(
        options(fixture, store, bindings(), persistedAuthority),
        { now: () => 31 * 60 * 1_000 },
      ).recoverUnfinished(receiptWriter()),
    ).toEqual({ recovered: [TRANSACTION_ID], failures: [] });
    expect(store.list()).toEqual([]);
    expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["network", "rm"]);
  });

  it("recovers prepared and exact creating/created/started journals without touching finalized ownership (#8395)", () => {
    for (const phase of ["prepared", "creating", "created", "started"] as const) {
      const fixture = dockerFixture();
      const store = journalStore();
      const base = preparedJournal();
      store.create(base);
      fixture.seedNetwork(base);
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
      ).recoverUnfinished(receiptWriter());
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
      ).recoverUnfinished(receiptWriter());
      expect(recovery.recovered).toEqual([]);
      expect(recovery.failures).toHaveLength(1);
      expect(store.load(TRANSACTION_ID)).not.toBeNull();
      expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["rm", "--force"]);
    }
  });

  it("fails re-prove on Docker network identity drift (#8395)", () => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(receiptWriter());
    fixture.setNetworkId("8".repeat(64));
    expect(() => lifecycle.runtime.preserveForRebuild(receipt)).toThrow(
      "internal network identity changed",
    );
  });

  it("rejects effective hardening drift after creation (#8395)", () => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(receiptWriter());
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
      const candidateReceipt = candidateLifecycle.start(receiptWriter());
      mutate(candidate);
      expect(() => candidateLifecycle.runtime.inspectManaged(candidateReceipt)).toThrow(
        "exact journal authority",
      );
    }
  });

  it("rejects model and API-key filesystem identity drift during exact inspection", () => {
    const modelFixture = dockerFixture();
    const modelLifecycle = controller(modelFixture);
    const modelReceipt = modelLifecycle.start(receiptWriter());
    fs.writeFileSync(modelPath, Buffer.alloc(MODEL_CONTENT.length, 0x62));
    expect(() => modelLifecycle.runtime.inspectManaged(modelReceipt)).toThrow(
      "filesystem identity",
    );

    fs.writeFileSync(modelPath, MODEL_CONTENT, { mode: 0o600 });
    const keyFixture = dockerFixture();
    const keyLifecycle = controller(keyFixture);
    const keyReceipt = keyLifecycle.start(receiptWriter());
    fs.writeFileSync(apiKeyPath, "replacement-test-key\n", { mode: 0o600 });
    expect(() => keyLifecycle.runtime.inspectManaged(keyReceipt)).toThrow("API-key identity");
  });

  it("rejects a same-size GGUF replacement when inspection reconstructs current identity", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const persistedAuthority = authorityStore();
    const initial = createDockerLlamaCppManagedLifecycle(
      options(fixture, store, bindings(), persistedAuthority),
    );
    const receipt = initial.start(receiptWriter());

    fs.writeFileSync(modelPath, Buffer.alloc(MODEL_CONTENT.length, 0x62));
    const currentIdentityInspector = createDockerLlamaCppManagedLifecycle(
      options(fixture, store, bindings(), persistedAuthority),
    );

    expect(() => currentIdentityInspector.runtime.inspectManaged(receipt)).toThrow(
      "durable create journal",
    );
  });

  it("fails closed on crafted absent destroy authority and status-one daemon errors (#8395)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const lifecycle = controller(fixture, store);
    const receipt = lifecycle.start(receiptWriter());
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
    expect(() => controller(unavailable, unavailableStore).start(receiptWriter())).toThrow(
      "container inspection failed",
    );
    expect(unavailableStore.list()).toEqual([]);
  });
});
