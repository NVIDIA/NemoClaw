// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { ArtifactSink } from "./artifacts.ts";
import type { DockerCommandResult, DockerProbe } from "./docker-probe.ts";
import { type ShellProbe, trustedShellCommand } from "./shell-probe.ts";

const CORE_LIMIT = 256 * 1024 * 1024;
const IDENTITY_PREFIX = "NEMOCLAW_HERMES_CRASH_PROCESS=";

export function hermesCrashCaptureArgs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return env.NEMOCLAW_HERMES_CRASH_CAPTURE === "1" &&
    env.GITHUB_ACTIONS === "true" &&
    platform === "linux"
    ? [
        "--ulimit",
        `core=0:${CORE_LIMIT}`,
        "--env",
        "NEMOCLAW_HERMES_CRASH_CAPTURE=1",
        "--label",
        "io.nvidia.nemoclaw.hermes-crash-capture=1",
      ]
    : [];
}

function processIdentity(stdout: string): { pid: number; executable: string } {
  const line = stdout.split("\n").find((entry) => entry.startsWith(IDENTITY_PREFIX));
  const identity = JSON.parse(line?.slice(IDENTITY_PREFIX.length) ?? "null");
  if (
    !identity ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 1 ||
    identity.pid > 2147483647 ||
    typeof identity.executable !== "string" ||
    !/^\/[A-Za-z0-9_./-]+$/.test(identity.executable) ||
    identity.executable.split("/").includes("..")
  )
    throw new Error("Missing or unsafe crash process identity");
  return { pid: identity.pid, executable: identity.executable };
}

/** Diagnostic failure must never replace the package probe's original result. */
export async function captureHermesCrash(options: {
  docker: Pick<DockerProbe, "run">;
  shell: Pick<ShellProbe, "run">;
  artifacts: Pick<ArtifactSink, "writeJson">;
  container: string;
  result: DockerCommandResult;
}): Promise<void> {
  const { docker, shell, artifacts, container, result } = options;
  const report: Record<string, unknown> = {
    probeExitCode: result.exitCode,
    state: "not-a-core-signal",
  };
  let privateDirectory: string | undefined;
  try {
    if (result.exitCode !== 139 && result.exitCode !== 134) return;
    report.state = "capture-failed";
    if (!/^nemoclaw-hermes-root-clean-[A-Za-z0-9_.-]+$/.test(container))
      throw new Error("Invalid capture container");
    const identity = processIdentity(result.stdout);
    const inspect = await docker.run(
      ["inspect", "--format", "{{.State.Pid}} {{.Image}}", container],
      {
        artifactName: "crash-container-identity",
        timeoutMs: 30_000,
      },
    );
    const match = /^([1-9][0-9]{0,9}) (sha256:[a-f0-9]{64})$/.exec(inspect.stdout.trim());
    if (inspect.exitCode !== 0 || !match || Number(match[1]) <= 1 || Number(match[1]) > 2147483647)
      throw new Error("Invalid capture container identity");
    report.image = match[2];
    report.process = identity;
    // Never put process memory in the E2E artifact tree. The CI always-step also
    // removes this task-specific prefix if cancellation interrupts this finally.
    const runnerTemp = process.env.RUNNER_TEMP;
    if (!runnerTemp || !path.isAbsolute(runnerTemp) || !/^[A-Za-z0-9_./-]+$/.test(runnerTemp))
      throw new Error("Missing safe runner temporary directory");
    if (process.env.E2E_ARTIFACT_DIR) {
      const relative = path.relative(path.resolve(process.env.E2E_ARTIFACT_DIR), runnerTemp);
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        throw new Error("Core directory overlaps artifacts");
    }
    privateDirectory = fs.mkdtempSync(path.join(runnerTemp, "nemoclaw-hermes-crash-"));
    fs.chmodSync(privateDirectory, 0o700);
    const core = path.join(privateDirectory, "core");
    const copied = await docker.run(
      ["cp", `${container}:/tmp/nemoclaw-hermes-crash/core.${identity.pid}`, core],
      {
        artifactName: "copy-private-hermes-core",
        timeoutMs: 30_000,
      },
    );
    if (copied.exitCode !== 0) throw new Error("Core unavailable");
    const stat = fs.lstatSync(core);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 4 || stat.size > CORE_LIMIT)
      throw new Error("Unsafe core file");
    fs.chmodSync(core, 0o600);
    report.coreAtSizeLimit = stat.size === CORE_LIMIT;
    const root = `/proc/${match[1]}/root`;
    const commands = [
      `set sysroot ${root}`,
      `file ${root}${identity.executable}`,
      `core-file ${core}`,
      "set $hermes_fault_thread = $_thread",
      "bt 32",
      "p/x $pc",
      "x/i $pc",
      "info threads",
      "thread apply all bt 32",
      "info sharedlibrary",
      "info proc mappings",
      "info files",
      // ShellProbe retains the output tail. Repeat the fault block after verbose
      // metadata while retaining the initial block for an interrupted debugger.
      'eval "thread %d", $hermes_fault_thread',
      "frame 0",
      "bt 32",
      "p/x $pc",
      "x/i $pc",
    ];
    const debug = await shell.run(
      trustedShellCommand({
        command: "/usr/bin/sudo",
        args: [
          "-n",
          // The inner timeout runs as root so escalation can kill privileged GDB
          // before the runner-owned outer timeout terminates sudo.
          "/usr/bin/timeout",
          "--signal=TERM",
          "--kill-after=2s",
          "25s",
          "/usr/bin/gdb",
          "-nx",
          "-nh",
          "-batch",
          "-iex",
          "set auto-load off",
          "-iex",
          "set debuginfod enabled off",
          "-iex",
          "set print frame-arguments none",
          ...commands.flatMap((command) => ["-ex", command]),
        ],
        reason:
          "Read a bounded Hermes core with the live container's exact executable and libraries; never execute inferior code or load debugger scripts",
      }),
      {
        artifactName: "hermes-native-crash-stack",
        timeoutMs: 30_000,
        captureLimitBytes: 512 * 1024,
        cwd: privateDirectory,
        env: { PATH: "/usr/bin:/bin", HOME: privateDirectory },
      },
    );
    report.gdbExitCode = debug.exitCode;
    report.state = debug.exitCode === 0 ? "captured" : "capture-incomplete";
  } catch {
    // Tool diagnostics are already bounded and redacted by DockerProbe/ShellProbe.
    // Do not serialize arbitrary exceptions or memory into the report.
    report.state = "capture-failed";
  } finally {
    if (privateDirectory) {
      try {
        fs.rmSync(privateDirectory, { recursive: true, force: true });
        report.privateCoreCleanup = "removed";
      } catch {
        report.privateCoreCleanup = "failed";
      }
    }
    try {
      await artifacts.writeJson("hermes-crash-capture.json", report);
    } catch {
      process.stderr.write(
        "Hermes crash diagnostic report was not retained; original probe status is unchanged.\n",
      );
    }
  }
}
