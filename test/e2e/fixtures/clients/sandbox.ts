// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as importedSandboxNameContract from "../../../../nemoclaw/src/shared/sandbox-name.cts";
import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { trustedShellCommand } from "../shell-probe.ts";
import {
  artifactLabel,
  assertExitZero,
  type CommandRunner,
  outputContainsSandbox,
  resultText,
} from "./command.ts";

const sandboxNameContract = (
  "default" in importedSandboxNameContract && importedSandboxNameContract.default
    ? importedSandboxNameContract.default
    : importedSandboxNameContract
) as typeof import("../../../../nemoclaw/src/shared/sandbox-name.cts");
const { diagnosticPreview, isValidName, NAME_ALLOWED_FORMAT } = sandboxNameContract;

const SANDBOX_ALREADY_ABSENT =
  /\bNotFound\b|\bNot Found\b|sandbox[^\n]*(?:not found|not present|does not exist)|no such sandbox/i;
const INITIAL_OPENCLAW_PAIRING_TIMEOUT_MS = 60_000;
const OPENCLAW_STATE_DIR = "/sandbox/.openclaw";

// argv: deadline ms, state dir. Exit 0 once the local CLI device is paired; exit 1 at the deadline.
const WAIT_FOR_INITIAL_OPENCLAW_PAIRING_PROGRAM = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const deadline = Date.now() + Number(process.argv[1]);
const stateDir = process.argv[2];
function wait() {
  try {
    const identity = JSON.parse(fs.readFileSync(path.join(stateDir, "identity/device.json"), "utf8"));
    const auth = JSON.parse(fs.readFileSync(path.join(stateDir, "identity/device-auth.json"), "utf8"));
    const paired = Object.values(JSON.parse(fs.readFileSync(path.join(stateDir, "devices/paired.json"), "utf8")));
    if (paired.some((device) => device?.deviceId === identity.deviceId && device.clientId === "cli" && device.clientMode === "cli" && device.tokens?.operator?.token && device.tokens.operator.token === auth.tokens?.operator?.token)) process.exit(0);
  } catch {}
  if (Date.now() >= deadline) process.exit(1);
  setTimeout(wait, 250);
}
wait();
`;

/**
 * Default env for openshell-targeted spawns. ShellProbe filters env via
 * the framework allowlist (HOME, PATH, …) which excludes OPENSHELL_GATEWAY,
 * so raw `openshell sandbox exec` invocations would fail with
 * "× No active gateway" even when the workflow sets the env var. Inject
 * it explicitly from the test process's env (defaulting to the canonical
 * `nemoclaw` gateway registered by
 * src/lib/actions/sandbox/connect.ts:NEMOCLAW_GATEWAY_NAME).
 */
function openshellProbeEnv(): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

export function sandboxAccessEnv(): NodeJS.ProcessEnv {
  return openshellProbeEnv();
}

export interface SandboxClientOptions {
  openshellPath?: string;
}

declare const trustedSandboxShellScriptBrand: unique symbol;

export type TrustedSandboxShellScript = string & {
  readonly [trustedSandboxShellScriptBrand]: true;
};

export function trustedSandboxShellScript(script: string): TrustedSandboxShellScript {
  if (script.length === 0) {
    throw new Error("sandbox shell script must not be empty");
  }
  if (script.includes("\0")) {
    throw new Error("sandbox shell script must contain no NUL bytes");
  }
  return script as TrustedSandboxShellScript;
}

export class SandboxClient {
  private readonly runner: CommandRunner;
  private readonly openshellPath: string;

  constructor(runner: CommandRunner, options: SandboxClientOptions = {}) {
    this.runner = runner;
    this.openshellPath = options.openshellPath ?? process.env.OPENSHELL_BIN ?? "openshell";
  }

  openshell(args: string[] = [], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.runner.run(
      trustedShellCommand({
        command: this.openshellPath,
        args,
        reason: "run OpenShell sandbox command",
      }),
      {
        artifactName: `openshell-${artifactLabel(args.join("-") || "default")}`,
        ...options,
      },
    );
  }

  list(options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.openshell(["sandbox", "list"], {
      artifactName: "sandbox-list",
      ...options,
    });
  }

  status(name: string, options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    validateSandboxName(name);
    return this.openshell(["sandbox", "status", "--name", name], {
      artifactName: `sandbox-status-${name}`,
      ...options,
    });
  }

  async cleanupSandbox(name: string, options: ShellProbeRunOptions = {}): Promise<void> {
    validateSandboxName(name);
    const result = await this.openshell(["sandbox", "delete", name], {
      artifactName: `cleanup-openshell-sandbox-${name}`,
      ...options,
    });
    if (result.exitCode === 0 || SANDBOX_ALREADY_ABSENT.test(resultText(result))) return;
    assertExitZero(result, `cleanup OpenShell sandbox ${name}`);
  }

  exec(
    name: string,
    command: string[],
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    validateSandboxName(name);
    return this.openshell(["sandbox", "exec", "-n", name, "--", ...command], {
      artifactName: `sandbox-exec-${name}`,
      ...options,
    });
  }

  async waitForInitialOpenClawPairing(
    name: string,
    options: ShellProbeRunOptions = {},
  ): Promise<void> {
    const result = await this.exec(
      name,
      [
        "node",
        "-e",
        WAIT_FOR_INITIAL_OPENCLAW_PAIRING_PROGRAM,
        String(INITIAL_OPENCLAW_PAIRING_TIMEOUT_MS),
        OPENCLAW_STATE_DIR,
      ],
      {
        artifactName: "wait-for-initial-openclaw-pairing",
        ...options,
        timeoutMs: INITIAL_OPENCLAW_PAIRING_TIMEOUT_MS + 10_000,
      },
    );
    assertExitZero(result, `wait for initial OpenClaw CLI pairing in ${name}`);
  }

  execShell(
    name: string,
    script: TrustedSandboxShellScript,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    validateSandboxName(name);
    return this.openshell(["sandbox", "exec", "-n", name, "--", "sh", "-lc", script], {
      artifactName: `sandbox-exec-shell-${name}`,
      ...options,
    });
  }

  upload(
    name: string,
    localPath: string,
    remotePath: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    validateSandboxName(name);
    validateUploadPath("local", localPath);
    validateUploadPath("remote", remotePath);
    return this.openshell(["sandbox", "upload", name, localPath, remotePath], {
      artifactName: `sandbox-upload-${name}`,
      ...options,
    });
  }

  async expectRunning(name: string, options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    const result = await this.status(name, options);
    assertExitZero(result, `openshell sandbox status ${name}`);
    return result;
  }

  async expectListed(name: string, options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    validateSandboxName(name);
    const result = await this.list({ env: openshellProbeEnv(), ...options });
    assertExitZero(result, "openshell sandbox list");
    if (!outputContainsSandbox(result, name)) {
      throw new Error(`openshell sandbox list did not include '${name}'.`);
    }
    return result;
  }

  /**
   * Disruption helper: simulate the post-pod-recreate /tmp wipe by removing
   * the guard chain files. After this, a sandbox containing a running gateway
   * is in the same shape as a fresh container that would only see /tmp
   * recreated empty by the OpenShell sandbox controller.
   *
   * Used exclusively by recovery E2E targets (#2701). Removes:
   *   - /tmp/nemoclaw-proxy-env.sh (the NODE_OPTIONS chain export file)
   *   - the five --require preload guard scripts written by the entrypoint
   */
  async wipeGuardChain(
    name: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    validateSandboxName(name);
    const removeCommand = [
      "rm",
      "-f",
      "/tmp/nemoclaw-proxy-env.sh",
      "/tmp/nemoclaw-sandbox-safety-net.js",
      "/tmp/nemoclaw-ciao-network-guard.js",
      "/tmp/nemoclaw-slack-channel-guard.js",
      "/tmp/nemoclaw-http-proxy-fix.js",
      "/tmp/nemoclaw-nemotron-inference-fix.js",
    ];
    const result = await this.exec(name, removeCommand, {
      artifactName: `sandbox-wipe-guard-chain-${name}`,
      env: openshellProbeEnv(),
      ...options,
    });
    assertExitZero(result, `wipe guard chain in ${name}`);
    return result;
  }

  /**
   * Disruption helper: kill the observed OpenClaw process tree inside the
   * sandbox. Used after `wipeGuardChain` to force the managed watchdog or
   * recovery path to relaunch from scratch.
   *
   * The bracket pattern `[o]penclaw` is the standard pgrep/pkill trick to
   * avoid matching the matcher process itself.
   *
   * Used exclusively by recovery E2E targets (#2701).
   */
  async killGatewayTree(
    name: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    validateSandboxName(name);
    // Require an initial gateway process, then kill it. Do not assert that the
    // process stays absent: PID 1 is expected to respawn the gateway, and the
    // live scenario verifies the replacement PID and restored guard chain.
    const script = "pkill -9 -f '[o]penclaw'";
    const result = await this.exec(name, ["sh", "-c", script], {
      artifactName: `sandbox-kill-gateway-tree-${name}`,
      env: openshellProbeEnv(),
      ...options,
    });
    assertExitZero(result, `kill gateway tree in ${name}`);
    return result;
  }
}

export function validateSandboxName(name: string): void {
  if (!isValidName(name)) {
    throw new Error(
      `sandbox name is invalid for fixture client: ${diagnosticPreview(name)}. Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }
}

function validateUploadPath(label: string, filePath: string): void {
  if (filePath.length === 0 || filePath.startsWith("-") || filePath.includes("\0")) {
    throw new Error(`sandbox upload ${label} path is invalid for fixture client: ${filePath}`);
  }
}
