// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createOpenShellSandbox,
  defaultOpenShellTools,
  deleteOpenShellSandbox,
  execOpenShellSandbox,
  type OpenShellTools,
  startOwnedOpenShellGateway,
} from "../openshell-agent/runtime.mts";
import { prepareCiNpmInstall } from "../../scripts/checks/prepare-ci-npm-install.mts";
import {
  candidateDigest,
  parseSelection,
  readJson,
  repairValidationPlan,
  type RepairValidationCommand,
  type RepairSelection,
  type ValidatedCandidate,
  validateRepairPatch,
  validationReceipt,
} from "./repair-contract.mts";

type RepairValidationResult = Array<{ command: string; exitCode: number }>;

function boundedDiagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 1_000);
}

export type RepairValidationExecutor = (
  commands: readonly RepairValidationCommand[],
  candidateDirectory: string,
) => Promise<RepairValidationResult>;

export async function runRepairValidationInSandbox(
  input: {
    candidateDirectory: string;
    commands: readonly RepairValidationCommand[];
    env: NodeJS.ProcessEnv;
    sdkArtifactDirectory: string;
    trustedCheckout: string;
  },
  dependencies: {
    prepareDependencies?: typeof prepareCiNpmInstall;
    tools?: OpenShellTools;
  } = {},
): Promise<RepairValidationResult> {
  const workspace = path.dirname(input.candidateDirectory);
  if (path.basename(input.candidateDirectory) !== "repo")
    throw new Error("repair validation candidate must use the isolated repo workspace");
  const cacheDirectory = path.join(workspace, "npm-cache");
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  await (dependencies.prepareDependencies ?? prepareCiNpmInstall)({
    artifactDirectory: input.sdkArtifactDirectory,
    cacheDirectory,
    mode: "artifact",
    targetRoot: input.candidateDirectory,
  });

  const tools = dependencies.tools ?? defaultOpenShellTools;
  const sandboxName = required(input.env.SANDBOX_NAME, "SANDBOX_NAME");
  const gateway = startOwnedOpenShellGateway(
    input.env,
    {
      gatewayId: `pr-review-advisor-validation-${required(input.env.GITHUB_RUN_ID, "GITHUB_RUN_ID")}`,
    },
    tools,
  );
  let primaryError: unknown;
  try {
    await gateway.ready;
    createOpenShellSandbox(
      input.env,
      {
        name: sandboxName,
        image: required(input.env.PI_IMAGE, "PI_IMAGE"),
        policyPath: path.join(
          input.trustedCheckout,
          "tools",
          "pr-review-advisor",
          "repair-validation-policy.yaml",
        ),
        uploads: [{ source: workspace, destination: "/sandbox" }],
        command: [
          "/bin/sh",
          "-c",
          "mkdir -p /sandbox/runtime/home /sandbox/runtime/tmp /sandbox/runtime/config && : > /sandbox/runtime/config/user-npmrc && : > /sandbox/runtime/config/global-npmrc",
        ],
      },
      tools,
    );
    const results: RepairValidationResult = [];
    for (const command of input.commands) {
      execOpenShellSandbox(
        input.env,
        {
          name: sandboxName,
          timeoutSeconds: 1_800,
          workdir: "/sandbox/repo",
          environment: {
            CI: "true",
            HOME: "/sandbox/runtime/home",
            NPM_CONFIG_CACHE: "/sandbox/npm-cache",
            NPM_CONFIG_GLOBALCONFIG: "/sandbox/runtime/config/global-npmrc",
            NPM_CONFIG_USERCONFIG: "/sandbox/runtime/config/user-npmrc",
            NODE_OPTIONS: "--max-old-space-size=8192",
            TMPDIR: "/sandbox/runtime/tmp",
            XDG_CACHE_HOME: "/sandbox/npm-cache",
            XDG_CONFIG_HOME: "/sandbox/runtime/config",
          },
          command: [command.executable, ...command.arguments],
        },
        tools,
      );
      results.push({ command: command.command, exitCode: 0 });
    }
    return results;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupDiagnostics: string[] = [];
    try {
      deleteOpenShellSandbox(input.env, sandboxName, tools);
    } catch (error) {
      cleanupDiagnostics.push(
        `validation sandbox ${sandboxName} cleanup failed: ${boundedDiagnostic(error)}`,
      );
    }
    try {
      await gateway.stop();
    } catch (error) {
      cleanupDiagnostics.push(
        `validation gateway for ${sandboxName} cleanup failed: ${boundedDiagnostic(error)}`,
      );
    }
    if (cleanupDiagnostics.length > 0) {
      const cleanupMessage = cleanupDiagnostics.join("; ");
      if (primaryError !== undefined)
        throw new Error(`${boundedDiagnostic(primaryError)}; ${cleanupMessage}`);
      throw new Error(cleanupMessage);
    }
  }
}

export async function validateAndSealRepair(input: {
  selection: RepairSelection;
  candidate: ValidatedCandidate;
  candidateDirectory: string;
  patchFile: string;
  outputDirectory: string;
  execute?: RepairValidationExecutor;
}): Promise<void> {
  const plan = repairValidationPlan(input.selection);
  const commands = await (
    input.execute ??
    ((selectedPlan, candidateDirectory) =>
      runRepairValidationInSandbox({
        candidateDirectory,
        commands: selectedPlan,
        env: process.env,
        sdkArtifactDirectory: required(process.env.SDK_ARTIFACT_DIR, "SDK_ARTIFACT_DIR"),
        trustedCheckout: required(process.env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
      }))
  )(plan, input.candidateDirectory);
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

export async function reconstructAndSealRepair(input: {
  selection: RepairSelection;
  sourceCheckout: string;
  candidateDirectory: string;
  patchFile: string;
  proposalFile: string;
  outputDirectory: string;
  execute?: RepairValidationExecutor;
}): Promise<ValidatedCandidate> {
  const candidate = validateRepairPatch({
    sourceCheckout: input.sourceCheckout,
    destination: input.candidateDirectory,
    selection: input.selection,
    patchFile: input.patchFile,
    proposalFile: input.proposalFile,
  });
  await validateAndSealRepair({
    selection: input.selection,
    candidate,
    candidateDirectory: input.candidateDirectory,
    patchFile: input.patchFile,
    outputDirectory: input.outputDirectory,
    execute: input.execute,
  });
  return candidate;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const inputDirectory = required(process.env.INPUT_DIR, "INPUT_DIR");
  const candidateArtifactDirectory = path.join(inputDirectory, "candidate");
  const selection = parseSelection(
    readJson(path.join(inputDirectory, "context", "selection.json")),
  );
  const candidateDirectory = required(process.env.CANDIDATE_DIR, "CANDIDATE_DIR");
  const patchFile = path.join(candidateArtifactDirectory, "repair.patch");
  await reconstructAndSealRepair({
    selection,
    sourceCheckout: required(process.env.SOURCE_REPOSITORY, "SOURCE_REPOSITORY"),
    candidateDirectory,
    patchFile,
    proposalFile: path.join(candidateArtifactDirectory, "proposal.json"),
    outputDirectory: required(process.env.OUTPUT_DIR, "OUTPUT_DIR"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
