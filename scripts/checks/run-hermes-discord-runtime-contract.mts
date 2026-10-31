#!/usr/bin/env -S node --no-warnings

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ManagedImageDirectE2eInputs } from "./run-managed-image-direct-e2e.ts";
import * as importedDirectE2e from "./run-managed-image-direct-e2e.ts";

// tsx exposes this root TypeScript module as CJS; Vitest exposes an ESM namespace.
const directE2e = (
  "default" in importedDirectE2e && importedDirectE2e.default
    ? importedDirectE2e.default
    : importedDirectE2e
) as typeof import("./run-managed-image-direct-e2e.ts");
const { parseManagedImageDirectE2eInputs } = directE2e;

const WORKSPACE = fileURLToPath(new URL("../../", import.meta.url));

export function hermesDiscordRuntimeContractCommand(
  input: Pick<ManagedImageDirectE2eInputs, "image" | "platform">,
  workspace = WORKSPACE,
  cidfile = join(workspace, ".e2e/hermes-discord-runtime.cid"),
): readonly string[] {
  return [
    "run",
    "--rm",
    "--init",
    "--platform",
    input.platform,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "0:0",
    "--entrypoint",
    "/usr/local/bin/node",
    "--cidfile",
    cidfile,
    "--mount",
    `type=bind,src=${workspace},dst=/workspace,readonly`,
    "--workdir",
    "/workspace",
    "--tmpfs",
    "/workspace/node_modules/.vite:rw,nosuid,nodev",
    "--tmpfs",
    "/workspace/node_modules/.vite-temp:rw,nosuid,nodev",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev",
    "--tmpfs",
    "/sandbox/.hermes:rw,nosuid,nodev,mode=0700",
    "--env",
    "HOME=/tmp/hermes-contract-home",
    "--env",
    "HERMES_HOME=/sandbox/.hermes",
    "--env",
    "NEMOCLAW_HERMES_RUNTIME_TEST=1",
    input.image,
    "node_modules/vitest/vitest.mjs",
    "run",
    "--project",
    "package-contract",
    "test/package-contract/channels/hermes-discord-runtime.test.ts",
    "--maxWorkers=1",
    "--no-file-parallelism",
  ];
}

export function runHermesDiscordRuntimeContract(argv: readonly string[]): void {
  const input = parseManagedImageDirectE2eInputs(["--agent", "hermes", ...argv]);
  mkdirSync(join(WORKSPACE, ".e2e"), { recursive: true });
  mkdirSync(join(WORKSPACE, "node_modules/.vite"), { recursive: true });
  mkdirSync(join(WORKSPACE, "node_modules/.vite-temp"), { recursive: true });
  const temporary = mkdtempSync(join(WORKSPACE, ".e2e/hermes-discord-runtime-"));
  const cidfile = join(temporary, "container.cid");
  let contractFailure: unknown;
  try {
    const result = spawnSync(
      "docker",
      [...hermesDiscordRuntimeContractCommand(input, WORKSPACE, cidfile)],
      {
        stdio: "inherit",
        timeout: 180_000,
        killSignal: "SIGKILL",
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Native Hermes Discord runtime contract failed");
  } catch (error) {
    contractFailure = error;
  }
  const cleanupFailure = cleanupHermesContract(temporary, cidfile);
  if (contractFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [contractFailure, cleanupFailure],
      "Native Hermes Discord runtime contract and cleanup failed",
    );
  }
  if (contractFailure !== undefined) throw contractFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

function cleanupHermesContract(temporary: string, cidfile: string): unknown {
  let failure: unknown;
  try {
    // A timed-out Docker client can leave its container running. The read-only
    // workspace prevents the test from replacing the daemon-written identity.
    if (existsSync(cidfile)) {
      const id = readFileSync(cidfile, "utf8").trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid Hermes contract container identity");
      const removed = spawnSync("docker", ["rm", "--force", id], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (removed.status !== 0 && !removed.stderr?.includes("No such container")) {
        throw new Error(`Could not remove Hermes contract container ${id}`);
      }
    }
  } catch (error) {
    failure = error;
  }
  try {
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    failure ??= error;
  }
  return failure;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runHermesDiscordRuntimeContract(process.argv.slice(2));
}
