// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import type { ContainerEngine } from "../../adapters/container-engine";
import {
  createDockerLlamaCppHostLocalOperation,
  createDockerLlamaCppInspectionOperation,
} from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import { requirePersistedEngineAuthority } from "../../onboard/runtime-provider/persisted-engine-authority";
import { probeLlamaCppAttachment } from "./index";
import {
  inspectManagedLlamaCppRuntimeExact,
  MANAGED_LLAMA_CPP_CONTAINER_NAME,
  resolveManagedLlamaCppOwnerSelection,
} from "./managed-installer";
import {
  loadManagedLlamaCppApiKey,
  loadManagedLlamaCppOwner,
  loadManagedLlamaCppReceipt,
  managedLlamaCppStatePaths,
} from "./managed-state";

const INSPECT_TIMEOUT_MS = 10_000;

export type ManagedLlamaCppLifecycleState =
  | "preparing"
  | "running"
  | "stopped"
  | "absent"
  | "conflict"
  | "unknown";

export interface ManagedLlamaCppStatus {
  readonly recipeId: string;
  readonly modelDigest: string | null;
  readonly imageReference: string | null;
  readonly endpoint: "https://inference.local/v1";
  readonly state: ManagedLlamaCppLifecycleState;
  readonly detail: string;
}

export interface ManagedLlamaCppStatusOptions {
  readonly homeDir?: string;
  readonly gatewayPort?: number;
  readonly engine?: ContainerEngine;
  readonly env?: NodeJS.ProcessEnv;
  readonly inspectExact?: typeof inspectManagedLlamaCppRuntimeExact;
  readonly probe?: typeof probeLlamaCppAttachment;
}

function unknownStatus(recipeId: string, detail: string): ManagedLlamaCppStatus {
  return {
    recipeId,
    modelDigest: null,
    imageReference: null,
    endpoint: "https://inference.local/v1",
    state: "unknown",
    detail,
  };
}

/** Inspect only the managed runtime owned by this gateway and sandbox. */
export function inspectManagedLlamaCppStatus(
  sandboxName: string,
  options: ManagedLlamaCppStatusOptions = {},
): ManagedLlamaCppStatus | null {
  const homeDir = fs.realpathSync(options.homeDir ?? os.homedir());
  const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
  if (!fs.existsSync(paths.ownerPath)) return null;
  let owner;
  try {
    owner = loadManagedLlamaCppOwner(paths);
  } catch (error) {
    return unknownStatus("unknown", error instanceof Error ? error.message : String(error));
  }
  if (!owner || owner.sandboxName !== sandboxName) return null;
  let selection;
  try {
    selection = resolveManagedLlamaCppOwnerSelection(owner);
  } catch (error) {
    return unknownStatus(owner.recipeId, error instanceof Error ? error.message : String(error));
  }
  let receipt;
  try {
    receipt = loadManagedLlamaCppReceipt(paths);
  } catch (error) {
    return unknownStatus(owner.recipeId, error instanceof Error ? error.message : String(error));
  }
  if (!receipt) {
    return {
      recipeId: owner.recipeId,
      modelDigest: null,
      imageReference: null,
      endpoint: "https://inference.local/v1",
      state: "preparing",
      detail: "ownership is reserved; no finalized runtime receipt is published",
    };
  }
  if (
    receipt.service !== "llama-cpp" ||
    receipt.runtime.kind !== "container" ||
    receipt.runtime.name !== MANAGED_LLAMA_CPP_CONTAINER_NAME ||
    receipt.runtime.model?.recipeId !== owner.recipeId
  ) {
    return unknownStatus(owner.recipeId, "the persisted runtime receipt is incompatible");
  }
  const base = {
    recipeId: owner.recipeId,
    modelDigest: receipt.runtime.model.digest,
    imageReference: receipt.runtime.imageRef,
    endpoint: "https://inference.local/v1" as const,
  };
  let engine: ContainerEngine;
  let operation: ReturnType<typeof createDockerLlamaCppHostLocalOperation>;
  try {
    operation = options.engine
      ? createDockerLlamaCppInspectionOperation(options.engine)
      : createDockerLlamaCppHostLocalOperation(options.env ?? process.env);
    engine = operation.engine;
    requirePersistedEngineAuthority(
      receipt.engineAuthority,
      "docker",
      engine,
      operation.bindingSha256,
    );
  } catch (error) {
    return {
      ...base,
      state: "conflict",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let result: ReturnType<ContainerEngine["capture"]>;
  try {
    result = engine.capture(
      ["container", "inspect", receipt.runtime.runtimeId],
      INSPECT_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      ...base,
      state: "conflict",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const absent = new RegExp(
    `^(?:Error response from daemon:\\s*)?(?:No such container|No such object): ${receipt.runtime.runtimeId}$`,
    "iu",
  );
  if (!result.error && result.status === 1 && absent.test(result.stderr.trim())) {
    return { ...base, state: "absent", detail: "the exact managed container is absent" };
  }
  if (result.error || result.status !== 0) {
    return { ...base, state: "unknown", detail: "Docker inspection failed" };
  }
  try {
    const inspected = (options.inspectExact ?? inspectManagedLlamaCppRuntimeExact)({
      homeDir,
      operation,
      paths,
      receipt,
      selection,
    });
    if (!inspected.running) {
      return { ...base, state: "stopped", detail: "exact managed container is stopped" };
    }
  } catch (error) {
    return {
      ...base,
      state: "conflict",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let apiKey: string | null;
  try {
    apiKey = loadManagedLlamaCppApiKey(paths);
  } catch (error) {
    return {
      ...base,
      state: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (apiKey === null) {
    return { ...base, state: "unknown", detail: "managed llama.cpp API-key authority is missing" };
  }
  let readiness: ReturnType<typeof probeLlamaCppAttachment>;
  try {
    readiness = (options.probe ?? probeLlamaCppAttachment)(apiKey, {
      requestedModel: selection.recipe.spec.model.servedName,
    });
  } catch {
    return {
      ...base,
      state: "unknown",
      detail: "managed llama.cpp readiness probe failed unexpectedly",
    };
  }
  if (!readiness.ok) {
    return {
      ...base,
      state: "unknown",
      detail: `managed llama.cpp readiness failed: ${readiness.message}`,
    };
  }
  return { ...base, state: "running", detail: "exact managed container is running and ready" };
}
