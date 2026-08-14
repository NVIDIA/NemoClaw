// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import type { RuntimeProviderBundle } from "../../onboard/runtime-provider/contract";
import type {
  HostLocalInferenceOperation,
  HostLocalInferencePreparedStartup,
  HostLocalInferenceReceipt,
  HostLocalInferenceRuntime,
} from "../../onboard/runtime-provider/host-local-inference";
import {
  normalizeHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import {
  finalizeManagedLlamaCppLifecycleCleanup,
  prepareManagedLlamaCppLifecycleCleanup,
} from "../local-model-profile/cleanup";
import { rehydrateManagedLlamaCppLifecycle } from "./managed-installer";
import { managedLlamaCppStatePaths } from "./managed-state";

export interface ManagedLlamaCppLifecycleAdapterOptions {
  readonly runtimeProvider: RuntimeProviderBundle;
  readonly runtimeOwnerSandboxName: string;
  readonly expectedModel: string;
  readonly expectedReceipt: HostLocalInferenceReceipt;
  readonly gatewayPort: number;
  readonly homeDir?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly operation?: HostLocalInferenceOperation;
  readonly finalizeCleanup?: typeof finalizeManagedLlamaCppLifecycleCleanup;
  readonly prepareCleanup?: typeof prepareManagedLlamaCppLifecycleCleanup;
  readonly rehydrate?: typeof rehydrateManagedLlamaCppLifecycle;
}

/** One provider-specific seam consumed by the common host-local lifecycle coordinator. */
export interface ManagedLlamaCppLifecycleAdapter {
  readonly gatewayPort: number;
  readonly runtimeOwnerSandboxName: string;
  readonly model: string;
  readonly operation: HostLocalInferenceOperation;
  readonly receipt: HostLocalInferenceReceipt;
  readonly runtime: HostLocalInferenceRuntime;
  prepareStartup(): HostLocalInferencePreparedStartup;
}

function requireExactReceipt(
  expected: string,
  value: HostLocalInferenceReceipt,
  message: string,
): HostLocalInferenceReceipt {
  const normalized = normalizeHostLocalInferenceReceipt(value);
  if (serializeHostLocalInferenceReceipt(normalized) !== expected) throw new Error(message);
  return normalized;
}

/**
 * Rehydrate the existing managed llama.cpp internals only after the caller has
 * selected the hidden lifecycle and supplied its durable original owner.
 */
export function createManagedLlamaCppLifecycleAdapter(
  options: ManagedLlamaCppLifecycleAdapterOptions,
): ManagedLlamaCppLifecycleAdapter {
  const expected = serializeHostLocalInferenceReceipt(
    normalizeHostLocalInferenceReceipt(options.expectedReceipt),
  );
  const normalizedReceipt = normalizeHostLocalInferenceReceipt(options.expectedReceipt);
  if (normalizedReceipt.service !== "llama-cpp" || normalizedReceipt.schemaVersion !== 1) {
    throw new Error(
      "Managed llama.cpp lifecycle authority requires its canonical schema-v1 receipt.",
    );
  }
  const gatewayPort = options.gatewayPort;
  if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
    throw new Error("Managed llama.cpp lifecycle authority requires its exact gateway port.");
  }
  const homeDir = fs.realpathSync(options.homeDir ?? os.homedir());
  const paths = managedLlamaCppStatePaths(homeDir, gatewayPort);
  const finalizeCleanup = options.finalizeCleanup ?? finalizeManagedLlamaCppLifecycleCleanup;
  const prepareCleanup = options.prepareCleanup ?? prepareManagedLlamaCppLifecycleCleanup;
  if (!fs.existsSync(paths.stateDir)) {
    const operation =
      options.operation ??
      (() => {
        throw new Error("Managed llama.cpp cleanup retry requires its exact provider operation.");
      })();
    const prepareExactCleanup = (value: HostLocalInferenceReceipt): HostLocalInferenceReceipt => {
      const receipt = requireExactReceipt(
        expected,
        value,
        "Managed llama.cpp cleanup retry changed registry receipt authority.",
      );
      return requireExactReceipt(
        expected,
        prepareCleanup(options.runtimeOwnerSandboxName, receipt, {
          gatewayPort,
          homeDir,
          ...(options.environment === undefined ? {} : { env: options.environment }),
          engine: operation.engine,
        }),
        "Managed llama.cpp cleanup retry could not re-prove registry receipt authority.",
      );
    };
    const unavailable = (): never => {
      throw new Error("Managed llama.cpp private lifecycle state is unavailable.");
    };
    const runtime: HostLocalInferenceRuntime = Object.freeze({
      providerId: operation.providerId,
      authorityId: operation.engine.authorityId,
      services: Object.freeze(["llama-cpp"] as const),
      translateContainerArgs: (args: readonly string[]) => args,
      qualifyOllama: unavailable,
      startManaged: unavailable,
      inspectManaged: unavailable,
      stopManaged: unavailable,
      preserveForRebuild: unavailable,
      prepareDestroy: prepareExactCleanup,
      destroy(value: HostLocalInferenceReceipt) {
        const receipt = prepareExactCleanup(value);
        const finalized = finalizeCleanup(options.runtimeOwnerSandboxName, receipt, {
          gatewayPort,
          homeDir,
          ...(options.environment === undefined ? {} : { env: options.environment }),
          engine: operation.engine,
        });
        if (!finalized.ok) throw new Error(finalized.reason);
        return Object.freeze({
          status: finalized.removed.length > 0 ? ("removed" as const) : ("already-absent" as const),
          receipt,
        });
      },
    });
    return Object.freeze({
      gatewayPort,
      runtimeOwnerSandboxName: options.runtimeOwnerSandboxName,
      model: options.expectedModel,
      operation,
      receipt: normalizedReceipt,
      runtime,
      prepareStartup: unavailable,
    });
  }

  const rehydrated = (options.rehydrate ?? rehydrateManagedLlamaCppLifecycle)({
    runtimeProvider: options.runtimeProvider,
    runtimeOwnerSandboxName: options.runtimeOwnerSandboxName,
    gatewayPort,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.environment === undefined ? {} : { env: options.environment }),
    ...(options.operation === undefined ? {} : { operation: options.operation }),
  });
  const receipt = requireExactReceipt(
    expected,
    rehydrated.receipt,
    "Managed llama.cpp private receipt differs from registry lifecycle authority.",
  );
  if (rehydrated.selection.recipe.spec.model.servedName !== options.expectedModel) {
    throw new Error("Managed llama.cpp private model differs from registry lifecycle authority.");
  }
  const providerRuntime = rehydrated.lifecycle.runtime;
  if (
    providerRuntime.providerId !== options.runtimeProvider.identity.id ||
    providerRuntime.authorityId !== rehydrated.operation.engine.authorityId ||
    !providerRuntime.services.includes("llama-cpp")
  ) {
    throw new Error("Managed llama.cpp adapter reconstructed a different runtime authority.");
  }
  const runtime: HostLocalInferenceRuntime = Object.freeze({
    ...providerRuntime,
    destroy(value: HostLocalInferenceReceipt) {
      const destroyed = providerRuntime.destroy(value);
      requireExactReceipt(
        expected,
        destroyed.receipt,
        "Managed llama.cpp destroy changed registry receipt authority.",
      );
      const finalized = finalizeCleanup(options.runtimeOwnerSandboxName, receipt, {
        gatewayPort,
        ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
        ...(options.environment === undefined ? {} : { env: options.environment }),
        engine: rehydrated.operation.engine,
      });
      if (!finalized.ok) throw new Error(finalized.reason);
      return Object.freeze({
        status:
          destroyed.status === "removed" || finalized.removed.length > 0
            ? ("removed" as const)
            : ("already-absent" as const),
        receipt,
      });
    },
  });

  return Object.freeze({
    gatewayPort,
    runtimeOwnerSandboxName: options.runtimeOwnerSandboxName,
    model: rehydrated.selection.recipe.spec.model.servedName,
    operation: rehydrated.operation,
    receipt,
    runtime,
    prepareStartup(): HostLocalInferencePreparedStartup {
      const atEntry = runtime.inspectManaged(receipt);
      requireExactReceipt(
        expected,
        atEntry.receipt,
        "Managed llama.cpp inspection changed registry receipt authority.",
      );
      const resumed = requireExactReceipt(
        expected,
        rehydrated.lifecycle.resume(receipt),
        "Managed llama.cpp resume changed registry receipt authority.",
      );
      const rollbackPriorState = atEntry.running ? ("running" as const) : ("stopped" as const);
      let state:
        | "prepared"
        | "validated"
        | "committing"
        | "committed"
        | "rolling-back"
        | "rolled-back"
        | "indeterminate" = "prepared";
      const requireRollbackSafe = (action: string): void => {
        if (state !== "prepared" && state !== "validated") {
          throw new Error(
            `Managed llama.cpp startup cannot ${action} from terminal state '${state}'.`,
          );
        }
      };
      return Object.freeze({
        receipt: resumed,
        rollbackPriorState,
        publicationState() {
          if (state === "committed") return "published" as const;
          if (state === "prepared" || state === "validated" || state === "rolled-back") {
            return "unpublished" as const;
          }
          return "indeterminate" as const;
        },
        validateBeforeCommit() {
          requireRollbackSafe("validate before commit");
          try {
            const validated = requireExactReceipt(
              expected,
              runtime.preserveForRebuild(receipt),
              "Managed llama.cpp validation changed registry receipt authority.",
            );
            state = "validated";
            return validated;
          } catch (error) {
            state = "prepared";
            throw error;
          }
        },
        commit() {
          if (state !== "validated") {
            throw new Error(
              `Managed llama.cpp startup cannot commit without fresh validation from state '${state}'.`,
            );
          }
          state = "committing";
          try {
            const committed = requireExactReceipt(
              expected,
              runtime.preserveForRebuild(receipt),
              "Managed llama.cpp commit changed registry receipt authority.",
            );
            state = "committed";
            return committed;
          } catch (error) {
            state = "indeterminate";
            throw error;
          }
        },
        rollback: () => {
          requireRollbackSafe("roll back");
          state = "rolling-back";
          try {
            const restored = atEntry.running
              ? runtime.preserveForRebuild(receipt)
              : runtime.stopManaged(receipt).receipt;
            const result = Object.freeze({
              status: "restored" as const,
              priorState: rollbackPriorState,
              receipt: requireExactReceipt(
                expected,
                restored,
                "Managed llama.cpp rollback changed registry receipt authority.",
              ),
            });
            state = "rolled-back";
            return result;
          } catch (error) {
            state = "indeterminate";
            throw error;
          }
        },
      });
    },
  });
}
