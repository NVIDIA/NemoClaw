// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

export interface HostClientOptions {
  cliPath?: string;
  cwd?: string;
}

const GATEWAY_ALREADY_ABSENT =
  /gateway[^\n]*(?:does not exist|not found)|No (?:active )?gateway|No gateway metadata found/i;
const GATEWAY_REMOVE_UNSUPPORTED =
  /unrecognized subcommand ['"]remove['"]|unknown command ['"]remove['"]/i;

export class HostCliClient {
  private readonly runner: CommandRunner;
  private readonly cliPath: string;
  private readonly cwd?: string;

  constructor(runner: CommandRunner, options: HostClientOptions = {}) {
    this.runner = runner;
    this.cliPath = options.cliPath ?? process.env.NEMOCLAW_CLI_BIN ?? "nemoclaw";
    this.cwd = options.cwd;
  }

  get commandPath(): string {
    return this.cliPath;
  }

  command(
    command: string,
    args: string[] = [],
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    const merged: ShellProbeRunOptions = { ...options };
    if (this.cwd && !merged.cwd) {
      merged.cwd = this.cwd;
    }
    return this.runner.run(
      trustedShellCommand({
        command,
        args,
        reason: `run host command ${command}`,
      }),
      merged,
    );
  }

  nemoclaw(args: string[] = [], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.command(this.cliPath, args, {
      artifactName: `nemoclaw-${artifactLabel(args.join("-") || "default")}`,
      ...options,
    });
  }

  async expectNemoclawAvailable(): Promise<ShellProbeResult> {
    const result = await this.nemoclaw(["--version"], {
      artifactName: "nemoclaw-version",
      env: buildAvailabilityProbeEnv(),
    });
    assertExitZero(result, "nemoclaw --version");
    return result;
  }

  async expectListed(
    sandboxName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    const result = await this.nemoclaw(["list"], {
      artifactName: `nemoclaw-list-${artifactLabel(sandboxName)}`,
      env: buildAvailabilityProbeEnv(),
      ...options,
    });
    assertExitZero(result, "nemoclaw list");
    if (!outputContainsSandbox(result, sandboxName)) {
      throw new Error(`nemoclaw list did not include '${sandboxName}': ${resultText(result)}`);
    }
    return result;
  }

  async expectStatus(
    sandboxName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    const result = await this.nemoclaw([sandboxName, "status"], {
      artifactName: `nemoclaw-status-${artifactLabel(sandboxName)}`,
      env: buildAvailabilityProbeEnv(),
      ...options,
    });
    assertExitZero(result, `nemoclaw ${sandboxName} status`);
    return result;
  }

  async destroySandbox(
    sandboxName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    return await this.nemoclaw([sandboxName, "destroy", "--yes"], {
      artifactName: `destroy-sandbox-${artifactLabel(sandboxName)}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 15 * 60_000,
      ...options,
    });
  }

  async cleanupSandbox(sandboxName: string, options: ShellProbeRunOptions = {}): Promise<void> {
    const result = await this.destroySandbox(sandboxName, options);
    if (result.exitCode === 0) return;
    const text = resultText(result);
    if (
      /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/i.test(
        text,
      )
    ) {
      return;
    }
    assertExitZero(result, `cleanup destroy sandbox ${sandboxName}`);
  }

  async cleanupGatewayRegistration(
    gatewayName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<void> {
    const artifactName = options.artifactName ?? `cleanup-gateway-${artifactLabel(gatewayName)}`;
    const remove = await this.command("openshell", ["gateway", "remove", gatewayName], {
      ...options,
      artifactName: `${artifactName}-remove`,
    });
    if (remove.exitCode === 0 || GATEWAY_ALREADY_ABSENT.test(resultText(remove))) return;
    if (!GATEWAY_REMOVE_UNSUPPORTED.test(resultText(remove))) {
      assertExitZero(remove, `cleanup gateway registration ${gatewayName}`);
    }

    // Remove this fallback once the supported OpenShell floor no longer
    // includes builds whose local-registration verb was `gateway destroy`.
    const destroy = await this.command("openshell", ["gateway", "destroy", "-g", gatewayName], {
      ...options,
      artifactName: `${artifactName}-legacy-destroy`,
    });
    if (destroy.exitCode === 0 || GATEWAY_ALREADY_ABSENT.test(resultText(destroy))) return;
    assertExitZero(destroy, `cleanup gateway registration ${gatewayName}`);
  }

  async bestEffortCleanupSandbox(
    sandboxName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<void> {
    try {
      await this.cleanupSandbox(sandboxName, options);
    } catch {
      // Best-effort cleanup must not mask the primary setup or assertion failure.
    }
  }
}
