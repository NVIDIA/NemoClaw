// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { type CleanupHost, CleanupRegistry } from "../fixtures/cleanup.ts";

describe("cleanup resources", () => {
  it("tears down acquired resources in reverse order", async () => {
    const calls: string[] = [];
    const host: CleanupHost = {
      cleanupSandbox: async (name) => {
        calls.push(`sandbox:${name}`);
      },
      cleanupGatewayRegistration: async (name) => {
        calls.push(`gateway:${name}`);
      },
      cleanupForward: async (port) => {
        calls.push(`forward:${port}`);
      },
    };
    const cleanup = new CleanupRegistry();
    cleanup.trackGateway(host, "nemoclaw");
    cleanup.trackSandbox(host, "e2e-resource");
    cleanup.trackForward(host, 18789);

    const result = await cleanup.runAll();
    expect(calls).toEqual(["forward:18789", "sandbox:e2e-resource", "gateway:nemoclaw"]);
    expect(result.failures).toEqual([]);
  });

  it("passes cleanup run options through tracked resources", async () => {
    const calls: unknown[] = [];
    const host: CleanupHost = {
      cleanupSandbox: async (_name, options) => {
        calls.push(options);
      },
      cleanupGatewayRegistration: async (_name, options) => {
        calls.push(options);
      },
      cleanupForward: async (_port, options) => {
        calls.push(options);
      },
    };
    const cleanup = new CleanupRegistry();
    const options = { artifactName: "cleanup-resource", timeoutMs: 1000 };

    cleanup.trackGateway(host, "nemoclaw", options);
    cleanup.trackSandbox(host, "e2e-resource", options);
    cleanup.trackForward(host, 18789, options);

    await cleanup.runAll();
    expect(calls).toEqual([options, options, options]);
  });

  it("supports partial setup and runs each registration only once", async () => {
    let calls = 0;
    const cleanup = new CleanupRegistry();
    cleanup.trackDisposable("close acquired server", () => {
      calls += 1;
    });

    expect((await cleanup.runAll()).passed).toEqual(["close acquired server"]);
    expect(await cleanup.runAll()).toEqual({ passed: [], failures: [] });
    expect(calls).toBe(1);
  });

  it("redacts failures and continues cleanup", async () => {
    const calls: string[] = [];
    const cleanup = new CleanupRegistry((text) => text.replaceAll("secret", "[REDACTED]"));
    cleanup.trackDisposable("later secret cleanup", () => {
      calls.push("later");
    });
    cleanup.trackDisposable("failing secret cleanup", () => {
      throw new Error("secret failure");
    });

    const result = await cleanup.runAll();
    expect(calls).toEqual(["later"]);
    expect(result).toEqual({
      passed: ["later [REDACTED] cleanup"],
      failures: [{ name: "failing [REDACTED] cleanup", message: "[REDACTED] failure" }],
    });
  });
});
