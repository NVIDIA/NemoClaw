// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { googlechatWebhookTunnelPidDir } from "./pid-dir";

type TunnelServices = Pick<
  typeof import("../../../../tunnel/services"),
  "resolveServicePidDir" | "stopCloudflared"
>;
type WebhookProxy = Pick<typeof import("./proxy"), "stopGooglechatWebhookProxy">;

export { googlechatWebhookTunnelPidDir } from "./pid-dir";

export const GOOGLECHAT_TUNNEL_CLEANUP_ERROR =
  "Google Chat tunnel cleanup is incomplete because cloudflared could not be confirmed stopped. Keep the PID record until the process exits, then retry.";

export type GooglechatWebhookLifecycleDeps = {
  readonly services: TunnelServices;
  readonly webhookProxy: WebhookProxy;
};

export function stopGooglechatWebhookTunnel(
  sandboxName: string,
  deps: GooglechatWebhookLifecycleDeps,
): string {
  const { services, webhookProxy } = deps;
  const pidDir = googlechatWebhookTunnelPidDir(services.resolveServicePidDir({ sandboxName }));
  if (!services.stopCloudflared({ pidDir })) {
    throw new Error(GOOGLECHAT_TUNNEL_CLEANUP_ERROR);
  }
  webhookProxy.stopGooglechatWebhookProxy(pidDir);
  return pidDir;
}
