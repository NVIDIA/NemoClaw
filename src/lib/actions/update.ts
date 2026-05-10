// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { versionGte } from "../domain/installer/version";

export const NEMOCLAW_INSTALLER_URL = "https://www.nvidia.com/nemoclaw.sh";
export const NEMOCLAW_REPO_URL = "https://github.com/NVIDIA/NemoClaw.git";
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
  installType: "installer" | "package" | "source";
  latestVersion: string | null;
  ranInstaller: boolean;
  status: number;
  updateAvailable: boolean | null;
}

interface UpdateBranding {
  cliName: string;
  displayName: string;
  maintainedUpdateCommand: string;
}

function trimOutput(value: string | Buffer | null | undefined): string {
  return String(value ?? "").trim();
}

function updateBranding(env: NodeJS.ProcessEnv): UpdateBranding {
  if (env.NEMOCLAW_AGENT === "hermes") {
    return {
      cliName: "nemohermes",
      displayName: "NemoHermes",
      maintainedUpdateCommand: `curl -fsSL ${NEMOCLAW_INSTALLER_URL} | NEMOCLAW_AGENT=hermes bash`,
    };
  }
  return {
    cliName: "nemoclaw",
    displayName: "NemoClaw",
    maintainedUpdateCommand: NEMOCLAW_UPDATE_COMMAND,
  };
}

function realOrResolved(inputPath: string): string {
  try {
    return fs.realpathSync(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function managedInstallRoot(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || os.homedir();
  return path.join(realOrResolved(home), ".nemoclaw", "source");
}

export function detectInstallType(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): RunUpdateResult["installType"] {
  if (!fs.existsSync(path.join(rootDir, ".git"))) return "package";

  const root = realOrResolved(rootDir);
  if (isSameOrChildPath(root, managedInstallRoot(env))) return "installer";

  return "source";
}

export function isSourceCheckout(rootDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return detectInstallType(rootDir, env) === "source";
}

export function getLatestNemoClawVersionFromGitLatestTag(
  deps: {
    env?: NodeJS.ProcessEnv;
    gitCommand?: string;
    repoUrl?: string;
    spawnSyncImpl?: SpawnSyncFn;
  } = {},
): string | null {
  const result = (deps.spawnSyncImpl ?? spawnSync)(
    deps.gitCommand ?? "git",
    [
      "ls-remote",
      "--tags",
      deps.repoUrl ?? NEMOCLAW_REPO_URL,
      "refs/tags/latest",
      "refs/tags/latest^{}",
      "refs/tags/v*",
    ],
    {
      encoding: "utf-8",
      env: deps.env ?? process.env,
      stdio: "pipe",
    },
  );
  if (result.error || (result.status ?? 1) !== 0) return null;

  const versionsBySha = new Map<string, string>();
  let latestSha: string | null = null;
  for (const line of trimOutput(result.stdout).split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/, 2);
    if (!sha || !ref) continue;
    if (ref === "refs/tags/latest^{}" || (ref === "refs/tags/latest" && !latestSha)) {
      latestSha = sha;
      continue;
    }
    const match = /^refs\/tags\/v(.+?)(\^\{\})?$/.exec(ref);
    if (match?.[1]) versionsBySha.set(sha, match[1]);
  }
  return latestSha ? versionsBySha.get(latestSha) ?? null : null;
}

function updateAvailable(currentVersion: string, latestVersion: string | null): boolean | null {
  if (!latestVersion) return null;
  return !versionGte(currentVersion, latestVersion);
}

function printStatus(input: {
  branding: UpdateBranding;
  currentVersion: string;
  installType: RunUpdateResult["installType"];
  latestVersion: string | null;
  log: LogFn;
  updateAvailable: boolean | null;
}): void {
  input.log(`  Current ${input.branding.displayName} version: ${input.currentVersion}`);
  input.log(`  Latest maintained version:${input.latestVersion ? ` ${input.latestVersion}` : " unknown"}`);
  const installTypeLabel =
    input.installType === "source"
      ? "source checkout"
      : input.installType === "installer"
        ? "installer-managed clone"
        : "package";
  input.log(`  Install type:             ${installTypeLabel}`);
  input.log(
    `  Update available:         ${
      input.updateAvailable === null ? "unknown" : input.updateAvailable ? "yes" : "no"
    }`,
  );
  input.log(`  Maintained update path:   ${input.branding.maintainedUpdateCommand}`);
}

function updateInstallerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.BASH_ENV;
  delete next.ENV;
  delete next.NEMOCLAW_INSTALL_REF;
  delete next.NEMOCLAW_INSTALL_TAG;
  return next;
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
  const branding = updateBranding(env);
  const latestVersion = (deps.getLatestVersion ?? (() => getLatestNemoClawVersionFromGitLatestTag({ env })))();
  const installType = deps.isSourceCheckout
    ? deps.isSourceCheckout()
      ? "source"
      : "package"
    : detectInstallType(rootDir, env);
  const available = updateAvailable(currentVersion, latestVersion);

  printStatus({ branding, currentVersion, installType, latestVersion, log, updateAvailable: available });

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
    log(`  ${branding.displayName} is already up to date.`);
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
    if (env.NEMOCLAW_NON_INTERACTIVE === "1") {
      error("  Refusing to prompt in non-interactive mode. Re-run with --yes to update.");
      return {
        currentVersion,
        installType,
        latestVersion,
        ranInstaller: false,
        status: 1,
        updateAvailable: available,
      };
    }
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
    const answer = (await prompt(`  Run the maintained ${branding.displayName} installer now? [y/N]: `))
      .trim()
      .toLowerCase();
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

  log(`  Running maintained ${branding.displayName} installer...`);
  const result = (deps.spawnSyncImpl ?? spawnSync)("bash", ["-o", "pipefail", "-lc", NEMOCLAW_UPDATE_COMMAND], {
    env: updateInstallerEnv(env),
    stdio: "inherit",
  });
  const status = result.status ?? 1;
  if (status === 0) {
    log(`  Installer completed. Run \`${branding.cliName} upgrade-sandboxes --check\` to verify sandbox state.`);
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
