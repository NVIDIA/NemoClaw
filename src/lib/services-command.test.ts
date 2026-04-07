// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  resolveDefaultSandboxName,
  runStartCommand,
  runStopCommand,
} from "../../dist/lib/services-command";

describe("services command", () => {
  it("returns a safe default sandbox name", () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "alpha-1" }))).toBe("alpha-1");
  });

  it("drops an unsafe default sandbox name", () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "bad name" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "../../oops" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: ".hidden" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "-leading-dash" }))).toBeUndefined();
  });

  it("starts services for the default sandbox when present", async () => {
    const startAll = vi.fn(async () => {});
    await runStartCommand({
      listSandboxes: () => ({ defaultSandbox: "alpha" }),
      startAll,
    });
    expect(startAll).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  it("stops services without a sandbox override when the default sandbox is unsafe", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "bad name" }),
      stopAll,
    });
    expect(stopAll).toHaveBeenCalledWith({ sandboxName: undefined });
  });
});
