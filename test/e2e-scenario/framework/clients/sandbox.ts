// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { trustedShellCommand } from "../shell-probe.ts";
import { artifactLabel, assertExitZero, type CommandRunner } from "./command.ts";

export interface SandboxClientOptions {
  openshellPath?: string;
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
    return this.openshell(["sandbox", "status", name], {
      artifactName: `sandbox-status-${name}`,
      ...options,
    });
  }

  // openshell `sandbox exec` requires the sandbox name as a `-n <name>`
  // flag value, NOT a positional argument. Production code (src/lib/agent/
  // onboard.ts, src/lib/onboard/initial-policy.ts, src/lib/onboard/web-search-
  // verify.ts, ...) uniformly uses the `-n` short form; the legacy bash tests
  // and the existing test/openclaw-tui-chat-correlation.test.ts use the
  // equivalent `--name` long form. Passing the name positionally returns
  // exit 127 (openshell argument-parse failure surfacing as command-not-
  // found) — silently latent until a free-standing live test invoked
  // `sandbox.exec` against a real sandbox, since the registry-driven matrix
  // mostly skips and the one cloud-openclaw scenario that ran did not
  // exercise this code path.
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

  // Convenience wrapper for running a multi-line bash script in a sandbox.
  // Equivalent to `openshell sandbox exec -n <name> -- sh -lc "<script>"`.
  // Used by free-standing live tests that need to run bespoke shell pipelines
  // (e.g. starting an in-sandbox gateway, reading config files via node -e)
  // without manually wiring `["sh", "-lc", script]` argv at every call site.
  execShell(
    name: string,
    script: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    validateSandboxName(name);
    return this.openshell(["sandbox", "exec", "-n", name, "--", "sh", "-lc", script], {
      artifactName: `sandbox-exec-shell-${name}`,
      ...options,
    });
  }

  // Uploads a host-side file into the sandbox at the given remote path.
  // Wraps `openshell sandbox upload <name> <localPath> <remotePath>`.
  upload(
    name: string,
    localPath: string,
    remotePath: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    validateSandboxName(name);
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
}

export function validateSandboxName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`sandbox name is invalid for fixture client: ${name}`);
  }
}
