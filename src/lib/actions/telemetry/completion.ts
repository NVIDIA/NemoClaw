// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import type { TelemetryConfigurationOperation } from "../../domain/telemetry/event";
import { loadCompleteRegistrySnapshot } from "../../state/registry/persistence";
import { sendConfigurationSnapshotTelemetry } from "./send";
import { projectPublishedTelemetrySnapshot } from "./snapshot";

// A parent command owns its completion. Child onboarding/rebuild steps must not
// publish intermediate state; concurrent unrelated commands have separate scopes.
const parentCompletion = new AsyncLocalStorage<{ completedChildren: number }>();

export function hasParentConfigurationCompletion(): boolean {
  return parentCompletion.getStore() !== undefined;
}

export function completedNestedConfigurationCount(): number {
  return parentCompletion.getStore()?.completedChildren ?? 0;
}

export async function withConfigurationCompletion(
  operation: TelemetryConfigurationOperation,
  run: (complete: () => void) => Promise<void>,
): Promise<void> {
  const parent = parentCompletion.getStore();
  let completed = false;
  await parentCompletion.run({ completedChildren: 0 }, () =>
    run(() => {
      completed = true;
    }),
  );
  if (!completed) return;
  if (parent) {
    parent.completedChildren++;
    return;
  }
  try {
    await sendConfigurationSnapshotTelemetry(operation, () =>
      projectPublishedTelemetrySnapshot(operation, loadCompleteRegistrySnapshot()),
    );
  } catch {
    // Reporting must not change the successful product operation.
  }
}
