// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import type { OpenClawBridgeHealthHookOptions } from "../../openclaw-bridge-health";
import { createDiscordOpenClawBridgeHealthHookRegistration } from "./openclaw-bridge-health";

export * from "./openclaw-bridge-health";

export interface DiscordHookOptions {
  readonly openclawBridgeHealth?: OpenClawBridgeHealthHookOptions;
}

export function createDiscordHookRegistrations(
  options: DiscordHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [createDiscordOpenClawBridgeHealthHookRegistration(options.openclawBridgeHealth)] as const;
}
