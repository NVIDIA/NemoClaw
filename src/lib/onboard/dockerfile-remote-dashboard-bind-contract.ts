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
  /^RUN\s+(?:NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0\s+)?(?:NEMOCLAW_OPENCLAW_MANAGED_PROXY=0\s+)?node\s+\/scripts\/generate-openclaw-config\.mts$/;
const SAFE_VALIDATION_GENERATOR_RE =
  /^RUN\s+validation_home="\$validation_root\/progressive";\s+HOME=(?:"\$validation_home"|\$validation_home)\s+node\s+\/scripts\/generate-openclaw-config\.mts$/;
const PASSIVE_FINAL_STAGE_INSTRUCTION_RE = /^(?:ARG|ENV|WORKDIR|USER|HEALTHCHECK|ENTRYPOINT|CMD)\b/;
const CONFIG_MODE_RE = /^RUN\s+chmod\s+660\s+\/sandbox\/\.openclaw\/openclaw\.json$/;
const CONFIG_HASH_RE =
  /^RUN\s+sha256sum\s+\/sandbox\/\.openclaw\/openclaw\.json\s+>\s+\/sandbox\/\.openclaw\/\.config-hash(?:\s+&&\s+chmod\s+660\s+\/sandbox\/\.openclaw\/\.config-hash)?(?:\s+&&\s+chown\s+sandbox:sandbox\s+\/sandbox\/\.openclaw\/\.config-hash)?$/;
const MESSAGING_BUILD_APPLIER_RE =
  /^RUN\s+OPENCLAW_VERSION="\$\{OPENCLAW_VERSION\}"\s+node\s+\/src\/lib\/messaging\/applier\/build\/messaging-build-applier\.mts\s+--agent\s+openclaw\s+--phase\s+(?:agent-install|post-agent-install)$/;
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
  "d0ed2268f42964e8a150deb39e68e31313e520503fa2c131a4d7cc8b21191da0",
  "6f457f365f5c0d128e5e3b549a630b5bd9ebd223919f2c2c8e6a31235d763781",
  "dca7d3dbc030e4efa77c850b9d21a826358c69c7d2062f3eee2f5a57eeb07aa2",
  "b01b5f5d2cba5778cd8eb87139f2c6a8174082a7f6775e443a1dbdc0629ce7e5",
  "4a48c125d519e3967d4dfc45bb9970ab1a7ba60336854cc4aed03cde81336f88",
  "e7256f12c618bb424f53fec801378d92446d880c5935965ebb3b548694866b63",
  "4e548aafe9484a887a0ab0cf92ec82f77843fd346de7a2dff50b93ebd632b044",
  "737edaaa69f80cf10d42fd349e0be068c1ef6e7375d5dcb4055b012420b58736",
  "5b814e92449a6778385f588877fe72ebed80e601f8eb0c90c2842b17a489f3da",
  "7c2cf32df8b7ad57a7bc155707df0dd706dd74fe640d726df25f9b8c4d150a90",
  "71abf445c5919eb84d25c3d15fc70ddf71b02eb7e22177794d425e295bb14e5e",
  "a68297161e2c6463440b822f4e4be0518e745fb5fba8c61ab53b876724f7b666",
  "a54e2ac58ef00d7080ad697cb1892bf91b7bffe011f698df17b936c9906cd4af",
  "ca493ae7905fae5c587a8e5c31fcb3d423235940589c2decee99d7b338e87d88",
  "d181ff3c36d8982f78b5627d1f4a02fd30d2667cd1ca8ffb97fb65535ae452ee",
  "6d4094a9d7c21eeb408cadd728da7cd7e0ee9574746436be59c26b218c8ab218",
  "fa9a9916a254ea4faa06339c759b89ade441bd54c22fa8fc4c927547e40ff456",
  // Reviewed NemoClaw runtime-state permissions; the instruction only changes
  // filesystem metadata and preserves the generated dashboard config.
  "d50e094416f150f74c24f81665be08064a1c5bd23c11d29575b20379b5a58ce2",
  "42ef0b12e92ebe146c25367831b4ce3a2664f0fa99fd5e4fb98a8939d3af8800",
  "8b49e78185185f1b7e24d01631186554fef21d2300db65c9bc9998e7ec00469f",
  "a0a554d474cb70087e50686d998915eae06201d6182a2410d3ccc4879e5058e6",
  "9068e33dfc0e794a60149229823fa49f4bf7aeb1f7b06f1fc8c79243a78d002e",
  "715d3a312ee9952d9fe55b827f2c855a078cdfbc2a8d6edeb32699dcaebb952b",
  "1197b99bdb996b37a3e4e386a507dfabcdfb2c26a40b015d617f97208668187d",
  "e4d6ad4cea1f9b676bcd0c11b3665933bc9baf783de1adef782c283775dd5171",
  "c0b409e1bf4d33a9e44f407c6bd9b0445b2ffd0b796823fe3cfa5989314d6603",
  "9fcc674a44a152707380cdb09a67f8594f568288406c96f5354f1c87f5b939a6",
  "83567d1fa0e73bef6a3333383c13ace05e26704964ae6a7a76ee24a2f2be3d7e",
  "ca1f7b1cb9dd5d467f806792c4072a84ef1e6402c3e8650b6325b95cc186ccdf",
  "4e517a6a30d0489c0d3df219f3510189b774da7d8adf1ffa6d09c3283caeb37f",
  "4165899eb1f0f948f8883eddf4136136caac21cee1df39b12afea7672b23a378",
  "7e6a6879382f833f17be02ca7d287685b6afa1c423b1e087b3b05dd677d6e325",
  "4a54da2c1c33c681ae0dad181a5a7456c926051d91420aa60cf7edef6330ba65",
  "e69b86c132e44c502b3dce8b9359c8798079e93489bd2d27f75d514b45502d4e",
  "d4b6c80ecc6f243f2141a439e2690aa563c55e19e7d6f3965d3d8685507866c1",
  "e1b6dca3e6b30624f364b36ff52e654978bc120cc7800df2ff209c14949acd64",
  "c682148fc7efec9f947c326c6029181cd879b7cba3e8361246aba7d0e6fe70a3",
  "2801e488822e10a39a5586bd150279e54df4612e30c2fa782453534a466def59",
  "8f0861e48c0cec37faa662fccd130ab21f972ac3ed2a0ce5f4e5a1e9ec223130",
  "6364b77bae0a2a4449737beefac36c439333a5e37993ac404c02e375aa170515",
  // Reviewed late messaging inputs, metadata setup, npm 12 helper, and runtime assertions.
  "7e5f7e1dfb90e5e4b863afdfb9ba58e57e3693bdc6f47ac8c13e80bdc9eff56b",
  "8f5966da093ef75cefd35c2b7f1361fbf5b32e63a4a8a34cb3ac7f76a1330e5e",
  "4c2f29cb433ff14ca386e71373b53e88c705e2ed255b435715681a0dd64e43f9",
  "0634acc02be0de381a0f706baff09233a1c069d55f6419fea0f385909656e88b",
  "761ea4fbb0da5cf3390ee8f2e56f3703a7da88c96ac47fea89d0fff800f728ae",
  "4e9657fbcb5125375526565714926638d0e7d40d56f2726e3a4c7b02aa42bcd9",
  // Reviewed 2026.9.1 optional-plugin archive verification and neutral union install.
  "2cdccfbeaf58c06c1df1d98b066543b1576d43d5742e8eb98a8c7bc71825adee",
  // The same reviewed install after OpenClaw 2026.9.1 began requiring
  // explicit acceptance of package-declared plugin capabilities.
  "46a1858936c680a21252483515f55ebfa2de65fb4352d27ec71d3aaa8d67dbd5",
  // The same reviewed install with npm forced offline for every optional
  // plugin command; it still preserves the generated dashboard config.
  "a72a06b293274fb997f5a4b8b1c61cf3daa8a7cc4b8385baa0d9dc63400b8d52",
  // Reviewed local NemoClaw plugin installation with explicit capability
  // acceptance; the following inspect and pruning steps are unchanged.
  "464abc5ff104c8bdeae57e6fdb775b7bda7dd756cba0dd1a7752b7d03e8f8372",
  // Reviewed neutral-union validation for OpenClaw 2026.9.1's bundled a2a,
  // reef, and Telegram channel inventory.
  "6727034f71f9fadce7d076d0e9518c288f904b13b2be8037565b61a87b1dfbb0",
  // Reviewed 2026.9.1 legacy-state migration hardening, obsolete exec-approval
  // cleanup, and canonical SQLite ownership repair. This exact instruction
  // preserves the generated openclaw.json dashboard binding.
  "5a05a0165f86404dfab14fcd4b0cc94b97eca42c1ebf264b385b245f323d07d0",
  "76961dfa868381e4fb3756eb8eae0c6645074132bc0e9d96bda7f3058ac12706",
  // Native gateway lifecycle plus the 2026.9.1 canonical pairing-state
  // reader. This merged instruction only hardens installed helper metadata.
  "e119ca83b4982da2201821e5d29bb9964cc9fd1c60dc95cd56a6abcaa17d6416",
  // COPY --from=openclaw-runtime-payload / /
  // The reviewed scratch payload has no /sandbox/.openclaw content, so this
  // exact late copy preserves the generated remote-dashboard configuration.
  "0416afe770a7a4281aca9db4cf13d58f90bbf2b46e8225cbd4d6c2571eb7a9c0",
  // Direct managed-startup runtime validation, modes, and metadata after
  // retiring the standard managed-bootstrap payload.
  "bf6df41d55eb02903bb30facc2cd4952cc0a947ae22eab171ecb7e08f14939d6",
  "8f73b4550983c6eaef623d5a23ffdbdbde46e96ea301f98c6ffcf29c1ba4843b",
  "53b08d415b78bfdebf6939f38293041af436b38f8ae890c409c32aad9a8a3e04",
  // Exact metadata normalization after the managed-bootstrap binary and
  // trampoline were retired; it preserves the generated dashboard config.
  "e24efa55ce02a2d625f14b176393e2000c48a69e55a07ee71200d721dbcad1d1",
  // Exact non-root startup hold copy and image-mode normalization.
  "d54adeffc53c42612daf871fc0d46e2e782976ce8629bebe27758a63065476f0",
  "5966651fd0de01944c8c30587ff99b3f45f69659a7a4b62ed1369a8236d098b7",
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
