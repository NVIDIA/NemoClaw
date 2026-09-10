// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { formatEnvAssignment } from "../core/url-utils";

const DEFAULT_OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw";
const AUTO_PAIR_SECONDS_VALUE =
  /^\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]{1,3})?$/u;
const AUTO_PAIR_POLLS_VALUE = /^\+?[0-9]+$/u;
const AUTO_PAIR_MIN_INTERVAL_SECONDS = 0.05;
const AUTO_PAIR_MAX_INTERVAL_SECONDS = 300;
const AUTO_PAIR_MAX_DEADLINE_SECONDS = 86_400;
const AUTO_PAIR_MAX_RUN_TIMEOUT_SECONDS = 300;
const AUTO_PAIR_MAX_FAST_REENTRY_POLLS =
  AUTO_PAIR_MAX_DEADLINE_SECONDS / AUTO_PAIR_MIN_INTERVAL_SECONDS;

export const OPENCLAW_AUTO_PAIR_RUNTIME_ENV_RULES = Object.freeze([
  {
    name: "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS",
    kind: "seconds",
    minimum: 1,
    maximum: AUTO_PAIR_MAX_DEADLINE_SECONDS,
  },
  {
    name: "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS",
    kind: "seconds",
    minimum: AUTO_PAIR_MIN_INTERVAL_SECONDS,
    maximum: AUTO_PAIR_MAX_INTERVAL_SECONDS,
  },
  {
    name: "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
    kind: "polls",
    minimum: 1,
    maximum: AUTO_PAIR_MAX_FAST_REENTRY_POLLS,
  },
  {
    name: "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS",
    kind: "seconds",
    minimum: AUTO_PAIR_MIN_INTERVAL_SECONDS,
    maximum: AUTO_PAIR_MAX_RUN_TIMEOUT_SECONDS,
  },
  {
    name: "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS",
    kind: "seconds",
    minimum: AUTO_PAIR_MIN_INTERVAL_SECONDS,
    maximum: AUTO_PAIR_MAX_INTERVAL_SECONDS,
  },
] as const);

export type OpenClawAutoPairRuntimeEnvRule =
  (typeof OPENCLAW_AUTO_PAIR_RUNTIME_ENV_RULES)[number];

/** Describe the accepted range in user-facing validation errors. */
export function openClawAutoPairRuntimeEnvRequirement(
  rule: OpenClawAutoPairRuntimeEnvRule,
): string {
  return rule.kind === "polls"
    ? `a positive integer no greater than ${rule.maximum}`
    : `a positive, finite number of seconds no less than ${rule.minimum} and no greater than ${rule.maximum}`;
}

/** Parse one scheduler value with the grammar and consumer limit shared by host paths. */
export function parseOpenClawAutoPairRuntimeEnvValue(
  rule: OpenClawAutoPairRuntimeEnvRule,
  raw: string,
): { readonly input: string; readonly value: number } | null {
  if (raw.includes("\0") || /[\r\n]/u.test(raw)) return null;
  const input = raw.trim();
  const value = Number(input);
  const valid =
    rule.kind === "polls"
      ? AUTO_PAIR_POLLS_VALUE.test(input) && Number.isSafeInteger(value)
      : AUTO_PAIR_SECONDS_VALUE.test(input) && Number.isFinite(value);
  return valid && value >= rule.minimum && value <= rule.maximum ? { input, value } : null;
}

type AgentLike = {
  readonly name?: string;
  readonly configPaths?: { readonly dir?: string };
} | null;

function isOpenClawAgent(agent: AgentLike): boolean {
  return !agent || agent.name === "openclaw";
}

export function appendOpenClawRuntimeEnvArgs(envArgs: string[], agent: AgentLike): void {
  if (!isOpenClawAgent(agent)) return;
  const configDir = agent?.configPaths?.dir || DEFAULT_OPENCLAW_CONFIG_DIR;
  const homeDir = path.posix.dirname(configDir);
  envArgs.push(formatEnvAssignment("OPENCLAW_HOME", homeDir));
  envArgs.push(formatEnvAssignment("OPENCLAW_STATE_DIR", configDir));
  envArgs.push(formatEnvAssignment("OPENCLAW_WORKSPACE_DIR", `${configDir}/workspace`));
}
