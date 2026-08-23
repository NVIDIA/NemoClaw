// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LLAMA_CPP_PORT } from "../../inference/llama-cpp/contract";
import type { LlamaCppGgufCachePlan } from "../../inference/llama-cpp/gguf-cache-plan";
import {
  LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH,
  LLAMA_CPP_HOST_LOCAL_SERVER_PATH,
} from "../../inference/llama-cpp/host-local-runtime";
import type { DockerLlamaCppManagedLifecycleOptions } from "./docker-llama-cpp-managed-lifecycle";
import {
  contract,
  digest,
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
import {
  createDockerFixture,
  type DockerFixture,
} from "./docker-llama-cpp-managed-lifecycle-engine.test-support";
import {
  createTestDockerLlamaCppManagedLifecycle as createLifecycle,
  privateBridgeFixture,
} from "./docker-llama-cpp-private-bridge.test-support";
import type {
  HostLocalCreateJournalExecutionLease,
  HostLocalCreateJournalRecord,
  HostLocalCreateJournalStore,
} from "./host-local-create-journal";
import {
  type HostLocalInferenceReceiptWriter,
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

function dockerFixture(
  configuredHostPort = "",
  publishedHostPort?: string,
  publishedHostIp = "127.0.0.1",
  publishedBindingCount = 0,
): DockerFixture {
  return createDockerFixture(
    { apiKeyPath, modelPath, networkName: bindings().network.name },
    configuredHostPort,
    publishedHostPort,
    publishedHostIp,
    publishedBindingCount,
  );
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
  return createLifecycle(options(fixture, store), {
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
    const fixture = dockerFixture();
    const store = journalStore();
    const privateBridge = privateBridgeFixture();
    const runtimeBindings = { ...bindings(), hostPort: 8081 };
    const lifecycle = createLifecycle(options(fixture, store, runtimeBindings), {}, privateBridge);
    const writer = receiptWriter();
    const receipt = lifecycle.start(writer);
    const serialized = serializeHostLocalInferenceReceipt(receipt);
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
    expect(privateBridge.start).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: TRANSACTION_ID,
        apiKeyPath: runtimeBindings.apiKeyHostPath,
        targetHost: "172.30.0.2",
        bindAddresses: ["127.0.0.1", "172.29.0.1"],
      }),
    );
    expect(serialized).not.toContain(modelPath);
    expect(serialized).not.toContain("filesystemIdentity");
    expect(serialized).not.toContain("test-only-secret");
    expect(fixture.capture.mock.calls.map(([argv]) => argv)).toContainEqual(
      expect.arrayContaining(["create", "--no-healthcheck"]),
    );
    const create = fixture.capture.mock.calls
      .map(([argv]) => argv)
      .find(([operation]) => operation === "create");
    expect(create).toBeDefined();
    expect(create?.[create.indexOf("--entrypoint") + 1]).toBe(
      LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH,
    );
    const command = create?.slice(create.indexOf(IMAGE) + 1) ?? [];
    expect(command[command.indexOf("--max-request-body-bytes") + 1]).toBe(
      String(contract().serve.limits.maxRequestBodyBytes),
    );
    expect(command[command.indexOf("--upstream-port") + 1]).toBe(
      String(contract().serve.requestGuard.upstreamPort),
    );
    const separator = command.indexOf("--");
    expect(command.slice(separator + 1, separator + 8)).toEqual([
      LLAMA_CPP_HOST_LOCAL_SERVER_PATH,
      "--model",
      `/models/${MODEL_FILENAME}`,
      "--alias",
      contract().model.servedName,
      "--host",
      "127.0.0.1",
    ]);
    expect(command.slice(separator)[command.slice(separator).indexOf("--port") + 1]).toBe(
      String(contract().serve.requestGuard.upstreamPort),
    );
    expect(lifecycle.runtime.inspectManaged(receipt).running).toBe(true);
    expect(lifecycle.runtime.stopManaged(receipt).running).toBe(false);
    expect(lifecycle.runtime.prepareDestroy(receipt)).toEqual(receipt);
    expect(lifecycle.runtime.destroy(receipt).status).toBe("removed");
    expect(lifecycle.runtime.destroy(receipt).status).toBe("already-absent");
  });

  it("accepts managed reachability through the authoritative OpenShell bridge (#8712)", () => {
    const fixture = dockerFixture();
    createLifecycle(options(fixture)).start(receiptWriter());

    expect(fixture.capture.mock.calls.map((call) => call[0])).toContainEqual(
      expect.arrayContaining([
        "--network",
        "openshell-docker",
        "--add-host",
        "host.openshell.internal:172.29.0.1",
        "http://host.openshell.internal:8081/health",
      ]),
    );
  });

  it.each([
    { failure: "connection refusal", status: 7, stderr: "curl: (7) failed to connect" },
    { failure: "timeout", status: 28, stderr: "curl: (28) timed out" },
  ])(
    "reports a narrow UFW remediation and rolls back after bridge $failure (#8712)",
    ({ status, stderr }) => {
      const fixture = dockerFixture();
      const store = journalStore();
      const privateBridge = privateBridgeFixture();
      fixture.failSandboxBridgeProbe({ status, stderr });

      let failure: Error | undefined;
      try {
        createLifecycle(options(fixture, store), {}, privateBridge).start(receiptWriter());
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }

      expect(failure?.message).toContain(
        "Managed llama.cpp host-loopback health check passed, but the OpenShell Docker bridge health check failed.",
      );
      expect(failure?.message).toContain("OpenShell Docker network: openshell-docker");
      expect(failure?.message).toContain("Source subnet: 172.29.0.0/16");
      expect(failure?.message).toContain("Gateway IP address: 172.29.0.1");
      expect(failure?.message).toContain("TCP port: 8081");
      expect(failure?.message).toContain(
        "sudo ufw allow from 172.29.0.0/16 to 172.29.0.1 port 8081 proto tcp",
      );
      expect(failure?.message).not.toContain("test-only-secret");
      expect(privateBridge.stopTransaction).toHaveBeenCalledWith(TRANSACTION_ID);
      expect(store.list()).toEqual([]);
      expect(dockerCommandPrefixes(fixture)).toContainEqual(["rm", "--force"]);
      expect(dockerCommandPrefixes(fixture)).toContainEqual(["network", "rm"]);
    },
  );

  it("does not report UFW remediation for a Docker probe command failure (#8712)", () => {
    const fixture = dockerFixture();
    fixture.failSandboxBridgeProbe({ status: 125, stderr: "docker run failed" });

    let failure: Error | undefined;
    try {
      createLifecycle(options(fixture)).start(receiptWriter());
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    expect(failure?.message).toBe(
      "Docker llama.cpp private sandbox bridge probe failed (exit 125).",
    );
    expect(failure?.message).not.toContain("sudo ufw");
  });

  it("does not print unvalidated bridge topology in UFW remediation (#8712)", () => {
    const fixture = dockerFixture();
    fixture.setOpenShellBridgeSubnet("0.0.0.0/0");
    fixture.failSandboxBridgeProbe({ status: 28, stderr: "curl: (28) timed out" });

    let failure: Error | undefined;
    try {
      createLifecycle(options(fixture)).start(receiptWriter());
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    expect(failure?.message).toBe(
      "Docker llama.cpp private sandbox bridge probe failed (exit 28).",
    );
    expect(failure?.message).not.toContain("sudo ufw");
    expect(failure?.message).not.toContain("0.0.0.0/0");
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

  it("preserves receipt-bound resources after bridge refusal during resume (#8712)", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const privateBridge = privateBridgeFixture();
    const lifecycle = createLifecycle(options(fixture, store), {}, privateBridge);
    const receipt = lifecycle.start(receiptWriter());
    lifecycle.runtime.stopManaged(receipt);
    fixture.capture.mockClear();
    privateBridge.stopTransaction.mockClear();
    fixture.failSandboxBridgeProbe({ status: 7, stderr: "curl: (7) failed to connect" });

    let failure: Error | undefined;
    try {
      lifecycle.resume(receipt);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    expect(failure?.message).toContain(
      "Managed llama.cpp host-loopback health check passed, but the OpenShell Docker bridge health check failed.",
    );
    expect(failure?.message).toContain(
      "sudo ufw allow from 172.29.0.0/16 to 172.29.0.1 port 8081 proto tcp",
    );
    expect(privateBridge.stopTransaction).not.toHaveBeenCalled();
    expect(store.load(TRANSACTION_ID)).toMatchObject({
      phase: "finalized",
      runtimeId: RUNTIME_ID,
      networkId: NETWORK_ID,
    });
    expect(lifecycle.runtime.inspectManaged(receipt).running).toBe(true);
    expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["rm", "--force"]);
    expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["network", "rm"]);
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
  ] as const)(
    "fails closed on post-readiness %s drift without replacement (#8144)",
    (_kind, drift, expected) => {
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
      expect(store.load(TRANSACTION_ID)).toMatchObject({
        phase: "finalized",
        runtimeId: RUNTIME_ID,
      });
    },
  );
  it.each([
    ["configured", "8081", undefined, "127.0.0.1", 0, /must not configure/u],
    ["runtime", "", "8081", "127.0.0.1", 1, /must not publish/u],
    ["runtime-wide", "", "8081", "0.0.0.0", 1, /must not publish/u],
  ] as const)(
    "rolls back exact ownership for unexpected %s Docker publication (#8544)",
    (_kind, configured, published, ip, count, expectedError) => {
      const [fixture, store] = [dockerFixture(configured, published, ip, count), journalStore()];
      const lifecycle = createLifecycle(options(fixture, store));
      expect(() => lifecycle.start(receiptWriter())).toThrow(expectedError);
      const calls = fixture.capture.mock.calls.map((call) => call[0]);
      expect(calls).toContainEqual(["rm", "--force", RUNTIME_ID]);
      expect(calls).toContainEqual(["network", "rm", NETWORK_ID]);
      expect(store.list()).toEqual([]);
    },
  );
  it("uses the declarative readiness timeout as both curl retry budget and capture budget", () => {
    const fixture = dockerFixture();
    const lifecycle = createLifecycle({
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
      createLifecycle({
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
    expect(() => createLifecycle(invalid)).toThrow("canonical payload");
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
    const lifecycle = createLifecycle({
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

  it.each(["stdout", "probe"] as const)(
    "rolls back malformed create output and readiness failure before receipt prepare [%s] (#8395)",
    (failure) => {
      const arrangeFailure = {
        stdout: (fixture: DockerFixture) => fixture.setCreateStdout("short-id\n"),
        probe: (fixture: DockerFixture) => fixture.failProbe(),
      } as const;

      const fixture = dockerFixture();
      const store = journalStore();
      arrangeFailure[failure](fixture);
      expect(() => controller(fixture, store).start(receiptWriter())).toThrow();
      expect(store.list()).toEqual([]);
      expect(dockerCommandPrefixes(fixture)).toContainEqual(["rm", "--force"]);
    },
  );

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
          fs.writeFileSync(path.join(apiKeyRoot, "receipt.json"), serializedReceipt);
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

  it.each(["transaction", "target", "value"] as const)(
    "fails closed on receipt writer target or existing-value drift [case %#] (#8414)",
    (drift) => {
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
    },
  );

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

    const recovery = createLifecycle(options(fixture, store, bindings(), persistedAuthority), {
      now: () => 31 * 60 * 1_000,
    }).recoverUnfinished(receiptWriter());

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
      createLifecycle(options(fixture, store, bindings(), persistedAuthority), {
        now: () => 31 * 60 * 1_000,
      }).recoverUnfinished(receiptWriter()),
    ).toEqual({ recovered: [TRANSACTION_ID], failures: [] });
    expect(store.list()).toEqual([]);
    expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["network", "rm"]);
  });

  it.each(["prepared", "creating", "created", "started"] as const)(
    "recovers prepared and exact creating/created/started journals without touching finalized ownership [case %#] (#8395)",
    (phase) => {
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
      const recovery = createLifecycle(options(fixture, store, bindings(), persistedAuthority), {
        now: () => 31 * 60 * 1_000,
      }).recoverUnfinished(receiptWriter());
      expect(recovery).toEqual({ recovered: [TRANSACTION_ID], failures: [] });
      expect(store.list()).toEqual([]);
    },
  );

  it.each(["missing", "drifted"] as const)(
    "refuses unfinished recovery when protected engine authority is missing or drifted [case %#] (#8395)",
    (state) => {
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
      const recovery = createLifecycle(
        options(fixture, store, bindings(), persistedAuthority),
      ).recoverUnfinished(receiptWriter());
      expect(recovery.recovered).toEqual([]);
      expect(recovery.failures).toHaveLength(1);
      expect(store.load(TRANSACTION_ID)).not.toBeNull();
      expect(dockerCommandPrefixes(fixture)).not.toContainEqual(["rm", "--force"]);
    },
  );

  it("fails re-prove on Docker network identity drift (#8395)", () => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(receiptWriter());
    fixture.setNetworkId("8".repeat(64));
    expect(() => lifecycle.runtime.preserveForRebuild(receipt)).toThrow(
      "internal network identity changed",
    );
  });

  it.each(
    Array.from(
      [
        (candidate: DockerFixture) => candidate.driftGpuRequest(undefined, 1),
        (candidate: DockerFixture) => candidate.driftGpuRequest("nvidia", 2),
        (candidate: DockerFixture) => candidate.driftExtraDeviceAuthority("cap-add"),
        (candidate: DockerFixture) => candidate.driftExtraDeviceAuthority("legacy-device"),
        (candidate: DockerFixture) => candidate.dropTmpfs(),
        (candidate: DockerFixture) => candidate.driftEntrypoint(),
      ],
      (value) => [value],
    ),
  )("rejects effective hardening drift after creation [case %#] (#8395)", (mutate) => {
    const fixture = dockerFixture();
    const lifecycle = controller(fixture);
    const receipt = lifecycle.start(receiptWriter());
    fixture.driftHardening();
    expect(() => lifecycle.runtime.inspectManaged(receipt)).toThrow("exact journal authority");

    const candidate = dockerFixture();
    const candidateLifecycle = controller(candidate);
    const candidateReceipt = candidateLifecycle.start(receiptWriter());
    mutate(candidate);
    expect(() => candidateLifecycle.runtime.inspectManaged(candidateReceipt)).toThrow(
      "exact journal authority",
    );
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
    const keyReceipt = keyLifecycle.start(
      receiptWriter((serializedReceipt) => {
        fs.writeFileSync(path.join(apiKeyRoot, "receipt.json"), serializedReceipt, { mode: 0o600 });
        return serializedReceipt;
      }),
    );
    expect(() => keyLifecycle.runtime.inspectManaged(keyReceipt)).not.toThrow();
    fs.writeFileSync(apiKeyPath, "replacement-test-key\n", { mode: 0o600 });
    expect(() => keyLifecycle.runtime.inspectManaged(keyReceipt)).toThrow("API-key identity");
  });
  it("rejects a same-size GGUF replacement when inspection reconstructs current identity", () => {
    const fixture = dockerFixture();
    const store = journalStore();
    const persistedAuthority = authorityStore();
    const initial = createLifecycle(options(fixture, store, bindings(), persistedAuthority));
    const receipt = initial.start(receiptWriter());
    fs.writeFileSync(modelPath, Buffer.alloc(MODEL_CONTENT.length, 0x62));
    const currentIdentityInspector = createLifecycle(
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
