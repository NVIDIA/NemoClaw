// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const lockMocks = vi.hoisted(() => ({
  withMcpLifecycleLock: vi.fn(async (_sandboxName: string, operation: () => unknown) =>
    operation(),
  ),
  withSandboxMutationLock: vi.fn(async () => undefined),
}));

vi.mock("../../state/mcp-lifecycle-lock", () => lockMocks);

import {
  addSandboxChannel,
  addSandboxPolicy,
  removeSandboxChannel,
  removeSandboxPolicy,
  startSandboxChannel,
  stopSandboxChannel,
} from "./policy-channel";

describe("policy and channel sandbox mutation locking", () => {
  beforeEach(() => {
    lockMocks.withSandboxMutationLock.mockClear();
  });

  it.each([
    ["policy add", () => addSandboxPolicy("alpha")],
    ["policy remove", () => removeSandboxPolicy("alpha")],
    ["channel add", () => addSandboxChannel("alpha")],
    ["channel remove", () => removeSandboxChannel("alpha")],
    ["channel start", () => startSandboxChannel("alpha")],
    ["channel stop", () => stopSandboxChannel("alpha")],
  ])("routes %s through the shared per-sandbox lock", async (_label, action) => {
    await action();

    expect(lockMocks.withSandboxMutationLock).toHaveBeenCalledOnce();
    expect(lockMocks.withSandboxMutationLock).toHaveBeenCalledWith("alpha", expect.any(Function));
  });
});
