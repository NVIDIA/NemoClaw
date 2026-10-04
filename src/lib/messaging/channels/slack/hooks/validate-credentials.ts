// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatSlackValidationFailure, validateSlackCredentials } from "./credential-validation";
import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";

export const SLACK_VALIDATE_CREDENTIALS_HOOK_HANDLER_ID = "slack.validateCredentials";

export interface SlackValidateCredentialsHookOptions {
  readonly validateCredentials?: typeof validateSlackCredentials;
  readonly formatValidationFailure?: typeof formatSlackValidationFailure;
  readonly log?: (message: string) => void;
}

export function createSlackValidateCredentialsHook(
  options: SlackValidateCredentialsHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    const botToken = normalizeHookToken(context.inputs?.botToken);
    const appToken = normalizeHookToken(context.inputs?.appToken);
    if (!botToken || !appToken) {
      throw new Error("Slack credential validation requires botToken and appToken.");
    }

    const validate = options.validateCredentials ?? validateSlackCredentials;
    const validation = validate({ botToken, appToken });
    if (validation.ok) {
      if (validation.skipped && validation.message) {
        (options.log ?? console.log)(`  ⚠ ${validation.message}`);
      }
      return {};
    }

    const log = options.log ?? console.log;
    const formatFailure = options.formatValidationFailure ?? formatSlackValidationFailure;
    const prefix = validation.kind === "rejected" ? "✗" : "⚠";
    log(`  ${prefix} ${formatFailure(validation)}`);
    log(
      `  Skipped slack (${
        validation.kind === "rejected"
          ? "invalid Slack credentials"
          : "Slack API validation unavailable"
      })`,
    );
    throw new Error(`Slack credential validation failed: ${formatFailure(validation)}`);
  };
}

export function createSlackValidateCredentialsHookRegistration(
  options: SlackValidateCredentialsHookOptions = {},
): MessagingHookRegistration {
  return {
    id: SLACK_VALIDATE_CREDENTIALS_HOOK_HANDLER_ID,
    handler: createSlackValidateCredentialsHook(options),
  };
}

function normalizeHookToken(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r/g, "").trim() : "";
}
