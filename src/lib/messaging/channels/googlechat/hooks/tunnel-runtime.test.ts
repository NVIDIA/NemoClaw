// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createDefaultGooglechatTunnelGateOptions } from "./tunnel-runtime";

describe("Google Chat tunnel runtime", () => {
  it("targets a dedicated route-restricted proxy instead of the dashboard", async () => {
    const pidDir = "/tmp/nemoclaw-services-test-googlechat";
    const startAll = vi.fn(async () => undefined);
    const stopCloudflared = vi.fn(() => true);
    const stopGooglechatWebhookProxy = vi.fn();
    const startGooglechatWebhookProxy = vi.fn(async () => 24680);
    const services = {
      getTunnelUrl: vi.fn(() => "https://restricted.trycloudflare.com"),
      readCloudflaredState: vi.fn(() => ({ kind: "running", pid: 123 }) as const),
      resolveServicePidDir: vi.fn(() => "/tmp/nemoclaw-services-test"),
      startAll,
      stopCloudflared,
    };
    const webhookProxy = {
      readGooglechatWebhookProxyState: vi.fn(
        () => ({ running: true, port: 24680, upstreamPort: 18789 }) as const,
      ),
      startGooglechatWebhookProxy,
      stopGooglechatWebhookProxy,
    };
    const options = createDefaultGooglechatTunnelGateOptions({
      dashboardPort: 18789,
      loadServices: () => services,
      loadWebhookProxy: () => webhookProxy,
      sandboxName: "test",
    });

    expect(options.readTunnelState?.()).toEqual({ running: true });
    await options.startTunnel?.();
    expect(stopCloudflared).toHaveBeenCalledWith({ pidDir });
    expect(startGooglechatWebhookProxy).toHaveBeenCalledWith(pidDir, 18789);
    expect(startAll).toHaveBeenCalledWith({
      pidDir,
      dashboardPort: 24680,
      cloudflareTunnelToken: "",
      sandboxName: "test",
    });
    expect(options.getTunnelUrl?.()).toBe("https://restricted.trycloudflare.com");
    expect(services.getTunnelUrl).toHaveBeenCalledWith(pidDir, 24680);

    options.stopTunnel?.();
    expect(stopCloudflared).toHaveBeenLastCalledWith({ pidDir });
    expect(stopGooglechatWebhookProxy).toHaveBeenCalledWith(pidDir);
  });

  it("does not report the tunnel ready when its route proxy is unavailable", () => {
    const options = createDefaultGooglechatTunnelGateOptions({
      loadServices: () => ({
        getTunnelUrl: () => "https://unsafe.example.com",
        readCloudflaredState: () => ({ kind: "running", pid: 123 }),
        resolveServicePidDir: () => "/tmp/nemoclaw-services-test",
        startAll: async () => undefined,
        stopCloudflared: () => true,
      }),
      loadWebhookProxy: () => ({
        readGooglechatWebhookProxyState: () => ({
          running: false,
          port: null,
          upstreamPort: null,
        }),
        startGooglechatWebhookProxy: async () => 24680,
        stopGooglechatWebhookProxy: () => undefined,
      }),
      sandboxName: "test",
    });

    expect(options.readTunnelState?.()).toEqual({ running: false });
    expect(options.getTunnelUrl?.()).toBe("");
  });

  it("stops the route proxy when cloudflared startup fails", async () => {
    const stopGooglechatWebhookProxy = vi.fn();
    const options = createDefaultGooglechatTunnelGateOptions({
      loadServices: () => ({
        getTunnelUrl: () => "",
        readCloudflaredState: () => ({ kind: "stopped" }),
        resolveServicePidDir: () => "/tmp/nemoclaw-services-test",
        startAll: async () => {
          throw new Error("cloudflared failed");
        },
        stopCloudflared: () => true,
      }),
      loadWebhookProxy: () => ({
        readGooglechatWebhookProxyState: () => ({
          running: false,
          port: null,
          upstreamPort: null,
        }),
        startGooglechatWebhookProxy: async () => 24680,
        stopGooglechatWebhookProxy,
      }),
      sandboxName: "test",
    });

    await expect(options.startTunnel?.()).rejects.toThrow("cloudflared failed");
    expect(stopGooglechatWebhookProxy).toHaveBeenCalledWith(
      "/tmp/nemoclaw-services-test-googlechat",
    );
  });

  it("preserves the route proxy when cloudflared cleanup is unverified", () => {
    const stopGooglechatWebhookProxy = vi.fn();
    const options = createDefaultGooglechatTunnelGateOptions({
      loadServices: () => ({
        getTunnelUrl: () => "https://restricted.trycloudflare.com",
        readCloudflaredState: () => ({ kind: "unverified-pid-process", pid: 4242 }),
        resolveServicePidDir: () => "/tmp/nemoclaw-services-test",
        startAll: async () => undefined,
        stopCloudflared: () => false,
      }),
      loadWebhookProxy: () => ({
        readGooglechatWebhookProxyState: () => ({
          running: true,
          port: 24680,
          upstreamPort: 18789,
        }),
        startGooglechatWebhookProxy: async () => 24680,
        stopGooglechatWebhookProxy,
      }),
      sandboxName: "test",
    });

    expect(() => options.stopTunnel?.()).toThrow(
      "Google Chat tunnel cleanup is incomplete because cloudflared could not be confirmed stopped",
    );
    expect(stopGooglechatWebhookProxy).not.toHaveBeenCalled();
  });

  it("does not start a route proxy when prior cloudflared cleanup is unverified", async () => {
    const startAll = vi.fn(async () => undefined);
    const startGooglechatWebhookProxy = vi.fn(async () => 24680);
    const options = createDefaultGooglechatTunnelGateOptions({
      loadServices: () => ({
        getTunnelUrl: () => "",
        readCloudflaredState: () => ({ kind: "unverified-pid-process", pid: 4242 }),
        resolveServicePidDir: () => "/tmp/nemoclaw-services-test",
        startAll,
        stopCloudflared: () => false,
      }),
      loadWebhookProxy: () => ({
        readGooglechatWebhookProxyState: () => ({
          running: false,
          port: null,
          upstreamPort: null,
        }),
        startGooglechatWebhookProxy,
        stopGooglechatWebhookProxy: vi.fn(),
      }),
      sandboxName: "test",
    });

    await expect(options.startTunnel?.()).rejects.toThrow(
      "Google Chat tunnel cleanup is incomplete because cloudflared could not be confirmed stopped",
    );
    expect(startGooglechatWebhookProxy).not.toHaveBeenCalled();
    expect(startAll).not.toHaveBeenCalled();
  });
});
