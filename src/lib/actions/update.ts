// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { versionGte } from "../domain/installer/version";

export const NEMOCLAW_INSTALLER_URL = "https://www.nvidia.com/nemoclaw.sh";
export const NEMOCLAW_UPDATE_COMMAND = `curl -fsSL ${NEMOCLAW_INSTALLER_URL} | bash`;

type LogFn = (message?: string) => void;
type PromptFn = (question: string) => Promise<string>;
type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; stdio: "inherit" | "pipe"; encoding?: BufferEncoding },
) => SpawnSyncReturns<string | Buffer>;

export interface RunUpdateOptions {
  check?: boolean;
  yes?: boolean;
}

export interface RunUpdateDeps {
  currentVersion: () => string;
  env?: NodeJS.ProcessEnv;
  error?: LogFn;
  getLatestVersion?: () => string | null;
  isSourceCheckout?: () => boolean;
  log?: LogFn;
  prompt?: PromptFn;
  rootDir?: string;
  spawnSyncImpl?: SpawnSyncFn;
}

export interface RunUpdateResult {
  currentVersion: string;
  installType: "package" | "source";
  latestVersion: string | null;
  ranInstaller: boolean;
  status: number;
  updateAvailable: boolean | null;
}

function trimOutput(value: string | Buffer | null | undefined): string {
  return String(value ?? "").trim();
}

export function getLatestNemoClawVersionFromNpm(
  deps: {
    env?: NodeJS.ProcessEnv;
    npmCommand?: string;
    spawnSyncImpl?: SpawnSyncFn;
  } = {},
): string | null {
  const result = (deps.spawnSyncImpl ?? spawnSync)(deps.npmCommand ?? "npm", ["view", "nemoclaw", "version"], {
    encoding: "utf-8",
    env: deps.env ?? process.env,
    stdio: "pipe",
  });
  if (result.error || (result.status ?? 1) !== 0) return null;
  return trimOutput(result.stdout) || null;
}

export function isSourceCheckout(rootDir: string): boolean {
  return fs.existsSync(path.join(rootDir, ".git"));
}

function updateAvailable(currentVersion: string, latestVersion: string | null): boolean | null {
  if (!latestVersion) return null;
  return !versionGte(currentVersion, latestVersion);
}

function printStatus(input: {
  currentVersion: string;
  installType: "package" | "source";
  latestVersion: string | null;
  log: LogFn;
  updateAvailable: boolean | null;
}): void {
  input.log(`  Current NemoClaw version: ${input.currentVersion}`);
  input.log(`  Latest published version: ${input.latestVersion ?? "unknown"}`);
  input.log(`  Install type:             ${input.installType === "source" ? "source checkout" : "package"}`);
  input.log(
    `  Update available:         ${
      input.updateAvailable === null ? "unknown" : input.updateAvailable ? "yes" : "no"
    }`,
  );
  input.log(`  Maintained update path:   ${NEMOCLAW_UPDATE_COMMAND}`);
}

export async function runUpdateAction(
  options: RunUpdateOptions,
  deps: RunUpdateDeps,
): Promise<RunUpdateResult> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const env = deps.env ?? process.env;
  const rootDir = deps.rootDir ?? process.cwd();
  const currentVersion = deps.currentVersion();
  const latestVersion = (deps.getLatestVersion ?? (() => getLatestNemoClawVersionFromNpm({ env })))();
  const installType = (deps.isSourceCheckout ?? (() => isSourceCheckout(rootDir)))() ? "source" : "package";
  const available = updateAvailable(currentVersion, latestVersion);

  printStatus({ currentVersion, installType, latestVersion, log, updateAvailable: available });

  if (options.check) {
    return {
      currentVersion,
      installType,
      latestVersion,
      ranInstaller: false,
      status: 0,
      updateAvailable: available,
    };
  }

  if (installType === "source") {
    error("  This command is running from a source checkout.");
    error("  Update this checkout with git, or run the maintained installer outside the checkout.");
    return {
      currentVersion,
      installType,
      latestVersion,
      ranInstaller: false,
      status: 1,
      updateAvailable: available,
    };
  }

  if (available === false) {
    log("  NemoClaw is already up to date.");
    return {
      currentVersion,
      installType,
      latestVersion,
      ranInstaller: false,
      status: 0,
      updateAvailable: available,
    };
  }

  if (!options.yes) {
    const prompt = deps.prompt;
    if (!prompt) {
      error("  Refusing to run the installer without confirmation. Re-run with --yes for non-interactive update.");
      return {
        currentVersion,
        installType,
        latestVersion,
        ranInstaller: false,
        status: 1,
        updateAvailable: available,
      };
    }
    const answer = (await prompt("  Run the maintained NemoClaw installer now? [y/N]: ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      log("  Update cancelled.");
      return {
        currentVersion,
        installType,
        latestVersion,
        ranInstaller: false,
        status: 0,
        updateAvailable: available,
      };
    }
  }

  log("  Running maintained NemoClaw installer...");
  const result = (deps.spawnSyncImpl ?? spawnSync)("bash", ["-lc", NEMOCLAW_UPDATE_COMMAND], {
    env,
    stdio: "inherit",
  });
  const status = result.status ?? 1;
  if (status === 0) {
    log("  Installer completed. Run `nemoclaw upgrade-sandboxes --check` to verify sandbox state.");
  } else {
    error(`  Installer failed with exit ${status}.`);
  }

  return {
    currentVersion,
    installType,
    latestVersion,
    ranInstaller: true,
    status,
    updateAvailable: available,
  };
}
