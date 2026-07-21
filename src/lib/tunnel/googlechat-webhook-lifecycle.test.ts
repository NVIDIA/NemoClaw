// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  googlechatWebhookTunnelPidDir,
  stopGooglechatWebhookTunnel,
} from "./googlechat-webhook-lifecycle";

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
});
