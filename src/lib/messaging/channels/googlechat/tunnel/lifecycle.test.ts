// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveServicePidDir, stopCloudflared } from "../../../../tunnel/services";
import { createDefaultGooglechatTunnelGateOptions } from "../hooks/tunnel-runtime";
import { googlechatWebhookTunnelPidDir, stopGooglechatWebhookTunnel } from "./lifecycle";

describe("Google Chat webhook tunnel lifecycle", () => {
  it("stops the sandbox-scoped cloudflared process and route proxy", () => {
    const stopCloudflared = vi.fn(() => true);
    const stopGooglechatWebhookProxy = vi.fn();
    const pidDir = stopGooglechatWebhookTunnel("alpha", {
      services: {
        resolveServicePidDir: ({ sandboxName } = {}) =>
          `/tmp/nemoclaw-services-${sandboxName ?? "default"}`,
        stopCloudflared,
      },
      webhookProxy: { stopGooglechatWebhookProxy },
    });

    expect(pidDir).toBe("/tmp/nemoclaw-services-alpha-googlechat");
    expect(stopCloudflared).toHaveBeenCalledWith({ pidDir });
    expect(stopGooglechatWebhookProxy).toHaveBeenCalledWith(pidDir);
  });

  it("retains the proxy and tunnel state when the tunnel cannot be stopped", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "googlechat-stop-"));
    const stopGooglechatWebhookProxy = vi.fn();
    const signal = vi.fn(() => {
      throw new Error("signal denied");
    });
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    writeFileSync(join(pidDir, "cloudflared.dashboard-port"), "24680");
    try {
      expect(() =>
        stopGooglechatWebhookTunnel("alpha", {
          services: {
            resolveServicePidDir: () => "/unused",
            stopCloudflared: () =>
              stopCloudflared({
                pidDir,
                processControl: {
                  isAlive: () => true,
                  commandLine: () => "cloudflared tunnel --url http://localhost:24680",
                  signalCloudflared: signal,
                },
              }),
          },
          webhookProxy: { stopGooglechatWebhookProxy },
        }),
      ).toThrow("signal denied");
      expect(signal).toHaveBeenCalledWith(999999999, "SIGTERM");
      expect(stopGooglechatWebhookProxy).not.toHaveBeenCalled();
      expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe("999999999");
      expect(readFileSync(join(pidDir, "cloudflared.dashboard-port"), "utf-8")).toBe("24680");
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }
  });

  it("derives a separate state directory from the normal tunnel", () => {
    expect(googlechatWebhookTunnelPidDir("/tmp/nemoclaw-services-alpha")).toBe(
      "/tmp/nemoclaw-services-alpha-googlechat",
    );
  });

  it("uses the same real sandbox-scoped PID resolver for enrollment and teardown", () => {
    const readCloudflaredState = vi.fn(() => ({ kind: "running", pid: 123 }) as const);
    const readGooglechatWebhookProxyState = vi.fn(
      () => ({ running: true, port: 24680, upstreamPort: 18789 }) as const,
    );
    const options = createDefaultGooglechatTunnelGateOptions({
      loadServices: () => ({
        getTunnelUrl: () => "https://restricted.trycloudflare.com",
        readCloudflaredState,
        resolveServicePidDir,
        startAll: async () => undefined,
        stopCloudflared: () => true,
      }),
      loadWebhookProxy: () => ({
        readGooglechatWebhookProxyState,
        startGooglechatWebhookProxy: async () => 24680,
        stopGooglechatWebhookProxy: () => undefined,
      }),
      sandboxName: "alpha",
    });

    expect(options.readTunnelState?.()).toEqual({ running: true });
    const teardownPidDir = stopGooglechatWebhookTunnel("alpha", {
      services: {
        resolveServicePidDir,
        stopCloudflared: () => true,
      },
      webhookProxy: { stopGooglechatWebhookProxy: () => undefined },
    });

    expect(readCloudflaredState).toHaveBeenCalledWith(teardownPidDir);
    expect(readGooglechatWebhookProxyState).toHaveBeenCalledWith(teardownPidDir);
  });

  it("preserves the route proxy when cloudflared cleanup is unverified", () => {
    const stopGooglechatWebhookProxy = vi.fn();

    expect(() =>
      stopGooglechatWebhookTunnel("alpha", {
        services: {
          resolveServicePidDir: () => "/tmp/nemoclaw-services-alpha",
          stopCloudflared: () => false,
        },
        webhookProxy: { stopGooglechatWebhookProxy },
      }),
    ).toThrow(
      "Google Chat tunnel cleanup is incomplete because cloudflared could not be confirmed stopped",
    );
    expect(stopGooglechatWebhookProxy).not.toHaveBeenCalled();
  });
});
