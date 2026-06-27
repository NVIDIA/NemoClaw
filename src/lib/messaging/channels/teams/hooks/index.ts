// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import {
  createTeamsHostForwardPortConflictHookRegistration,
  createTeamsHostForwardPortStatusHookRegistration,
  type TeamsHostForwardPortConflictHookOptions,
  type TeamsHostForwardPortStatusHookOptions,
} from "./host-forward-port-conflict";
import { TEAMS_MSTEAMS_MENTION_PATCH_HOOK_HANDLER_ID } from "./msteams-mention-patch";

export * from "./host-forward-port-conflict";
export * from "./msteams-mention-patch";

export interface TeamsHookOptions {
  readonly hostForwardPortConflict?: TeamsHostForwardPortConflictHookOptions;
  readonly hostForwardPortStatus?: TeamsHostForwardPortStatusHookOptions;
}

export function createTeamsHookRegistrations(
  options: TeamsHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    createTeamsHostForwardPortConflictHookRegistration(
      withoutUndefinedValues(options.hostForwardPortConflict),
    ),
    createTeamsHostForwardPortStatusHookRegistration(
      withoutUndefinedValues(options.hostForwardPortStatus),
    ),
    {
      id: TEAMS_MSTEAMS_MENTION_PATCH_HOOK_HANDLER_ID,
      handler: () => ({}),
    },
  ] as const;
}

function withoutUndefinedValues<T extends object>(options: T | undefined): T {
  return Object.fromEntries(
    Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
  ) as T;
}
