// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, type MockInstance } from "vitest";

export function expectNoSandboxDelete(runOpenshellSpy: MockInstance): void {
  const sandboxDeleteWasCalled = runOpenshellSpy.mock.calls.some(
    ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "delete",
  );
  expect(sandboxDeleteWasCalled).toBe(false);
}
