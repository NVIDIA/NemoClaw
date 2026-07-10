// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  dockerfileInstructions,
  readDockerfilePatchSnapshot,
  type DockerfileInstruction,
} from "./dockerfile-tool-disclosure-contract";

const REMOTE_BIND_ARG_RE = /^ARG\s+NEMOCLAW_DASHBOARD_BIND=/;
const REMOTE_BIND_PATCHED_ARG_RE = /^ARG\s+NEMOCLAW_DASHBOARD_BIND=0\.0\.0\.0$/;
const REMOTE_BIND_PROMOTION_RE = /NEMOCLAW_DASHBOARD_BIND=\$\{NEMOCLAW_DASHBOARD_BIND\}/;
const OPENCLAW_CONFIG_GENERATOR_RE = /^RUN\b.*generate-openclaw-config\.mts/;
const SAFE_VALIDATION_GENERATOR_HOME_RE =
  /\bHOME=(?:"\$validation_home"|\$validation_home)(?=\s|$)/;
const OPENCLAW_CONFIG_TARGET_PATTERN = `(?:/sandbox/|\\$HOME/|~/)?\\.openclaw/openclaw\\.json\\b`;
const OPENCLAW_CONFIG_TARGET_RE = new RegExp(OPENCLAW_CONFIG_TARGET_PATTERN);
const SAFE_OPENCLAW_CONFIG_CHMOD_RE = new RegExp(
  `^RUN\\s+chmod\\s+[0-7]{3,4}\\s+["']?${OPENCLAW_CONFIG_TARGET_PATTERN}["']?$`,
);
const SAFE_OPENCLAW_CONFIG_HASH_RE = new RegExp(
  `^RUN\\s+sha256sum\\s+["']?${OPENCLAW_CONFIG_TARGET_PATTERN}["']?\\s*>\\s*["']?(?:/sandbox/|\\$HOME/|~/)?\\.openclaw/\\.config-hash\\b["']?$`,
);

export type PatchedRemoteDashboardBindContract = {
  dockerfile: string;
  dashboardRemoteBindPrepared: boolean;
};

function finalStageInstructions(dockerfile: string): DockerfileInstruction[] {
  const instructions = dockerfileInstructions(dockerfile);
  const finalFromIndex = instructions.reduce(
    (last, instruction, index) => (/^FROM(?:\s|$)/i.test(instruction.text) ? index : last),
    -1,
  );
  return instructions.slice(finalFromIndex + 1);
}

export function findRemoteDashboardBindFinalStageArg(
  dockerfile: string,
): DockerfileInstruction | undefined {
  return finalStageInstructions(dockerfile).find((instruction) =>
    REMOTE_BIND_ARG_RE.test(instruction.text),
  );
}

function allowsPostGeneratorOpenClawConfigInstruction(instruction: DockerfileInstruction): boolean {
  if (OPENCLAW_CONFIG_GENERATOR_RE.test(instruction.text)) {
    return SAFE_VALIDATION_GENERATOR_HOME_RE.test(instruction.text);
  }
  if (!OPENCLAW_CONFIG_TARGET_RE.test(instruction.text)) {
    return true;
  }
  return (
    SAFE_OPENCLAW_CONFIG_CHMOD_RE.test(instruction.text) ||
    SAFE_OPENCLAW_CONFIG_HASH_RE.test(instruction.text)
  );
}

export function hasRemoteDashboardBindGenerationContract(dockerfile: string): boolean {
  const finalStage = finalStageInstructions(dockerfile);
  const argIndex = finalStage.findIndex((instruction) =>
    REMOTE_BIND_PATCHED_ARG_RE.test(instruction.text),
  );
  const promotionIndex = finalStage.findIndex(
    (instruction, index) => index > argIndex && REMOTE_BIND_PROMOTION_RE.test(instruction.text),
  );
  const generatorIndex = finalStage.findIndex(
    (instruction, index) =>
      index > promotionIndex && OPENCLAW_CONFIG_GENERATOR_RE.test(instruction.text),
  );
  const invalidatorIndex = finalStage.findIndex(
    (instruction, index) =>
      index > generatorIndex && !allowsPostGeneratorOpenClawConfigInstruction(instruction),
  );
  return (
    argIndex >= 0 &&
    promotionIndex > argIndex &&
    generatorIndex > promotionIndex &&
    invalidatorIndex < 0
  );
}

export function patchRemoteDashboardBindContract(
  dockerfile: string,
  dashboardBind: "" | "0.0.0.0",
): PatchedRemoteDashboardBindContract {
  const dashboardBindArg = findRemoteDashboardBindFinalStageArg(dockerfile);
  if (dashboardBind && !dashboardBindArg) {
    throw new Error(
      "Dockerfile is missing ARG NEMOCLAW_DASHBOARD_BIND; cannot prepare remote dashboard exposure.",
    );
  }
  const patchedDockerfile = dashboardBindArg
    ? `${dockerfile.slice(0, dashboardBindArg.start)}ARG NEMOCLAW_DASHBOARD_BIND=${dashboardBind}${dockerfile.slice(dashboardBindArg.end)}`
    : dockerfile;
  const dashboardRemoteBindPrepared =
    dashboardBind === "0.0.0.0" && hasRemoteDashboardBindGenerationContract(patchedDockerfile);
  if (dashboardBind === "0.0.0.0" && !dashboardRemoteBindPrepared) {
    throw new Error(
      "Dockerfile declares ARG NEMOCLAW_DASHBOARD_BIND but does not promote it to " +
        "generate-openclaw-config.mts or preserve the generated remote dashboard output; " +
        "cannot prepare remote dashboard exposure.",
    );
  }
  return { dockerfile: patchedDockerfile, dashboardRemoteBindPrepared };
}

export function hasPreparedRemoteDashboardBind(dockerfilePath: string): boolean {
  return hasRemoteDashboardBindGenerationContract(
    readDockerfilePatchSnapshot(dockerfilePath).content,
  );
}
