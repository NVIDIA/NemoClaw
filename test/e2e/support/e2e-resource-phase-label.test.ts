// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { assertPhaseLabel } from "../../../tools/e2e/runner-pressure-core.mts";
import { resourcePhaseLabel } from "../fixtures/e2e-test.ts";

it("bounds long resource phase labels without losing deterministic identity", () => {
  const target = "openshell-gateway-auth-contract";
  const phase = "confirm gateway and Docker prerequisites";
  const label = resourcePhaseLabel(target, phase);

  expect(label).toHaveLength(64);
  expect(label).toMatch(/\.[a-f0-9]{12}$/u);
  expect(assertPhaseLabel(label)).toBe(label);
  expect(resourcePhaseLabel(target, phase)).toBe(label);
  expect(resourcePhaseLabel(target, `${phase} again`)).not.toBe(label);
});
