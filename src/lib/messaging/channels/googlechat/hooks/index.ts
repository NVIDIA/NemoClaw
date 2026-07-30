// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import { createGooglechatTokenPasteHookRegistration } from "./service-account-token-paste";
import {
  createGooglechatTunnelAudienceGateHookRegistration,
  type GooglechatTunnelAudienceGateHookOptions,
} from "./tunnel-audience-gate";
import {
  createDefaultGooglechatTunnelGateOptions,
  type GooglechatTunnelRuntimeDeps,
} from "./tunnel-runtime";

export * from "./service-account-token-paste";
export * from "./tunnel-audience-gate";

export interface GooglechatHookOptions {
  readonly tunnelAudienceGate?: GooglechatTunnelAudienceGateHookOptions;
  readonly tunnelRuntime?: GooglechatTunnelRuntimeDeps;
}

export function createGooglechatHookRegistrations(
  options: GooglechatHookOptions = {},
): readonly MessagingHookRegistration[] {
  const gateOptions = {
    ...createDefaultGooglechatTunnelGateOptions(options.tunnelRuntime),
    ...withoutUndefinedValues(options.tunnelAudienceGate),
  };
  return [
    createGooglechatTunnelAudienceGateHookRegistration(gateOptions),
    createGooglechatTokenPasteHookRegistration(),
  ] as const;
}

function withoutUndefinedValues(
  options: GooglechatTunnelAudienceGateHookOptions | undefined,
): GooglechatTunnelAudienceGateHookOptions {
  return Object.fromEntries(
    Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
  ) as GooglechatTunnelAudienceGateHookOptions;
}
