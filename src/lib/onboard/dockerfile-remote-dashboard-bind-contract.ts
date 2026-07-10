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
const OPENCLAW_CONFIG_GENERATOR_RE =
  /^RUN\b.*\bnode\s+--experimental-strip-types\s+\/scripts\/generate-openclaw-config\.mts\b/;
const SAFE_VALIDATION_GENERATOR_HOME_RE =
  /\bHOME=(?:"\$validation_home"|\$validation_home)(?=\s|$)/;
const PASSIVE_FINAL_STAGE_INSTRUCTION_RE = /^(?:ARG|ENV|WORKDIR|USER|HEALTHCHECK|ENTRYPOINT|CMD)\b/;
const CONFIG_MODE_RE = /^RUN\s+chmod\s+660\s+\/sandbox\/\.openclaw\/openclaw\.json$/;
const CONFIG_HASH_RE =
  /^RUN\s+sha256sum\s+\/sandbox\/\.openclaw\/openclaw\.json\s+>\s+\/sandbox\/\.openclaw\/\.config-hash(?:\s+&&\s+chmod\s+660\s+\/sandbox\/\.openclaw\/\.config-hash)?(?:\s+&&\s+chown\s+sandbox:sandbox\s+\/sandbox\/\.openclaw\/\.config-hash)?$/;
const MESSAGING_BUILD_APPLIER_RE =
  /^RUN\s+OPENCLAW_VERSION="\$\{OPENCLAW_VERSION\}"\s+node\s+--experimental-strip-types\s+\/src\/lib\/messaging\/applier\/build\/messaging-build-applier\.mts\s+--agent\s+openclaw\s+--phase\s+(?:agent-install|post-agent-install)$/;
const OPENCLAW_PLUGIN_INTEGRITY_RE = /^RUN\s+set -eu;\s+verify_openclaw_plugin_integrity\(\) \{/;
const NEMOCLAW_PLUGIN_INSTALL_RE =
  /^RUN\s+NPM_CONFIG_IGNORE_SCRIPTS=true\s+npm_config_ignore_scripts=true\s+openclaw plugins install \/opt\/nemoclaw\b/;
const MANAGED_PROXY_TOKEN_PATCH_RE =
  /^RUN\s+python3 -c ".*path = os\.path\.expanduser\('~\/\.openclaw\/openclaw\.json'\);.*cfg\.setdefault\('gateway', \{\}\)\.setdefault\('auth', \{\}\)\['token'\] = '';.*cfg\['proxy'\] = \{.*'loopbackMode': 'gateway-only'.*json\.dump\(cfg, open\(path, 'w'\), indent=2\);.*os\.chmod\(path, 0o600\)"$/;
const LEGACY_OPENCLAW_LAYOUT_RE =
  /^RUN\s+set -eu;\s+config_dir=\/sandbox\/\.openclaw;\s+data_dir=\/sandbox\/\.openclaw-data;\s+/;
const GROUP_MEMBERSHIP_RE = /^RUN\s+if id gateway\b/;
const OPENCLAW_PERMISSION_RE =
  /^RUN\s+set -eu;\s+if \[ -e \/tmp\/nemoclaw-legacy-openclaw-layout \]; then\b/;
const SHELL_HOOKS_RE = /^RUN\s+chmod 444 \/usr\/local\/lib\/nemoclaw\/sandbox-rlimits\.sh\b/;
const NEMOCLAW_STATE_RE = /^RUN\s+chown root:root \/sandbox\/\.nemoclaw\b/;
const DARWIN_VM_COMPAT_RE = /^RUN\s+if \[ "\$NEMOCLAW_DARWIN_VM_COMPAT" = "1" \]; then\b/;
const OTEL_PROXY_PATCH_RE = /^RUN\s+set -eu;\s+if \[ "\$NEMOCLAW_OPENCLAW_OTEL" = "1" \]; then\b/;

const ALLOWED_POST_GENERATOR_RUN_RE = [
  CONFIG_MODE_RE,
  CONFIG_HASH_RE,
  MESSAGING_BUILD_APPLIER_RE,
  OPENCLAW_PLUGIN_INTEGRITY_RE,
  NEMOCLAW_PLUGIN_INSTALL_RE,
  MANAGED_PROXY_TOKEN_PATCH_RE,
  LEGACY_OPENCLAW_LAYOUT_RE,
  GROUP_MEMBERSHIP_RE,
  OPENCLAW_PERMISSION_RE,
  SHELL_HOOKS_RE,
  NEMOCLAW_STATE_RE,
  DARWIN_VM_COMPAT_RE,
  OTEL_PROXY_PATCH_RE,
] as const;

const postGeneratorInstructionAllowed = (instruction: DockerfileInstruction): boolean => {
  const { text } = instruction;
  if (PASSIVE_FINAL_STAGE_INSTRUCTION_RE.test(text)) return true;
  if (OPENCLAW_CONFIG_GENERATOR_RE.test(text)) {
    return SAFE_VALIDATION_GENERATOR_HOME_RE.test(text);
  }
  return ALLOWED_POST_GENERATOR_RUN_RE.some((pattern) => pattern.test(text));
};

const isPrimaryOpenClawConfigGenerator = (instruction: DockerfileInstruction): boolean =>
  OPENCLAW_CONFIG_GENERATOR_RE.test(instruction.text) &&
  !SAFE_VALIDATION_GENERATOR_HOME_RE.test(instruction.text);

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
