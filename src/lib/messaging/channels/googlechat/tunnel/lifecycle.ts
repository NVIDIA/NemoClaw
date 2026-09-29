// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { googlechatWebhookTunnelPidDir } from "./pid-dir";

type TunnelServices = Pick<
  typeof import("../../../../tunnel/services"),
  "resolveServicePidDir" | "stopCloudflared"
>;
type WebhookProxy = Pick<typeof import("./proxy"), "stopGooglechatWebhookProxy">;

export { googlechatWebhookTunnelPidDir } from "./pid-dir";

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
  const stopOutcome = services.stopCloudflared({ pidDir });
  if (stopOutcome.kind === "unverified-pid-process") {
    throw new Error(
      `Cannot stop cloudflared PID ${String(stopOutcome.pid)} while its process identity is unavailable. Restore process inspection access, then retry.`,
    );
  }
  webhookProxy.stopGooglechatWebhookProxy(pidDir);
  return pidDir;
}
