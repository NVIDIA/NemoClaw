// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertExitZero } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { SandboxClient } from "./clients/sandbox.ts";
import type { CorporateCaWorkloadKind } from "./corporate-ca.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";

const MANAGED_RUNTIME_ENVIRONMENT_PATH = "/run/nemoclaw/managed-startup-runtime.env";
const REASONING_ENVIRONMENT_NAME = "NEMOCLAW_REASONING";
const MANAGED_REASONING_PROPAGATION_PROBE = String.raw`
const fs = require("node:fs");
const expectedModel = process.argv[1];
const runtimeEnvironmentPath = process.argv[2];
const runtimeEnvironmentStat = fs.lstatSync(runtimeEnvironmentPath);
if (
  !runtimeEnvironmentStat.isFile() ||
  runtimeEnvironmentStat.isSymbolicLink() ||
  runtimeEnvironmentStat.uid !== 0 ||
  runtimeEnvironmentStat.gid !== 0 ||
  (runtimeEnvironmentStat.mode & 0o777) !== 0o444
) {
  throw new Error("managed startup runtime environment is not a root-owned mode 0444 regular file");
}
const runtimeReasoningLines = fs
  .readFileSync(runtimeEnvironmentPath, "utf8")
  .split(/\r?\n/u)
  .filter((line) => line.startsWith("export NEMOCLAW_REASONING="));
if (runtimeReasoningLines.length !== 1) {
  throw new Error("managed startup runtime environment must export NEMOCLAW_REASONING exactly once");
}
const runtimeReasoningMatch = /^export NEMOCLAW_REASONING='(true|false)'$/u.exec(
  runtimeReasoningLines[0],
);
if (runtimeReasoningMatch === null) {
  throw new Error("managed startup runtime environment has an invalid NEMOCLAW_REASONING export");
}
const config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const models = config.models?.providers?.inference?.models ?? [];
const model = models.find((entry) => entry?.id === expectedModel);
const evidence = {
  runtimeReasoning: runtimeReasoningMatch[1],
  modelReasoning: model?.reasoning,
};
console.log(JSON.stringify(evidence));
process.exit(evidence.runtimeReasoning === "true" && evidence.modelReasoning === true ? 0 : 1);
`;
const REASONING_MODEL_PROBE = String.raw`
const fs = require("node:fs");
const expectedModel = process.argv[1];
const config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const models = config.models?.providers?.inference?.models ?? [];
const model = models.find((entry) => entry?.id === expectedModel);
const evidence = { modelReasoning: model?.reasoning };
console.log(JSON.stringify(evidence));
process.exit(evidence.modelReasoning === true ? 0 : 1);
`;

export type ReasoningPropagationSource =
  | {
      kind: "managed-runtime-environment";
      path: typeof MANAGED_RUNTIME_ENVIRONMENT_PATH;
    }
  | {
      environmentName: typeof REASONING_ENVIRONMENT_NAME;
      kind: "legacy-image-environment";
    };

export type ReasoningPropagationEvidence =
  | { imageReasoning: string; modelReasoning: boolean }
  | { modelReasoning: boolean; runtimeReasoning: string };

interface ReasoningPropagationClients {
  host: Pick<HostCliClient, "command">;
  sandbox: Pick<SandboxClient, "exec">;
}

interface ReasoningPropagationProbeOptions extends ReasoningPropagationClients {
  commandOptions?: ShellProbeRunOptions;
  expectedModel: string;
  sandboxName: string;
  workloadKind: CorporateCaWorkloadKind;
}

export function reasoningPropagationSource(
  workloadKind: CorporateCaWorkloadKind,
): ReasoningPropagationSource {
  if (workloadKind === "managed-image") {
    return {
      kind: "managed-runtime-environment",
      path: MANAGED_RUNTIME_ENVIRONMENT_PATH,
    };
  }
  return {
    environmentName: REASONING_ENVIRONMENT_NAME,
    kind: "legacy-image-environment",
  };
}

export function parseLegacyReasoningContainerId(stdout: string): string {
  const containerIds = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (containerIds.length !== 1 || !/^[0-9a-f]{12,64}$/u.test(containerIds[0] ?? "")) {
    throw new Error("legacy reasoning probe requires exactly one valid sandbox container ID");
  }
  return containerIds[0]!;
}

export function parseLegacyImageReasoning(stdout: string): "false" | "true" {
  const matches = stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(`${REASONING_ENVIRONMENT_NAME}=`));
  if (matches.length !== 1) {
    throw new Error("legacy sandbox image must define NEMOCLAW_REASONING exactly once");
  }
  const value = matches[0]!.slice(`${REASONING_ENVIRONMENT_NAME}=`.length);
  if (value !== "true" && value !== "false") {
    throw new Error("legacy sandbox image has an invalid NEMOCLAW_REASONING value");
  }
  return value;
}

function parseManagedEvidence(stdout: string): ReasoningPropagationEvidence {
  return JSON.parse(stdout.trim()) as ReasoningPropagationEvidence;
}

function parseModelEvidence(stdout: string): { modelReasoning: boolean } {
  return JSON.parse(stdout.trim()) as { modelReasoning: boolean };
}

async function probeManagedReasoning(
  options: ReasoningPropagationProbeOptions,
  source: Extract<ReasoningPropagationSource, { kind: "managed-runtime-environment" }>,
): Promise<ReasoningPropagationEvidence> {
  const result = await options.sandbox.exec(
    options.sandboxName,
    ["node", "-e", MANAGED_REASONING_PROPAGATION_PROBE, options.expectedModel, source.path],
    {
      ...options.commandOptions,
      artifactName: "phase-2-compatible-endpoint-reasoning",
    },
  );
  assertExitZero(result, "managed compatible-endpoint reasoning probe");
  return parseManagedEvidence(result.stdout);
}

async function probeLegacyReasoning(
  options: ReasoningPropagationProbeOptions,
): Promise<ReasoningPropagationEvidence> {
  const containerList = await options.host.command(
    "docker",
    [
      "ps",
      "--filter",
      `label=openshell.ai/sandbox-name=${options.sandboxName}`,
      "--format",
      "{{.ID}}",
    ],
    {
      ...options.commandOptions,
      artifactName: "phase-2-compatible-endpoint-reasoning-container",
    },
  );
  assertExitZero(containerList, "locate legacy sandbox container for reasoning probe");
  const containerId = parseLegacyReasoningContainerId(containerList.stdout);
  const imageEnvironment = await options.host.command(
    "docker",
    [
      "inspect",
      "--type",
      "container",
      "--format",
      "{{range .Config.Env}}{{println .}}{{end}}",
      containerId,
    ],
    {
      ...options.commandOptions,
      artifactName: "phase-2-compatible-endpoint-reasoning-image-environment",
    },
  );
  assertExitZero(imageEnvironment, "inspect legacy sandbox image reasoning environment");
  const imageReasoning = parseLegacyImageReasoning(imageEnvironment.stdout);
  const modelProbe = await options.sandbox.exec(
    options.sandboxName,
    ["node", "-e", REASONING_MODEL_PROBE, options.expectedModel],
    {
      ...options.commandOptions,
      artifactName: "phase-2-compatible-endpoint-reasoning",
    },
  );
  assertExitZero(modelProbe, "legacy compatible-endpoint reasoning model probe");
  return { imageReasoning, ...parseModelEvidence(modelProbe.stdout) };
}

export async function probeReasoningPropagation(
  options: ReasoningPropagationProbeOptions,
): Promise<ReasoningPropagationEvidence> {
  const source = reasoningPropagationSource(options.workloadKind);
  return source.kind === "managed-runtime-environment"
    ? await probeManagedReasoning(options, source)
    : await probeLegacyReasoning(options);
}
