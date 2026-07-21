// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import {
  createGooglechatTunnelAudienceGateHookRegistration,
  type GooglechatTunnelAudienceGateHookOptions,
} from "./tunnel-audience-gate";
import { createDefaultGooglechatTunnelGateOptions } from "./tunnel-runtime";

export * from "./tunnel-audience-gate";

export interface GooglechatHookOptions {
  readonly tunnelAudienceGate?: GooglechatTunnelAudienceGateHookOptions;
}

export function createGooglechatHookRegistrations(
  options: GooglechatHookOptions = {},
): readonly MessagingHookRegistration[] {
  const gateOptions = {
    ...createDefaultGooglechatTunnelGateOptions(),
    ...withoutUndefinedValues(options.tunnelAudienceGate),
  };
  return [createGooglechatTunnelAudienceGateHookRegistration(gateOptions)] as const;
}

function withoutUndefinedValues(
  options: GooglechatTunnelAudienceGateHookOptions | undefined,
): GooglechatTunnelAudienceGateHookOptions {
  return Object.fromEntries(
    Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
  ) as GooglechatTunnelAudienceGateHookOptions;
}
