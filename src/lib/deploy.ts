// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DeployCredentials {
  NVIDIA_API_KEY?: string | null;
  OPENAI_API_KEY?: string | null;
  ANTHROPIC_API_KEY?: string | null;
  GEMINI_API_KEY?: string | null;
  COMPATIBLE_API_KEY?: string | null;
  COMPATIBLE_ANTHROPIC_API_KEY?: string | null;
  GITHUB_TOKEN?: string | null;
  TELEGRAM_BOT_TOKEN?: string | null;
  DISCORD_BOT_TOKEN?: string | null;
  SLACK_BOT_TOKEN?: string | null;
}

export interface BrevInstanceStatus {
  name?: string;
  id?: string;
  status?: string;
  build_status?: string;
  shell_status?: string;
  health_status?: string;
  instance_type?: string;
  instance_kind?: string;
  gpu?: string;
}

export interface DeployExecutionOptions {
  instanceName?: string;
  env: NodeJS.ProcessEnv;
  rootDir: string;
  getCredential: (key: string) => string | null;
  validateName: (value: string, label: string) => string;
  shellQuote: (value: string) => string;
  run: (command: string, opts?: { ignoreError?: boolean }) => void;
  runInteractive: (command: string) => void;
  execFileSync: (file: string, args: string[], opts?: Record<string, unknown>) => string;
  spawnSync: (file: string, args: string[], opts?: Record<string, unknown>) => void;
  log: (message?: string) => void;
  error: (message?: string) => void;
  stdoutWrite: (message: string) => void;
  exit: (code: number) => never;
}

// SSH host key verification helper — resolves the real hostname from SSH config
// (brev aliases aren't DNS-resolvable) and returns it for ssh-keyscan.
export function resolveRealHost(
  name: string,
  execFileSync: DeployExecutionOptions["execFileSync"],
): string {
  const sshConfigOut = execFileSync("ssh", ["-G", name], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return (
    sshConfigOut
      .split("\n")
      .find((l) => l.startsWith("hostname "))
      ?.split(" ")[1] || name
  );
}

// Build SSH options that enforce strict host key checking against a pinned known_hosts file.
export function buildSshOpts(knownHostsFile: string, shellQuote: (v: string) => string): string {
  return `-o UserKnownHostsFile=${shellQuote(knownHostsFile)} -o StrictHostKeyChecking=yes -o LogLevel=ERROR`;
}

// Build SSH argument array for execFileSync calls with pinned host key verification.
export function buildSshArgs(knownHostsFile: string): string[] {
  return [
    "-o",
    `UserKnownHostsFile=${knownHostsFile}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "LogLevel=ERROR",
  ];
}

export function inferDeployProvider(
  explicitProvider: string | undefined,
  credentials: DeployCredentials,
): string | null {
  const explicit = String(explicitProvider || "")
    .trim()
    .toLowerCase();
  if (explicit) return explicit;

  const providerByCredential: Array<[keyof DeployCredentials, string]> = [
    ["NVIDIA_API_KEY", "build"],
    ["OPENAI_API_KEY", "openai"],
    ["ANTHROPIC_API_KEY", "anthropic"],
    ["GEMINI_API_KEY", "gemini"],
    ["COMPATIBLE_API_KEY", "custom"],
    ["COMPATIBLE_ANTHROPIC_API_KEY", "anthropicCompatible"],
  ];
  const matches = providerByCredential.filter(([key]) => credentials[key]);
  if (matches.length === 1) return matches[0][1];
  return null;
}

export function buildDeployEnvLines(opts: {
  env: NodeJS.ProcessEnv;
  sandboxName: string;
  provider: string;
  credentials: DeployCredentials;
  shellQuote: (value: string) => string;
}): string[] {
  const { env, sandboxName, provider, credentials, shellQuote } = opts;
  const envLines = [
    "NEMOCLAW_NON_INTERACTIVE=1",
    "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1",
    `NEMOCLAW_SANDBOX_NAME=${shellQuote(sandboxName)}`,
    `NEMOCLAW_PROVIDER=${shellQuote(provider)}`,
  ];

  const passthroughVars = [
    "NEMOCLAW_MODEL",
    "NEMOCLAW_ENDPOINT_URL",
    "NEMOCLAW_POLICY_MODE",
    "NEMOCLAW_POLICY_PRESETS",
    "CHAT_UI_URL",
  ] as const;
  for (const key of passthroughVars) {
    const value = env[key];
    if (value) envLines.push(`${key}=${shellQuote(value)}`);
  }

  for (const [key, value] of Object.entries(credentials)) {
    if (value) envLines.push(`${key}=${shellQuote(value)}`);
  }

  return envLines;
}

function outputHasExactLine(output: string | undefined, expected: string): boolean {
  return String(output || "")
    .split(/\r?\n/)
    .some((line) => line.trim() === expected);
}

export function findBrevInstanceStatus(
  rawJson: string,
  instanceName: string,
): BrevInstanceStatus | null {
  try {
    const items = JSON.parse(rawJson);
    if (!Array.isArray(items)) return null;
    return (items.find((item) => item && item.name === instanceName) as BrevInstanceStatus) || null;
  } catch {
    return null;
  }
}

export function isBrevInstanceFailed(status: BrevInstanceStatus | null): boolean {
  if (!status) return false;
  const overall = String(status.status || "").toUpperCase();
  const build = String(status.build_status || "").toUpperCase();
  return overall === "FAILURE" || build === "FAILURE";
}

export function isBrevInstanceReady(status: BrevInstanceStatus | null): boolean {
  if (!status) return false;
  const overall = String(status.status || "").toUpperCase();
  const build = String(status.build_status || "").toUpperCase();
  const shell = String(status.shell_status || "").toUpperCase();
  return overall === "RUNNING" && build === "COMPLETED" && shell === "READY";
}

function getBrevInstanceStatus(
  instanceName: string,
  execFileSync: DeployExecutionOptions["execFileSync"],
): BrevInstanceStatus | null {
  try {
    const raw = execFileSync("brev", ["ls", "--json"], { encoding: "utf-8" });
    return findBrevInstanceStatus(raw, instanceName);
  } catch {
    return null;
  }
}

function fail(
  lines: string[],
  error: DeployExecutionOptions["error"],
  exit: DeployExecutionOptions["exit"],
): never {
  for (const line of lines) error(line);
  return exit(1);
}

export async function executeDeploy(opts: DeployExecutionOptions): Promise<void> {
  const {
    instanceName,
    env,
    rootDir,
    getCredential,
    validateName,
    shellQuote,
    run,
    runInteractive,
    execFileSync,
    spawnSync,
    log,
    error,
    stdoutWrite,
    exit,
  } = opts;

  log("");
  log("  ⚠  `nemoclaw deploy` is deprecated and will be removed in a future release.");
  log(
    "  Prefer provisioning the remote host separately, then run the standard installer and `nemoclaw onboard` on that host.",
  );
  log("");
  if (!instanceName) {
    return fail(
      [
        "  Usage: nemoclaw deploy <instance-name>",
        "",
        "  Examples:",
        "    nemoclaw deploy my-gpu-box",
        "    nemoclaw deploy nemoclaw-prod",
        "    nemoclaw deploy nemoclaw-test",
      ],
      error,
      exit,
    );
  }

  const name = validateName(instanceName, "instance name");
  const qname = shellQuote(name);
  const gpu = env.NEMOCLAW_GPU || "a2-highgpu-1g:nvidia-tesla-a100:1";
  const brevProvider = String(env.NEMOCLAW_BREV_PROVIDER || "gcp").trim().toLowerCase();
  const skipConnect = ["1", "true"].includes(
    String(env.NEMOCLAW_DEPLOY_NO_CONNECT || "").toLowerCase(),
  );
  const skipStartServices = ["1", "true"].includes(
    String(env.NEMOCLAW_DEPLOY_NO_START_SERVICES || "").toLowerCase(),
  );
  const sandboxName = validateName(env.NEMOCLAW_SANDBOX_NAME || "my-assistant", "sandbox name");
  const credentials: DeployCredentials = {
    NVIDIA_API_KEY: getCredential("NVIDIA_API_KEY"),
    OPENAI_API_KEY: getCredential("OPENAI_API_KEY"),
    ANTHROPIC_API_KEY: getCredential("ANTHROPIC_API_KEY"),
    GEMINI_API_KEY: getCredential("GEMINI_API_KEY"),
    COMPATIBLE_API_KEY: getCredential("COMPATIBLE_API_KEY"),
    COMPATIBLE_ANTHROPIC_API_KEY: getCredential("COMPATIBLE_ANTHROPIC_API_KEY"),
    GITHUB_TOKEN: getCredential("GITHUB_TOKEN"),
    TELEGRAM_BOT_TOKEN: getCredential("TELEGRAM_BOT_TOKEN"),
    DISCORD_BOT_TOKEN: getCredential("DISCORD_BOT_TOKEN"),
    SLACK_BOT_TOKEN: getCredential("SLACK_BOT_TOKEN"),
  };
  const provider = inferDeployProvider(env.NEMOCLAW_PROVIDER, credentials);
  if (!provider) {
    return fail(
      [
        "  Could not determine which inference provider to configure for remote onboarding.",
        "  Set `NEMOCLAW_PROVIDER` explicitly or provide exactly one matching provider credential.",
        "  Supported provider credentials: NVIDIA_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, COMPATIBLE_API_KEY, COMPATIBLE_ANTHROPIC_API_KEY.",
      ],
      error,
      exit,
    );
  }

  log("");
  log(`  Deploying NemoClaw to Brev instance: ${name}`);
  log("");

  try {
    execFileSync("which", ["brev"], { stdio: "ignore" });
  } catch {
    return fail(["brev CLI not found. Install: https://brev.nvidia.com"], error, exit);
  }

  let exists = false;
  try {
    const out = execFileSync("brev", ["ls"], { encoding: "utf-8" });
    exists = outputHasExactLine(out, name);
  } catch (caught) {
    const err = caught as { stdout?: string; stderr?: string };
    if (outputHasExactLine(err.stdout, name)) exists = true;
    if (outputHasExactLine(err.stderr, name)) exists = true;
  }

  if (!exists) {
    log(`  Creating Brev instance '${name}' (${gpu}, provider=${brevProvider})...`);
    run(`brev create ${qname} --type ${shellQuote(gpu)} --provider ${shellQuote(brevProvider)}`);
  } else {
    log(`  Brev instance '${name}' already exists.`);
  }

  run("brev refresh", { ignoreError: true });

  stdoutWrite("  Waiting for Brev instance readiness ");
  for (let i = 0; i < 60; i++) {
    const brevStatus = getBrevInstanceStatus(name, execFileSync);
    if (isBrevInstanceFailed(brevStatus)) {
      stdoutWrite("\n");
      error(`  Brev instance '${name}' did not become ready.`);
      error(
        `  Brev status: status=${brevStatus?.status || "unknown"} build=${brevStatus?.build_status || "unknown"} shell=${brevStatus?.shell_status || "unknown"}`,
      );
      if (brevStatus?.id) error(`  Instance id: ${brevStatus.id}`);
      return fail([`  Try: brev reset ${name}`], error, exit);
    }
    if (isBrevInstanceReady(brevStatus)) {
      stdoutWrite(" ✓\n");
      break;
    }

    if (i === 59) {
      stdoutWrite("\n");
      const finalBrevStatus = getBrevInstanceStatus(name, execFileSync);
      if (finalBrevStatus) {
        error(
          `  Brev status at timeout: status=${finalBrevStatus.status || "unknown"} build=${finalBrevStatus.build_status || "unknown"} shell=${finalBrevStatus.shell_status || "unknown"}`,
        );
        if (finalBrevStatus.id) error(`  Instance id: ${finalBrevStatus.id}`);
      }
      return fail([`  Timed out waiting for Brev instance readiness for ${name}`], error, exit);
    }
    stdoutWrite(".");
    spawnSync("sleep", ["3"]);
  }

  // ── SSH trust-on-first-use (TOFU) ──────────────────────────────
  // Pin the host key on first contact via ssh-keyscan, then verify all
  // subsequent connections against it. We keyscan first (not a probe with
  // StrictHostKeyChecking=no) to avoid a TOCTOU window where an attacker
  // could interpose between an unauthenticated probe and key capture.
  // Ref: https://github.com/NVIDIA/NemoClaw/issues/691
  const khDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ssh-"));
  const knownHostsFile = path.join(khDir, "known_hosts");
  const realHost = resolveRealHost(name, execFileSync);

  stdoutWrite("  Waiting for SSH ");
  for (let i = 0; i < 60; i++) {
    try {
      const hostKeys = execFileSync("ssh-keyscan", ["-T", "5", "-H", realHost], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (hostKeys.trim()) {
        fs.writeFileSync(knownHostsFile, hostKeys, { mode: 0o600 });
        stdoutWrite(" ✓\n");
        break;
      }
    } catch {
      /* keyscan failed, retry */
    }
    if (i === 59) {
      stdoutWrite("\n");
      fs.rmSync(khDir, { recursive: true, force: true });
      return fail(
        [`  Timed out waiting for SSH to ${name} (keyscan failed after 60 attempts)`],
        error,
        exit,
      );
    }
    stdoutWrite(".");
    spawnSync("sleep", ["3"]);
  }

  const sshOpts = buildSshOpts(knownHostsFile, shellQuote);
  const sshArgs = buildSshArgs(knownHostsFile);

  try {
    const remoteHome = execFileSync("ssh", [...sshArgs, name, "echo", "$HOME"], {
      encoding: "utf-8",
    }).trim();
    const remoteDir = `${remoteHome}/nemoclaw`;

    log("  Syncing NemoClaw to VM...");
    run(`ssh ${sshOpts} ${qname} 'mkdir -p ${shellQuote(remoteDir)}'`);
    run(
      `rsync -az --delete --exclude node_modules --exclude .git --exclude dist --exclude .venv -e "ssh ${sshOpts}" "${rootDir}/" ${qname}:${shellQuote(`${remoteDir}/`)}`,
    );

    const envLines = buildDeployEnvLines({
      env,
      sandboxName,
      provider,
      credentials,
      shellQuote,
    });
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-"));
    const envTmp = path.join(envDir, "env");
    fs.writeFileSync(envTmp, envLines.join("\n") + "\n", { mode: 0o600 });
    try {
      run(`scp -q ${sshOpts} ${shellQuote(envTmp)} ${qname}:${shellQuote(`${remoteDir}/.env`)}`);
      run(
        `ssh -q ${sshOpts} ${qname} 'chmod 600 ${shellQuote(`${remoteDir}/.env`)}'`,
      );
    } finally {
      try {
        fs.unlinkSync(envTmp);
      } catch {
        /* ignored */
      }
      try {
        fs.rmdirSync(envDir);
      } catch {
        /* ignored */
      }
    }

    log("  Running setup...");
    runInteractive(
      `ssh -t ${sshOpts} ${qname} 'cd ${shellQuote(remoteDir)} && set -a && . .env && set +a && bash scripts/install.sh --non-interactive --yes-i-accept-third-party-software'`,
    );

    if (
      !skipStartServices &&
      (credentials.TELEGRAM_BOT_TOKEN ||
        credentials.DISCORD_BOT_TOKEN ||
        credentials.SLACK_BOT_TOKEN)
    ) {
      log("  Starting services...");
      run(
        `ssh ${sshOpts} ${qname} 'cd ${shellQuote(remoteDir)} && set -a && . .env && set +a && bash scripts/start-services.sh'`,
      );
    }

    if (skipStartServices) {
      log("  Skipping service startup (NEMOCLAW_DEPLOY_NO_START_SERVICES=1).");
    }

    if (skipConnect) {
      log("");
      log("  Skipping interactive sandbox connect (NEMOCLAW_DEPLOY_NO_CONNECT=1).");
      log(`  Remote sandbox: ${sandboxName}`);
      log(`  Connect later with: ssh ${name} 'openshell sandbox connect ${sandboxName}'`);
      return;
    }

    log("");
    log("  Connecting to sandbox...");
    log("");
    runInteractive(
      `ssh -t ${sshOpts} ${qname} 'cd ${shellQuote(remoteDir)} && set -a && . .env && set +a && openshell sandbox connect ${shellQuote(sandboxName)}'`,
    );
  } finally {
    fs.rmSync(khDir, { recursive: true, force: true });
  }
}
