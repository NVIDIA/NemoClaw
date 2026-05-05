// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  resolveDefaultSandboxName,
  runStartCommand,
  runStopCommand,
} from "../../dist/lib/services-command";

describe("services command", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      NEMOCLAW_SANDBOX_NAME: process.env.NEMOCLAW_SANDBOX_NAME,
      NEMOCLAW_SANDBOX: process.env.NEMOCLAW_SANDBOX,
      SANDBOX_NAME: process.env.SANDBOX_NAME,
    };
    delete process.env.NEMOCLAW_SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    delete process.env.SANDBOX_NAME;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns a safe default sandbox name", () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "alpha-1" }))).toBe("alpha-1");
  });

  it("drops an unsafe default sandbox name", () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "bad name" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "../../oops" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: ".hidden" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "-leading-dash" }))).toBeUndefined();
  });

  it("prefers NEMOCLAW_SANDBOX_NAME env var over registry default", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "env-sandbox";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe("env-sandbox");
  });

  it("prefers NEMOCLAW_SANDBOX env var over registry default", () => {
    process.env.NEMOCLAW_SANDBOX = "env-sandbox-2";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe("env-sandbox-2");
  });

  it("ignores unsafe env var values and falls back to registry", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "bad name";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe("registry-sandbox");
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
