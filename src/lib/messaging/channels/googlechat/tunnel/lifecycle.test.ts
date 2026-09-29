// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { resolveServicePidDir } from "../../../../tunnel/services";
import { createDefaultGooglechatTunnelGateOptions } from "../hooks/tunnel-runtime";
import { googlechatWebhookTunnelPidDir, stopGooglechatWebhookTunnel } from "./lifecycle";

describe("Google Chat webhook tunnel lifecycle", () => {
  it("stops the sandbox-scoped cloudflared process and route proxy", () => {
    const stopCloudflared = vi.fn();
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
        stopCloudflared: () => undefined,
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
        stopCloudflared: () => undefined,
      },
      webhookProxy: { stopGooglechatWebhookProxy: () => undefined },
    });

    expect(readCloudflaredState).toHaveBeenCalledWith(teardownPidDir);
    expect(readGooglechatWebhookProxyState).toHaveBeenCalledWith(teardownPidDir);
  });
});
