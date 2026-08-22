// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import { dockerLlamaCppBindingSha256 as managedLlamaCppBindingSha256 } from "../../onboard/runtime-provider/docker-llama-cpp-operation";
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
} from "../llama-cpp/managed-installer";
import {
  createManagedLlamaCppReceiptWriter,
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
} from "../llama-cpp/managed-state";

export const TRANSACTION_ID = "1".repeat(64);
export const RUNTIME_ID = "2".repeat(64);
export const NETWORK_ID = "3".repeat(64);
const SPEC_SHA256 = "4".repeat(64);

function commandResult(status: number, stdout = "", stderr = ""): ContainerEngineCommandResult {
  return { status, stdout, stderr };
}

interface EngineHarnessOptions {
  authorityId?: string;
  containerForeign?: boolean;
  containerPresent?: boolean;
  networkPresent?: boolean;
  daemonInspectFailure?: boolean;
  removalLeavesContainer?: boolean;
}

export function engineHarness(options: EngineHarnessOptions = {}): {
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
              Labels: options.containerForeign
                ? {}
                : {
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

export function createManagedState(
  homeDir: string,
  engine: ContainerEngine,
  options: {
    phase?: HostLocalCreateJournalPhase;
    gatewayPort?: number;
    createIntentUnixMs?: number;
    sandboxName?: string;
  } = {},
): void {
  const phase = options.phase ?? "finalized";
  const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
  reserveManagedLlamaCppOwner(paths, {
    schemaVersion: 1,
    sandboxName: options.sandboxName ?? "spark-agent",
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

export function createPreStartManagedState(homeDir: string, engine: ContainerEngine): void {
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
