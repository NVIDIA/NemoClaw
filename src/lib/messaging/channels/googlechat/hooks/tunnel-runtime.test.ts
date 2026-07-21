// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createDefaultGooglechatTunnelGateOptions } from "./tunnel-runtime";

describe("Google Chat tunnel runtime", () => {
  it("targets a dedicated route-restricted proxy instead of the dashboard", async () => {
    const pidDir = "/tmp/nemoclaw-services-test-googlechat";
    const startAll = vi.fn(async () => undefined);
    const stopCloudflared = vi.fn();
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
    });

    expect(options.readTunnelState?.()).toEqual({ running: true });
    await options.startTunnel?.();
    expect(stopCloudflared).toHaveBeenCalledWith({ pidDir });
    expect(startGooglechatWebhookProxy).toHaveBeenCalledWith(pidDir, 18789);
    expect(startAll).toHaveBeenCalledWith({
      pidDir,
      dashboardPort: 24680,
      cloudflareTunnelToken: "",
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
        stopCloudflared: () => undefined,
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
        stopCloudflared: () => undefined,
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
    });

    await expect(options.startTunnel?.()).rejects.toThrow("cloudflared failed");
    expect(stopGooglechatWebhookProxy).toHaveBeenCalledWith(
      "/tmp/nemoclaw-services-test-googlechat",
    );
  });
});
