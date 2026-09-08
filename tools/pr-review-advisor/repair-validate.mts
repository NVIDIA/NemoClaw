#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
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
) => number;

const defaultRunner: RepairValidationRunner = (executable, arguments_, workingDirectory) => {
  const result = spawnSync(executable, arguments_, {
    cwd: workingDirectory,
    env: process.env,
    stdio: "inherit",
  });
  return result.status ?? 1;
};

export function validateAndSealRepair(input: {
  selection: RepairSelection;
  candidate: ValidatedCandidate;
  candidateDirectory: string;
  patchFile: string;
  outputDirectory: string;
  run?: RepairValidationRunner;
}): void {
  const commands: Array<{ command: string; exitCode: number }> = [];
  for (const command of repairValidationPlan(input.selection)) {
    const exitCode = (input.run ?? defaultRunner)(
      command.executable,
      command.arguments,
      input.candidateDirectory,
    );
    if (exitCode !== 0) throw new Error(`repair validation failed: ${command.command}`);
    commands.push({ command: command.command, exitCode });
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
