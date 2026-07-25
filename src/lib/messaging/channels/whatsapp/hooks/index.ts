// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import {
  createWhatsappStatusHealthHookRegistration,
  type WhatsappStatusHealthHookOptions,
} from "./status-health";

export * from "./status-health";
export * from "./status-health-eval";

/**
 * Aggregate options for all WhatsApp channel hooks. Kept as an interface so
 * additional hooks (e.g. an enrollment or reachability hook) can be added
 * later without changing every caller.
 */
export interface WhatsappHookOptions {
  readonly statusHealth?: WhatsappStatusHealthHookOptions;
}

export function createWhatsappHookRegistrations(
  options: WhatsappHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [createWhatsappStatusHealthHookRegistration(options.statusHealth)];
}
