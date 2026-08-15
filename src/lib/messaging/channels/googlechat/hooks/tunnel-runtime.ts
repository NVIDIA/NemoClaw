// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT } from "../../../../core/ports";
import { googlechatWebhookTunnelPidDir } from "../tunnel/pid-dir";
import type { GooglechatTunnelAudienceGateHookOptions } from "./tunnel-audience-gate";

type TunnelServices = Pick<
  typeof import("../../../../tunnel/services"),
  "getTunnelUrl" | "readCloudflaredState" | "resolveServicePidDir" | "startAll" | "stopCloudflared"
>;
type WebhookProxy = Pick<
  typeof import("../tunnel/proxy"),
  "readGooglechatWebhookProxyState" | "startGooglechatWebhookProxy" | "stopGooglechatWebhookProxy"
>;

export interface GooglechatTunnelRuntimeDeps {
  readonly dashboardPort?: number;
  readonly hasCloudflared?: () => boolean;
  readonly loadServices?: () => TunnelServices;
  readonly loadWebhookProxy?: () => WebhookProxy;
  readonly prompt?: (question: string) => Promise<string>;
  readonly sandboxName?: string;
}

// Compose the tunnel/audience gate from caller-injected host boundaries. Google
// Chat uses a dedicated cloudflared state directory and a loopback-only proxy
// that forwards POST /googlechat while denying dashboard and control paths. It
// must not reuse `nemoclaw tunnel start`, whose purpose is to publish the full
// dashboard. Keeping internal host modules out of this eagerly imported hook
// graph also prevents the built-in registry from closing an import cycle.
export function createDefaultGooglechatTunnelGateOptions(
  deps: GooglechatTunnelRuntimeDeps = {},
): GooglechatTunnelAudienceGateHookOptions {
  const dashboardPort = deps.dashboardPort ?? DASHBOARD_PORT;
  const loadServices =
    deps.loadServices ??
    (() => {
      throw new Error("Google Chat tunnel runtime requires injected service dependencies.");
    });
  const loadWebhookProxy =
    deps.loadWebhookProxy ??
    (() => {
      throw new Error("Google Chat tunnel runtime requires an injected webhook proxy.");
    });
  const resolveSandboxName = (): string => {
    const sandboxName = deps.sandboxName?.trim();
    if (!sandboxName) {
      throw new Error("Google Chat tunnel runtime requires a sandbox name.");
    }
    return sandboxName;
  };
  const resolveGooglechatPidDir = (): string =>
    googlechatWebhookTunnelPidDir(
      loadServices().resolveServicePidDir({ sandboxName: resolveSandboxName() }),
    );
  return {
    hasCloudflared:
      deps.hasCloudflared ??
      (() => {
        try {
          const { execSync } = require("node:child_process") as typeof import("node:child_process");
          execSync("command -v cloudflared", { stdio: ["ignore", "ignore", "ignore"] });
          return true;
        } catch {
          // Not found or unprobeable — `command -v` exits non-zero (execSync
          // throws) when cloudflared is absent; either way, treat as absent and
          // let the gate prompt the user to install it.
          return false;
        }
      }),
    readTunnelState: () => {
      const { readCloudflaredState } = loadServices();
      const { readGooglechatWebhookProxyState } = loadWebhookProxy();
      const pidDir = resolveGooglechatPidDir();
      return {
        running:
          readCloudflaredState(pidDir).kind === "running" &&
          readGooglechatWebhookProxyState(pidDir).running,
      };
    },
    startTunnel: async () => {
      const { startAll, stopCloudflared } = loadServices();
      const { startGooglechatWebhookProxy, stopGooglechatWebhookProxy } = loadWebhookProxy();
      const pidDir = resolveGooglechatPidDir();
      stopCloudflared({ pidDir });
      const proxyPort = await startGooglechatWebhookProxy(pidDir, dashboardPort);
      try {
        await startAll({
          pidDir,
          dashboardPort: proxyPort,
          cloudflareTunnelToken: "",
          sandboxName: resolveSandboxName(),
        });
      } catch (error) {
        stopGooglechatWebhookProxy(pidDir);
        throw error;
      }
    },
    stopTunnel: () => {
      const { stopCloudflared } = loadServices();
      const { stopGooglechatWebhookProxy } = loadWebhookProxy();
      const pidDir = resolveGooglechatPidDir();
      stopCloudflared({ pidDir });
      stopGooglechatWebhookProxy(pidDir);
    },
    getTunnelUrl: () => {
      const { getTunnelUrl: getServiceTunnelUrl } = loadServices();
      const { readGooglechatWebhookProxyState } = loadWebhookProxy();
      const pidDir = resolveGooglechatPidDir();
      const proxy = readGooglechatWebhookProxyState(pidDir);
      return proxy.running ? getServiceTunnelUrl(pidDir, proxy.port) : "";
    },
    prompt:
      deps.prompt ??
      (() => Promise.reject(new Error("Google Chat tunnel runtime requires an injected prompt."))),
  };
}
