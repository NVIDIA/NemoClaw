// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  gatewayHasRegisteredSandbox,
  teardownOrphanManagedGatewayOnAbort,
} from "./gateway-destroy";
import { GatewayAuthorityError } from "./gateway-teardown-authority";

describe("gatewayHasRegisteredSandbox", () => {
  it("returns true when a sandbox is bound to the gateway name", () => {
    const listSandboxes = () => ({
      sandboxes: [{ name: "alpha", gatewayName: "nemoclaw-8814", gatewayPort: 8814 }],
      defaultSandbox: "alpha" as string | null,
    });
    expect(gatewayHasRegisteredSandbox("nemoclaw-8814", listSandboxes)).toBe(true);
  });

  it("returns false when no sandbox owns the gateway", () => {
    const listSandboxes = () => ({
      sandboxes: [{ name: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 }],
      defaultSandbox: "alpha" as string | null,
    });
    expect(gatewayHasRegisteredSandbox("nemoclaw-8814", listSandboxes)).toBe(false);
  });

  it("reports unknown ownership when a registry binding cannot be resolved", () => {
    const listSandboxes = () => ({
      sandboxes: [{ name: "alpha", gatewayName: "not-a-nemoclaw-gateway" }],
      defaultSandbox: "alpha" as string | null,
    });
    expect(gatewayHasRegisteredSandbox("nemoclaw-8814", listSandboxes)).toBeNull();
  });
});

describe("teardownOrphanManagedGatewayOnAbort (#8952)", () => {
  it("skips teardown when a sandbox still owns the gateway", () => {
    const release = vi.fn();
    const remove = vi.fn();
    const cleanupComplete = teardownOrphanManagedGatewayOnAbort({
      gatewayPort: 8814,
      gatewayName: "nemoclaw-8814",
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", gatewayName: "nemoclaw-8814", gatewayPort: 8814 }],
        defaultSandbox: "alpha",
      }),
      releaseManagedGatewayPort: release,
      removeGatewayRegistration: remove,
    });
    expect(cleanupComplete).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("skips teardown for an externally supervised gateway", () => {
    const release = vi.fn();
    const remove = vi.fn();
    const log = vi.fn();
    const cleanupComplete = teardownOrphanManagedGatewayOnAbort({
      gatewayPort: 8814,
      gatewayName: "nemoclaw-8814",
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      resolveAuthority: () => ({
        gatewayName: "nemoclaw-8814",
        gatewayPort: 8814,
        mode: "externally-supervised",
        source: "declared",
        endpoint: "https://gateway.example",
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      releaseManagedGatewayPort: release,
      removeGatewayRegistration: remove,
      log,
    });
    expect(cleanupComplete).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "externally supervised",
    );
  });

  it("skips teardown when authority cannot be revalidated", () => {
    const release = vi.fn();
    const remove = vi.fn();
    const warn = vi.fn();
    const cleanupComplete = teardownOrphanManagedGatewayOnAbort({
      gatewayPort: 8814,
      gatewayName: "nemoclaw-8814",
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      resolveAuthority: () => {
        throw new GatewayAuthorityError("authority mismatch");
      },
      releaseManagedGatewayPort: release,
      removeGatewayRegistration: remove,
      warn,
    });
    expect(cleanupComplete).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "authority mismatch",
    );
  });

  it("fails cleanup without teardown when sandbox ownership is unknown", () => {
    const release = vi.fn();
    const remove = vi.fn();
    const warn = vi.fn();
    const cleanupComplete = teardownOrphanManagedGatewayOnAbort({
      gatewayPort: 8814,
      gatewayName: "nemoclaw-8814",
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", gatewayName: "not-a-nemoclaw-gateway" }],
        defaultSandbox: "alpha",
      }),
      releaseManagedGatewayPort: release,
      removeGatewayRegistration: remove,
      warn,
    });

    expect(cleanupComplete).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "sandbox gateway binding is unreadable",
    );
  });

  it("stops the host listener and removes registration when no sandbox owns the gateway", () => {
    const release = vi.fn(() => ({
      port: 8814,
      released: true,
      stopped: [4242],
      remaining: [],
      scanned: true,
      skipped: false,
    }));
    const remove = vi.fn(() => true);
    const log = vi.fn();
    const cleanupComplete = teardownOrphanManagedGatewayOnAbort({
      gatewayPort: 8814,
      gatewayName: "nemoclaw-8814",
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      resolveAuthority: () => ({
        gatewayName: "nemoclaw-8814",
        gatewayPort: 8814,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      releaseManagedGatewayPort: release,
      removeGatewayRegistration: remove,
      log,
    });
    expect(cleanupComplete).toBe(true);
    expect(release).toHaveBeenCalledWith({ port: 8814 });
    expect(remove).toHaveBeenCalledWith("nemoclaw-8814");
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Onboard aborted before a sandbox was created");
    expect(output).toContain("Released gateway port 8814");
  });

  it("warns and returns false when the sandbox registry cannot be read", () => {
    const release = vi.fn();
    const remove = vi.fn();
    const warn = vi.fn();
    const cleanupComplete = teardownOrphanManagedGatewayOnAbort({
      gatewayPort: 8814,
      gatewayName: "nemoclaw-8814",
      listSandboxes: () => {
        throw new Error("registry unreadable");
      },
      releaseManagedGatewayPort: release,
      removeGatewayRegistration: remove,
      warn,
    });
    expect(cleanupComplete).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "registry unreadable",
    );
  });

  it("keeps registration when listener release is not confirmed", () => {
    const release = vi.fn(() => ({
      port: 8814,
      released: false,
      stopped: [],
      remaining: [4242],
      scanned: true,
      skipped: false,
    }));
    const remove = vi.fn();
    const warn = vi.fn();
    const cleanupComplete = teardownOrphanManagedGatewayOnAbort({
      gatewayPort: 8814,
      gatewayName: "nemoclaw-8814",
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      resolveAuthority: () => ({
        gatewayName: "nemoclaw-8814",
        gatewayPort: 8814,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      releaseManagedGatewayPort: release,
      removeGatewayRegistration: remove,
      warn,
    });
    expect(cleanupComplete).toBe(false);
    expect(release).toHaveBeenCalledWith({ port: 8814 });
    expect(remove).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "not confirmed released",
    );
  });

  it("keeps registration when listener release throws", () => {
    const release = vi.fn(() => {
      throw new Error("stop boom");
    });
    const remove = vi.fn();
    const warn = vi.fn();
    const cleanupComplete = teardownOrphanManagedGatewayOnAbort({
      gatewayPort: 8814,
      gatewayName: "nemoclaw-8814",
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      resolveAuthority: () => ({
        gatewayName: "nemoclaw-8814",
        gatewayPort: 8814,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      releaseManagedGatewayPort: release,
      removeGatewayRegistration: remove,
      warn,
    });
    expect(cleanupComplete).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("stop boom");
  });

  it("fails cleanup when gateway registration removal is not confirmed", () => {
    const warn = vi.fn();
    const cleanupComplete = teardownOrphanManagedGatewayOnAbort({
      gatewayPort: 8814,
      gatewayName: "nemoclaw-8814",
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      resolveAuthority: () => ({
        gatewayName: "nemoclaw-8814",
        gatewayPort: 8814,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      releaseManagedGatewayPort: () => ({
        port: 8814,
        released: true,
        stopped: [4242],
        remaining: [],
        scanned: true,
        skipped: false,
      }),
      removeGatewayRegistration: () => false,
      warn,
    });

    expect(cleanupComplete).toBe(false);
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "was not confirmed removed",
    );
  });

  it("fails cleanup when gateway registration removal throws", () => {
    const warn = vi.fn();
    const cleanupComplete = teardownOrphanManagedGatewayOnAbort({
      gatewayPort: 8814,
      gatewayName: "nemoclaw-8814",
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      resolveAuthority: () => ({
        gatewayName: "nemoclaw-8814",
        gatewayPort: 8814,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      releaseManagedGatewayPort: () => ({
        port: 8814,
        released: true,
        stopped: [4242],
        remaining: [],
        scanned: true,
        skipped: false,
      }),
      removeGatewayRegistration: () => {
        throw new Error("remove boom");
      },
      warn,
    });

    expect(cleanupComplete).toBe(false);
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("remove boom");
  });
});
