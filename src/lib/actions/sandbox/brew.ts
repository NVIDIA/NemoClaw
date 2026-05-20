// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLI_NAME } from "../../cli/branding";
import { privilegedSandboxExec } from "../../adapters/sandbox/privileged-exec";
import * as policy from "../../policy";
import { ROOT, run, runCapture } from "../../runner";
import { isShieldsDown } from "../../shields";
import * as registry from "../../state/registry";
import type { SandboxEntry } from "../../state/registry";

const LINUXBREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const BREW_BIN = `${LINUXBREW_PREFIX}/bin/brew`;
const PROFILE_D_PATH = "/etc/profile.d/nemoclaw-linuxbrew.sh";
const FORMULA_PATTERN = /^[a-z0-9][a-z0-9._@/+-]*$/;
const HOMEBREW_INSTALL_URL =
  "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh";
const BREW_INTEGRATION_POLICY = path.join(
  ROOT,
  "nemoclaw-blueprint",
  "policies",
  "integrations",
  "brew.yaml",
);

export type BrewRequest =
  | { kind: "help" }
  | { kind: "init" }
  | { kind: "deinit" }
  | { kind: "install"; packages: readonly string[]; yes?: boolean }
  | { kind: "uninstall"; packages: readonly string[] };

export class BrewCommandError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[] = [], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n") || `Brew command failed with exit ${exitCode}`);
    this.name = "BrewCommandError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

function brewExit(exitCode = 1): never {
  throw new BrewCommandError([], exitCode);
}

function assertSandboxRegistered(name: string): SandboxEntry {
  const entry = registry.getSandbox(name);
  if (!entry) {
    console.error(`  Sandbox '${name}' is not registered.`);
    brewExit(1);
  }
  return entry;
}

function assertShieldsDown(name: string): void {
  if (!isShieldsDown(name)) {
    console.error(`  Sandbox '${name}' has shields up. Run '${CLI_NAME} ${name} shields down' first.`);
    brewExit(1);
  }
}

function assertBrewInitialised(
  entry: SandboxEntry,
  sandboxName: string,
  extraHint?: string,
): void {
  if (entry.brewInitialised !== true) {
    console.error(
      `  Homebrew is not installed in '${sandboxName}'. Run '${CLI_NAME} ${sandboxName} brew init' first.`,
    );
    if (extraHint) console.error(`  ${extraHint}`);
    brewExit(1);
  }
}

function isNonInteractive(): boolean {
  return process.env.NEMOCLAW_NON_INTERACTIVE === "1";
}

function readBrewIntegrationEntries(): string | null {
  if (!fs.existsSync(BREW_INTEGRATION_POLICY)) return null;
  const content = fs.readFileSync(BREW_INTEGRATION_POLICY, "utf-8");
  return policy.extractPresetEntries(content);
}

function withTempPolicyFile<T>(content: string, fn: (filePath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-brew-policy-"));
  const filePath = path.join(dir, "policy.yaml");
  fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
  try {
    return fn(filePath);
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* best effort */
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      /* best effort */
    }
  }
}

function applyBrewRuntimePolicy(sandboxName: string): void {
  const entries = readBrewIntegrationEntries();
  if (!entries) return;
  const rawPolicy = runCapture(policy.buildPolicyGetCommand(sandboxName), { ignoreError: true });
  const current = policy.parseCurrentPolicy(rawPolicy);
  const merged = policy.mergePresetIntoPolicy(current, entries);
  withTempPolicyFile(merged, (filePath) => {
    run(policy.buildPolicySetCommand(filePath, sandboxName));
  });
}

function removeBrewRuntimePolicy(sandboxName: string): void {
  const entries = readBrewIntegrationEntries();
  if (!entries) return;
  const rawPolicy = runCapture(policy.buildPolicyGetCommand(sandboxName), { ignoreError: true });
  const current = policy.parseCurrentPolicy(rawPolicy);
  if (!current) return;
  const updated = policy.removePresetFromPolicy(current, entries);
  if (updated === current) return;
  withTempPolicyFile(updated, (filePath) => {
    run(policy.buildPolicySetCommand(filePath, sandboxName));
  });
}

function assertFormulae(packages: readonly string[]): void {
  if (packages.length === 0) {
    console.error("  No packages specified.");
    brewExit(1);
  }
  const invalid = packages.filter((p) => !FORMULA_PATTERN.test(p));
  if (invalid.length > 0) {
    console.error(`  Invalid formula name(s): ${invalid.join(", ")}`);
    brewExit(1);
  }
}

function printHelp(sandboxName: string): void {
  console.log(`  Usage:`);
  console.log(`    ${CLI_NAME} ${sandboxName} brew init                       Bootstrap Homebrew (Linuxbrew) in the sandbox`);
  console.log(`    ${CLI_NAME} ${sandboxName} brew install <pkg>... [--yes]   Install one or more formulae (--yes + NEMOCLAW_NON_INTERACTIVE=1 auto-runs init)`);
  console.log(`    ${CLI_NAME} ${sandboxName} brew uninstall <pkg>...         Uninstall one or more formulae`);
  console.log(`    ${CLI_NAME} ${sandboxName} brew deinit                     Remove Homebrew from the sandbox`);
}

function brewInitScript(): string {
  return [
    "set -euo pipefail",
    `if ! id linuxbrew >/dev/null 2>&1; then`,
    "  useradd -m -s /bin/bash linuxbrew",
    "fi",
    `mkdir -p ${LINUXBREW_PREFIX}`,
    `chown -R linuxbrew:linuxbrew /home/linuxbrew`,
    `runuser -u linuxbrew -- env NONINTERACTIVE=1 /bin/bash -c '/bin/bash -c "$(curl -fsSL ${HOMEBREW_INSTALL_URL})"'`,
    `test -x ${BREW_BIN}`,
    `cat >${PROFILE_D_PATH} <<'EOF'`,
    `# NemoClaw: expose Homebrew (Linuxbrew) to interactive shells (#3757)`,
    `if [ -d ${LINUXBREW_PREFIX}/bin ]; then`,
    `  case ":\${PATH}:" in`,
    `    *":${LINUXBREW_PREFIX}/bin:"*) ;;`,
    `    *) PATH="${LINUXBREW_PREFIX}/bin:\${PATH}"; export PATH ;;`,
    `  esac`,
    `fi`,
    `EOF`,
    `chmod 444 ${PROFILE_D_PATH}`,
  ].join("\n");
}

function brewDeinitScript(): string {
  return [
    "set -eu",
    `rm -f ${PROFILE_D_PATH}`,
    `rm -rf ${LINUXBREW_PREFIX} /home/linuxbrew`,
    `userdel linuxbrew 2>/dev/null || true`,
  ].join("\n");
}

function runInit(sandboxName: string): void {
  const entry = assertSandboxRegistered(sandboxName);
  assertShieldsDown(sandboxName);
  if (entry.brewInitialised === true) {
    console.log(`  Homebrew is already installed in '${sandboxName}'.`);
    return;
  }
  console.log(`  Bootstrapping Homebrew in '${sandboxName}' (this can take several minutes)...`);
  privilegedSandboxExec(sandboxName, ["bash", "-s"], {
    input: brewInitScript(),
    timeout: 900_000,
  });
  console.log(`  Authorising Homebrew binaries on the sandbox gateway policy...`);
  applyBrewRuntimePolicy(sandboxName);
  if (!registry.updateSandbox(sandboxName, { brewInitialised: true })) {
    console.error(`  Failed to persist Homebrew state for '${sandboxName}'.`);
    brewExit(1);
  }
  console.log(`  Homebrew installed at ${LINUXBREW_PREFIX}.`);
  console.log(`  Install formulae with: ${CLI_NAME} ${sandboxName} brew install <formula>...`);
}

function runInstall(
  sandboxName: string,
  packages: readonly string[],
  yes: boolean,
): void {
  const entry = assertSandboxRegistered(sandboxName);
  assertShieldsDown(sandboxName);
  assertFormulae(packages);
  if (entry.brewInitialised !== true) {
    if (yes && isNonInteractive()) {
      console.log(
        `  Homebrew is not installed in '${sandboxName}'. --yes + NEMOCLAW_NON_INTERACTIVE=1 set; auto-initialising.`,
      );
      runInit(sandboxName);
    } else {
      assertBrewInitialised(
        entry,
        sandboxName,
        "Or pass --yes with NEMOCLAW_NON_INTERACTIVE=1 to auto-initialise before install.",
      );
    }
  }
  console.log(`  Installing ${packages.length} formula(e) into '${sandboxName}': ${packages.join(", ")}`);
  privilegedSandboxExec(sandboxName, [BREW_BIN, "install", ...packages], {
    user: "linuxbrew",
    timeout: 900_000,
  });
  console.log(`  Done.`);
}

function runUninstall(sandboxName: string, packages: readonly string[]): void {
  const entry = assertSandboxRegistered(sandboxName);
  assertShieldsDown(sandboxName);
  assertBrewInitialised(entry, sandboxName);
  assertFormulae(packages);
  console.log(`  Uninstalling ${packages.length} formula(e) from '${sandboxName}': ${packages.join(", ")}`);
  privilegedSandboxExec(sandboxName, [BREW_BIN, "uninstall", ...packages], {
    user: "linuxbrew",
    timeout: 300_000,
  });
  console.log(`  Done.`);
}

function runDeinit(sandboxName: string): void {
  const entry = assertSandboxRegistered(sandboxName);
  assertShieldsDown(sandboxName);
  if (entry.brewInitialised !== true) {
    console.log(`  Homebrew is not installed in '${sandboxName}'; nothing to deinit.`);
    return;
  }
  console.log(`  Removing Homebrew from '${sandboxName}'...`);
  privilegedSandboxExec(sandboxName, ["bash", "-s"], {
    input: brewDeinitScript(),
    timeout: 180_000,
  });
  console.log(`  Removing Homebrew gateway-policy entry...`);
  removeBrewRuntimePolicy(sandboxName);
  if (!registry.updateSandbox(sandboxName, { brewInitialised: false })) {
    console.error(`  Failed to persist Homebrew state for '${sandboxName}'.`);
    brewExit(1);
  }
  console.log(`  Homebrew removed.`);
}

export async function runSandboxBrew(
  sandboxName: string,
  request: BrewRequest = { kind: "help" },
): Promise<void> {
  switch (request.kind) {
    case "help":
      printHelp(sandboxName);
      return;
    case "init":
      runInit(sandboxName);
      return;
    case "deinit":
      runDeinit(sandboxName);
      return;
    case "install":
      runInstall(sandboxName, request.packages, request.yes === true);
      return;
    case "uninstall":
      runUninstall(sandboxName, request.packages);
      return;
  }
}
