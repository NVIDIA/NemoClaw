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
const OPENCLAW_CONFIG_TARGET_RE = `(?:/sandbox/|\\$HOME/|~/)?\\.openclaw/openclaw\\.json\\b`;
const OPENCLAW_CONFIG_REDIRECT_OVERWRITE_RE = new RegExp(
  `(?:^|[\\s;&|])(?:[0-9]?>|>>)\\s*["']?${OPENCLAW_CONFIG_TARGET_RE}`,
);
const OPENCLAW_CONFIG_COPY_OVERWRITE_RE = new RegExp(
  `\\b(?:cp|mv|install)\\b[\\s\\S]*\\s["']?${OPENCLAW_CONFIG_TARGET_RE}`,
);
const OPENCLAW_CONFIG_IN_PLACE_EDIT_RE = new RegExp(
  `\\b(?:sed|perl)\\b[\\s\\S]*\\s-i\\b[\\s\\S]*${OPENCLAW_CONFIG_TARGET_RE}`,
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

function invalidatesGeneratedOpenClawConfig(instruction: DockerfileInstruction): boolean {
  return (
    OPENCLAW_CONFIG_REDIRECT_OVERWRITE_RE.test(instruction.text) ||
    OPENCLAW_CONFIG_COPY_OVERWRITE_RE.test(instruction.text) ||
    OPENCLAW_CONFIG_IN_PLACE_EDIT_RE.test(instruction.text) ||
    (OPENCLAW_CONFIG_GENERATOR_RE.test(instruction.text) &&
      !SAFE_VALIDATION_GENERATOR_HOME_RE.test(instruction.text))
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
      index > generatorIndex && invalidatesGeneratedOpenClawConfig(instruction),
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
