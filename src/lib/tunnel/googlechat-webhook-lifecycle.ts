// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type TunnelServices = Pick<typeof import("./services"), "resolveServicePidDir" | "stopCloudflared">;
type WebhookProxy = Pick<typeof import("./googlechat-webhook-proxy"), "stopGooglechatWebhookProxy">;

export type GooglechatWebhookLifecycleDeps = {
  readonly services?: TunnelServices;
  readonly webhookProxy?: WebhookProxy;
};

export function googlechatWebhookTunnelPidDir(servicePidDir: string): string {
  return `${servicePidDir}-googlechat`;
}

export function stopGooglechatWebhookTunnel(
  sandboxName: string,
  deps: GooglechatWebhookLifecycleDeps = {},
): string {
  const services = deps.services ?? (require("./services") as TunnelServices);
  const webhookProxy = deps.webhookProxy ?? (require("./googlechat-webhook-proxy") as WebhookProxy);
  const pidDir = googlechatWebhookTunnelPidDir(services.resolveServicePidDir({ sandboxName }));
  services.stopCloudflared({ pidDir });
  webhookProxy.stopGooglechatWebhookProxy(pidDir);
  return pidDir;
}
