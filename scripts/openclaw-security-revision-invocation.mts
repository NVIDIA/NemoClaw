#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

export type OpenClawPluginInstallInvocation = Readonly<{
  stateDirectory: string;
  target: string;
  targetIndex: number;
}>;

type InvocationEnvironment = Readonly<{
  HOME?: string;
  OPENCLAW_PROFILE?: string;
  OPENCLAW_STATE_DIR?: string;
}>;

const PROFILE_NAME = /^[A-Za-z0-9_-]+$/u;

function requiredHome(environment: InvocationEnvironment): string {
  const home = environment.HOME?.trim();
  if (!home) throw new Error("HOME is required for OpenClaw plugin installation");
  return path.resolve(home);
}

function resolveStateDirectory(
  environment: InvocationEnvironment,
  cliProfile: string | null,
  workingDirectory: string,
): string {
  const override = environment.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    const expanded = override.startsWith("~")
      ? override.replace(/^~(?=$|[\\/])/u, requiredHome(environment))
      : override;
    return path.resolve(workingDirectory, expanded);
  }

  const home = requiredHome(environment);
  const environmentProfile = environment.OPENCLAW_PROFILE?.trim() || null;
  const profile = cliProfile ?? environmentProfile;
  if (!profile || profile.toLowerCase() === "default") return path.join(home, ".openclaw");
  if (!PROFILE_NAME.test(profile)) throw new Error("OPENCLAW_PROFILE is invalid");
  return path.join(home, `.openclaw-${profile}`);
}

/**
 * Mirror OpenClaw 2026.5.18 through 2026.6.10 root profile handling closely
 * enough to bind post-install remediation to the same state directory. The
 * upstream parser accepts --profile/--dev before or after the command and lets
 * an existing OPENCLAW_STATE_DIR override the profile-derived path.
 */
export function parseOpenClawPluginInstallInvocation(options: {
  args: readonly string[];
  environment?: InvocationEnvironment;
  workingDirectory?: string;
}): OpenClawPluginInstallInvocation | null {
  const environment = options.environment ?? process.env;
  const workingDirectory = path.resolve(options.workingDirectory ?? process.cwd());
  const positional: Array<{ index: number; value: string }> = [];
  let profile: string | null = null;
  let sawDev = false;
  let sawProfile = false;
  let afterDoubleDash = false;

  for (let index = 0; index < options.args.length; index += 1) {
    const value = options.args[index];
    if (afterDoubleDash) {
      positional.push({ index, value });
      continue;
    }
    if (value === "--") {
      if (positional.length === 0) return null;
      afterDoubleDash = true;
      positional.push({ index, value });
      continue;
    }
    if (value === "--dev") {
      if (sawProfile) return null;
      profile = "dev";
      sawDev = true;
      continue;
    }
    if (value === "--profile" || value.startsWith("--profile=")) {
      if (sawDev) return null;
      const inline = value.startsWith("--profile=") ? value.slice("--profile=".length) : null;
      const candidate = inline ?? options.args[index + 1];
      if (!candidate || candidate.startsWith("-") || !PROFILE_NAME.test(candidate)) return null;
      profile = candidate;
      sawProfile = true;
      if (inline === null) index += 1;
      continue;
    }
    positional.push({ index, value });
  }

  if (positional[0]?.value !== "plugins" || positional[1]?.value !== "install") return null;
  const target = positional[2];
  if (!target || target.value === "--" || target.value.startsWith("-")) return null;
  return {
    stateDirectory: resolveStateDirectory(environment, profile, workingDirectory),
    target: target.value,
    targetIndex: target.index,
  };
}

export function isHistoricalNemoClawInstallTarget(
  target: string,
  workingDirectory = process.cwd(),
): boolean {
  return path.resolve(workingDirectory, target) === "/opt/nemoclaw";
}

function isMainModule(): boolean {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    : false;
}

if (isMainModule()) {
  try {
    const separator = process.argv.indexOf("--");
    if (!process.argv.includes("--describe-plugin-install") || separator < 0) {
      throw new Error("expected --describe-plugin-install -- <openclaw arguments>");
    }
    const invocation = parseOpenClawPluginInstallInvocation({
      args: process.argv.slice(separator + 1),
    });
    if (invocation) {
      process.stdout.write(
        `${invocation.targetIndex}\0${invocation.stateDirectory}\0${invocation.target}\0`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
