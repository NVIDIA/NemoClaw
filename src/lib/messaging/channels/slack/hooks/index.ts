// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import {
  createSlackOpenClawBridgeHealthHookRegistration,
  type OpenClawBridgeHealthHookOptions,
} from "./openclaw-bridge-health";
import {
  createSlackSocketModeGatewayConflictHookRegistration,
  type SlackSocketModeGatewayConflictHookOptions,
} from "./socket-mode-gateway-conflict";
import {
  createSlackSocketModeGatewayStatusHookRegistration,
  type SlackSocketModeGatewayStatusHookOptions,
} from "./socket-mode-gateway-status";
import {
  createSlackValidateCredentialsHookRegistration,
  type SlackValidateCredentialsHookOptions,
} from "./validate-credentials";

export * from "./credential-validation";
export * from "./openclaw-bridge-health";
export * from "./socket-mode-gateway-conflict";
export * from "./socket-mode-gateway-status";
export * from "./validate-credentials";

export interface SlackHookOptions {
  readonly socketModeGatewayConflict?: SlackSocketModeGatewayConflictHookOptions;
  readonly socketModeGatewayStatus?: SlackSocketModeGatewayStatusHookOptions;
  readonly validateCredentials?: SlackValidateCredentialsHookOptions;
  readonly openclawBridgeHealth?: OpenClawBridgeHealthHookOptions;
}

export function createSlackHookRegistrations(
  options: SlackHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    createSlackSocketModeGatewayConflictHookRegistration(
      withoutUndefinedValues(options.socketModeGatewayConflict),
    ),
    createSlackSocketModeGatewayStatusHookRegistration(
      withoutUndefinedValues(options.socketModeGatewayStatus),
    ),
    createSlackOpenClawBridgeHealthHookRegistration(options.openclawBridgeHealth),
    createSlackValidateCredentialsHookRegistration(
      withoutUndefinedValues(options.validateCredentials),
    ),
  ] as const;
}

function withoutUndefinedValues<T extends object>(options: T | undefined): T {
  return Object.fromEntries(
    Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
  ) as T;
}
