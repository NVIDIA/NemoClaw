// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { createSession, filterSafeUpdates, normalizeSession } from "./onboard-session";

it("persists only valid Model Router cleanup ports", () => {
  const created = createSession({ routerPort: 14000 });

  expect(created.routerPort).toBe(14000);
  expect(normalizeSession(created)?.routerPort).toBe(14000);
  expect(filterSafeUpdates({ routerPort: 15000 })).toMatchObject({ routerPort: 15000 });
  expect(filterSafeUpdates({ routerPort: 70000 })).not.toHaveProperty("routerPort");
  expect(createSession({ routerPort: 70000 }).routerPort).toBeNull();
});
