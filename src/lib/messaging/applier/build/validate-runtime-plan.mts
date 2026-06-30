#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstatSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { normalizeProviderPlaceholderForEnvKey } from "../../provider-placeholders.ts";

const UNREDUCED_RUNTIME_PLAN_KEYS = [
  "agentRender",
  "buildSteps",
  "stateUpdates",
  "healthChecks",
] as const;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface MessagingRuntimePlanFileValidationOptions {
  readonly allowCurrentUserOwner?: boolean;
}

export function validateMessagingRuntimePlanFile(
  path: string,
  options: MessagingRuntimePlanFileValidationOptions = {},
): void {
  const linkStats = lstatSync(path);
  if (linkStats.isSymbolicLink()) {
    throw new Error("unsafe runtime plan file metadata");
  }
  const stats = statSync(path);
  if (
    !stats.isFile() ||
    !hasAllowedOwner(stats.uid, stats.gid, options) ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error("unsafe runtime plan file metadata");
  }
  validateMessagingRuntimePlan(JSON.parse(readFileSync(path, "utf8")));
}

export function validateMessagingRuntimePlan(plan: unknown): void {
  if (!isObject(plan)) throw new Error("runtime plan must be an object");
  for (const key of UNREDUCED_RUNTIME_PLAN_KEYS) {
    if (Object.hasOwn(plan, key)) throw new Error(`runtime plan contains unreduced key ${key}`);
  }

  const runtimeSetup = plan.runtimeSetup;
  if (
    !isObject(runtimeSetup) ||
    !isObjectArray(runtimeSetup.nodePreloads) ||
    !isObjectArray(runtimeSetup.secretScans)
  ) {
    throw new Error("runtime plan missing reduced runtimeSetup shape");
  }

  const credentialBindings = plan.credentialBindings;
  if (!Array.isArray(credentialBindings)) {
    throw new Error("runtime plan missing reduced credentialBindings shape");
  }
  const seenPlaceholders = new Map<string, string>();
  for (const [index, binding] of credentialBindings.entries()) {
    if (!isObject(binding) || !isValidCredentialBindingShape(binding)) {
      throw new Error(`runtime plan credentialBindings[${index}] has invalid reduced shape`);
    }
    if (binding.placeholder === undefined) continue;
    if (
      typeof binding.placeholder !== "string" ||
      !normalizeProviderPlaceholderForEnvKey(binding.placeholder, binding.providerEnvKey)
    ) {
      throw new Error(`runtime plan credentialBindings[${index}] has invalid placeholder`);
    }
    const previous = seenPlaceholders.get(binding.providerEnvKey);
    if (previous !== undefined && previous !== binding.placeholder) {
      throw new Error(
        `runtime plan credentialBindings[${index}] conflicts with an earlier placeholder for ${binding.providerEnvKey}`,
      );
    }
    seenPlaceholders.set(binding.providerEnvKey, binding.placeholder);
  }
}

function hasAllowedOwner(
  uid: number,
  gid: number,
  options: MessagingRuntimePlanFileValidationOptions,
): boolean {
  if (uid === 0 && gid === 0) return true;
  return (
    options.allowCurrentUserOwner === true &&
    typeof process.getuid === "function" &&
    typeof process.getgid === "function" &&
    uid === process.getuid() &&
    gid === process.getgid()
  );
}

function isValidCredentialBindingShape(
  binding: Record<string, unknown>,
): binding is { channelId: string; providerEnvKey: string; placeholder?: unknown } {
  return (
    typeof binding.channelId === "string" &&
    typeof binding.providerEnvKey === "string" &&
    ENV_KEY_RE.test(binding.providerEnvKey)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isObject);
}

function parseArgs(argv: readonly string[]): {
  path: string;
  options: MessagingRuntimePlanFileValidationOptions;
} {
  const args = [...argv];
  const allowCurrentUserOwnerIndex = args.indexOf("--allow-current-user-owner");
  const allowCurrentUserOwner = allowCurrentUserOwnerIndex >= 0;
  if (allowCurrentUserOwner) args.splice(allowCurrentUserOwnerIndex, 1);
  if (args.length !== 1) {
    throw new Error("Usage: validate-runtime-plan.mts [--allow-current-user-owner] <runtime-plan>");
  }
  return { path: args[0] as string, options: { allowCurrentUserOwner } };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    const { path, options } = parseArgs(argv);
    validateMessagingRuntimePlanFile(path, options);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
