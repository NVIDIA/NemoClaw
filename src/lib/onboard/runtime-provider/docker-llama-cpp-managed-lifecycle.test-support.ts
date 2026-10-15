// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { vi } from "vitest";

import { createHash } from "node:crypto";

import { LLAMA_CPP_PORT } from "../../inference/llama-cpp/contract";
import type { LlamaCppGgufCachePlan } from "../../inference/llama-cpp/gguf-cache-plan";
import type { LlamaCppHostLocalLaunchContract } from "../../inference/llama-cpp/host-local-runtime";
import type {
  HostLocalCreateJournalExecutionLease,
  HostLocalCreateJournalRecord,
  HostLocalCreateJournalStore,
} from "./host-local-create-journal";

export const MODEL_DIGEST = `sha256:${"a".repeat(64)}`;
export const IMAGE =
  "ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:93efd0bec1ed2a7166660edfef9bb743fdfeb3c125d915b43801e69c0befca67";
export const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"d".repeat(64)}`;
export const RUNTIME_ID = "e".repeat(64);
export const NETWORK_ID = "7".repeat(64);
export const TRANSACTION_ID = "9".repeat(64);
export const RECEIPT_TARGET_SHA256 = "8".repeat(64);
export const MODEL_CONTENT = Buffer.alloc(64, 0x61);
export const MODEL_FILENAME = "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
export const REVISION = "f".repeat(40);

export function plan(): LlamaCppGgufCachePlan {
  const payload = {
    schemaVersion: 1 as const,
    recipeId: "llama-cpp.nemotron.spark.v1",
    acquisition: {
      ref: "hugging-face-exact-file/v1" as const,
      downloaderImage: `nvcr.io/nvidia/vllm@sha256:${"d".repeat(64)}`,
      url: `https://huggingface.co/example/model/resolve/${REVISION}/${MODEL_FILENAME}`,
      authentication: { mode: "optional" as const, environment: "HF_TOKEN" as const },
      source: {
        repository: "example/model",
        revision: REVISION,
        file: { path: MODEL_FILENAME, digest: MODEL_DIGEST, sizeBytes: MODEL_CONTENT.length },
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

export function invariant(condition: unknown, message: string): asserts condition {
  switch (Boolean(condition)) {
    case false:
      throw new Error(message);
  }
}

export function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

export function rawDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function contract(): LlamaCppHostLocalLaunchContract {
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
      restartPolicy: "unless-stopped",
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
      chatTemplate: "nemotron-v3-embedded",
      contextSize: 262_144,
      flashAttention: "enabled",
      idleSleepSeconds: -1,
      kvCache: { key: "f16", value: "f16" },
      limits: {
        requestTimeoutSeconds: 900,
      },
      microBatchSize: 512,
      port: LLAMA_CPP_PORT,
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

export function modelFilesystemIdentity(modelPath: string) {
  const status = fs.lstatSync(modelPath, { bigint: true });
  return {
    ctimeNs: status.ctimeNs,
    dev: status.dev,
    ino: status.ino,
    mtimeNs: status.mtimeNs,
    size: status.size,
  };
}

export function replaceModelWithSameSizeContent(modelPath: string) {
  const replacement = `${modelPath}.replacement`;
  fs.writeFileSync(replacement, Buffer.alloc(MODEL_CONTENT.length, 0x62), { mode: 0o600 });
  fs.renameSync(replacement, modelPath);
}

export function keyRootIdentitySha256(apiKeyRoot: string): string {
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

export interface TestJournalStore extends HostLocalCreateJournalStore {
  readonly abandonExecution: () => void;
  readonly hasExecution: () => boolean;
  readonly failNextPrepareReceipt: () => void;
  readonly failNextPrepareReceiptAfterCommit: () => void;
  readonly failNextFinalize: () => void;
}

export function journalStore(): TestJournalStore {
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
        ownerStartIdentity: "test-process-start-identity",
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

import {
  createDockerLlamaCppManagedLifecycle,
  type DockerLlamaCppManagedLifecycleDependencies,
  type DockerLlamaCppManagedLifecycleOptions,
} from "./docker-llama-cpp-managed-lifecycle";

export function privateBridgeFixture() {
  let active: string | null = null;
  const privateBridge = {
    start: vi.fn((authority: unknown) => {
      active = JSON.stringify(authority);
    }),
    assertRunning: vi.fn((authority: unknown) =>
      invariant(active === JSON.stringify(authority), "bridge is not running"),
    ),
    assertStopped: vi.fn(() => invariant(active === null, "bridge is still running")),
    stopTransaction: vi.fn(() => {
      active = null;
    }),
  };
  return privateBridge;
}

export function createTestDockerLlamaCppManagedLifecycle(
  options: DockerLlamaCppManagedLifecycleOptions,
  dependencies: DockerLlamaCppManagedLifecycleDependencies = {},
  privateBridge = privateBridgeFixture(),
) {
  return createDockerLlamaCppManagedLifecycle(options, { privateBridge, ...dependencies });
}
