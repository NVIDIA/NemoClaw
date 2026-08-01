// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GooglechatTunnelRuntimeDeps } from "./tunnel-runtime";

/**
 * Compose the host-only Google Chat tunnel dependencies at the CLI boundary.
 * Keep each module lazy so command metadata and help do not load onboarding,
 * tunnel process control, or credential prompting before `onboard` runs.
 */
export function createGooglechatTunnelRuntimeDeps(): Omit<
  GooglechatTunnelRuntimeDeps,
  "prompt" | "sandboxName"
> {
  return {
    loadServices: () =>
      require("../../../../tunnel/services") as typeof import("../../../../tunnel/services"),
    loadWebhookProxy: () => require("../tunnel/proxy") as typeof import("../tunnel/proxy"),
  };
}
