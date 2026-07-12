// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCurlProbe, type CurlProbeResult } from "../../../../adapters/http/probe";

export type SlackTokenKind = "bot" | "app";
export type SlackValidationFailureKind = "rejected" | "indeterminate";

export type SlackTokenValidationResult =
  | { ok: true; skipped?: boolean; message?: string }
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
  | Extract<SlackTokenValidationResult, { ok: true }>
  | (Exclude<SlackTokenValidationResult, { ok: true }> & { credential: SlackTokenKind });

const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
const SLACK_APPS_CONNECTIONS_OPEN_URL = "https://slack.com/api/apps.connections.open";
export const SLACK_AUTH_VALIDATION_SKIP_ENV = "NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION";

const TRANSIENT_SLACK_ERRORS = new Set(["ratelimited", "request_timeout"]);

const SLACK_CURL_CONFIG_PREFIX = "nemoclaw-slack-probe";

function isTruthyEnvFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function shouldSkipSlackAuthValidation(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isTruthyEnvFlag(env[SLACK_AUTH_VALIDATION_SKIP_ENV]);
}

function skippedSlackValidationResult(): Extract<SlackTokenValidationResult, { ok: true }> {
  return {
    ok: true,
    skipped: true,
    message: `Live Slack API validation skipped because ${SLACK_AUTH_VALIDATION_SKIP_ENV} is set.`,
  };
}

function escapeCurlConfigValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function slackCurlConfig(token: string): string {
  const authorization = escapeCurlConfigValue(`Authorization: Bearer ${token}`);
  return [
    `header = "${authorization}"`,
    'header = "Content-Type: application/x-www-form-urlencoded"',
    "",
  ].join("\n");
}

function writeSlackCurlConfig(token: string): { configPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${SLACK_CURL_CONFIG_PREFIX}-`));
  const configPath = path.join(dir, "curl.conf");
  try {
    fs.writeFileSync(configPath, slackCurlConfig(token), { mode: 0o600 });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    configPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function slackApiArgs(configPath: string, url: string): string[] {
  return [
    "-sS",
    "--connect-timeout",
    "5",
    "--max-time",
    "10",
    "-X",
    "POST",
    "--config",
    configPath,
    "--data",
    "",
    url,
  ];
}

function runSlackApiProbe(token: string, url: string): CurlProbeResult {
  const { configPath, cleanup } = writeSlackCurlConfig(token);
  try {
    return runCurlProbe(slackApiArgs(configPath, url), { trustedConfigFiles: [configPath] });
  } finally {
    cleanup();
  }
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
  // Transport failures, unreadable bodies, and documented transient Slack errors
  // are outside NemoClaw's credential source of truth, so callers fail closed
  // without saving or enabling unvalidated Slack credentials.
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
  if (shouldSkipSlackAuthValidation()) return skippedSlackValidationResult();

  return classifySlackProbeResult("bot", token, runSlackApiProbe(token, SLACK_AUTH_TEST_URL));
}

export function validateSlackAppToken(token: string): SlackTokenValidationResult {
  if (shouldSkipSlackAuthValidation()) return skippedSlackValidationResult();

  return classifySlackProbeResult(
    "app",
    token,
    runSlackApiProbe(token, SLACK_APPS_CONNECTIONS_OPEN_URL),
  );
}

export function validateSlackCredentials(tokens: {
  botToken: string;
  appToken: string;
}): SlackCredentialValidationResult {
  if (shouldSkipSlackAuthValidation()) return skippedSlackValidationResult();

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
