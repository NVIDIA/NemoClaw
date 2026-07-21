#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
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
const PLUGIN_INSTALL_BOOLEAN_OPTIONS = new Set([
  "-l",
  "--link",
  "--force",
  "--pin",
  "--dangerously-force-unsafe-install",
]);
const PLUGIN_INSTALL_VALUE_OPTIONS = new Set(["--marketplace"]);

export function validateOpenClawStateDirectory(options: {
  effectiveUid?: number;
  stateDirectory: string;
  trustedRoot: string;
}): string {
  const trustedRoot = path.resolve(options.trustedRoot);
  const stateDirectory = path.resolve(options.stateDirectory);
  if (path.dirname(stateDirectory) !== trustedRoot) {
    throw new Error(`OpenClaw state directory must be a direct child of ${trustedRoot}`);
  }
  const effectiveUid =
    options.effectiveUid ??
    (typeof process.geteuid === "function" ? process.geteuid() : Number.NaN);
  if (!Number.isSafeInteger(effectiveUid) || effectiveUid < 0) {
    throw new Error("effective user ID is unavailable for OpenClaw state validation");
  }
  const rootMetadata = fs.lstatSync(trustedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`OpenClaw state root must be a real directory: ${trustedRoot}`);
  }
  if (rootMetadata.uid !== effectiveUid) {
    throw new Error(`OpenClaw state root must be owned by the current user: ${trustedRoot}`);
  }
  try {
    const stateMetadata = fs.lstatSync(stateDirectory);
    if (!stateMetadata.isDirectory() || stateMetadata.isSymbolicLink()) {
      throw new Error(`OpenClaw state directory must be a real directory: ${stateDirectory}`);
    }
    if (stateMetadata.uid !== effectiveUid) {
      throw new Error(
        `OpenClaw state directory must be owned by the current user: ${stateDirectory}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return stateDirectory;
}

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
    const parsingInstallOptions =
      positional[0]?.value === "plugins" && positional[1]?.value === "install";
    if (parsingInstallOptions && PLUGIN_INSTALL_BOOLEAN_OPTIONS.has(value)) continue;
    if (parsingInstallOptions && PLUGIN_INSTALL_VALUE_OPTIONS.has(value)) {
      const candidate = options.args[index + 1];
      if (!candidate || candidate.startsWith("-")) return null;
      index += 1;
      continue;
    }
    if (
      parsingInstallOptions &&
      [...PLUGIN_INSTALL_VALUE_OPTIONS].some((option) => value.startsWith(`${option}=`))
    ) {
      if (value.endsWith("=")) return null;
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
    const validationIndex = process.argv.indexOf("--validate-state-directory");
    if (validationIndex >= 0) {
      const stateDirectory = process.argv[validationIndex + 1];
      const rootIndex = process.argv.indexOf("--trusted-root");
      const trustedRoot = rootIndex >= 0 ? process.argv[rootIndex + 1] : null;
      if (!stateDirectory || !trustedRoot) {
        throw new Error("expected --validate-state-directory <path> --trusted-root <path>");
      }
      validateOpenClawStateDirectory({ stateDirectory, trustedRoot });
    } else {
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
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
