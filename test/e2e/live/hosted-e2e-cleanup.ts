// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

/** A failed or malformed list cannot establish resource absence. */
export function sandboxAbsentFromList(result: ShellProbeResult, name: string): boolean {
  if (result.exitCode !== 0 || result.timedOut || result.signal !== null) return false;
  try {
    const entries: unknown = JSON.parse(result.stdout);
    return (
      Array.isArray(entries) &&
      entries.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof entry.name === "string" &&
          entry.name !== name,
      )
    );
  } catch {
    return false;
  }
}

/** Attempt every owned cleanup even when an earlier operation fails. */
export async function cleanupBootstrapState(input: {
  host: HostCliClient;
  sandbox: SandboxClient;
  name: string;
  cloneDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { host, sandbox, name, cloneDir, env } = input;
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  const available = async (command: string) => {
    const result = await host.command("sh", ["-c", 'command -v "$1"', "sh", command], {
      env,
      artifactName: `cleanup-bootstrap-${command}-available`,
      timeoutMs: 30_000,
    });
    // Shells report a missing command with either status; diagnostics remain failures.
    if (
      (result.exitCode === 1 || result.exitCode === 127) &&
      !result.timedOut &&
      result.signal === null &&
      !result.stdout.trim() &&
      !result.stderr.trim()
    )
      return false;
    assertExitZero(result, `inspect ${command} availability`);
    return true;
  };
  await attempt(async () => {
    if (!(await available("nemoclaw"))) return;
    const result = await host.command(
      "nemoclaw",
      [name, "destroy", "--yes", "--no-cleanup-gateway"],
      {
        env,
        artifactName: "cleanup-bootstrap-destroy",
        timeoutMs: 120_000,
      },
    );
    if (
      result.exitCode !== 0 &&
      !result.timedOut &&
      result.signal === null &&
      /Sandbox '.+' does not exist|sandbox[^\n]*(?:not found|not present)|no such sandbox/iu.test(
        resultText(result),
      )
    )
      return;
    assertExitZero(result, "destroy bootstrap sandbox");
  });
  await attempt(async () => {
    if (!(await available("openshell"))) return;
    if (await sandbox.hasGatewayForInitialCleanup("nemoclaw", { env, timeoutMs: 30_000 })) {
      await sandbox.cleanupSandbox(name, {
        env,
        artifactName: "cleanup-bootstrap-delete",
        timeoutMs: 60_000,
      });
    }
  });
  await attempt(async () => {
    if (!(await available("openshell"))) return;
    await host.cleanupGatewayRegistration("nemoclaw", {
      env,
      artifactName: "cleanup-bootstrap-gateway",
      timeoutMs: 60_000,
    });
  });
  await attempt(async () => {
    const result = await host.command(
      "bash",
      [
        "-c",
        'if ! sudo -n rm -rf -- "$1"; then rm -rf -- "$1" || exit; fi; test ! -e "$1" && test ! -L "$1"',
        "bash",
        cloneDir,
      ],
      { env, artifactName: "cleanup-bootstrap-clone", timeoutMs: 60_000 },
    );
    assertExitZero(result, "remove bootstrap clone");
  });
  if (failures.length)
    throw new AggregateError(failures, "Bootstrap cleanup failed; see cleanup artifacts");
}
