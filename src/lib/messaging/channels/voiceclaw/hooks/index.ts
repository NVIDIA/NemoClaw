// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import {
  createVoiceClawStatusHealthHookRegistration,
  type VoiceClawStatusHealthHookOptions,
} from "./status-health";

export * from "./status-health";

export interface VoiceClawHookOptions {
  readonly statusHealth?: VoiceClawStatusHealthHookOptions;
}

export function createVoiceClawHookRegistrations(
  options: VoiceClawHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [createVoiceClawStatusHealthHookRegistration(options.statusHealth)];
}
