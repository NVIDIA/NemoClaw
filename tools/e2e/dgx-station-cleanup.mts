// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { ArtifactSink } from "../../test/e2e/fixtures/artifacts.ts";
import { startTestProgress } from "../../test/e2e/fixtures/progress.ts";
import {
  type ChildProcessProgress,
  spawnObservedChild,
} from "../../test/e2e/fixtures/observed-child-process.ts";
import { superviseChild } from "../../test/helpers/process-supervisor.ts";
import { trustedShellCommand } from "../../test/e2e/fixtures/shell/trusted-command.ts";
import { pathToFileURL } from "node:url";

export const STATION_SANDBOX = "e2e-station-express";
export const STATION_STATE_VOLUME = `nemoclaw-openclaw-state-v1-${STATION_SANDBOX}`;
type Command = (
  label: string,
  executable: string,
  args: string[],
  timeoutMs?: number,
) => Promise<string>;

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function record(value: unknown): Record<string, unknown> {
  requireCondition(
    value && typeof value === "object" && !Array.isArray(value),
    "Invalid Station cleanup record",
  );
  return value as Record<string, unknown>;
}
export function stationVolumeBaseline(value: unknown): string[] {
  requireCondition(
    Array.isArray(value) &&
      value.every(
        (name) => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/u.test(name),
      ) &&
      new Set(value).size === value.length,
    "Invalid Station volume baseline",
  );
  requireCondition(
    !value.includes(STATION_STATE_VOLUME),
    "Station state volume was present before the job",
  );
  return [...value].sort();
}
function present(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function registered(home: string): boolean {
  const file = path.join(home, ".nemoclaw", "sandboxes.json");
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const info = fs.fstatSync(fd);
    requireCondition(
      info.isFile() &&
        info.nlink === 1 &&
        info.uid === process.getuid?.() &&
        info.size <= 1024 * 1024,
      "Unsafe Station sandbox registry",
    );
    const rows = record(record(JSON.parse(fs.readFileSync(fd, "utf8"))).sandboxes);
    requireCondition(
      Object.keys(rows).every((name) => name === STATION_SANDBOX),
      "Station registry contains another sandbox",
    );
    if (!(STATION_SANDBOX in rows)) return false;
    const entry = record(rows[STATION_SANDBOX]);
    requireCondition(
      entry.agent === "openclaw" && record(entry.workload).kind === "managed-image",
      "Station registry does not describe the expected OpenClaw workload",
    );
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
function installationPresent(home: string): boolean {
  return [
    ".nemoclaw",
    ".config/nemoclaw",
    ".config/openshell",
    ".local/state/nemoclaw",
    ".config/systemd/user/nemoclaw-openshell-gateway.service",
    ...[
      "nemoclaw",
      "nemoclaw-acp",
      "nemohermes",
      "nemo-deepagents",
      "openshell",
      "openshell-gateway",
      "openshell-sandbox",
      "openshell-driver-vm",
    ].map((name) => `.local/bin/${name}`),
  ].some((name) => present(path.join(home, name)));
}

export async function cleanupStationRuntime(options: {
  home: string;
  repoRoot: string;
  baselineVolumes: unknown;
  command: Command;
}): Promise<{ uninstalled: boolean; fallbackVolumes: string[] }> {
  const before = stationVolumeBaseline(options.baselineVolumes);
  const { command, home } = options;
  const hasRegisteredSandbox = registered(home);
  const uninstalled = hasRegisteredSandbox || installationPresent(home);
  if (uninstalled)
    await command(
      "station-express-uninstall",
      "bash",
      ["uninstall.sh", "--yes", "--destroy-user-data"],
      180_000,
    );
  const volumes = (
    await command("station-cleanup-volume-inventory", "docker", ["volume", "ls", "--quiet"])
  )
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const added = volumes.filter((name) => !before.includes(name));
  requireCondition(
    before.every((name) => volumes.includes(name)) &&
      added.every((name) => name === STATION_STATE_VOLUME),
    "Station cleanup volume inventory contains an unexplained change",
  );
  if (added.length) {
    const values: unknown = JSON.parse(
      await command("station-leftover-volume-identity", "docker", [
        "volume",
        "inspect",
        STATION_STATE_VOLUME,
      ]),
    );
    requireCondition(
      Array.isArray(values) && values.length === 1,
      "Ambiguous Station state volume",
    );
    const volume = record(values[0]);
    const labels = record(volume.Labels);
    const expected = {
      managed: "true",
      schema: "1",
      sandbox: STATION_SANDBOX,
      target: "/sandbox/.openclaw",
    };
    requireCondition(
      volume.Name === STATION_STATE_VOLUME &&
        volume.Driver === "local" &&
        volume.Scope === "local" &&
        (volume.Options == null || Object.keys(record(volume.Options)).length === 0) &&
        Object.entries(expected).every(
          ([key, value]) => labels[`io.nvidia.nemoclaw.openclaw-state.${key}`] === value,
        ),
      "Station leftover volume ownership is unproven",
    );
    requireCondition(
      (
        await command("station-leftover-volume-users", "docker", [
          "container",
          "ls",
          "--all",
          "--quiet",
          "--filter",
          `volume=${STATION_STATE_VOLUME}`,
        ])
      ).trim() === "",
      "Station leftover volume is still attached",
    );
    await command("station-leftover-volume-remove", "docker", [
      "volume",
      "rm",
      STATION_STATE_VOLUME,
    ]);
  }
  const remaining = (
    await command("station-cleanup-volumes-restored", "docker", ["volume", "ls", "--quiet"])
  )
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  requireCondition(
    JSON.stringify(remaining) === JSON.stringify(before),
    "Station cleanup did not restore the volume baseline",
  );
  return { uninstalled, fallbackVolumes: added };
}

export function createStationCleanupCommand(options: {
  artifacts: ArtifactSink;
  progress: ChildProcessProgress;
  environment: NodeJS.ProcessEnv;
  repoRoot: string;
  deadline: number;
}): Command {
  return async function runStationCleanupCommand(label, executable, args, timeoutMs = 30_000) {
    const remaining = options.deadline - Date.now();
    requireCondition(remaining > 0, "Station cleanup deadline expired");
    const command = trustedShellCommand({
      command: executable,
      args,
      reason: "clean up the Station job runtime",
    });
    const output = { stdout: "", stderr: "" };
    const abort = new AbortController();
    let outputExceeded = false;
    const capture = (stream: "stdout" | "stderr", chunk: string): void => {
      if (outputExceeded) return;
      if (Buffer.byteLength(output[stream]) + Buffer.byteLength(chunk) > 1024 * 1024) {
        outputExceeded = true;
        output.stdout = "";
        output.stderr = "";
        abort.abort();
      } else {
        output[stream] += chunk;
      }
    };
    const child = spawnObservedChild(command.command, command.args, {
      activityLabel: label,
      progress: options.progress,
      spawn: {
        cwd: options.repoRoot,
        detached: true,
        env: { ...options.environment, DOCKER_HOST: "", DOCKER_CONTEXT: "default" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    const result = await superviseChild(child, {
      timeoutMs: Math.min(timeoutMs, remaining),
      killGraceMs: 1000,
      signal: abort.signal,
      onStdout: (chunk) => capture("stdout", chunk),
      onStderr: (chunk) => capture("stderr", chunk),
    });
    await options.artifacts.writeJson(`shell/${label}.result.json`, {
      ...output,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      outputExceeded,
      spawnFailed: !!result.spawnError,
      cleanupFailed: !!result.cleanupError,
    });
    requireCondition(!outputExceeded, "Station cleanup output exceeded its bound");
    requireCondition(
      result.exitCode === 0 &&
        !result.timedOut &&
        result.signal === null &&
        !result.spawnError &&
        !result.cleanupError,
      `${label} failed; inspect the private cleanup artifact`,
    );
    return output.stdout;
  };
}

async function main(): Promise<void> {
  requireCondition(
    process.argv.length === 3 &&
      process.env.HOME &&
      process.env.NEMOCLAW_REPO_ROOT &&
      process.env.E2E_ARTIFACT_DIR,
    "Station cleanup requires its runner environment and volume baseline",
  );
  process.umask(0o077);
  const artifacts = new ArtifactSink(process.env.E2E_ARTIFACT_DIR);
  const progress = startTestProgress(
    "Station runtime cleanup",
    ["prepare Station cleanup", "clean up the job runtime"],
    {
      logLine: (line) => process.stderr.write(`${line}\n`),
    },
  );
  let succeeded = false;
  try {
    progress.phase("clean up the job runtime");
    const result = await cleanupStationRuntime({
      home: process.env.HOME,
      repoRoot: process.env.NEMOCLAW_REPO_ROOT,
      baselineVolumes: JSON.parse(process.argv[2]!),
      command: createStationCleanupCommand({
        artifacts,
        progress,
        environment: process.env,
        repoRoot: process.env.NEMOCLAW_REPO_ROOT,
        deadline: Date.now() + 280_000,
      }),
    });
    succeeded = true;
    console.log(JSON.stringify(result));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await artifacts.writeText("cleanup-error.txt", reason);
    throw error;
  } finally {
    progress.stop(succeeded ? "passed" : "failed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Station runtime cleanup failed; retained evidence requires recovery.");
    process.exitCode = 1;
  });
}
