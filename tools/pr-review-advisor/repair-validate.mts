#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  candidateDigest,
  parseSelection,
  readJson,
  repairValidationPlan,
  type RepairSelection,
  type ValidatedCandidate,
  validationReceipt,
} from "./repair-contract.mts";

export type RepairValidationRunner = (
  executable: string,
  arguments_: string[],
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
) => number;

const defaultRunner: RepairValidationRunner = (
  executable,
  arguments_,
  workingDirectory,
  environment,
) => {
  const result = spawnSync(executable, arguments_, {
    cwd: workingDirectory,
    env: environment,
    stdio: "inherit",
  });
  return result.status ?? 1;
};

function repairValidationEnvironment(runtimeDirectory: string): NodeJS.ProcessEnv {
  const homeDirectory = path.join(runtimeDirectory, "home");
  const temporaryDirectory = path.join(runtimeDirectory, "tmp");
  const cacheDirectory = path.join(runtimeDirectory, "npm-cache");
  const configDirectory = path.join(runtimeDirectory, "config");
  for (const directory of [homeDirectory, temporaryDirectory, cacheDirectory, configDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const userConfig = path.join(configDirectory, "npmrc");
  writeFileSync(userConfig, "", { mode: 0o600 });

  const environment: NodeJS.ProcessEnv = {
    CI: "true",
    HOME: homeDirectory,
    NPM_CONFIG_CACHE: cacheDirectory,
    NPM_CONFIG_GLOBALCONFIG: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
    PATH: process.env.PATH,
    TMPDIR: temporaryDirectory,
    XDG_CACHE_HOME: cacheDirectory,
    XDG_CONFIG_HOME: configDirectory,
  };
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

export function validateAndSealRepair(input: {
  selection: RepairSelection;
  candidate: ValidatedCandidate;
  candidateDirectory: string;
  patchFile: string;
  outputDirectory: string;
  run?: RepairValidationRunner;
}): void {
  const commands: Array<{ command: string; exitCode: number }> = [];
  const runtimeDirectory = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-validation-"));
  try {
    const environment = repairValidationEnvironment(runtimeDirectory);
    for (const command of repairValidationPlan(input.selection)) {
      const exitCode = (input.run ?? defaultRunner)(
        command.executable,
        command.arguments,
        input.candidateDirectory,
        environment,
      );
      if (exitCode !== 0) throw new Error(`repair validation failed: ${command.command}`);
      commands.push({ command: command.command, exitCode });
    }
  } finally {
    rmSync(runtimeDirectory, { force: true, recursive: true });
  }
  const receipt = validationReceipt({
    selection: input.selection,
    candidate: input.candidate,
    candidateDigestAfter: candidateDigest(input.candidateDirectory, input.selection.sourceHeadSha),
    commands,
  });
  mkdirSync(input.outputDirectory, { recursive: true, mode: 0o700 });
  copyFileSync(input.patchFile, path.join(input.outputDirectory, "repair.patch"));
  writeFileSync(
    path.join(input.outputDirectory, "validation.json"),
    `${JSON.stringify(receipt)}\n`,
    { mode: 0o600 },
  );
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const inputDirectory = required(process.env.INPUT_DIR, "INPUT_DIR");
  validateAndSealRepair({
    selection: parseSelection(readJson(path.join(inputDirectory, "context", "selection.json"))),
    candidate: readJson(path.join(inputDirectory, "candidate.json")) as ValidatedCandidate,
    candidateDirectory: required(process.env.CANDIDATE_DIR, "CANDIDATE_DIR"),
    patchFile: path.join(inputDirectory, "candidate", "repair.patch"),
    outputDirectory: required(process.env.OUTPUT_DIR, "OUTPUT_DIR"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
