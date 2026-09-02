// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the real shields/config boundary from the former shell test: source
 * install, OpenShell/runtime sandbox exec, host-root runtime tamper, chmod/chown
 * lock state, config redaction, audit JSONL, and the auto-restore timer. Local
 * helpers stay in this file because this is one focused security/policy
 * dependent, not a new shields fixture family.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  cleanupWhenCommandAvailable,
  cleanupWhenOpenShellAvailable,
} from "../fixtures/cleanup-resources.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { pollUntil } from "../fixtures/polling.ts";
import { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  failedStartupProcessControlCommands,
  resumeSupervisorIfPaused,
} from "../fixtures/shields-failed-startup.ts";
import { stripAnsi } from "./json-envelope.ts";

const CONFIG_PATH = "/sandbox/.openclaw/openclaw.json";
const CONFIG_DIR = path.dirname(CONFIG_PATH);
const CONFIG_HASH_PATH = `${CONFIG_DIR}/.config-hash`;
const CONFIG_GUARD_PATH = "/usr/local/lib/nemoclaw/openclaw-config-guard.py";
const STATE_LOCK_PLAN_PATH = "/usr/local/share/nemoclaw/state-lock-plan.json";
const STARTUP_MARKER_PATHS = [
  "/run/nemoclaw/openclaw-config-ready-v1.capability.json",
  "/run/nemoclaw/openclaw-config-ready.json",
] as const;
const AUDIT_FILE = path.join(os.homedir(), ".nemoclaw", "state", "shields-audit.jsonl");
const STATE_FILE = (sandboxName: string) =>
  path.join(os.homedir(), ".nemoclaw", "state", `shields-${sandboxName}.json`);
const TIMER_FILE = (sandboxName: string) =>
  path.join(os.homedir(), ".nemoclaw", "state", `shields-timer-${sandboxName}.json`);
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-shields";

const TEST_TIMEOUT_MS = 45 * 60_000;
const INSTALL_TIMEOUT_MS = 25 * 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
const TIMER_POLL_TIMEOUT_MS = 75_000;
const TIMER_POLL_INTERVAL_MS = 5_000;

validateSandboxName(SANDBOX_NAME);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

async function runNemoclaw(
  host: HostCliClient,
  args: string[],
  options: {
    artifactName: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    redactionValues?: string[];
  },
): Promise<ShellProbeResult> {
  return host.command("nemoclaw", args, {
    artifactName: options.artifactName,
    env: options.env ?? commandEnv(),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    redactionValues: options.redactionValues,
  });
}

async function sandboxShell(
  sandbox: SandboxClient,
  script: string,
  options: { artifactName: string; timeoutMs?: number },
): Promise<ShellProbeResult> {
  return sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(script), {
    artifactName: options.artifactName,
    env: commandEnv(),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
}

function selectedRuntimeProvider(host: HostCliClient): RuntimeProviderPrerequisite {
  return new RuntimeProviderPrerequisite(host, (reason) => {
    throw new Error(reason);
  });
}

async function runtimeCommand(
  host: HostCliClient,
  args: string[],
  options: { artifactName: string; timeoutMs?: number; redactionValues?: string[] } = {
    artifactName: "runtime",
  },
): Promise<ShellProbeResult> {
  return selectedRuntimeProvider(host).command(args, {
    artifactName: options.artifactName,
    env: commandEnv(),
    redactionValues: options.redactionValues,
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
}

async function installedShellCommand(
  host: HostCliClient,
  script: string,
  options: {
    artifactName: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    redactionValues?: string[];
  },
): Promise<ShellProbeResult> {
  return host.command("bash", ["-lc", script], {
    artifactName: options.artifactName,
    env: options.env ?? commandEnv(),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    redactionValues: options.redactionValues,
  });
}

function parseModeOwner(value: string): { mode: string; owner: string } {
  const [mode = "", owner = ""] = value.trim().split(/\s+/, 2);
  return { mode, owner };
}

async function statPath(
  sandbox: SandboxClient,
  targetPath: string,
  artifactName: string,
): Promise<{ mode: string; owner: string; raw: string }> {
  const result = await sandboxShell(sandbox, `stat -c '%a %U:%G' ${JSON.stringify(targetPath)}`, {
    artifactName,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  const parsed = parseModeOwner(result.stdout);
  return { ...parsed, raw: result.stdout.trim() };
}

async function collectStartFailureRuntimeLogs(
  host: HostCliClient,
  artifactPrefix: string,
  redactionValues: string[],
): Promise<string> {
  const lookup = await runtimeCommand(
    host,
    [
      "ps",
      "--all",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`,
      "--filter",
      "label=openshell.ai/sandbox-workspace=default",
      "-q",
    ],
    {
      artifactName: `${artifactPrefix}-failure-container`,
      redactionValues,
      timeoutMs: 30_000,
    },
  );
  const containerId = lookup.stdout.trim().split(/\s+/u).filter(Boolean)[0] ?? "";
  const result =
    lookup.exitCode !== 0 || !containerId
      ? lookup
      : await runtimeCommand(host, ["logs", "--tail", "200", containerId], {
          artifactName: `${artifactPrefix}-failure-runtime-logs`,
          redactionValues,
          timeoutMs: 30_000,
        });
  return resultText(result);
}

async function expectStopStartRecovery(
  host: HostCliClient,
  sandbox: SandboxClient,
  posture: "DOWN" | "UP",
  artifactPrefix: string,
  redactionValues: string[],
): Promise<void> {
  const stop = await runNemoclaw(host, [SANDBOX_NAME, "stop"], {
    artifactName: `${artifactPrefix}-stop`,
    redactionValues,
    timeoutMs: 5 * 60_000,
  });
  expect(stop.exitCode, resultText(stop)).toBe(0);

  const start = await runNemoclaw(host, [SANDBOX_NAME, "start"], {
    artifactName: `${artifactPrefix}-start`,
    redactionValues,
    timeoutMs: 5 * 60_000,
  });
  const startFailureLogs =
    start.exitCode === 0
      ? ""
      : await collectStartFailureRuntimeLogs(host, artifactPrefix, redactionValues);
  expect(
    start.exitCode,
    [resultText(start), startFailureLogs && `Runtime logs:\n${startFailureLogs}`]
      .filter(Boolean)
      .join("\n"),
  ).toBe(0);

  const statusAttempt = await pollUntil({
    artifactPrefix: `${artifactPrefix}-status`,
    attempts: 5,
    delayMs: 5_000,
    probe: async (_attempt, artifactName) =>
      await runNemoclaw(host, [SANDBOX_NAME, "status"], {
        artifactName,
        redactionValues,
        timeoutMs: 60_000,
      }),
    accept: (result) =>
      result.exitCode === 0 && /Phase:\s*Ready/i.test(stripAnsi(resultText(result))),
  });
  const status = statusAttempt.value;
  expect(status.exitCode, resultText(status)).toBe(0);
  expect(stripAnsi(resultText(status))).toMatch(/Phase:\s*Ready/i);

  const shields = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
    artifactName: `${artifactPrefix}-shields-status`,
    redactionValues,
  });
  expect(shields.exitCode, resultText(shields)).toBe(0);
  expect(resultText(shields)).toContain(`Shields: ${posture}`);

  const runtimeIdentity = await sandboxShell(
    sandbox,
    'printf \'pwd=%s\\nhome=%s\\nuser=%s\\ngroup=%s\\n\' "$PWD" "$HOME" "$(id -un)" "$(id -gn)"',
    { artifactName: `${artifactPrefix}-runtime-identity` },
  );
  expect(runtimeIdentity.exitCode, resultText(runtimeIdentity)).toBe(0);
  expect(runtimeIdentity.stdout).toContain("pwd=/sandbox\n");
  expect(runtimeIdentity.stdout).toContain("home=/sandbox\n");
  expect(runtimeIdentity.stdout).toContain("user=sandbox\n");
  expect(runtimeIdentity.stdout).toContain("group=sandbox\n");
}

async function expectLockedSandboxParent(
  host: HostCliClient,
  artifactPrefix: string,
): Promise<void> {
  const containerId = await findSandboxContainer(host);
  const parent = await runtimeCommand(
    host,
    ["exec", "--user", "0", containerId, "stat", "-c", "%a %U:%G", "/sandbox"],
    { artifactName: `${artifactPrefix}-sandbox-parent` },
  );
  expect(parent.exitCode, resultText(parent)).toBe(0);
  expect(parent.stdout.trim()).toBe("1775 root:sandbox");
}

async function expectCredentialsTraversalBoundary(
  host: HostCliClient,
  sandbox: SandboxClient,
  containerId: string,
): Promise<void> {
  const credentialsDir = "/sandbox/.openclaw/credentials";
  const seededPath = `${credentialsDir}/.nemoclaw-permission-probe`;
  const seeded = await runtimeCommand(
    host,
    ["exec", "--user", "0", containerId, "sh", "-c", `umask 077; : > ${seededPath}`],
    { artifactName: "phase-5a-seed-credential-permission-probe" },
  );
  expect(seeded.exitCode, resultText(seeded)).toBe(0);

  try {
    const metadata = await statPath(
      sandbox,
      credentialsDir,
      "phase-5a-credential-directory-metadata",
    );
    expect(metadata.mode).toBe("710");
    expect(metadata.owner).toBe("root:sandbox");

    const boundary = await sandboxShell(
      sandbox,
      `python3 - <<'PY'\nimport os\n\ndirectory = ${JSON.stringify(credentialsDir)}\nseeded = ${JSON.stringify(seededPath)}\noptional = os.path.join(directory, "optional.json")\n\ntry:\n    os.stat(optional)\nexcept FileNotFoundError:\n    print("traversal=allowed")\nelse:\n    raise RuntimeError("optional credential path unexpectedly exists")\n\noperations = (\n    ("listing", lambda: os.listdir(directory)),\n    ("reading", lambda: open(seeded, "rb").read()),\n    ("creation", lambda: open(os.path.join(directory, "created"), "wb").close()),\n    ("removal", lambda: os.unlink(seeded)),\n)\nfor label, operation in operations:\n    try:\n        operation()\n    except PermissionError:\n        print(f"{label}=denied")\n    else:\n        raise RuntimeError(f"{label} unexpectedly allowed")\nPY`,
      { artifactName: "phase-5a-credential-traversal-boundary" },
    );
    expect(boundary.exitCode, resultText(boundary)).toBe(0);
    expect(boundary.stdout).toContain("traversal=allowed");
    for (const operation of ["listing", "reading", "creation", "removal"]) {
      expect(boundary.stdout).toContain(`${operation}=denied`);
    }
  } finally {
    await runtimeCommand(host, ["exec", "--user", "0", containerId, "rm", "-f", seededPath], {
      artifactName: "phase-5a-remove-credential-permission-probe",
    });
  }
}

async function preCleanSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  artifactPrefix: string,
): Promise<void> {
  await runNemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], {
    artifactName: `${artifactPrefix}-nemoclaw-destroy`,
    timeoutMs: 120_000,
  }).catch(() => undefined);
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: `${artifactPrefix}-openshell-sandbox-delete`,
      env: commandEnv(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: `${artifactPrefix}-openshell-gateway-destroy`,
      env: commandEnv(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  for (const file of [STATE_FILE(SANDBOX_NAME), TIMER_FILE(SANDBOX_NAME), AUDIT_FILE]) {
    fs.rmSync(file, { force: true });
  }
  fs.rmSync(path.join(os.homedir(), ".nemoclaw", "onboard.lock"), {
    force: true,
  });
}

async function findSandboxContainer(host: HostCliClient): Promise<string> {
  const result = await runtimeCommand(
    host,
    [
      "ps",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`,
      "--filter",
      "label=openshell.ai/sandbox-workspace=default",
      "-q",
    ],
    {
      artifactName: "runtime-ps-sandbox-container",
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  const containerId = result.stdout.trim().split(/\s+/).filter(Boolean)[0] ?? "";
  expect(containerId, `could not find openshell container for ${SANDBOX_NAME}`).not.toBe("");
  return containerId;
}

type StartupCensus = { count: number; pid: number | null };

async function installedStartupCensus(
  host: HostCliClient,
  containerId: string,
  artifactName: string,
): Promise<StartupCensus> {
  const script = [
    "import json, runpy",
    `guard = runpy.run_path(${JSON.stringify(CONFIG_GUARD_PATH)})`,
    "identity = guard['_production_identity']()",
    "census = guard['_openshell_supervised_nonroot_start_census'](identity.root_uid, identity.sandbox_uid)",
    "assert census is not None",
    "print(json.dumps({'count': census[0], 'pid': census[1]}))",
  ].join("\n");
  const result = await runtimeCommand(
    host,
    ["exec", "--user", "0", containerId, "python3", "-I", "-c", script],
    { artifactName, timeoutMs: 30_000 },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  return JSON.parse(result.stdout.trim()) as StartupCensus;
}

async function runInstalledFailedStartupUnlock(
  host: HostCliClient,
  containerId: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  const script = [
    "set -eu",
    `plan_json=$(cat ${STATE_LOCK_PLAN_PATH})`,
    `exec timeout --signal=TERM --kill-after=5s 25m python3 -I ${CONFIG_GUARD_PATH} unlock-failed-startup --config-dir ${CONFIG_DIR} --plan-json "$plan_json"`,
  ].join("\n");
  return runtimeCommand(host, ["exec", "--user", "0", containerId, "sh", "-c", script], {
    artifactName,
    timeoutMs: 26 * 60_000,
  });
}

async function waitForChildlessStartup(host: HostCliClient, containerId: string): Promise<void> {
  await pollUntil({
    artifactPrefix: "phase-12-childless-census",
    attempts: 20,
    delayMs: 500,
    probe: async (_attempt, artifactName) =>
      await installedStartupCensus(host, containerId, artifactName),
    accept: (census) => census.count === 0,
  });
}

function createPolicySetChildlessBoundaryShim(
  host: HostCliClient,
  realOpenshellPath: string,
  containerId: string,
  startupPid: number,
): { directory: string; executable: string; receipt: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-openshell-"));
  const executable = path.join(directory, "openshell-childless-boundary.cjs");
  const receipt = path.join(directory, "childless-boundary.json");
  const processControl = failedStartupProcessControlCommands(containerId, startupPid);
  const runtimeInvocation = selectedRuntimeProvider(host).hostInvocation([]);
  const childlessCensusScript = [
    "import runpy, sys, time",
    `guard = runpy.run_path(${JSON.stringify(CONFIG_GUARD_PATH)})`,
    "identity = guard['_production_identity']()",
    "for _ in range(100):",
    "    census = guard['_openshell_supervised_nonroot_start_census'](identity.root_uid, identity.sandbox_uid)",
    "    if census is not None and census[0] == 0:",
    "        sys.exit(0)",
    "    time.sleep(0.1)",
    "sys.exit(1)",
  ].join("\n");
  const shimSource = `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const delegated = spawnSync(${JSON.stringify(realOpenshellPath)}, args, {
  env: process.env,
  stdio: "inherit",
});
if (delegated.error || delegated.status !== 0) {
  if (delegated.error) console.error(delegated.error.message);
  process.exit(delegated.status ?? 1);
}

const isTargetPolicySet =
  args[0] === "policy" &&
  args[1] === "set" &&
  args.includes("--wait") &&
  args.at(-1) === ${JSON.stringify(SANDBOX_NAME)};
if (!isTargetPolicySet || fs.existsSync(${JSON.stringify(receipt)})) process.exit(0);

fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ status: "arming" }), {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
const runtimeCommand = ${JSON.stringify(runtimeInvocation.command)};
const runtimePrefix = ${JSON.stringify(runtimeInvocation.args)};
const pause = spawnSync(runtimeCommand, [...runtimePrefix, ...${JSON.stringify(processControl.pauseSupervisor)}], {
  env: process.env,
  stdio: "inherit",
});
if (pause.error || pause.status !== 0) process.exit(pause.status ?? 1);
const terminate = spawnSync(runtimeCommand, [...runtimePrefix, ...${JSON.stringify(processControl.terminateStartupChild)}], {
  env: process.env,
  stdio: "inherit",
});
if (terminate.error || terminate.status !== 0) process.exit(terminate.status ?? 1);
const childless = spawnSync(
  runtimeCommand,
  [
    ...runtimePrefix,
    "exec",
    "--user",
    "0",
    ${JSON.stringify(containerId)},
    "python3",
    "-I",
    "-c",
    ${JSON.stringify(childlessCensusScript)},
  ],
  { env: process.env, stdio: "inherit" },
);
if (childless.error || childless.status !== 0) process.exit(childless.status ?? 1);
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ status: "childless" }), {
  encoding: "utf8",
  mode: 0o600,
});
`;
  fs.writeFileSync(executable, shimSource, { encoding: "utf8", mode: 0o700 });
  return { directory, executable, receipt };
}

async function readOriginalConfig(
  host: HostCliClient,
  containerId: string,
  targetFile: string,
): Promise<void> {
  const invocation = selectedRuntimeProvider(host).hostInvocation([
    "container",
    "exec",
    "--user",
    "0",
    containerId,
    "cat",
    CONFIG_PATH,
  ]);
  const result = await host.command(
    "bash",
    [
      "-lc",
      'output="$1"; shift; "$@" > "$output"',
      "runtime-config-backup",
      targetFile,
      invocation.command,
      ...invocation.args,
    ],
    {
      artifactName: "phase-5b-backup-original-config",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(fs.statSync(targetFile).size, "original config backup must not be empty").toBeGreaterThan(
    0,
  );
}

function readAuditEntries(): unknown[] {
  return fs
    .readFileSync(AUDIT_FILE, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readTimerMarker(sandboxName: string): {
  pid: number;
  restoreAt: string;
  snapshotPath: string;
} {
  return JSON.parse(fs.readFileSync(TIMER_FILE(sandboxName), "utf8"));
}

test(
  "shields-config: live Shields lifecycle restores stopped OpenClaw under both postures (#8112)",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm selected runtime and onboard the shields sandbox",
        "establish the mutable unified OpenClaw config",
        "lock config and workspace and inspect redaction",
        "restart OpenClaw with shields up",
        "detect host-root config drift and refuse resealing",
        "re-seal a perms-only .config-hash drift instead of failing closed",
        "unlock shields and inspect the audit trail",
        "restart OpenClaw with shields down",
        "recover shields after a dead restore timer",
        "reject duplicate shields transitions",
        "prove installed failed-startup guard refuses a live child and supported shields down unlocks childless state",
        "record shields contract evidence",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    await artifacts.target.declare({
      id: "shields-config",
      boundary: "live-sandbox-shields-config",
      contracts: [
        "source install creates a live OpenClaw sandbox",
        "default config starts mutable with unified .openclaw layout",
        "documented nemoclaw exec doctor path preserves 2770/660 and gateway writes",
        "fresh mutable-default shields down preserves the mutable config posture",
        "host policy edits survive interactive and timer Shields restoration",
        "shields up locks config/workspace and config get redacts secrets",
        "start restores a stopped OpenClaw sandbox while shields are up",
        "empty sealed credentials allow traversal but deny sandbox identity access",
        "host-root chmod-write-chmod tamper is detected as content drift",
        "a perms-only .config-hash drift is re-sealed by shields up, not failed closed",
        "shields down restores mutable modes and records audit JSONL",
        "start restores a stopped OpenClaw sandbox while shields are down",
        "dead auto-restore timer inline recovery re-locks config and .config-hash",
        "double shields-up/down operations are rejected",
        "installed failed-startup guard refuses a live child and supported shields down atomically unlocks childless state",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-info",
      scenarioLabel: "shields-config",
    });

    const hosted = requireHostedInferenceConfig(secrets);
    const apiKey = hosted.apiKey;

    await preCleanSandbox(host, sandbox, "pre-cleanup");
    cleanup.trackDisposable(`remove shields state for ${SANDBOX_NAME}`, () => {
      [STATE_FILE(SANDBOX_NAME), TIMER_FILE(SANDBOX_NAME), AUDIT_FILE].forEach((file) => {
        fs.rmSync(file, { force: true });
      });
      fs.rmSync(path.join(os.homedir(), ".nemoclaw", "onboard.lock"), {
        force: true,
      });
    });
    const gatewayCleanupOptions = {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: commandEnv(),
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    };
    cleanup.trackGateway(
      {
        cleanupGatewayRegistration: (name: string) =>
          cleanupWhenOpenShellAvailable(
            host,
            {
              artifactName: "cleanup-probe-openshell-gateway",
              env: gatewayCleanupOptions.env,
              redactionValues: gatewayCleanupOptions.redactionValues,
              timeoutMs: 30_000,
            },
            () => host.cleanupGatewayRegistration(name, gatewayCleanupOptions),
          ),
      },
      "nemoclaw",
      gatewayCleanupOptions,
    );
    const openshellSandboxCleanupOptions = {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: commandEnv(),
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    };
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      cleanupWhenOpenShellAvailable(
        host,
        {
          artifactName: "cleanup-probe-openshell-sandbox",
          env: openshellSandboxCleanupOptions.env,
          redactionValues: openshellSandboxCleanupOptions.redactionValues,
          timeoutMs: 30_000,
        },
        () => sandbox.cleanupSandbox(SANDBOX_NAME, openshellSandboxCleanupOptions),
      ),
    );
    const nemoclawSandboxCleanupOptions = {
      artifactName: "cleanup-nemoclaw-destroy",
      env: commandEnv(),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    };
    cleanup.trackSandbox(
      {
        cleanupSandbox: (name: string) =>
          cleanupWhenCommandAvailable(
            host,
            host.commandPath,
            {
              artifactName: "cleanup-probe-nemoclaw-sandbox",
              env: nemoclawSandboxCleanupOptions.env,
              redactionValues: nemoclawSandboxCleanupOptions.redactionValues,
              timeoutMs: 30_000,
            },
            () => host.cleanupSandbox(name, nemoclawSandboxCleanupOptions),
          ),
      },
      SANDBOX_NAME,
      nemoclawSandboxCleanupOptions,
    );

    const install = await installedShellCommand(
      host,
      `cd ${JSON.stringify(REPO_ROOT)} && bash install.sh --non-interactive --fresh`,
      {
        artifactName: "phase-1-install-shields-config",
        env: commandEnv({
          ...hosted.env,
          NEMOCLAW_RECREATE_SANDBOX: "1",
        }),
        redactionValues: [apiKey],
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    expect(install.exitCode, resultText(install)).toBe(0);

    const cliVersion = await installedShellCommand(
      host,
      "command -v nemoclaw && command -v openshell",
      {
        artifactName: "phase-1-installed-commands-on-path",
      },
    );
    expect(cliVersion.exitCode, resultText(cliVersion)).toBe(0);

    progress.phase("establish the mutable unified OpenClaw config");
    const configDefault = await statPath(sandbox, CONFIG_PATH, "phase-2-config-perms-default");
    expect(configDefault.mode).toBe("660");
    expect(configDefault.owner).toBe("sandbox:sandbox");
    const dirDefault = await statPath(sandbox, CONFIG_DIR, "phase-2-config-dir-perms-default");
    expect(dirDefault.mode).toBe("2770");
    expect(dirDefault.owner).toBe("sandbox:sandbox");

    const doctor = await runNemoclaw(
      host,
      [
        SANDBOX_NAME,
        "exec",
        "--",
        "bash",
        "-c",
        'openclaw doctor --fix; rc=$?; printf "doctor_exit:%s\\n" "$rc"; stat -c "doctor_file_mode:%a" /sandbox/.openclaw/openclaw.json; stat -c "doctor_dir_mode:%a" /sandbox/.openclaw',
      ],
      {
        artifactName: "phase-2b-documented-exec-doctor-fix",
        timeoutMs: 5 * 60_000,
      },
    );
    expect(doctor.exitCode, resultText(doctor)).toBe(0);
    expect(resultText(doctor)).toMatch(/doctor_exit:\d+/);
    expect(resultText(doctor)).toContain("doctor_file_mode:600");
    expect(resultText(doctor)).toContain("doctor_dir_mode:700");

    const configAfterDoctor = await statPath(
      sandbox,
      CONFIG_PATH,
      "phase-2b-config-perms-after-doctor",
    );
    expect(configAfterDoctor).toMatchObject({ mode: "660", owner: "sandbox:sandbox" });
    const dirAfterDoctor = await statPath(
      sandbox,
      CONFIG_DIR,
      "phase-2b-config-dir-perms-after-doctor",
    );
    expect(dirAfterDoctor).toMatchObject({ mode: "2770", owner: "sandbox:sandbox" });

    const containerId = await findSandboxContainer(host);
    const gatewayWrite = await runtimeCommand(
      host,
      ["exec", "-u", "gateway", containerId, "sh", "-c", `printf ' ' >>${CONFIG_PATH}`],
      {
        artifactName: "phase-2b-gateway-config-append-after-doctor",
        timeoutMs: 30_000,
      },
    );
    expect(gatewayWrite.exitCode, resultText(gatewayWrite)).toBe(0);
    const refreshHash = await sandboxShell(
      sandbox,
      `cd ${CONFIG_DIR} && sha256sum openclaw.json >.config-hash`,
      { artifactName: "phase-2b-refresh-hash-after-gateway-write" },
    );
    expect(refreshHash.exitCode, resultText(refreshHash)).toBe(0);

    const statusDefault = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-2-shields-status-default",
    });
    expect(statusDefault.exitCode, resultText(statusDefault)).toBe(0);
    expect(statusDefault.stdout).toContain("Shields: NOT CONFIGURED");

    const freshMutableDown = await runNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "down", "--timeout", "5m", "--reason", "Fresh mutable-default E2E"],
      { artifactName: "phase-2c-fresh-mutable-shields-down" },
    );
    expect(freshMutableDown.exitCode, resultText(freshMutableDown)).toBe(0);
    expect(resultText(freshMutableDown)).toContain("Config unlocked");
    expect(await statPath(sandbox, CONFIG_PATH, "phase-2c-config-perms-after-down")).toMatchObject({
      mode: "660",
      owner: "sandbox:sandbox",
    });
    expect(
      await statPath(sandbox, CONFIG_DIR, "phase-2c-config-dir-perms-after-down"),
    ).toMatchObject({
      mode: "2770",
      owner: "sandbox:sandbox",
    });

    const interactiveHostPolicyEdit = await sandbox.openshell(
      [
        "policy",
        "update",
        SANDBOX_NAME,
        "--add-endpoint",
        "interactive-host-edit.example.com:443:read-only:rest:enforce",
        "--rule-name",
        "interactive_host_edit_e2e",
        "--binary",
        "/usr/bin/curl",
        "--wait",
      ],
      {
        artifactName: "phase-2c-interactive-host-policy-edit",
        env: commandEnv(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      },
    );
    expect(interactiveHostPolicyEdit.exitCode, resultText(interactiveHostPolicyEdit)).toBe(0);

    const layoutProbe = await sandboxShell(
      sandbox,
      [
        `bad=0`,
        `if [ -e /sandbox/.openclaw-data ] || [ -L /sandbox/.openclaw-data ]; then echo "legacy data dir exists: /sandbox/.openclaw-data"; bad=1; fi`,
        `for entry in /sandbox/.openclaw/*; do [ -L "$entry" ] || continue; target="$(readlink -f "$entry" 2>/dev/null || readlink "$entry" 2>/dev/null || true)"; case "$target" in /sandbox/.openclaw-data/*) echo "legacy symlink remains: $entry -> $target"; bad=1 ;; esac; done`,
        `exit "$bad"`,
      ].join("; "),
      { artifactName: "phase-2-unified-openclaw-layout" },
    );
    expect(layoutProbe.exitCode, resultText(layoutProbe)).toBe(0);
    expect(resultText(layoutProbe).trim()).toBe("");

    progress.phase("lock config and workspace and inspect redaction");
    const shieldsUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
      artifactName: "phase-3-shields-up",
    });
    expect(shieldsUp.exitCode, resultText(shieldsUp)).toBe(0);
    expect(resultText(shieldsUp)).toContain("Lockdown active");
    const policyAfterInteractiveRestore = await sandbox.openshell(
      ["policy", "get", "--full", SANDBOX_NAME],
      {
        artifactName: "phase-3-policy-after-interactive-restore",
        env: commandEnv(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      },
    );
    expect(policyAfterInteractiveRestore.exitCode, resultText(policyAfterInteractiveRestore)).toBe(
      0,
    );
    expect(policyAfterInteractiveRestore.stdout).toContain("interactive_host_edit_e2e");
    // Keep fixture teardown out of an artificial mutable window if a later
    // assertion aborts before the explicit final restore below.
    cleanup.trackDisposable(`restore shields for ${SANDBOX_NAME} before destroy`, async () => {
      const restore = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
        artifactName: "cleanup-shields-up-before-destroy",
      });
      expect(restore.exitCode, resultText(restore)).toBe(0);
      expect(resultText(restore)).toMatch(/Lockdown (?:is already )?active/);
    });

    const configUp = await statPath(sandbox, CONFIG_PATH, "phase-3-config-perms-up");
    expect(configUp.mode).toMatch(/^4[0-4][0-4]$/);
    expect(configUp.owner).toBe("root:root");

    const writeUp = await sandboxShell(
      sandbox,
      `echo 'TAMPERED' >> ${CONFIG_PATH} 2>&1 && echo WRITABLE || echo BLOCKED`,
      { artifactName: "phase-3-config-write-blocked" },
    );
    expect(resultText(writeUp)).toMatch(
      /BLOCKED|Permission denied|Read-only|Operation not permitted/,
    );

    const workspaceUp = await sandboxShell(
      sandbox,
      "touch /sandbox/.openclaw/workspace/.shields-up-probe 2>&1 && echo WRITABLE || echo BLOCKED",
      { artifactName: "phase-3-workspace-write-blocked" },
    );
    expect(resultText(workspaceUp)).toMatch(
      /BLOCKED|Permission denied|Read-only|Operation not permitted/,
    );

    const configGet = await runNemoclaw(host, [SANDBOX_NAME, "config", "get"], {
      artifactName: "phase-4-config-get",
      redactionValues: [apiKey],
    });
    expect(configGet.exitCode, resultText(configGet)).toBe(0);
    expect(configGet.stdout).toContain("{");
    expect(configGet.stdout).not.toMatch(/nvapi-|sk-|Bearer /);
    expect(configGet.stdout).not.toContain('"gateway"');

    const dotpath = await runNemoclaw(host, [SANDBOX_NAME, "config", "get", "--key", "inference"], {
      artifactName: "phase-4-config-get-dotpath",
      redactionValues: [apiKey],
    });
    if (
      dotpath.exitCode === 0 &&
      dotpath.stdout.trim() !== "" &&
      dotpath.stdout.trim() !== "null"
    ) {
      expect(dotpath.stdout).not.toMatch(/nvapi-|sk-|Bearer /);
    } else {
      await artifacts.writeJson("phase-4-dotpath-non-fatal.json", {
        exitCode: dotpath.exitCode,
        stdout: dotpath.stdout.trim(),
        stderr: dotpath.stderr.trim(),
        note: "config get --key inference is non-fatal because the inference key may not exist",
      });
    }

    const statusUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-5-shields-status-up",
    });
    expect(statusUp.exitCode, resultText(statusUp)).toBe(0);
    expect(statusUp.stdout).toContain("Shields: UP");

    progress.phase("restart OpenClaw with shields up");
    await expectStopStartRecovery(host, sandbox, "UP", "phase-5a-shields-up-start-recovery", [
      apiKey,
    ]);
    await expectLockedSandboxParent(host, "phase-5a-shields-up-start-recovery");
    const configAfterLockedRestart = await statPath(
      sandbox,
      CONFIG_PATH,
      "phase-5a-config-after-shields-up-start-recovery",
    );
    expect(configAfterLockedRestart.mode).toMatch(/^4[0-4][0-4]$/);
    expect(configAfterLockedRestart.owner).toBe("root:root");
    await expectCredentialsTraversalBoundary(host, sandbox, containerId);

    progress.phase("detect host-root config drift and refuse resealing");
    const originalConfig = path.join(os.tmpdir(), `nemoclaw-shields-orig-${process.pid}.json`);
    await readOriginalConfig(host, containerId, originalConfig);
    try {
      const tamper = await runtimeCommand(
        host,
        [
          "container",
          "exec",
          "--user",
          "0",
          containerId,
          "sh",
          "-c",
          [
            `had_immutable=false`,
            `if lsattr -d ${CONFIG_PATH} 2>/dev/null | awk '{print $1}' | grep -q i; then had_immutable=true; fi`,
            `chattr -i ${CONFIG_PATH} 2>/dev/null || true`,
            `chmod 644 ${CONFIG_PATH} && printf " " >> ${CONFIG_PATH} && chmod 444 ${CONFIG_PATH}`,
            `if [ "$had_immutable" = true ]; then chattr +i ${CONFIG_PATH} >/dev/null 2>&1 || true; fi`,
          ].join("\n"),
        ],
        {
          artifactName: "phase-5b-host-root-tamper",
          timeoutMs: 30_000,
        },
      );
      expect(tamper.exitCode, resultText(tamper)).toBe(0);

      const afterTamper = await runtimeCommand(
        host,
        ["exec", containerId, "stat", "-c", "%a %U:%G", CONFIG_PATH],
        {
          artifactName: "phase-5b-perms-after-tamper",
          timeoutMs: 30_000,
        },
      );
      expect(afterTamper.exitCode, resultText(afterTamper)).toBe(0);
      expect(afterTamper.stdout.trim()).toBe("444 root:root");

      const statusTamper = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
        artifactName: "phase-5b-shields-status-drifted",
      });
      expect(statusTamper.exitCode, resultText(statusTamper)).toBe(2);
      expect(resultText(statusTamper)).toContain("UP (DRIFTED");
      expect(resultText(statusTamper)).toContain("content drifted");

      const reUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
        artifactName: "phase-5b-shields-up-refuses-tamper",
      });
      expect(reUp.exitCode, resultText(reUp)).not.toBe(0);
      expect(resultText(reUp)).toContain("Refusing to re-seal");
    } finally {
      const invocation = selectedRuntimeProvider(host).hostInvocation([
        "container",
        "exec",
        "--interactive",
        "--user",
        "0",
        containerId,
        "sh",
        "-c",
        `chattr -i ${CONFIG_PATH} 2>/dev/null || true; chmod 644 ${CONFIG_PATH} && cat > ${CONFIG_PATH} && chmod 444 ${CONFIG_PATH} && chattr +i ${CONFIG_PATH} 2>/dev/null || true`,
      ]);
      const restore = await host.command(
        "bash",
        [
          "-lc",
          'input="$1"; shift; exec "$@" < "$input"',
          "runtime-config-restore",
          originalConfig,
          invocation.command,
          ...invocation.args,
        ],
        {
          artifactName: "phase-5b-restore-original-config",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(restore.exitCode, resultText(restore)).toBe(0);
      fs.rmSync(originalConfig, { force: true });
    }

    const statusRestored = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-5b-shields-status-restored",
    });
    expect(statusRestored.exitCode, resultText(statusRestored)).toBe(0);
    expect(statusRestored.stdout).toContain("Shields: UP (lockdown active)");

    progress.phase("re-seal a perms-only .config-hash drift instead of failing closed");
    // #7985/#4663: an in-sandbox privileged reconciler (OpenClaw gateway / doctor
    // perm-normalization) can re-permission .config-hash back to group-writable
    // AFTER the lock without touching its bytes. That perms-only drift must be
    // re-sealed by the drift-repair `shields up`, not fail closed with
    // "restart seal requires the exact shields-locked file posture" (which
    // stranded host state UNLOCKED while the tree stayed root-locked). The bytes
    // are untouched here, so it is a launderable perms drift, not content drift.
    const permsDrift = await runtimeCommand(
      host,
      [
        "container",
        "exec",
        "--user",
        "0",
        containerId,
        "sh",
        "-c",
        `chattr -i ${CONFIG_HASH_PATH} 2>/dev/null || true; chmod 660 ${CONFIG_HASH_PATH} && chown sandbox:sandbox ${CONFIG_HASH_PATH}`,
      ],
      {
        artifactName: "phase-5c-config-hash-perms-only-drift",
        timeoutMs: 30_000,
      },
    );
    expect(permsDrift.exitCode, resultText(permsDrift)).toBe(0);

    const hashDrifted = await statPath(
      sandbox,
      CONFIG_HASH_PATH,
      "phase-5c-hash-perms-after-drift",
    );
    expect(hashDrifted).toMatchObject({ mode: "660", owner: "sandbox:sandbox" });

    // The drift-repair relock reaches the OpenClaw config guard's already-locked
    // branch. The fix re-seals the perms-only drift; before it, the guard
    // rejected with config-not-locked and the relock could never re-apply.
    const reseal = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
      artifactName: "phase-5c-shields-up-reseals-perms-drift",
    });
    expect(reseal.exitCode, resultText(reseal)).toBe(0);
    // The guard surfaces the self-heal so a relock/rebuild does not fix a
    // perms-only drift invisibly (#4663 / #7985 observability).
    expect(resultText(reseal)).toContain("Re-sealed a perms-only config-lock drift");

    const hashResealed = await statPath(
      sandbox,
      CONFIG_HASH_PATH,
      "phase-5c-hash-perms-after-reseal",
    );
    expect(hashResealed).toMatchObject({ mode: "444", owner: "root:root" });

    const statusResealed = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-5c-shields-status-after-reseal",
    });
    expect(statusResealed.exitCode, resultText(statusResealed)).toBe(0);
    expect(statusResealed.stdout).toContain("Shields: UP (lockdown active)");

    progress.phase("unlock shields and inspect the audit trail");
    const shieldsDown = await runNemoclaw(
      host,
      [
        SANDBOX_NAME,
        "shields",
        "down",
        "--timeout",
        "15m",
        "--reason",
        "E2E shields lifecycle test",
      ],
      { artifactName: "phase-6-shields-down" },
    );
    expect(shieldsDown.exitCode, resultText(shieldsDown)).toBe(0);
    expect(resultText(shieldsDown)).toContain("Config unlocked");

    const configDown = await statPath(sandbox, CONFIG_PATH, "phase-6-config-perms-down");
    expect(configDown.mode).toBe("660");
    expect(configDown.owner).toBe("sandbox:sandbox");
    const dirDown = await statPath(sandbox, CONFIG_DIR, "phase-6-config-dir-perms-down");
    expect(dirDown.mode).toBe("2770");
    expect(dirDown.owner).toBe("sandbox:sandbox");
    const workspaceDown = await sandboxShell(
      sandbox,
      "touch /sandbox/.openclaw/workspace/.shields-down-probe 2>&1 && rm -f /sandbox/.openclaw/workspace/.shields-down-probe && echo WRITABLE || echo BLOCKED",
      { artifactName: "phase-6-workspace-write-restored" },
    );
    expect(resultText(workspaceDown)).toContain("WRITABLE");

    const statusDown = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-7-shields-status-down",
    });
    expect(statusDown.exitCode, resultText(statusDown)).toBe(0);
    expect(statusDown.stdout).toContain("Shields: DOWN");
    expect(statusDown.stdout).toContain("E2E shields lifecycle test");
    expect(statusDown.stdout).toMatch(/Auto-lockdown in:|remaining/i);

    progress.phase("restart OpenClaw with shields down");
    await expectStopStartRecovery(host, sandbox, "DOWN", "phase-7a-shields-down-start-recovery", [
      apiKey,
    ]);
    const configAfterMutableRestart = await statPath(
      sandbox,
      CONFIG_PATH,
      "phase-7a-config-after-shields-down-start-recovery",
    );
    expect(configAfterMutableRestart).toMatchObject({
      mode: "660",
      owner: "sandbox:sandbox",
    });

    const restoreUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
      artifactName: "phase-7-restore-shields-up",
    });
    expect(restoreUp.exitCode, resultText(restoreUp)).toBe(0);

    expect(fs.existsSync(AUDIT_FILE), `${AUDIT_FILE} should exist`).toBe(true);
    const auditText = fs.readFileSync(AUDIT_FILE, "utf8");
    const auditEntries = readAuditEntries();
    const upCount = auditText.split('"shields_up"').length - 1;
    const downCount = auditText.split('"shields_down"').length - 1;
    expect(upCount).toBeGreaterThanOrEqual(2);
    expect(downCount).toBeGreaterThanOrEqual(1);
    expect(auditText).not.toMatch(/nvapi-|sk-|Bearer /);
    await artifacts.writeJson("phase-8-audit-summary.json", {
      entries: auditEntries.length,
      upCount,
      downCount,
    });

    progress.phase("recover shields after a dead restore timer");
    const timerDown = await runNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "down", "--timeout", "60s", "--reason", "Auto-restore timer E2E"],
      { artifactName: "phase-9-shields-down-timer" },
    );
    expect(timerDown.exitCode, resultText(timerDown)).toBe(0);
    const timerHostPolicyEdit = await sandbox.openshell(
      [
        "policy",
        "update",
        SANDBOX_NAME,
        "--add-endpoint",
        "timer-host-edit.example.com:443:read-only:rest:enforce",
        "--rule-name",
        "timer_host_edit_e2e",
        "--binary",
        "/usr/bin/curl",
        "--wait",
      ],
      {
        artifactName: "phase-9-timer-host-policy-edit",
        env: commandEnv(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      },
    );
    expect(timerHostPolicyEdit.exitCode, resultText(timerHostPolicyEdit)).toBe(0);
    const timerMarker = readTimerMarker(SANDBOX_NAME);
    process.kill(timerMarker.pid, "SIGKILL");
    const statusTimer = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-9-status-after-dead-timer",
    });
    expect(statusTimer.exitCode, resultText(statusTimer)).toBe(0);

    let lastTimerStatus = resultText(statusTimer);
    expect(statusTimer.stdout).toMatch(/Shields: (?:UP|DOWN)/);
    let restored = statusTimer.stdout.includes("Shields: UP");

    const deadline = Date.now() + TIMER_POLL_TIMEOUT_MS;
    for (let attempt = 1; !restored && Date.now() < deadline; attempt += 1) {
      const waitForRestoreAt = Math.max(0, new Date(timerMarker.restoreAt).getTime() - Date.now());
      await delay(Math.max(TIMER_POLL_INTERVAL_MS, waitForRestoreAt + 1_000));
      const poll = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
        artifactName: `phase-9-status-dead-timer-inline-restore-poll-${attempt}`,
      });
      lastTimerStatus = resultText(poll);
      if (lastTimerStatus.includes("Shields: UP")) {
        restored = true;
        break;
      }
    }
    expect(restored, lastTimerStatus).toBe(true);
    const dirTimer = await statPath(
      sandbox,
      CONFIG_DIR,
      "phase-9-config-dir-perms-after-dead-timer-inline-restore",
    );
    expect(dirTimer).toMatchObject({ mode: "755", owner: "root:root" });
    const configTimer = await statPath(
      sandbox,
      CONFIG_PATH,
      "phase-9-config-perms-after-dead-timer-inline-restore",
    );
    expect(configTimer).toMatchObject({ mode: "444", owner: "root:root" });
    const hashTimer = await statPath(
      sandbox,
      CONFIG_HASH_PATH,
      "phase-9-config-hash-perms-after-dead-timer-inline-restore",
    );
    expect(hashTimer).toMatchObject({ mode: "444", owner: "root:root" });
    const stateAfterTimer = JSON.parse(fs.readFileSync(STATE_FILE(SANDBOX_NAME), "utf8"));
    expect(stateAfterTimer.fileHashes).toMatchObject({
      [CONFIG_PATH]: expect.any(String),
      [CONFIG_HASH_PATH]: expect.any(String),
    });
    const policyAfterTimerRestore = await sandbox.openshell(
      ["policy", "get", "--full", SANDBOX_NAME],
      {
        artifactName: "phase-9-policy-after-timer-restore",
        env: commandEnv(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      },
    );
    expect(policyAfterTimerRestore.exitCode, resultText(policyAfterTimerRestore)).toBe(0);
    expect(policyAfterTimerRestore.stdout).toContain("interactive_host_edit_e2e");
    expect(policyAfterTimerRestore.stdout).toContain("timer_host_edit_e2e");
    expect(readAuditEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "shields_auto_restore",
          policy_snapshot: timerMarker.snapshotPath,
        }),
      ]),
    );

    progress.phase("reject duplicate shields transitions");
    const doubleUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
      artifactName: "phase-10-double-shields-up",
    });
    expect(doubleUp.exitCode, resultText(doubleUp)).toBe(0);
    expect(resultText(doubleUp)).toContain("already active");

    const cleanupDown = await runNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "down", "--timeout", "5m", "--reason", "Cleanup"],
      { artifactName: "phase-10-cleanup-shields-down" },
    );
    expect(cleanupDown.exitCode, resultText(cleanupDown)).toBe(0);

    const doubleDown = await runNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "down", "--timeout", "5m", "--reason", "Should fail"],
      { artifactName: "phase-11-double-shields-down" },
    );
    expect(doubleDown.exitCode, resultText(doubleDown)).not.toBe(0);
    expect(resultText(doubleDown)).toContain("already unlocked");

    // The duplicate-down assertion deliberately leaves its first timer active;
    // restore the target's normal locked posture before generic destruction.
    const finalUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
      artifactName: "phase-11-restore-shields-up",
    });
    expect(finalUp.exitCode, resultText(finalUp)).toBe(0);
    expect(resultText(finalUp)).toContain("Lockdown active");

    progress.phase(
      "prove installed failed-startup guard refuses a live child and supported shields down unlocks childless state",
    );
    const recoveryContainerId = await findSandboxContainer(host);
    const removeMarkers = await runtimeCommand(
      host,
      ["exec", "--user", "0", recoveryContainerId, "rm", "-f", ...STARTUP_MARKER_PATHS],
      { artifactName: "phase-12-remove-startup-markers", timeoutMs: 30_000 },
    );
    expect(removeMarkers.exitCode, resultText(removeMarkers)).toBe(0);

    const liveCensus = await installedStartupCensus(
      host,
      recoveryContainerId,
      "phase-12-live-startup-census",
    );
    expect(liveCensus).toMatchObject({ count: 1, pid: expect.any(Number) });
    expect(liveCensus.pid).not.toBeNull();
    // OpenShell's supervised non-root compatibility path legitimately permits
    // ordinary Shields changes while its startup child is healthy. Exercise the
    // failed-startup admission boundary through the installed guard, then prove
    // the supported host command owns the terminal childless recovery below.
    const liveChildRefusal = await runInstalledFailedStartupUnlock(
      host,
      recoveryContainerId,
      "phase-12-live-child-refusal",
    );
    expect(liveChildRefusal.exitCode, resultText(liveChildRefusal)).not.toBe(0);
    expect(resultText(liveChildRefusal)).toContain('"code": "startup-not-ready"');
    expect(await statPath(sandbox, CONFIG_PATH, "phase-12-config-still-locked")).toMatchObject({
      mode: "444",
      owner: "root:root",
    });

    // A running OpenShell PID 1 can restart its child while the recovery guard
    // scans procfs, but pausing PID 1 before `policy set --wait` also prevents
    // OpenShell from acknowledging the policy version. A one-shot executable
    // shim delegates the real policy update first, then pauses the supervisor
    // and removes the exact live child before the public command reaches its
    // guarded config transition.
    let supervisorPaused = false;
    const processControl = failedStartupProcessControlCommands(
      recoveryContainerId,
      liveCensus.pid ?? 0,
    );
    cleanup.trackDisposable(`resume stopped supervisor for ${SANDBOX_NAME}`, async () => {
      await resumeSupervisorIfPaused(supervisorPaused, async () => {
        const resume = await runtimeCommand(host, processControl.resumeSupervisor, {
          artifactName: "cleanup-phase-12-resume-startup-supervisor",
          timeoutMs: 30_000,
        });
        expect(resume.exitCode, resultText(resume)).toBe(0);
      });
    });
    const openshellResolution = await host.command(
      "bash",
      ["-lc", 'command -v "$1"', "resolve-openshell", host.openshellCommandPath],
      {
        artifactName: "phase-12-resolve-openshell",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(openshellResolution.exitCode, resultText(openshellResolution)).toBe(0);
    const realOpenshellPath = openshellResolution.stdout.trim();
    expect(path.isAbsolute(realOpenshellPath), realOpenshellPath).toBe(true);
    const policyBoundary = createPolicySetChildlessBoundaryShim(
      host,
      realOpenshellPath,
      recoveryContainerId,
      liveCensus.pid ?? 0,
    );
    cleanup.trackDisposable("remove phase-12 OpenShell boundary shim", () => {
      fs.rmSync(policyBoundary.directory, { force: true, recursive: true });
    });

    // The shim may have paused PID 1 even if a later assertion fails. Arm the
    // cleanup before starting the public transition; SIGCONT is harmless if the
    // policy command fails before the shim reaches the test boundary.
    supervisorPaused = true;
    const childlessRecovery = await runNemoclaw(
      host,
      [
        SANDBOX_NAME,
        "shields",
        "down",
        "--timeout",
        "5m",
        "--reason",
        "Supported failed-startup recovery E2E",
      ],
      {
        artifactName: "phase-12-childless-shields-down",
        env: commandEnv({ NEMOCLAW_OPENSHELL_BIN: policyBoundary.executable }),
        timeoutMs: 16 * 60_000,
      },
    );
    expect(childlessRecovery.exitCode, resultText(childlessRecovery)).toBe(0);
    expect(resultText(childlessRecovery)).toContain(
      "Lowered shields on a sandbox whose startup never completed.",
    );
    expect(resultText(childlessRecovery)).toContain("Sandbox is in default (mutable) state.");
    expect(JSON.parse(fs.readFileSync(policyBoundary.receipt, "utf8"))).toEqual({
      status: "childless",
    });
    await waitForChildlessStartup(host, recoveryContainerId);
    const unlockedPaths = await runtimeCommand(
      host,
      [
        "exec",
        "--user",
        "0",
        recoveryContainerId,
        "stat",
        "-c",
        "%a %U:%G",
        CONFIG_PATH,
        `${CONFIG_DIR}/workspace`,
      ],
      { artifactName: "phase-12-unlocked-paths", timeoutMs: 30_000 },
    );
    expect(unlockedPaths.exitCode, resultText(unlockedPaths)).toBe(0);
    expect(unlockedPaths.stdout.trim().split(/\r?\n/).map(parseModeOwner)).toEqual([
      { mode: "660", owner: "sandbox:sandbox" },
      { mode: "2770", owner: "sandbox:sandbox" },
    ]);

    const resumeSupervisor = await runtimeCommand(host, processControl.resumeSupervisor, {
      artifactName: "phase-12-resume-startup-supervisor",
      timeoutMs: 30_000,
    });
    expect(resumeSupervisor.exitCode, resultText(resumeSupervisor)).toBe(0);
    supervisorPaused = false;

    // The supported host command owns only this bounded Shields transition.
    // Resume after it commits the mutable posture, then
    // prove ordinary stop/start recovery remains available before relocking.
    await expectStopStartRecovery(host, sandbox, "DOWN", "phase-12-restart-after-recovery", [
      apiKey,
    ]);
    const relockAfterRecovery = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
      artifactName: "phase-12-relock-after-recovery",
    });
    expect(relockAfterRecovery.exitCode, resultText(relockAfterRecovery)).toBe(0);
    expect(resultText(relockAfterRecovery)).toContain("Lockdown active");

    progress.phase("record shields contract evidence");
    await artifacts.target.complete({
      id: "shields-config",
      sandboxName: SANDBOX_NAME,
      assertions: {
        install: true,
        mutableDefault: true,
        documentedExecDoctorPreservesGatewayWrites: true,
        shieldsUpLock: true,
        configGetRedaction: true,
        contentDriftDetection: true,
        permsOnlyDriftReseal: true,
        shieldsDownMutableRestore: true,
        auditTrail: true,
        deadTimerInlineAutoRestore: true,
        doubleOperationRejection: true,
        installedFailedStartupLiveChildRefusal: true,
        supportedShieldsDownChildlessRecovery: true,
        inheritedMutationLockAcceptedByStateGuard: true,
      },
    });
  },
);
