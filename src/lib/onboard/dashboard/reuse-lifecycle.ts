// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type DashboardReuseLifecycle = {
  stopSandbox(sandboxName: string): { exitCode: number; message?: string };
  startSandbox(sandboxName: string): Promise<{ exitCode: number; message?: string }>;
};

let activeLifecycle: DashboardReuseLifecycle | undefined;

export function getDashboardReuseLifecycle(): DashboardReuseLifecycle | undefined {
  return activeLifecycle;
}

export async function withDashboardReuseLifecycle<T>(
  lifecycle: DashboardReuseLifecycle | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = activeLifecycle;
  activeLifecycle = lifecycle;
  try {
    return await operation();
  } finally {
    activeLifecycle = previous;
  }
}
