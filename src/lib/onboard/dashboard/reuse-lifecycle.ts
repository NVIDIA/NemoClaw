// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

export type DashboardReuseLifecycle = {
  stopSandbox(sandboxName: string): { exitCode: number; message?: string };
  startSandbox(sandboxName: string): Promise<{ exitCode: number; message?: string }>;
};

const lifecycleStorage = new AsyncLocalStorage<DashboardReuseLifecycle>();

export function getDashboardReuseLifecycle(): DashboardReuseLifecycle | undefined {
  return lifecycleStorage.getStore();
}

export function withDashboardReuseLifecycle<T>(
  lifecycle: DashboardReuseLifecycle,
  operation: () => Promise<T>,
): Promise<T> {
  return lifecycleStorage.run(lifecycle, operation);
}
