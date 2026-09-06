// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { getDashboardReuseLifecycle, withDashboardReuseLifecycle } from "./reuse-lifecycle";

it("keeps overlapping onboarding lifecycle scopes independent", async () => {
  const first = { startSandbox: vi.fn(), stopSandbox: vi.fn() };
  const second = { startSandbox: vi.fn(), stopSandbox: vi.fn() };
  let releaseFirst!: () => void;
  const firstPaused = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const firstOperation = withDashboardReuseLifecycle(first, async () => {
    expect(getDashboardReuseLifecycle()).toBe(first);
    await firstPaused;
    expect(getDashboardReuseLifecycle()).toBe(first);
  });
  await withDashboardReuseLifecycle(second, async () => {
    expect(getDashboardReuseLifecycle()).toBe(second);
  });
  releaseFirst();
  await firstOperation;

  expect(getDashboardReuseLifecycle()).toBeUndefined();
});
