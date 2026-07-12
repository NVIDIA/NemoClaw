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
    const calls: Array<{ resource: string; options: unknown }> = [];
    const host: CleanupHost = {
      cleanupSandbox: async (_name, options) => {
        calls.push({ resource: "sandbox", options });
      },
      cleanupGatewayRegistration: async (_name, options) => {
        calls.push({ resource: "gateway", options });
      },
      cleanupForward: async (_port, options) => {
        calls.push({ resource: "forward", options });
      },
    };
    const cleanup = new CleanupRegistry();
    const gatewayOptions = {
      artifactName: "cleanup-gateway",
      env: { OPENSHELL_GATEWAY: "nemoclaw" },
      redactionValues: ["gateway-secret"],
      timeoutMs: 1_000,
    };
    const sandboxOptions = {
      artifactName: "cleanup-sandbox",
      env: { NEMOCLAW_GATEWAY_PORT: "18080" },
      redactionValues: ["sandbox-secret"],
      timeoutMs: 2_000,
    };
    const forwardOptions = {
      artifactName: "cleanup-forward",
      env: { OPENSHELL_GATEWAY: "nemoclaw-18080" },
      redactionValues: ["forward-secret"],
      timeoutMs: 3_000,
    };

    cleanup.trackGateway(host, "nemoclaw", gatewayOptions);
    cleanup.trackSandbox(host, "e2e-resource", sandboxOptions);
    cleanup.trackForward(host, 18789, forwardOptions);

    await cleanup.runAll();
    expect(calls).toEqual([
      { resource: "forward", options: forwardOptions },
      { resource: "sandbox", options: sandboxOptions },
      { resource: "gateway", options: gatewayOptions },
    ]);
  });

  it("supports partial typed setup and runs each registration only once", async () => {
    let calls = 0;
    const host: CleanupHost = {
      cleanupSandbox: async () => {
        calls += 1;
      },
      cleanupGatewayRegistration: async () => {
        throw new Error("unregistered gateway cleanup must not run");
      },
      cleanupForward: async () => {
        throw new Error("unregistered forward cleanup must not run");
      },
    };
    const cleanup = new CleanupRegistry();
    cleanup.trackSandbox(host, "partially-created");

    expect((await cleanup.runAll()).passed).toEqual(["destroy sandbox partially-created"]);
    expect(await cleanup.runAll()).toEqual({ passed: [], failures: [] });
    expect(calls).toBe(1);
  });

  it("continues typed cleanup after a resource failure", async () => {
    const calls: string[] = [];
    const host: CleanupHost = {
      cleanupSandbox: async () => {
        calls.push("sandbox");
        throw new Error("sandbox cleanup denied");
      },
      cleanupGatewayRegistration: async () => {
        calls.push("gateway");
      },
      cleanupForward: async () => {
        calls.push("forward");
      },
    };
    const cleanup = new CleanupRegistry();
    cleanup.trackGateway(host, "nemoclaw");
    cleanup.trackSandbox(host, "e2e-resource");
    cleanup.trackForward(host, 18789);

    const result = await cleanup.runAll();
    expect(calls).toEqual(["forward", "sandbox", "gateway"]);
    expect(result).toEqual({
      passed: ["stop forward 18789", "remove gateway nemoclaw"],
      failures: [{ name: "destroy sandbox e2e-resource", message: "sandbox cleanup denied" }],
    });
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
