// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import {
  createHostLocalCreateJournalStore,
  type HostLocalCreateJournalPhase,
} from "../../onboard/runtime-provider/host-local-create-journal";
import { serializeHostLocalInferenceReceipt } from "../../onboard/runtime-provider/host-local-inference";
import {
  createFilePersistedEngineAuthorityStore,
  createPersistedEngineAuthority,
} from "../../onboard/runtime-provider/persisted-engine-authority";
import {
  MANAGED_LLAMA_CPP_CONTAINER_NAME,
  MANAGED_LLAMA_CPP_NETWORK_NAME,
  MANAGED_LLAMA_CPP_OWNER_LABEL,
  MANAGED_LLAMA_CPP_OWNER_VALUE,
  managedLlamaCppBindingSha256,
} from "../llama-cpp/managed-installer";
import {
  createManagedLlamaCppReceiptWriter,
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
} from "../llama-cpp/managed-state";
import { runtimeAuthFingerprint } from "../serving/runtime-auth-fingerprint";
import {
  HOST_LOCAL_VLLM_AUTH_LABEL,
  HOST_LOCAL_VLLM_CATALOG_LABEL,
  HOST_LOCAL_VLLM_CONTAINER_NAME,
  HOST_LOCAL_VLLM_MANAGED_LABEL,
  HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL,
  HOST_LOCAL_VLLM_PRESET_LABEL,
  HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL,
  HOST_LOCAL_VLLM_RECIPE_LABEL,
  HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE,
  persistHostLocalVllmRuntimeReceipt,
} from "../serving/vllm-host-local-lifecycle";
import { cleanupLocalModelRuntimes, cleanupManagedLlamaCppRuntimeForSandbox } from "./cleanup";

const TRANSACTION_ID = "1".repeat(64);
const RUNTIME_ID = "2".repeat(64);
const NETWORK_ID = "3".repeat(64);
const SPEC_SHA256 = "4".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-cleanup-"));
  const canonicalHome = fs.realpathSync(home);
  temporaryDirectories.push(canonicalHome);
  return canonicalHome;
}

function commandResult(status: number, stdout = "", stderr = ""): ContainerEngineCommandResult {
  return { status, stdout, stderr };
}

function ownedContainer(
  name: string,
  id: string,
  labels: Record<string, string>,
  env: string[] = [],
): string {
  return JSON.stringify([{ Id: id, Name: `/${name}`, Config: { Env: env, Labels: labels } }]);
}

interface EngineHarnessOptions {
  authorityId?: string;
  containerPresent?: boolean;
  networkPresent?: boolean;
  daemonInspectFailure?: boolean;
  removalLeavesContainer?: boolean;
}

function engineHarness(options: EngineHarnessOptions = {}): {
  engine: ContainerEngine;
  capture: ReturnType<typeof vi.fn>;
} {
  let containerPresent = options.containerPresent ?? true;
  let networkPresent = options.networkPresent ?? true;
  const capture = vi.fn((args: readonly string[]) => {
    if (args[0] === "info") return commandResult(0);
    if (args[0] === "container" && args[1] === "inspect") {
      if (options.daemonInspectFailure) return commandResult(1, "", "daemon unavailable");
      if (!containerPresent) return commandResult(1, "", "No such container");
      return commandResult(
        0,
        JSON.stringify([
          {
            Id: RUNTIME_ID,
            Name: `/${MANAGED_LLAMA_CPP_CONTAINER_NAME}`,
            Config: {
              Labels: {
                [MANAGED_LLAMA_CPP_OWNER_LABEL]: MANAGED_LLAMA_CPP_OWNER_VALUE,
                "io.nvidia.nemoclaw.host-local-inference.managed": "true",
                "io.nvidia.nemoclaw.host-local-inference.provider": "docker",
                "io.nvidia.nemoclaw.host-local-inference.service": "llama-cpp",
                "io.nvidia.nemoclaw.host-local-inference.spec-sha256": SPEC_SHA256,
                "io.nvidia.nemoclaw.host-local-inference.transaction-sha256": TRANSACTION_ID,
              },
            },
          },
        ]),
      );
    }
    if (args[0] === "container" && args[1] === "ls") {
      if (options.daemonInspectFailure) return commandResult(1, "", "daemon unavailable");
      return commandResult(0, containerPresent ? `${RUNTIME_ID}\n` : "");
    }
    if (args[0] === "rm" && args[1] === "--force") {
      if (!options.removalLeavesContainer) containerPresent = false;
      return commandResult(0, RUNTIME_ID);
    }
    if (args[0] === "network" && args[1] === "inspect") {
      if (!networkPresent) return commandResult(1, "", "No such network");
      return commandResult(
        0,
        JSON.stringify([
          {
            Id: NETWORK_ID,
            Name: MANAGED_LLAMA_CPP_NETWORK_NAME,
            Internal: true,
            Driver: "bridge",
            Scope: "local",
            Labels: {
              [MANAGED_LLAMA_CPP_OWNER_LABEL]: MANAGED_LLAMA_CPP_OWNER_VALUE,
              "io.nvidia.nemoclaw.host-local-inference.network-transaction-sha256": TRANSACTION_ID,
            },
          },
        ]),
      );
    }
    if (args[0] === "network" && args[1] === "ls") {
      return commandResult(0, networkPresent ? `${NETWORK_ID}\n` : "");
    }
    if (args[0] === "network" && args[1] === "rm") {
      networkPresent = false;
      return commandResult(0, NETWORK_ID);
    }
    return commandResult(1, "", `unexpected command: ${args.join(" ")}`);
  });
  const engine: ContainerEngine = Object.freeze({
    operation: "host-local-inference",
    engineId: "docker",
    displayName: "Docker",
    authorityId: options.authorityId ?? "docker:local",
    capture,
    captureHost: capture,
  });
  return { engine, capture };
}

function createManagedState(
  homeDir: string,
  engine: ContainerEngine,
  options: {
    phase?: HostLocalCreateJournalPhase;
    gatewayPort?: number;
    createIntentUnixMs?: number;
  } = {},
): void {
  const phase = options.phase ?? "finalized";
  const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
  reserveManagedLlamaCppOwner(paths, {
    schemaVersion: 1,
    sandboxName: "spark-agent",
    catalogDigest: `sha256:${"5".repeat(64)}`,
    presetDigest: `sha256:${"6".repeat(64)}`,
    recipeDigest: `sha256:${"7".repeat(64)}`,
    recipeId: "llama-cpp.nemotron.spark.v1",
  });
  const engineAuthority = {
    schemaVersion: 1 as const,
    providerId: "docker",
    operation: "host-local-inference" as const,
    engineId: engine.engineId,
    authorityId: engine.authorityId,
    bindingSha256: managedLlamaCppBindingSha256(engine),
  };
  const receipt = {
    schemaVersion: 1 as const,
    providerId: "docker",
    service: "llama-cpp" as const,
    engineAuthority,
    endpoint: {
      host: "host.openshell.internal",
      port: 8081,
      networkName: MANAGED_LLAMA_CPP_NETWORK_NAME,
    },
    runtime: {
      kind: "container" as const,
      runtimeId: RUNTIME_ID,
      name: MANAGED_LLAMA_CPP_CONTAINER_NAME,
      imageRef: `ghcr.io/nvidia/llama-cpp@sha256:${"9".repeat(64)}`,
      probeImageRef: `nvcr.io/nvidia/vllm@sha256:${"a".repeat(64)}`,
      specSha256: SPEC_SHA256,
      model: {
        planDigest: `sha256:${"b".repeat(64)}`,
        recipeId: "llama-cpp.nemotron.spark.v1",
        generation: TRANSACTION_ID,
        digest: `sha256:${"c".repeat(64)}`,
        sizeBytes: 64,
      },
      gpu: { vendor: "nvidia" as const, count: 1 as const },
    },
  };
  const serialized = serializeHostLocalInferenceReceipt(receipt);
  const journal = createHostLocalCreateJournalStore(paths.stateDir);
  journal.create({
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    phase: phase === "network-creating" ? "network-creating" : "prepared",
    providerId: "docker",
    service: "llama-cpp",
    containerName: MANAGED_LLAMA_CPP_CONTAINER_NAME,
    runtimeId: null,
    createIntentUnixMs:
      phase === "network-creating"
        ? (options.createIntentUnixMs ?? Date.now() - 31 * 60 * 1000)
        : null,
    specSha256: SPEC_SHA256,
    networkId: phase === "network-creating" ? null : NETWORK_ID,
    apiKeyIdentitySha256: "d".repeat(64),
    apiKeyRootIdentitySha256: "e".repeat(64),
    engineAuthority,
    receiptTargetSha256: createManagedLlamaCppReceiptWriter(paths, TRANSACTION_ID).targetSha256,
    serializedReceipt: null,
    receiptSha256: null,
  });
  if (phase === "network-creating") return;
  if (phase === "prepared") return;
  journal.recordCreating(TRANSACTION_ID, options.createIntentUnixMs ?? Date.now() - 31 * 60 * 1000);
  if (phase === "creating") return;
  journal.recordCreated(TRANSACTION_ID, RUNTIME_ID);
  if (phase === "created") return;
  journal.recordStarted(TRANSACTION_ID);
  if (phase === "started") return;
  journal.prepareReceipt(TRANSACTION_ID, serialized);
  if (phase === "receipt-prepared") return;
  createManagedLlamaCppReceiptWriter(paths, TRANSACTION_ID).writeExact(serialized);
  journal.finalize(TRANSACTION_ID);
}

function createPreStartManagedState(homeDir: string, engine: ContainerEngine): void {
  const paths = managedLlamaCppStatePaths(homeDir);
  reserveManagedLlamaCppOwner(paths, {
    schemaVersion: 1,
    sandboxName: "spark-agent",
    catalogDigest: `sha256:${"5".repeat(64)}`,
    presetDigest: `sha256:${"6".repeat(64)}`,
    recipeDigest: `sha256:${"7".repeat(64)}`,
    recipeId: "llama-cpp.nemotron.spark.v1",
  });
  createFilePersistedEngineAuthorityStore(paths.stateDir).record(
    createPersistedEngineAuthority("docker", engine, managedLlamaCppBindingSha256(engine)),
  );
}

describe("host-local model cleanup", () => {
  it("retires an interrupted pre-start owner only after proving both runtime names absent", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ containerPresent: false, networkPresent: false });
    createPreStartManagedState(homeDir, harness.engine);

    const result = cleanupLocalModelRuntimes({
      deleteModels: false,
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
    expect(harness.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).not.toContainEqual([
      "rm",
      "--force",
    ]);
    expect(harness.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).not.toContainEqual([
      "network",
      "rm",
    ]);
  });

  it("retains pre-start ownership when either fixed Docker name is present", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ containerPresent: true, networkPresent: false });
    createPreStartManagedState(homeDir, harness.engine);

    const result = cleanupLocalModelRuntimes({
      deleteModels: false,
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.reason).toContain("cannot prove its fixed runtime names absent");
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
    expect(harness.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).not.toContainEqual([
      "rm",
      "--force",
    ]);
  });

  it("removes authenticated legacy host-local vLLM when key and fingerprint match", () => {
    const homeDir = temporaryHome();
    const stateDir = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    const apiKey = "c".repeat(64);
    const containerId = "d".repeat(64);
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${apiKey}\n`, {
      mode: 0o600,
    });
    const forceRm = vi.fn(() => ({ status: 0 }) as never);
    const capture = vi.fn((argv: readonly string[]) =>
      argv[0] === "container" && argv[2] === HOST_LOCAL_VLLM_CONTAINER_NAME
        ? ownedContainer(
            HOST_LOCAL_VLLM_CONTAINER_NAME,
            containerId,
            {
              [HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
              [HOST_LOCAL_VLLM_AUTH_LABEL]: runtimeAuthFingerprint(apiKey),
            },
            [`VLLM_API_KEY=${apiKey}`],
          )
        : "",
    );

    expect(
      cleanupLocalModelRuntimes({
        deleteModels: false,
        homeDir,
        deps: {
          capture: capture as never,
          forceRm: forceRm as never,
          run: vi.fn(() => ({ status: 0 }) as never),
        },
      }),
    ).toMatchObject({ ok: true, removed: [`container:${containerId}`] });
    expect(fs.existsSync(path.join(stateDir, "dual-station-vllm-api-key"))).toBe(false);
  });

  it("removes a profile-labeled vLLM and its exact ownership receipt", () => {
    const homeDir = temporaryHome();
    const stateDir = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    const apiKey = "1".repeat(64);
    const containerId = "2".repeat(64);
    const serving = {
      catalogDigest: `sha256:${"3".repeat(64)}`,
      presetId: "vllm.dgx-spark-gb10.single.example",
      presetDigest: `sha256:${"4".repeat(64)}`,
      recipeId: "vllm.dgx-spark-gb10.single.example",
      recipeDigest: `sha256:${"5".repeat(64)}`,
    } as const;
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${apiKey}\n`, {
      mode: 0o600,
    });
    persistHostLocalVllmRuntimeReceipt(
      { containerId, authFingerprint: runtimeAuthFingerprint(apiKey), serving },
      stateDir,
    );
    const forceRm = vi.fn(() => ({ status: 0 }) as never);
    const capture = vi.fn((argv: readonly string[]) =>
      argv[0] === "container" && argv[2] === HOST_LOCAL_VLLM_CONTAINER_NAME
        ? ownedContainer(
            HOST_LOCAL_VLLM_CONTAINER_NAME,
            containerId,
            {
              [HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
              [HOST_LOCAL_VLLM_AUTH_LABEL]: runtimeAuthFingerprint(apiKey),
              [HOST_LOCAL_VLLM_CATALOG_LABEL]: serving.catalogDigest,
              [HOST_LOCAL_VLLM_PRESET_LABEL]: serving.presetId,
              [HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: serving.presetDigest,
              [HOST_LOCAL_VLLM_RECIPE_LABEL]: serving.recipeId,
              [HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: serving.recipeDigest,
            },
            [`VLLM_API_KEY=${apiKey}`],
          )
        : "",
    );

    expect(
      cleanupLocalModelRuntimes({
        deleteModels: false,
        homeDir,
        deps: {
          capture: capture as never,
          forceRm: forceRm as never,
          run: vi.fn(() => ({ status: 0 }) as never),
        },
      }),
    ).toMatchObject({ ok: true, removed: [`container:${containerId}`] });
    expect(fs.existsSync(path.join(stateDir, HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE))).toBe(false);
  });

  it("refuses to remove a profile-labeled vLLM without its ownership receipt", () => {
    const homeDir = temporaryHome();
    const stateDir = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    const apiKey = "6".repeat(64);
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${apiKey}\n`, {
      mode: 0o600,
    });
    const labels = {
      [HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
      [HOST_LOCAL_VLLM_AUTH_LABEL]: runtimeAuthFingerprint(apiKey),
      [HOST_LOCAL_VLLM_CATALOG_LABEL]: `sha256:${"7".repeat(64)}`,
      [HOST_LOCAL_VLLM_PRESET_LABEL]: "vllm.dgx-spark-gb10.single.example",
      [HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: `sha256:${"8".repeat(64)}`,
      [HOST_LOCAL_VLLM_RECIPE_LABEL]: "vllm.dgx-spark-gb10.single.example",
      [HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: `sha256:${"9".repeat(64)}`,
    };
    const forceRm = vi.fn(() => ({ status: 0 }) as never);

    expect(
      cleanupLocalModelRuntimes({
        deleteModels: false,
        homeDir,
        deps: {
          capture: vi.fn(() =>
            ownedContainer(HOST_LOCAL_VLLM_CONTAINER_NAME, "a".repeat(64), labels, [
              `VLLM_API_KEY=${apiKey}`,
            ]),
          ) as never,
          forceRm: forceRm as never,
          run: vi.fn(() => ({ status: 0 }) as never),
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("ownership receipt") });
    expect(forceRm).not.toHaveBeenCalled();
  });

  it("fails closed when the vLLM container name is foreign while local key state remains", () => {
    const homeDir = temporaryHome();
    const stateDir = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${"e".repeat(64)}\n`, {
      mode: 0o600,
    });
    const capture = vi.fn((argv: readonly string[]) => {
      return argv[0] === "container" && argv[2] === HOST_LOCAL_VLLM_CONTAINER_NAME
        ? ownedContainer(HOST_LOCAL_VLLM_CONTAINER_NAME, "f".repeat(64), {})
        : "";
    });
    const forceRm = vi.fn(() => ({ status: 0 }) as never);

    expect(
      cleanupLocalModelRuntimes({
        deleteModels: false,
        homeDir,
        deps: {
          capture: capture as never,
          forceRm: forceRm as never,
          run: vi.fn(() => ({ status: 0 }) as never),
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("container name is foreign") });
    expect(forceRm).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, "dual-station-vllm-api-key"))).toBe(true);
  });

  it("removes only exact receipt-owned llama.cpp resources through the qualified engine", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const cache = path.join(homeDir, ".cache", "huggingface");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "shared-model"), "keep");
    const ambientCapture = vi.fn(() => "") as never;
    const ambientForceRm = vi.fn(() => ({ status: 0 })) as never;
    const ambientRun = vi.fn(() => ({ status: 0 })) as never;

    const result = cleanupLocalModelRuntimes({
      deleteModels: true,
      homeDir,
      engine: harness.engine,
      deps: {
        capture: ambientCapture,
        forceRm: ambientForceRm,
        run: ambientRun,
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(harness.capture).toHaveBeenCalledWith(["rm", "--force", RUNTIME_ID], expect.any(Number));
    expect(harness.capture).toHaveBeenCalledWith(["network", "rm", NETWORK_ID], expect.any(Number));
    expect(ambientCapture).not.toHaveBeenCalled();
    expect(ambientForceRm).not.toHaveBeenCalled();
    expect(ambientRun).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cache, "shared-model"))).toBe(true);
    expect(result.preserved).toContain(cache);
  });

  it.each([
    "network-creating",
    "creating",
    "created",
    "started",
    "receipt-prepared",
  ] as const)("rolls back an unfinished %s create journal before deleting state", (phase) => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ containerPresent: phase !== "network-creating" });
    createManagedState(homeDir, harness.engine, { phase });

    const result = cleanupLocalModelRuntimes({
      deleteModels: false,
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
  });

  it("fails closed on a fresh uncertain create that has no exact container yet", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ containerPresent: false });
    createManagedState(homeDir, harness.engine, {
      phase: "creating",
      createIntentUnixMs: Date.now(),
    });

    const result = cleanupLocalModelRuntimes({
      deleteModels: false,
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("grace period"),
    });
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });

  it("refuses a changed engine authority before any Docker inspection", () => {
    const homeDir = temporaryHome();
    const original = engineHarness({ authorityId: "docker:original" });
    const changed = engineHarness({ authorityId: "docker:changed" });
    createManagedState(homeDir, original.engine);

    const result = cleanupLocalModelRuntimes({
      deleteModels: false,
      homeDir,
      engine: changed.engine,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("endpoint"),
    });
    expect(changed.capture).not.toHaveBeenCalled();
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });

  it("does not collapse a daemon inspection error into exact absence", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ daemonInspectFailure: true });
    createManagedState(homeDir, harness.engine);

    const result = cleanupLocalModelRuntimes({
      deleteModels: false,
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("absence proof"),
    });
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });

  it("does not race cleanup against a live lifecycle execution lease", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine, { phase: "started" });
    const store = createHostLocalCreateJournalStore(managedLlamaCppStatePaths(homeDir).stateDir);
    const lease = store.acquireExecution(TRANSACTION_ID);
    try {
      const result = cleanupLocalModelRuntimes({
        deleteModels: false,
        homeDir,
        engine: harness.engine,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("live process"),
      });
      expect(harness.capture).not.toHaveBeenCalledWith(
        ["rm", "--force", RUNTIME_ID],
        expect.any(Number),
      );
      expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
    } finally {
      store.releaseExecution(lease);
    }
  });

  it("re-inspects after removal and retains authority when the container remains", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ removalLeavesContainer: true });
    createManagedState(homeDir, harness.engine);

    const result = cleanupLocalModelRuntimes({
      deleteModels: false,
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not proven"),
    });
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["network", "rm", NETWORK_ID],
      expect.any(Number),
    );
  });

  it("uses gateway and sandbox scope and leaves a different owner untouched", () => {
    const homeDir = temporaryHome();
    const gatewayPort = 8091;
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine, { gatewayPort });

    const skipped = cleanupManagedLlamaCppRuntimeForSandbox("different-sandbox", {
      homeDir,
      gatewayPort,
      engine: harness.engine,
    });
    expect(skipped).toEqual({ ok: true, removed: [], preserved: [] });
    expect(harness.capture).not.toHaveBeenCalled();

    const removed = cleanupManagedLlamaCppRuntimeForSandbox("spark-agent", {
      homeDir,
      gatewayPort,
      engine: harness.engine,
    });
    expect(removed).toMatchObject({ ok: true });
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir, gatewayPort).stateDir)).toBe(false);
  });
});
