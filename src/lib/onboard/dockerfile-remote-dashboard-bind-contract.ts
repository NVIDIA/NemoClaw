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
  /^RUN\s+(?:NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0\s+)?(?:NEMOCLAW_OPENCLAW_MANAGED_PROXY=0\s+)?node\s+--experimental-strip-types\s+\/scripts\/generate-openclaw-config\.mts$/;
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

// Complex RUN instructions and reviewed payload copies in the shipped
// Dockerfile are accepted only as exact normalized instructions. Prefix
// matching here would let a custom Dockerfile append `&& <rewrite
// openclaw.json>` to an otherwise safe command. A lifecycle test verifies
// these digests against the checked-in Dockerfile.
const CANONICAL_POST_GENERATOR_INSTRUCTION_SHA256 = new Set([
  "9300de0b56a7d8a1498fd36cb9c05313b6691d6756b455f91628ed989221afc2",
  "6f457f365f5c0d128e5e3b549a630b5bd9ebd223919f2c2c8e6a31235d763781",
  "dca7d3dbc030e4efa77c850b9d21a826358c69c7d2062f3eee2f5a57eeb07aa2",
  "b01b5f5d2cba5778cd8eb87139f2c6a8174082a7f6775e443a1dbdc0629ce7e5",
  "4a48c125d519e3967d4dfc45bb9970ab1a7ba60336854cc4aed03cde81336f88",
  "e7256f12c618bb424f53fec801378d92446d880c5935965ebb3b548694866b63",
  "4e548aafe9484a887a0ab0cf92ec82f77843fd346de7a2dff50b93ebd632b044",
  "737edaaa69f80cf10d42fd349e0be068c1ef6e7375d5dcb4055b012420b58736",
  "5b814e92449a6778385f588877fe72ebed80e601f8eb0c90c2842b17a489f3da",
  "0e1a9a7bab2fab0a974577c3af8785157b4b9be2b4db32d5f4f9e5aa3c8c8171",
  "ede14966118316b58139830b4a1ffaceca86a6d0857cd0c1705d69db109907b0",
  "a68297161e2c6463440b822f4e4be0518e745fb5fba8c61ab53b876724f7b666",
  "a54e2ac58ef00d7080ad697cb1892bf91b7bffe011f698df17b936c9906cd4af",
  "ca493ae7905fae5c587a8e5c31fcb3d423235940589c2decee99d7b338e87d88",
  "d181ff3c36d8982f78b5627d1f4a02fd30d2667cd1ca8ffb97fb65535ae452ee",
  "6d4094a9d7c21eeb408cadd728da7cd7e0ee9574746436be59c26b218c8ab218",
  "fa9a9916a254ea4faa06339c759b89ade441bd54c22fa8fc4c927547e40ff456",
  "d50e094416f150f74c24f81665be08064a1c5bd23c11d29575b20379b5a58ce2",
  "42ef0b12e92ebe146c25367831b4ce3a2664f0fa99fd5e4fb98a8939d3af8800",
  "8b49e78185185f1b7e24d01631186554fef21d2300db65c9bc9998e7ec00469f",
  "a0a554d474cb70087e50686d998915eae06201d6182a2410d3ccc4879e5058e6",
  "5af905889f94ffed2f6c371111d0589e38eed7b0de54ddb0dd68ad912a23149a",
  "1197b99bdb996b37a3e4e386a507dfabcdfb2c26a40b015d617f97208668187d",
  "c65f4558aa283a73d4043aa7465fe8f4291af0be72ea721d76812095e7be6995",
  "c0b409e1bf4d33a9e44f407c6bd9b0445b2ffd0b796823fe3cfa5989314d6603",
  "9fcc674a44a152707380cdb09a67f8594f568288406c96f5354f1c87f5b939a6",
  "83567d1fa0e73bef6a3333383c13ace05e26704964ae6a7a76ee24a2f2be3d7e",
  "ca1f7b1cb9dd5d467f806792c4072a84ef1e6402c3e8650b6325b95cc186ccdf",
  "4165899eb1f0f948f8883eddf4136136caac21cee1df39b12afea7672b23a378",
  "7e6a6879382f833f17be02ca7d287685b6afa1c423b1e087b3b05dd677d6e325",
  "4a54da2c1c33c681ae0dad181a5a7456c926051d91420aa60cf7edef6330ba65",
  "e958e532c3e770fa426a6662652dbde2ddaeb41a214ccffe2def5a43a8b5b023",
  "c6894538ce0c377566a22b11af9682a9952bfd936fd4d011f6f50da30c8e875e",
  "e1b6dca3e6b30624f364b36ff52e654978bc120cc7800df2ff209c14949acd64",
  "c682148fc7efec9f947c326c6029181cd879b7cba3e8361246aba7d0e6fe70a3",
  "2801e488822e10a39a5586bd150279e54df4612e30c2fa782453534a466def59",
  "8f0861e48c0cec37faa662fccd130ab21f972ac3ed2a0ce5f4e5a1e9ec223130",
  // Reviewed late messaging inputs, metadata setup, and runtime assertions.
  "7e5f7e1dfb90e5e4b863afdfb9ba58e57e3693bdc6f47ac8c13e80bdc9eff56b",
  "8f5966da093ef75cefd35c2b7f1361fbf5b32e63a4a8a34cb3ac7f76a1330e5e",
  "c6b042ac2cc3d5570ae43f1e387a951cbe89fbb22e8cd9df486f99719bb32939",
  "ba29b499af923b4331cf7abf14648f187dc0e0b8f3dc2c33dac61f079981c187",
  "f91353eff1014dbe84120fc954cf2db18be7c3b01b3af95f6bbc0dbb2771003d",
  // COPY --from=openclaw-runtime-payload / /
  // The reviewed scratch payload has no /sandbox/.openclaw content, so this
  // exact late copy preserves the generated remote-dashboard configuration.
  "0416afe770a7a4281aca9db4cf13d58f90bbf2b46e8225cbd4d6c2571eb7a9c0",
]);

function instructionSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const postGeneratorInstructionAllowed = (instruction: DockerfileInstruction): boolean => {
  const { text } = instruction;
  if (PASSIVE_FINAL_STAGE_INSTRUCTION_RE.test(text)) return true;
  if (SAFE_VALIDATION_GENERATOR_RE.test(text)) return true;
  if (EXACT_CUSTOM_POST_GENERATOR_RUN_RE.some((pattern) => pattern.test(text))) return true;
  return CANONICAL_POST_GENERATOR_INSTRUCTION_SHA256.has(instructionSha256(text));
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
