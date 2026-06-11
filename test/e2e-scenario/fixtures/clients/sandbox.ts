// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { trustedShellCommand } from "../shell-probe.ts";
import { artifactLabel, assertExitZero, type CommandRunner } from "./command.ts";

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
    return this.openshell(["sandbox", "list"], { artifactName: "sandbox-list", ...options });
  }

  status(name: string, options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    validateSandboxName(name);
    return this.openshell(["sandbox", "status", "--name", name], {
      artifactName: `sandbox-status-${name}`,
      ...options,
    });
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

  /**
   * Disruption helper: simulate the post-pod-recreate /tmp wipe by removing
   * the guard chain files. After this, a sandbox containing a running gateway
   * is in the same shape as a fresh container that would only see /tmp
   * recreated empty by the OpenShell sandbox controller.
   *
   * Used exclusively by recovery E2E scenarios (#2701). Removes:
   *   - /tmp/nemoclaw-proxy-env.sh (the NODE_OPTIONS chain export file)
   *   - the seven --require preload guard scripts written by the entrypoint
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
      "/tmp/nemoclaw-ws-proxy-fix.js",
      "/tmp/nemoclaw-nemotron-inference-fix.js",
      "/tmp/nemoclaw-seccomp-guard.js",
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
   * Disruption helper: kill the entire openclaw process tree inside the
   * sandbox (gateway + launcher + supervisor watchdog). Used after
   * `wipeGuardChain` to force the recovery path to relaunch from scratch.
   *
   * The bracket pattern `[o]penclaw` is the standard pgrep/pkill trick to
   * avoid matching the matcher process itself.
   *
   * Used exclusively by recovery E2E scenarios (#2701).
   */
  async killGatewayTree(
    name: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    validateSandboxName(name);
    // Two-phase kill: SIGKILL the tree, sleep, then verify nothing came back.
    // Mirrors the bash test's pkill -9 + verify pattern.
    const script =
      "pkill -9 -f '[o]penclaw' 2>/dev/null || true; " +
      "sleep 2; " +
      "pgrep -af '[o]penclaw' >/dev/null 2>&1 && exit 1 || exit 0";
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
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`sandbox name is invalid for fixture client: ${name}`);
  }
}

function validateUploadPath(label: string, filePath: string): void {
  if (filePath.length === 0 || filePath.startsWith("-") || filePath.includes("\0")) {
    throw new Error(`sandbox upload ${label} path is invalid for fixture client: ${filePath}`);
  }
}
