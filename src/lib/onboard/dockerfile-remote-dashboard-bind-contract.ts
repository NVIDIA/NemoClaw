// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  type DockerfileInstruction,
  dockerfileInstructions,
  readDockerfilePatchSnapshot,
} from "./dockerfile-tool-disclosure-contract";

const REMOTE_BIND_ARG_RE = /^ARG\s+NEMOCLAW_DASHBOARD_BIND=/;
const REMOTE_BIND_PATCHED_ARG_RE = /^ARG\s+NEMOCLAW_DASHBOARD_BIND=0\.0\.0\.0$/;
const REMOTE_BIND_PROMOTION_RE = /NEMOCLAW_DASHBOARD_BIND=\$\{NEMOCLAW_DASHBOARD_BIND\}/;
const OPENCLAW_CONFIG_GENERATOR_RE =
  /^RUN\s+(?:NEMOCLAW_OPENCLAW_MANAGED_PROXY=0\s+)?node\s+--experimental-strip-types\s+\/scripts\/generate-openclaw-config\.mts$/;
const SAFE_VALIDATION_GENERATOR_RE =
  /^RUN\s+validation_home="\$validation_root\/progressive";\s+HOME=(?:"\$validation_home"|\$validation_home)\s+node\s+--experimental-strip-types\s+\/scripts\/generate-openclaw-config\.mts$/;
const PASSIVE_FINAL_STAGE_INSTRUCTION_RE = /^(?:ARG|ENV|WORKDIR|USER|HEALTHCHECK|ENTRYPOINT|CMD)\b/;
const CONFIG_MODE_RE = /^RUN\s+chmod\s+660\s+\/sandbox\/\.openclaw\/openclaw\.json$/;
const CONFIG_HASH_RE =
  /^RUN\s+sha256sum\s+\/sandbox\/\.openclaw\/openclaw\.json\s+>\s+\/sandbox\/\.openclaw\/\.config-hash(?:\s+&&\s+chmod\s+660\s+\/sandbox\/\.openclaw\/\.config-hash)?(?:\s+&&\s+chown\s+sandbox:sandbox\s+\/sandbox\/\.openclaw\/\.config-hash)?$/;
const MESSAGING_BUILD_APPLIER_RE =
  /^RUN\s+OPENCLAW_VERSION="\$\{OPENCLAW_VERSION\}"\s+node\s+--experimental-strip-types\s+\/src\/lib\/messaging\/applier\/build\/messaging-build-applier\.mts\s+--agent\s+openclaw\s+--phase\s+(?:agent-install|post-agent-install)$/;
const EXACT_CUSTOM_POST_GENERATOR_RUN_RE = [
  CONFIG_MODE_RE,
  CONFIG_HASH_RE,
  MESSAGING_BUILD_APPLIER_RE,
] as const;

// Complex RUN instructions in the shipped Dockerfile are accepted only as
// exact normalized instructions. Prefix matching here would let a custom
// Dockerfile append `&& <rewrite openclaw.json>` to an otherwise safe command.
// A lifecycle test verifies these digests against the checked-in Dockerfile.
const CANONICAL_POST_GENERATOR_RUN_SHA256 = new Set([
  "e7256f12c618bb424f53fec801378d92446d880c5935965ebb3b548694866b63",
  "862807dd20a2879f49862a7d9d02fbdc2aa1be00539d05c86814b23f451b4a29",
  "737edaaa69f80cf10d42fd349e0be068c1ef6e7375d5dcb4055b012420b58736",
  "5b814e92449a6778385f588877fe72ebed80e601f8eb0c90c2842b17a489f3da",
  "0e1a9a7bab2fab0a974577c3af8785157b4b9be2b4db32d5f4f9e5aa3c8c8171",
  "a68297161e2c6463440b822f4e4be0518e745fb5fba8c61ab53b876724f7b666",
  "865a9e486e1f0f54e33138a94d5cf51feb67daec4b6e6f0e21f9de22ef7e10f7",
  "ca493ae7905fae5c587a8e5c31fcb3d423235940589c2decee99d7b338e87d88",
  "d181ff3c36d8982f78b5627d1f4a02fd30d2667cd1ca8ffb97fb65535ae452ee",
  "6d4094a9d7c21eeb408cadd728da7cd7e0ee9574746436be59c26b218c8ab218",
  "fa9a9916a254ea4faa06339c759b89ade441bd54c22fa8fc4c927547e40ff456",
  "d50e094416f150f74c24f81665be08064a1c5bd23c11d29575b20379b5a58ce2",
  "42ef0b12e92ebe146c25367831b4ce3a2664f0fa99fd5e4fb98a8939d3af8800",
  "8b49e78185185f1b7e24d01631186554fef21d2300db65c9bc9998e7ec00469f",
]);

function instructionSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const postGeneratorInstructionAllowed = (instruction: DockerfileInstruction): boolean => {
  const { text } = instruction;
  if (PASSIVE_FINAL_STAGE_INSTRUCTION_RE.test(text)) return true;
  if (SAFE_VALIDATION_GENERATOR_RE.test(text)) return true;
  if (EXACT_CUSTOM_POST_GENERATOR_RUN_RE.some((pattern) => pattern.test(text))) return true;
  return CANONICAL_POST_GENERATOR_RUN_SHA256.has(instructionSha256(text));
};

const isPrimaryOpenClawConfigGenerator = (instruction: DockerfileInstruction): boolean =>
  OPENCLAW_CONFIG_GENERATOR_RE.test(instruction.text);

export type PatchedRemoteDashboardBindContract = {
  dockerfile: string;
  dashboardRemoteBindPrepared: boolean;
};

export function isRemoteDashboardBindRequested(value: string | undefined): boolean {
  return value === "0.0.0.0";
}

export function patchManagedDeviceAuthOptOutContract(dockerfile: string): string {
  return dockerfile
    .replace(/^ARG NEMOCLAW_DISABLE_DEVICE_AUTH=.*$/m, "ARG NEMOCLAW_DISABLE_DEVICE_AUTH=1")
    .replace(
      /^ARG NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE=.*$/m,
      "ARG NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE=managed-onboard",
    );
}

export function resolveRequestedRemoteDashboardBind(
  value: string | undefined,
  trustedManagedDockerfile: boolean,
): "" | "0.0.0.0" {
  if (value === undefined || value === "") return "";
  if (!isRemoteDashboardBindRequested(value)) {
    throw new Error("NEMOCLAW_DASHBOARD_BIND must be empty or 0.0.0.0.");
  }
  if (!trustedManagedDockerfile) {
    throw new Error(
      "Remote dashboard bind is unavailable with custom --from Dockerfiles until post-build runtime configuration attestation is implemented.",
    );
  }
  return "0.0.0.0";
}

export function patchRequestedRemoteDashboardBindContract(
  dockerfile: string,
  value: string | undefined,
  trustedManagedDockerfile: boolean,
): PatchedRemoteDashboardBindContract {
  return patchRemoteDashboardBindContract(
    dockerfile,
    resolveRequestedRemoteDashboardBind(value, trustedManagedDockerfile),
  );
}

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

export function hasRemoteDashboardBindGenerationContract(dockerfile: string): boolean {
  const finalStage = finalStageInstructions(dockerfile);
  const argIndex = finalStage.findIndex((instruction) =>
    REMOTE_BIND_PATCHED_ARG_RE.test(instruction.text),
  );
  const promotionIndex = finalStage.findIndex(
    (instruction, index) => index > argIndex && REMOTE_BIND_PROMOTION_RE.test(instruction.text),
  );
  const generatorIndex = finalStage.findIndex(
    (instruction, index) => index > promotionIndex && isPrimaryOpenClawConfigGenerator(instruction),
  );
  const invalidatorIndex = finalStage.findIndex(
    (instruction, index) => index > generatorIndex && !postGeneratorInstructionAllowed(instruction),
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
