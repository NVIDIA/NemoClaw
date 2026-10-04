// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAgentNameAlias } from "../agent/aliases";
import { normalizeVersion } from "../domain/installer/version";

export const NEMOCLAW_INSTALLER_URL = "https://www.nvidia.com/nemoclaw.sh";
export const NEMOCLAW_REPO_URL = "https://github.com/NVIDIA/NemoClaw.git";
/**
 * Pipeline `nemoclaw update` runs to install the maintained build.
 * `--proto '=https'` and `--proto-redir '=https'` hold the transfer on HTTPS for
 * the initial request and for every redirect, so a downgrade redirect fails
 * closed instead of piping plaintext-fetched bytes into `bash`. Same fetch
 * hardening as `src/lib/onboard/install-ollama-linux.ts`.
 */
const NEMOCLAW_UPDATE_FETCH_COMMAND = `curl -fsSL --proto '=https' --proto-redir '=https' ${NEMOCLAW_INSTALLER_URL}`;
export const NEMOCLAW_UPDATE_COMMAND = `${NEMOCLAW_UPDATE_FETCH_COMMAND} | bash`;
export const NEMOCLAW_MAINTAINED_INSTALL_TAG = "lkg";

type LogFn = (message?: string) => void;
type PromptFn = (question: string) => Promise<string>;
type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; stdio: "inherit" | "pipe"; encoding?: BufferEncoding },
) => SpawnSyncReturns<string | Buffer>;

export interface RunUpdateOptions {
  /**
   * Accept a `--fresh` reinstall that moves the install to an older version
   * than the one already present, or whose version cannot be ordered against
   * the maintained tag. Deliberately separate from `yes`: `yes` waives the
   * confirmation prompt, never a version regression (#8306).
   */
  allowDowngrade?: boolean;
  check?: boolean;
  /**
   * Reinstall the maintained build even when already up to date. The installer
   * re-clones `~/.nemoclaw/source`, so this repairs a broken-but-current
   * install. Does not reset onboarding state (distinct from the installer's
   * onboard-scoped `--fresh`/`NEMOCLAW_FRESH`). Refuses when the maintained
   * build is older than the installed one unless `allowDowngrade` is set.
   */
  fresh?: boolean;
  yes?: boolean;
}

export interface RunUpdateDeps {
  currentVersion: () => string;
  env?: NodeJS.ProcessEnv;
  error?: LogFn;
  getMaintainedTarget?: () => MaintainedNemoClawTarget | null;
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

export interface MaintainedNemoClawTarget {
  revision: string;
  version: string | null;
}

function trimOutput(value: string | Buffer | null | undefined): string {
  return String(value ?? "").trim();
}

const UPDATE_BRANDING_AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;

function maintainedUpdateCommand(agent?: (typeof UPDATE_BRANDING_AGENTS)[number]): string {
  const agentAssignment = agent ? `NEMOCLAW_AGENT=${agent} ` : "";
  return `${NEMOCLAW_UPDATE_FETCH_COMMAND} | ${agentAssignment}bash`;
}

function updateBranding(env: NodeJS.ProcessEnv): UpdateBranding {
  const agent =
    resolveAgentNameAlias(env.NEMOCLAW_AGENT, UPDATE_BRANDING_AGENTS) ?? env.NEMOCLAW_AGENT;
  if (agent === "hermes") {
    return {
      cliName: "nemohermes",
      displayName: "NemoHermes",
      maintainedUpdateCommand: maintainedUpdateCommand("hermes"),
    };
  }
  if (agent === "langchain-deepagents-code") {
    return {
      cliName: "nemo-deepagents",
      displayName: "NemoDeepAgents",
      maintainedUpdateCommand: maintainedUpdateCommand("langchain-deepagents-code"),
    };
  }
  return {
    cliName: "nemoclaw",
    displayName: "NemoClaw",
    maintainedUpdateCommand: maintainedUpdateCommand(),
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

export function getMaintainedNemoClawTargetFromGitTag(
  deps: {
    env?: NodeJS.ProcessEnv;
    gitCommand?: string;
    repoUrl?: string;
    spawnSyncImpl?: SpawnSyncFn;
  } = {},
): MaintainedNemoClawTarget | null {
  const result = (deps.spawnSyncImpl ?? spawnSync)(
    deps.gitCommand ?? "git",
    [
      "ls-remote",
      "--tags",
      deps.repoUrl ?? NEMOCLAW_REPO_URL,
      `refs/tags/${NEMOCLAW_MAINTAINED_INSTALL_TAG}`,
      `refs/tags/${NEMOCLAW_MAINTAINED_INSTALL_TAG}^{}`,
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
  let maintainedSha: string | null = null;
  for (const line of trimOutput(result.stdout).split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/, 2);
    if (!sha || !ref) continue;
    if (
      ref === `refs/tags/${NEMOCLAW_MAINTAINED_INSTALL_TAG}^{}` ||
      (ref === `refs/tags/${NEMOCLAW_MAINTAINED_INSTALL_TAG}` && !maintainedSha)
    ) {
      maintainedSha = sha;
      continue;
    }
    const match = /^refs\/tags\/v(.+?)(\^\{\})?$/.exec(ref);
    if (match?.[1]) versionsBySha.set(sha, match[1]);
  }
  if (!maintainedSha || !/^[0-9a-f]{40,64}$/i.test(maintainedSha)) return null;
  return {
    revision: maintainedSha,
    version: versionsBySha.get(maintainedSha) ?? null,
  };
}

export function getMaintainedNemoClawVersionFromGitTag(
  deps: {
    env?: NodeJS.ProcessEnv;
    gitCommand?: string;
    repoUrl?: string;
    spawnSyncImpl?: SpawnSyncFn;
  } = {},
): string | null {
  return getMaintainedNemoClawTargetFromGitTag(deps)?.version ?? null;
}

/**
 * How the installed version relates to the maintained tag. `"ahead"` is normal
 * because the maintained tag can lag the newest release. `"unknown"` means the
 * tag did not resolve, and `"incomparable"` means a version has an unsupported format.
 */
type MaintainedVersionRelation = "ahead" | "behind" | "incomparable" | "same" | "unknown";

/**
 * `getVersion()` can return SemVer metadata or git-describe output, which
 * `versionGte` rejects. Parse the complete public version format for this guard.
 */
const PUBLIC_VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
/** A git-describe suffix identifies commits after its base tag. */
const DESCRIBED_VERSION = /^(.*)-\d+-g[0-9a-f]{7,64}$/;

interface ParsedPublicVersion {
  describedAfterTag: boolean;
  normalized: string;
  prerelease: readonly string[];
  release: readonly [number, number, number];
}

function parsePublicVersion(version: string): ParsedPublicVersion | null {
  const normalized = normalizeVersion(version);
  const described = DESCRIBED_VERSION.exec(normalized);
  const match = PUBLIC_VERSION.exec(described?.[1] ?? normalized);
  if (!match) return null;
  const releaseParts = [match[1], match[2], match[3]] as const;
  if (releaseParts.some((part) => part.length > 1 && part.startsWith("0"))) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (
    prerelease.some(
      (identifier) =>
        /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
    )
  ) {
    return null;
  }
  const release = releaseParts.map(Number) as [number, number, number];
  if (release.some((part) => !Number.isSafeInteger(part))) return null;
  return {
    describedAfterTag: described !== null,
    normalized,
    prerelease,
    release,
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const normalizedLeft = left.replace(/^0+(?=\d)/, "");
    const normalizedRight = right.replace(/^0+(?=\d)/, "");
    if (normalizedLeft.length !== normalizedRight.length) {
      return Math.sign(normalizedLeft.length - normalizedRight.length);
    }
    return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSemver(left: ParsedPublicVersion, right: ParsedPublicVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = Math.sign(left.release[index] - right.release[index]);
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = comparePrereleaseIdentifier(left.prerelease[index], right.prerelease[index]);
    if (difference !== 0) return difference;
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

function maintainedVersionRelation(
  currentVersion: string,
  latestVersion: string | null,
): MaintainedVersionRelation {
  if (!latestVersion) return "unknown";
  const current = parsePublicVersion(currentVersion);
  const maintained = parsePublicVersion(latestVersion);
  if (!current || !maintained) return "incomparable";

  const releaseDifference = compareSemver(
    { ...current, prerelease: [] },
    { ...maintained, prerelease: [] },
  );
  if (releaseDifference > 0) return "ahead";
  if (releaseDifference < 0) return "behind";

  // A git-described commit is ordered against the same base tag. Another tag
  // on the same release line does not establish which commit is later.
  if (current.describedAfterTag || maintained.describedAfterTag) {
    if (current.normalized === maintained.normalized) return "same";
    const baseDifference = compareSemver(current, maintained);
    if (baseDifference !== 0) return "incomparable";
    if (current.describedAfterTag && !maintained.describedAfterTag) return "ahead";
    if (!current.describedAfterTag && maintained.describedAfterTag) return "behind";
    return "incomparable";
  }

  const difference = compareSemver(current, maintained);
  return difference > 0 ? "ahead" : difference < 0 ? "behind" : "same";
}

function updateAvailable(relation: MaintainedVersionRelation): boolean | null {
  if (relation === "unknown" || relation === "incomparable") return null;
  return relation === "behind";
}

/** Why a `--fresh` reinstall could not be shown to be regression-free (#8306). */
function describeUnsafeFresh(
  relation: MaintainedVersionRelation,
  branding: UpdateBranding,
  currentVersion: string,
  latestVersion: string | null,
): string {
  const tag = NEMOCLAW_MAINTAINED_INSTALL_TAG;
  if (relation === "ahead") {
    return `${branding.displayName} ${currentVersion} is newer than the maintained ${tag} tag (${latestVersion}).`;
  }
  if (relation === "incomparable") {
    return `Cannot order the installed version (${currentVersion}) against the maintained ${tag} tag (${latestVersion}).`;
  }
  return `Could not resolve the maintained ${tag} tag, so the installed version (${currentVersion}) cannot be checked.`;
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
  input.log(
    `  Latest maintained version:${input.latestVersion ? ` ${input.latestVersion}` : " unknown"}`,
  );
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

function updateInstallerEnv(
  env: NodeJS.ProcessEnv,
  forceCliReinstall: boolean,
  maintainedRevision: string | null,
): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.BASH_ENV;
  delete next.ENV;
  delete next.NEMOCLAW_FRESH;
  delete next.NEMOCLAW_INSTALL_REF;
  delete next.NEMOCLAW_INSTALL_TAG;
  delete next.NEMOCLAW_REINSTALL_CLI;
  if (maintainedRevision) next.NEMOCLAW_INSTALL_REF = maintainedRevision;
  if (forceCliReinstall) next.NEMOCLAW_REINSTALL_CLI = "1";
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
  const maintainedTarget = (
    deps.getMaintainedTarget ?? (() => getMaintainedNemoClawTargetFromGitTag({ env }))
  )();
  const latestVersion = maintainedTarget?.version ?? null;
  const installType = deps.isSourceCheckout
    ? deps.isSourceCheckout()
      ? "source"
      : "package"
    : detectInstallType(rootDir, env);
  const relation = maintainedVersionRelation(currentVersion, latestVersion);
  const available = updateAvailable(relation);

  printStatus({
    branding,
    currentVersion,
    installType,
    latestVersion,
    log,
    updateAvailable: available,
  });

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

  if (available === false && !options.fresh) {
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

  // `--fresh` replaces the install with the maintained tag. Permit only a known
  // upgrade or same-version reinstall unless the user explicitly accepts a downgrade.
  const freshIsProvablySafe = relation === "behind" || relation === "same";
  if (!freshIsProvablySafe && options.fresh && !options.allowDowngrade) {
    error(`  ${describeUnsafeFresh(relation, branding, currentVersion, latestVersion)}`);
    error(
      relation === "ahead"
        ? `  Refusing --fresh: reinstalling would replace it with ${latestVersion} (downgrade).`
        : "  Refusing --fresh: reinstalling could replace it with an older build.",
    );
    error(
      `  Drop --fresh to keep ${currentVersion}, or rerun with --allow-downgrade to reinstall anyway.`,
    );
    return {
      currentVersion,
      installType,
      latestVersion,
      ranInstaller: false,
      status: 1,
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
      error(
        "  Refusing to run the installer without confirmation. Re-run with --yes for non-interactive update.",
      );
      return {
        currentVersion,
        installType,
        latestVersion,
        ranInstaller: false,
        status: 1,
        updateAvailable: available,
      };
    }
    const answer = (
      await prompt(`  Run the maintained ${branding.displayName} installer now? [y/N]: `)
    )
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

  // Only announce the --fresh reinstall once the user has actually confirmed
  // (or passed --yes): before this point the run could still be declined, and
  // claiming a reinstall was happening would be untrue (CodeRabbit review #5963).
  // "already up to date" only holds for an exact-version re-clone; an accepted
  // downgrade must say so instead of reusing that wording (#8306).
  if (!freshIsProvablySafe && options.fresh) {
    log(
      `  ${describeUnsafeFresh(relation, branding, currentVersion, latestVersion)} Reinstalling anyway (--allow-downgrade); this may be a downgrade.`,
    );
  } else if (relation === "same" && options.fresh) {
    log(
      `  ${branding.displayName} is already up to date; reinstalling anyway (--fresh) for a clean re-clone.`,
    );
  }

  log(`  Running maintained ${branding.displayName} installer...`);
  const result = (deps.spawnSyncImpl ?? spawnSync)(
    "bash",
    ["-o", "pipefail", "-lc", NEMOCLAW_UPDATE_COMMAND],
    {
      env: updateInstallerEnv(env, options.fresh === true, maintainedTarget?.revision || null),
      stdio: "inherit",
    },
  );
  const status = result.status ?? 1;
  if (status === 0) {
    log(
      `  Installer completed. Run \`${branding.cliName} upgrade-sandboxes --check\` to verify sandbox state.`,
    );
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
