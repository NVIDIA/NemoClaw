// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import {
  createSlackValidateCredentialsHookRegistration,
  type SlackValidateCredentialsHookOptions,
} from "./validate-credentials";

export * from "./credential-validation";
export * from "./validate-credentials";

export interface SlackHookOptions {
  readonly validateCredentials?: SlackValidateCredentialsHookOptions;
}

export function createSlackHookRegistrations(
  options: SlackHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    createSlackValidateCredentialsHookRegistration(
      withoutUndefinedValues(options.validateCredentials),
    ),
  ] as const;
}

function withoutUndefinedValues(
  options: SlackValidateCredentialsHookOptions | undefined,
): SlackValidateCredentialsHookOptions {
  return Object.fromEntries(
    Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
  ) as SlackValidateCredentialsHookOptions;
}
