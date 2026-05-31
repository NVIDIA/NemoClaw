// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runCurlProbe, type CurlProbeResult } from "../adapters/http/probe";
import type { ChannelDef } from "../sandbox/channels";
import { getValidatedMessagingTokenByEnvKey } from "./messaging-token";

export type SlackTokenKind = "bot" | "app";
export type SlackValidationFailureKind = "rejected" | "indeterminate";

export type SlackTokenValidationResult =
  | { ok: true }
  | {
      ok: false;
      kind: SlackValidationFailureKind;
      tokenKind: SlackTokenKind;
      error?: string;
      httpStatus: number;
      curlStatus: number;
      message: string;
    };

export type SlackCredentialValidationResult =
  | { ok: true }
  | (Exclude<SlackTokenValidationResult, { ok: true }> & { credential: SlackTokenKind });

const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
const SLACK_APPS_CONNECTIONS_OPEN_URL = "https://slack.com/api/apps.connections.open";

const TRANSIENT_SLACK_ERRORS = new Set([
  "fatal_error",
  "internal_error",
  "rate_limited",
  "request_timeout",
  "service_unavailable",
  "timeout",
]);

function slackApiArgs(token: string, url: string): string[] {
  return [
    "-sS",
    "--connect-timeout",
    "5",
    "--max-time",
    "10",
    "-X",
    "POST",
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    "Content-Type: application/x-www-form-urlencoded",
    "--data",
    "",
    url,
  ];
}

function redactToken(text: string, token: string): string {
  return token ? text.split(token).join("<REDACTED>") : text;
}

function slackLabel(tokenKind: SlackTokenKind): string {
  return tokenKind === "bot" ? "Slack bot token" : "Slack app token";
}

function parseSlackApiResponse(body: string): { ok?: unknown; error?: unknown } | null {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function validationFailure(
  tokenKind: SlackTokenKind,
  kind: SlackValidationFailureKind,
  result: CurlProbeResult,
  message: string,
  token: string,
  error?: string,
): Exclude<SlackTokenValidationResult, { ok: true }> {
  return {
    ok: false,
    kind,
    tokenKind,
    error,
    httpStatus: result.httpStatus,
    curlStatus: result.curlStatus,
    message: redactToken(message, token),
  };
}

function classifySlackProbeResult(
  tokenKind: SlackTokenKind,
  token: string,
  result: CurlProbeResult,
): SlackTokenValidationResult {
  const label = slackLabel(tokenKind);
  if (result.curlStatus !== 0 || result.httpStatus === 0) {
    return validationFailure(
      tokenKind,
      "indeterminate",
      result,
      `${label} could not be validated because Slack API was unreachable: ${result.message}`,
      token,
    );
  }

  const parsed = parseSlackApiResponse(result.body);
  if (!parsed) {
    return validationFailure(
      tokenKind,
      "indeterminate",
      result,
      `${label} could not be validated because Slack API returned an unreadable response.`,
      token,
    );
  }

  if (parsed.ok === true) return { ok: true };

  const error = typeof parsed.error === "string" ? parsed.error : "unknown_error";
  if (result.httpStatus === 429 || result.httpStatus >= 500 || TRANSIENT_SLACK_ERRORS.has(error)) {
    return validationFailure(
      tokenKind,
      "indeterminate",
      result,
      `${label} could not be validated because Slack API returned ${error}.`,
      token,
      error,
    );
  }

  return validationFailure(
    tokenKind,
    "rejected",
    result,
    `${label} was rejected by Slack API: ${error}.`,
    token,
    error,
  );
}

export function validateSlackBotToken(token: string): SlackTokenValidationResult {
  return classifySlackProbeResult(
    "bot",
    token,
    runCurlProbe(slackApiArgs(token, SLACK_AUTH_TEST_URL)),
  );
}

export function validateSlackAppToken(token: string): SlackTokenValidationResult {
  return classifySlackProbeResult(
    "app",
    token,
    runCurlProbe(slackApiArgs(token, SLACK_APPS_CONNECTIONS_OPEN_URL)),
  );
}

export function validateSlackCredentials(tokens: {
  botToken: string;
  appToken: string;
}): SlackCredentialValidationResult {
  const bot = validateSlackBotToken(tokens.botToken);
  if (!bot.ok) return { ...bot, credential: "bot" };

  const app = validateSlackAppToken(tokens.appToken);
  if (!app.ok) return { ...app, credential: "app" };

  return { ok: true };
}

export function formatSlackValidationFailure(
  result: Exclude<SlackTokenValidationResult, { ok: true }>,
): string {
  return result.message;
}

export function filterSlackSelectionByValidation(
  found: string[],
  channels: readonly ChannelDef[],
  warn: (message: string) => void = console.warn,
): string[] {
  if (!found.includes("slack")) return found;

  const botToken = getValidatedMessagingTokenByEnvKey(channels, "SLACK_BOT_TOKEN");
  const appToken = getValidatedMessagingTokenByEnvKey(channels, "SLACK_APP_TOKEN");
  if (!botToken || !appToken) {
    warn(
      "  Slack integration will be disabled for this onboard run because both SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required.",
    );
    return found.filter((channel) => channel !== "slack");
  }

  const validation = validateSlackCredentials({ botToken, appToken });
  if (validation.ok) return found;

  warn(
    `  Slack integration will be disabled for this onboard run. ${formatSlackValidationFailure(validation)}`,
  );
  return found.filter((channel) => channel !== "slack");
}
