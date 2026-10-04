// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { vi } from "vitest";

import { resolveStationFixturePython } from "../../src/lib/inference/vllm-station-fixture.test-support";

import type {
  ModelStagingCommandOptions,
  ModelStagingCommandResult,
} from "../../src/lib/inference/vllm-station-model-staging";

type ModelStagingFixtureCommand = (
  file: string,
  args: readonly string[],
  options: ModelStagingCommandOptions,
) => Promise<ModelStagingCommandResult>;

function result(stdout = "", status = 0): ModelStagingCommandResult {
  return { status, stdout, stderr: "" };
}

function runPython(
  args: readonly string[],
  options: ModelStagingCommandOptions,
): ModelStagingCommandResult {
  const completed = spawnSync(resolveStationFixturePython(), [...args], {
    encoding: "utf8",
    env: options.env,
    input: options.input,
    timeout: options.timeoutMs,
  });
  return {
    status: completed.status,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? "",
    error: completed.error?.message,
    timedOut: (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

function unexpectedCommand(file: string): never {
  throw new Error(`unexpected command: ${file}`);
}

/**
 * Branching in these runners models external command behavior; assertions stay in the test file.
 */
export function createPostAuditMutationRunner(snapshot: string) {
  const state = {
    configMode: 0,
    snapshotMode: 0,
    transferSource: "",
    transferredConfig: "",
  };
  let pythonCall = 0;
  let sshCall = 0;
  const runCommand = vi.fn<ModelStagingFixtureCommand>(async (file, args, options) => {
    if (file === "python3") {
      pythonCall += 1;
      const audit = runPython(args, options);
      if (pythonCall === 2 && audit.status === 0) {
        fs.writeFileSync(path.join(snapshot, "config.json"), "changed-after-audit");
      }
      return audit;
    }
    if (file === "ssh") {
      sshCall += 1;
      return result(sshCall <= 2 ? '{"state":"transfer"}' : '{"state":"ready"}');
    }
    if (file === "rsync") {
      state.transferSource = String(args.at(-2)).replace(/\/$/, "");
      state.transferredConfig = fs.readFileSync(
        path.join(state.transferSource, "config.json"),
        "utf8",
      );
      state.snapshotMode = fs.statSync(state.transferSource).mode & 0o777;
      state.configMode = fs.statSync(path.join(state.transferSource, "config.json")).mode & 0o777;
      return result();
    }
    return unexpectedCommand(file);
  });
  return { runCommand, state };
}

export function createBetweenAuditMutationRunner(snapshot: string) {
  const state = { materializedSnapshot: "" };
  let pythonCall = 0;
  const runCommand = vi.fn<ModelStagingFixtureCommand>(async (file, args, options) => {
    if (file === "python3") {
      pythonCall += 1;
      if (args[3] !== undefined) state.materializedSnapshot = String(args[3]);
      const audit = runPython(args, options);
      if (pythonCall === 1 && audit.status === 0) {
        fs.writeFileSync(path.join(snapshot, "config.json"), "changed-between-audits");
      }
      return audit;
    }
    if (file === "ssh") {
      return result(pythonCall === 1 ? '{"state":"transfer"}' : '{"state":"cleaned"}');
    }
    return unexpectedCommand(file);
  });
  return { runCommand, state };
}

export function createPythonOnlyRunner() {
  return vi.fn<ModelStagingFixtureCommand>(async (file, args, options) => {
    if (file !== "python3") return unexpectedCommand(file);
    return runPython(args, options);
  });
}

export function createManifestPeerPythonRunner(options: {
  localManifest: string;
  peerHome: string;
  peerInputPrefix?: string;
}) {
  return vi.fn<ModelStagingFixtureCommand>(async (file, _args, commandOptions) => {
    if (file === "python3") return result(options.localManifest);
    if (file === "ssh") {
      return runPython(["-"], {
        ...commandOptions,
        env: { ...commandOptions.env, HOME: options.peerHome },
        input: `${options.peerInputPrefix ?? ""}${commandOptions.input ?? ""}`,
      });
    }
    return unexpectedCommand(file);
  });
}

export function createPeerIntegrityRunner(options: {
  localManifest: string;
  peerHome: string;
  peerInputPrefix?: string;
}) {
  const state = { stagingPath: "" };
  const runCommand = vi.fn<ModelStagingFixtureCommand>(async (file, args, commandOptions) => {
    if (file === "python3") return result(options.localManifest);
    if (file === "ssh") {
      return runPython(["-"], {
        ...commandOptions,
        env: { ...commandOptions.env, HOME: options.peerHome },
        input: `${options.peerInputPrefix ?? ""}${commandOptions.input ?? ""}`,
      });
    }
    if (file === "rsync") {
      const destination = String(args.at(-1));
      state.stagingPath = destination.slice(destination.indexOf(":") + 1).replace(/\/$/, "");
      fs.mkdirSync(state.stagingPath, { mode: 0o700, recursive: true });
      fs.writeFileSync(path.join(state.stagingPath, "config.json"), "xx");
      return result();
    }
    return unexpectedCommand(file);
  });
  return { runCommand, state };
}

export function createAtomicIdentityReplacementRunner(peerHome: string) {
  const state = { materializedSnapshot: "" };
  let sshCall = 0;
  const runCommand = vi.fn<ModelStagingFixtureCommand>(async (file, args, options) => {
    if (file === "python3") {
      if (args[3] !== undefined) state.materializedSnapshot = String(args[3]);
      return runPython(args, options);
    }
    if (file === "ssh") {
      sshCall += 1;
      const ampleCapacity = `import shutil
class _NemoClawDiskUsage:
    free = 1 << 50
shutil.disk_usage = lambda _path: _NemoClawDiskUsage()
`;
      const replaceInstalledIdentity =
        sshCall === 3
          ? `import os
_nemoclaw_original_rename = os.rename
def _nemoclaw_replace_after_rename(source, destination):
    _nemoclaw_original_rename(source, destination)
    _nemoclaw_original_rename(destination, str(destination) + ".nemoclaw-test-original")
    os.mkdir(destination, 0o700)
os.rename = _nemoclaw_replace_after_rename
`
          : "";
      return runPython(["-"], {
        ...options,
        env: { ...options.env, HOME: peerHome },
        input: `${ampleCapacity}${replaceInstalledIdentity}${options.input ?? ""}`,
      });
    }
    if (file === "rsync") {
      const source = String(args.at(-2)).replace(/\/$/, "");
      const destination = String(args.at(-1));
      const stagingPath = destination.slice(destination.indexOf(":") + 1).replace(/\/$/, "");
      for (const entry of fs.readdirSync(source)) {
        fs.cpSync(path.join(source, entry), path.join(stagingPath, entry), {
          recursive: true,
        });
      }
      return result();
    }
    return unexpectedCommand(file);
  });
  return { runCommand, state };
}
