// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { getDashboardReuseLifecycle, withDashboardReuseLifecycle } from "./reuse-lifecycle";

it("exposes dashboard reuse lifecycle only while onboarding runs", async () => {
  const lifecycle = { startSandbox: vi.fn(), stopSandbox: vi.fn() };

  await withDashboardReuseLifecycle(lifecycle, async () => {
    expect(getDashboardReuseLifecycle()).toBe(lifecycle);
  });

  expect(getDashboardReuseLifecycle()).toBeUndefined();
});
