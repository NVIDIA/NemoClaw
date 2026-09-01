// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { type E2eAgentRuntime, validateE2eExecutionMetadata } from "./execution-coverage.mts";
import {
  ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
  ONBOARD_SINGLE_FINAL_HANDOFF_TARGET_TIMEOUT_MINUTES,
} from "./onboard-timeout-contract.mts";
import { normalizeE2eSelectorId } from "./selector-aliases.mts";

export const E2E_EXECUTION_PROFILES = [
  "standard",
  "nvidia-api",
  "nvidia-inference",
  "github-read",
  "brave-nvidia-inference",
] as const;
export type E2eExecutionProfile = (typeof E2E_EXECUTION_PROFILES)[number];

export const E2E_INSTALL_MODES = ["none", "authenticated", "credential-free"] as const;
export type E2eInstallMode = (typeof E2E_INSTALL_MODES)[number];

export const E2E_HOST_PACKAGES = ["expect", "iptables"] as const;
export type E2eHostPackage = (typeof E2E_HOST_PACKAGES)[number];

export const E2E_CATALOGUE_RUNNER_KEYS = [
  "channels-stop-start-hermes",
  "common-egress-agent",
  "hermes-discord",
  "hermes-inference-switch",
  "hermes-shields-config",
  "rebuild-hermes",
  "rebuild-hermes-stale-base",
  "security-posture-hermes",
] as const;

export const E2E_HOST_PREPARATIONS = ["none", "hermes-swap", "rebuild-swap"] as const;
export type E2eHostPreparation = (typeof E2E_HOST_PREPARATIONS)[number];

export const E2E_ARTIFACT_LAYOUTS = ["target-shard", "flat-shard"] as const;
export type E2eArtifactLayout = (typeof E2E_ARTIFACT_LAYOUTS)[number];

export const E2E_OPTIONAL_CREDENTIALS = ["BRAVE_API_KEY"] as const;
export type E2eOptionalCredential = (typeof E2E_OPTIONAL_CREDENTIALS)[number];

export interface E2eCatalogueTarget {
  id: string;
  targetId: string;
  displayName: string;
  agentRuntime: E2eAgentRuntime;
  environmentOrInferenceEndpoint: string;
  unresolvedReason: string;
  testFile: string;
  profile: E2eExecutionProfile;
  runner: string;
  runnerKey: string;
  owningPaths: readonly string[];
  releaseRequired: boolean;
  timeoutMinutes: number;
  installMode: E2eInstallMode;
  installNonInteractive: boolean;
  restoreCli: boolean;
  exposeCliBin: boolean;
  cloudflared: boolean;
  hostPackages: readonly E2eHostPackage[];
  hostPreparation: E2eHostPreparation;
  runnerComparison: boolean;
  runnerPressure: boolean;
  compatibleApiKey: boolean;
  requiredOptionalCredentials: readonly E2eOptionalCredential[];
  prAdvisorSelectable: boolean;
  shard: string;
  artifactLayout: E2eArtifactLayout;
  selector?: string;
  environment: Readonly<Record<string, string>>;
}

export interface E2eCatalogueMatrixRow {
  id: string;
  target_id: string;
  display_name: string;
  agent_runtime: E2eAgentRuntime;
  observable_outcome: string;
  environment_or_inference_endpoint: string;
  unresolved_reason: string;
  runner: string;
  runner_key: string;
  test_file: string;
  timeout_minutes: number;
  install_mode: E2eInstallMode;
  install_non_interactive: boolean;
  restore_cli: boolean;
  cloudflared: boolean;
  host_packages: string;
  host_preparation: E2eHostPreparation;
  runner_comparison: boolean;
  runner_pressure: boolean;
  compatible_api_key: boolean;
  shard: string;
  artifact_layout: E2eArtifactLayout;
}

type TargetOptions = Omit<
  E2eCatalogueTarget,
  | "id"
  | "testFile"
  | "owningPaths"
  | "releaseRequired"
  | "agentRuntime"
  | "environmentOrInferenceEndpoint"
  | "unresolvedReason"
  | "environment"
  | "hostPackages"
  | "cloudflared"
  | "installNonInteractive"
  | "runner"
  | "runnerKey"
  | "targetId"
  | "hostPreparation"
  | "runnerComparison"
  | "runnerPressure"
  | "compatibleApiKey"
  | "requiredOptionalCredentials"
  | "prAdvisorSelectable"
  | "shard"
  | "artifactLayout"
> & {
  agentRuntime: E2eAgentRuntime;
  environmentOrInferenceEndpoint: string;
  unresolvedReason?: string;
  owningPaths?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  hostPackages?: readonly E2eHostPackage[];
  cloudflared?: boolean;
  installNonInteractive?: boolean;
  runner?: string;
  runnerKey?: string;
  targetId?: string;
  hostPreparation?: E2eHostPreparation;
  runnerComparison?: boolean;
  runnerPressure?: boolean;
  compatibleApiKey?: boolean;
  requiredOptionalCredentials?: readonly E2eOptionalCredential[];
  prAdvisorSelectable?: boolean;
  shard?: string;
  artifactLayout?: E2eArtifactLayout;
  testFile?: string;
};

function target(id: string, options: TargetOptions): E2eCatalogueTarget {
  const {
    displayName,
    agentRuntime,
    environmentOrInferenceEndpoint,
    unresolvedReason = "",
    owningPaths = [],
    environment = {},
    hostPackages = [],
    cloudflared = false,
    installNonInteractive = false,
    runner = "ubuntu-latest",
    runnerKey = "",
    targetId = id,
    hostPreparation = "none",
    runnerComparison = false,
    runnerPressure = false,
    compatibleApiKey = false,
    requiredOptionalCredentials = [],
    prAdvisorSelectable = false,
    shard = "default",
    artifactLayout = "target-shard",
    testFile = `test/e2e/live/${id}.test.ts`,
    ...execution
  } = options;
  return {
    id,
    displayName,
    agentRuntime,
    environmentOrInferenceEndpoint,
    unresolvedReason,
    testFile,
    owningPaths: [testFile, ...owningPaths],
    releaseRequired: true,
    runner,
    runnerKey,
    targetId,
    environment,
    hostPackages,
    cloudflared,
    hostPreparation,
    runnerComparison,
    runnerPressure,
    compatibleApiKey,
    requiredOptionalCredentials,
    prAdvisorSelectable,
    shard,
    artifactLayout,
    installNonInteractive,
    ...execution,
  };
}

const hostedInference = {
  NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
} as const;

const nonInteractive = {
  NEMOCLAW_NON_INTERACTIVE: "1",
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
} as const;

// Keep every checked-in input copied by the Pi Dockerfiles in the PR selection boundary.
// test/e2e/support/pi-agent-qualification-events.test.ts verifies this list against the
// real Dockerfiles so a new COPY instruction cannot silently reuse a stale image receipt.
const PI_IMAGE_SOURCE_OWNING_PATHS = [
  ".dockerignore",
  "agents/pi/",
  "nemoclaw-blueprint/",
  "scripts/lib/bundled-npm-package.mts",
  "scripts/lib/entrypoint-env-wrapper.sh",
  "scripts/lib/patch-bundled-npm-ip-address.mts",
  "scripts/lib/reviewed-npm-archive.mts",
  "scripts/lib/sandbox-rlimits.sh",
  "scripts/managed-bootstrap-entrypoint.c",
  "scripts/managed-bootstrap-trampoline.sh",
  "scripts/managed-startup-hold.sh",
  "scripts/patch-bundled-npm-brace-expansion.mts",
  "scripts/patch-bundled-npm-tar.mts",
  "scripts/security/build-native-security-packages.sh",
  "scripts/security/build-perl-security-packages.sh",
  "scripts/security/patches/libssh2-1.11.1-cve-2026.patch",
  "scripts/security/patches/perl-5.44.0-net-ping-capability-tests.patch",
  "scripts/security/patches/python3.13-htmlparser-cve-2026-15308.patch",
  "scripts/upgrade-bundled-npm.mts",
  "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-image-runtime.bundle",
] as const;

function commonEgressTarget(options: {
  displayName: string;
  environment?: Readonly<Record<string, string>>;
  environmentOrInferenceEndpoint: string;
  hermes?: boolean;
  owningPaths?: readonly string[];
  profile?: E2eExecutionProfile;
  requiredOptionalCredentials?: readonly E2eOptionalCredential[];
  runnerComparison?: boolean;
  selector: string;
  shard: string;
}): E2eCatalogueTarget {
  return target(`common-egress-agent-${options.shard}`, {
    targetId: "common-egress-agent",
    displayName: options.displayName,
    agentRuntime: options.hermes ? "hermes" : "openclaw",
    environmentOrInferenceEndpoint: options.environmentOrInferenceEndpoint,
    profile: options.profile ?? "brave-nvidia-inference",
    requiredOptionalCredentials: options.requiredOptionalCredentials,
    testFile: "test/e2e/live/common-egress-agent.test.ts",
    timeoutMinutes: 60,
    installMode: "credential-free",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    runnerKey: "common-egress-agent",
    hostPreparation: options.hermes ? "hermes-swap" : "none",
    runnerComparison: options.runnerComparison ?? true,
    shard: options.shard,
    selector: options.selector,
    owningPaths: [
      "test/e2e/live/common-egress-agent-helpers.ts",
      ...(options.hermes ? [] : ["test/e2e/live/openclaw-agent-assertion.ts"]),
      ...(options.owningPaths ?? []),
    ],
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_RECREATE_SANDBOX: "1",
      OPENSHELL_GATEWAY: "nemoclaw",
      ...options.environment,
    },
  });
}

interface GatewayUpgradeTargetOptions {
  commit: string;
  currentOpenClawVersion?: string;
  displayName: string;
  installerSha256: string;
  nemoclawRef: string;
  openClawVersion: string;
  openShellVersion: string;
  runner?: string;
  sandboxBaseImageRef: string;
  shard: string;
  stateUpgrade?: boolean;
}

function gatewayUpgradeTarget(options: GatewayUpgradeTargetOptions): E2eCatalogueTarget {
  return target(`openshell-gateway-upgrade-${options.shard}`, {
    targetId: "openshell-gateway-upgrade",
    displayName: options.displayName,
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint:
      options.runner === "ubuntu-24.04-arm"
        ? "Arm64 Ubuntu; GitHub release artifacts; no inference endpoint"
        : "x86-64 Ubuntu; GitHub release artifacts; no inference endpoint",
    profile: "github-read",
    runner: options.runner ?? "ubuntu-latest",
    testFile: "test/e2e/live/openshell-gateway-upgrade.test.ts",
    timeoutMinutes: 70,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    shard: options.shard,
    owningPaths: [
      "test/e2e/live/openshell-gateway-upgrade-helpers.ts",
      "test/e2e/live/openshell-gateway-upgrade-old-installer.ts",
    ],
    environment: {
      ...nonInteractive,
      NEMOCLAW_GATEWAY_UPGRADE_SURVIVOR_NAME: "e2e-gw-survivor",
      NEMOCLAW_OLD_NEMOCLAW_REF: options.nemoclawRef,
      NEMOCLAW_OLD_NEMOCLAW_COMMIT: options.commit,
      NEMOCLAW_OLD_INSTALLER_SHA256: options.installerSha256,
      NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF: options.sandboxBaseImageRef,
      NEMOCLAW_OLD_OPENSHELL_VERSION: options.openShellVersion,
      NEMOCLAW_OLD_OPENCLAW_VERSION: options.openClawVersion,
      NEMOCLAW_CURRENT_OPENCLAW_VERSION: options.currentOpenClawVersion ?? "",
      NEMOCLAW_OPENCLAW_STATE_UPGRADE_PROOF: options.stateUpgrade ? "1" : "",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  });
}

const GATEWAY_UPGRADE_FIXTURES = [
  {
    displayName: "Upgrade: preserves v0.0.36 state on x86-64",
    shard: "v0-0-36-x86-64",
    nemoclawRef: "v0.0.36",
    commit: "3351fbdd4eb7d9b80ec471545083956327da2b10",
    installerSha256: "0c42400a0d3867739f1d75d612e069967be4506e169974bbbebf14b7af39144f",
    sandboxBaseImageRef:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6",
    openShellVersion: "0.0.36",
    openClawVersion: "2026.4.24",
  },
  {
    displayName: "Upgrade: preserves v0.0.55 state on x86-64",
    shard: "v0-0-55-x86-64",
    nemoclawRef: "v0.0.55",
    commit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
    installerSha256: "ff8cf448e4d17b00421545a1f333262b615b1b0aa236d0cc5aeaf4e2cae2d897",
    sandboxBaseImageRef:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
    openShellVersion: "0.0.44",
    openClawVersion: "2026.5.22",
  },
  {
    displayName: "Upgrade: preserves v0.0.55 state on Arm64",
    runner: "ubuntu-24.04-arm",
    shard: "v0-0-55-aarch64",
    nemoclawRef: "v0.0.55",
    commit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
    installerSha256: "ff8cf448e4d17b00421545a1f333262b615b1b0aa236d0cc5aeaf4e2cae2d897",
    sandboxBaseImageRef:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
    openShellVersion: "0.0.44",
    openClawVersion: "2026.5.22",
  },
  {
    displayName: "Upgrade: preserves v0.0.74 state on x86-64",
    shard: "v0-0-74-x86-64",
    nemoclawRef: "v0.0.74",
    commit: "3a05b54e8ec3e1d5550ec5c728de54af872bffe3",
    installerSha256: "a0cd3feca488d247e53d59d7d8246d2b86e75e95acb5e7d78504b3c0c60fd7db",
    sandboxBaseImageRef:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6",
    openShellVersion: "0.0.72",
    openClawVersion: "2026.5.27",
  },
  {
    displayName: "Upgrade: migrates v0.0.89 state on x86-64",
    shard: "v0-0-89-x86-64",
    nemoclawRef: "v0.0.89",
    commit: "1143aa5cce77f3bad1b3b5588bd7fddbe438237e",
    installerSha256: "00f24959e5ca68104fe91221c0a015dab6a4154618497fa36b969b661f418cc2",
    sandboxBaseImageRef:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1",
    openShellVersion: "0.0.85",
    openClawVersion: "2026.6.10",
    currentOpenClawVersion: "2026.7.1",
    stateUpgrade: true,
  },
] as const satisfies readonly GatewayUpgradeTargetOptions[];

const GATEWAY_UPGRADE_TARGETS = GATEWAY_UPGRADE_FIXTURES.map(gatewayUpgradeTarget);
const GATEWAY_UPGRADE_TARGET_BY_ID = new Map(
  GATEWAY_UPGRADE_TARGETS.map((entry) => [entry.id, entry]),
);

export const E2E_CATALOGUE_EXCLUSION_REASONS = {
  "issue-4434-tui-unreachable-inference":
    "the nvidia-inference profile uses gateway-managed inference, which this test skips by design",
  "overlayfs-autofix":
    "the managed Linux Docker gateway bypasses the legacy overlayfs autofix path",
} as const satisfies Readonly<Record<string, string>>;

export function catalogueExclusionReason(id: string): string | undefined {
  return Object.hasOwn(E2E_CATALOGUE_EXCLUSION_REASONS, id)
    ? E2E_CATALOGUE_EXCLUSION_REASONS[id as keyof typeof E2E_CATALOGUE_EXCLUSION_REASONS]
    : undefined;
}

export const E2E_TARGET_CATALOGUE: readonly E2eCatalogueTarget[] = [
  target("agent-turn-latency", {
    displayName: "Performance: bounds hosted inference turns for OpenClaw and Hermes",
    agentRuntime: "openclaw + hermes",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    prAdvisorSelectable: true,
    timeoutMinutes: 110,
    installMode: "authenticated",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    hostPreparation: "hermes-swap",
    runnerComparison: true,
    compatibleApiKey: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_E2E_INFERENCE_MODE: "internal-nvidia",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("bedrock-runtime-compatible-anthropic-openclaw", {
    targetId: "bedrock-runtime-compatible-anthropic",
    displayName: "Inference: OpenClaw routes an Anthropic request through Amazon Bedrock",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; Amazon Bedrock Anthropic-compatible endpoint",
    profile: "standard",
    testFile: "test/e2e/live/bedrock-runtime-compatible-anthropic.test.ts",
    timeoutMinutes: 60,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    shard: "openclaw",
    environment: {
      ...nonInteractive,
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_SANDBOX_NAME: "e2e-oc-bedrock",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("bedrock-runtime-compatible-anthropic-hermes", {
    targetId: "bedrock-runtime-compatible-anthropic",
    displayName: "Inference: Hermes routes an Anthropic request through Amazon Bedrock",
    agentRuntime: "hermes",
    environmentOrInferenceEndpoint: "Ubuntu; Amazon Bedrock Anthropic-compatible endpoint",
    profile: "standard",
    testFile: "test/e2e/live/bedrock-runtime-compatible-anthropic.test.ts",
    timeoutMinutes: 60,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    hostPreparation: "hermes-swap",
    shard: "hermes",
    environment: {
      ...nonInteractive,
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_SANDBOX_NAME: "e2e-hm-bedrock",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("bootstrap-install-smoke", {
    displayName: "Install: bootstraps NemoClaw and completes hosted inference",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    prAdvisorSelectable: true,
    timeoutMinutes: 30,
    installMode: "none",
    restoreCli: false,
    exposeCliBin: false,
    compatibleApiKey: true,
    environment: {
      ...hostedInference,
      NEMOCLAW_SANDBOX_NAME: "e2e-bootstrap",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      SKIP_DOCKER_PULL: "1",
    },
  }),
  target("brave-search", {
    displayName: "Search: OpenClaw returns a Brave result without exposing its key",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and Brave Search",
    profile: "brave-nvidia-inference",
    requiredOptionalCredentials: ["BRAVE_API_KEY"],
    timeoutMinutes: 45,
    installMode: "authenticated",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-brave-search",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("channels-add-remove", {
    displayName: "Messaging: adds and removes Telegram configuration",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; no inference endpoint",
    profile: "standard",
    timeoutMinutes: 75,
    installMode: "credential-free",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-ch-add-remove",
      OPENSHELL_GATEWAY: "nemoclaw",
      TELEGRAM_BOT_TOKEN: "test-fake-telegram-token-add-remove-e2e",
      TELEGRAM_ALLOWED_IDS: "123456789",
      TELEGRAM_REQUIRE_MENTION: "0",
    },
  }),
  target("channels-stop-start-openclaw", {
    targetId: "channels-stop-start",
    displayName: "Messaging: OpenClaw preserves channels across stop and start",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    prAdvisorSelectable: true,
    testFile: "test/e2e/live/channels-stop-start.test.ts",
    timeoutMinutes: 90,
    installMode: "credential-free",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    shard: "openclaw",
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_CHANNELS_STOP_START_AGENT: "openclaw",
      NEMOCLAW_SANDBOX_NAME: "e2e-oc-ch-cycle",
      OPENSHELL_GATEWAY: "nemoclaw",
      TELEGRAM_BOT_TOKEN: "test-fake-telegram-token-stop-start-openclaw",
      DISCORD_BOT_TOKEN: "test-fake-discord-token-stop-start-openclaw",
      SLACK_BOT_TOKEN: "xoxb-fake-slack-token-stop-start-openclaw",
      SLACK_APP_TOKEN: "xapp-fake-slack-token-stop-start-openclaw",
      WECHAT_BOT_TOKEN: "test-fake-wechat-token-stop-start-openclaw",
    },
  }),
  target("channels-stop-start-hermes", {
    targetId: "channels-stop-start",
    displayName: "Messaging: Hermes preserves channels across stop and start",
    agentRuntime: "hermes",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    prAdvisorSelectable: true,
    testFile: "test/e2e/live/channels-stop-start.test.ts",
    timeoutMinutes: 90,
    installMode: "credential-free",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    runnerKey: "channels-stop-start-hermes",
    hostPreparation: "hermes-swap",
    runnerComparison: true,
    shard: "hermes",
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_CHANNELS_STOP_START_AGENT: "hermes",
      NEMOCLAW_SANDBOX_NAME: "e2e-hm-ch-cycle",
      OPENSHELL_GATEWAY: "nemoclaw",
      TELEGRAM_BOT_TOKEN: "test-fake-telegram-token-stop-start-hermes",
      DISCORD_BOT_TOKEN: "test-fake-discord-token-stop-start-hermes",
      SLACK_BOT_TOKEN: "xoxb-fake-slack-token-stop-start-hermes",
      SLACK_APP_TOKEN: "xapp-fake-slack-token-stop-start-hermes",
      WECHAT_BOT_TOKEN: "test-fake-wechat-token-stop-start-hermes",
    },
  }),
  target("cloud-inference", {
    displayName: "Inference: OpenClaw uses hosted inference",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 50,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...hostedInference,
      NEMOCLAW_SANDBOX_NAME: "e2e-cloud-inference",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  commonEgressTarget({
    displayName: "Networking: OpenClaw answers through balanced egress",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and public weather endpoint",
    shard: "openclaw-balanced-weather",
    selector: "^common-egress.+C1.+$",
    requiredOptionalCredentials: ["BRAVE_API_KEY"],
  }),
  commonEgressTarget({
    displayName: "Networking: OpenClaw reaches a public reference through open egress",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and public reference endpoint",
    shard: "openclaw-open-reference",
    selector: "^common-egress.+C2.+$",
  }),
  commonEgressTarget({
    displayName: "Networking: Hermes reaches a public reference through open egress",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and public reference endpoint",
    hermes: true,
    shard: "hermes-open-reference",
    selector: "^common-egress.+C3.+$",
  }),
  commonEgressTarget({
    displayName: "Networking: Personal public fetch without Brave Search or Tavily Search API keys",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and public Wikidata endpoint",
    profile: "nvidia-inference",
    runnerComparison: false,
    owningPaths: [
      "nemoclaw-blueprint/policies/presets/personal-open-internet.yaml",
      "nemoclaw-blueprint/policies/tiers.yaml",
      "src/lib/onboard/policy-selection.ts",
      "src/lib/onboard/policy-tier-suppression.ts",
      "src/lib/policy/index.ts",
    ],
    shard: "openclaw-personal-public-fetch",
    selector: "^common-egress.+C4.+$",
    environment: {
      BRAVE_API_KEY: "",
      NEMOCLAW_WEB_SEARCH_ENABLED: "0",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "none",
      TAVILY_API_KEY: "",
    },
  }),
  target("concurrent-gateway-ports", {
    displayName: "Gateway: isolates ports for concurrent sandboxes",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu Docker host; local gateway; no inference endpoint",
    profile: "standard",
    timeoutMinutes: 90,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: nonInteractive,
  }),
  target("cron-preflight-inference-local", {
    displayName: "Preflight: reaches managed inference without DNS failure",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu Docker host; local managed inference",
    profile: "nvidia-inference",
    timeoutMinutes: 45,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: ["test/e2e/live/network-policy-transient-provider.ts"],
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-cron-preflight",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("dashboard-remote-bind", {
    displayName: "Dashboard: retains audit findings when bound remotely",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 65,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: ["test/e2e/live/json-envelope.ts"],
    environment: {
      ...hostedInference,
      NEMOCLAW_E2E_DASHBOARD_REMOTE_BIND: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-dashboard-bind",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("device-auth-health", {
    displayName: "Health: treats a 401 authentication response as reachable",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; local authentication fixture; no inference endpoint",
    profile: "standard",
    timeoutMinutes: 40,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-health-auth",
      NEMOCLAW_DASHBOARD_PORT: "18789",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("double-onboard", {
    displayName: "Onboarding: reuses the gateway and preserves sibling sandboxes",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu Docker host; local gateway fixtures",
    profile: "standard",
    timeoutMinutes: 90,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: nonInteractive,
  }),
  target("gpu-double-onboard", {
    displayName: "Onboarding: preserves Ollama authentication after GPU re-onboarding",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "NVIDIA GPU runner; local Ollama",
    profile: "standard",
    runner: "linux-amd64-gpu-rtxpro6000-latest-1",
    timeoutMinutes: 100,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...nonInteractive,
      NEMOCLAW_MODEL: "qwen3.5:9b",
      NEMOCLAW_SANDBOX_NAME: "e2e-gpu-double",
      NEMOCLAW_PROVIDER: "ollama",
      NEMOCLAW_OLLAMA_PROXY_PORT: "11435",
    },
  }),
  target("gpu-e2e", {
    displayName: "Inference: validates OpenClaw and Hermes turns through GPU Ollama",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "NVIDIA GPU runner; local Ollama",
    profile: "standard",
    runner: "linux-amd64-gpu-rtxpro6000-latest-1",
    timeoutMinutes: 90,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: ["test/e2e/live/hermes-cli-adapter-live.ts"],
    environment: {
      ...nonInteractive,
      NEMOCLAW_MODEL: "qwen3.5:9b",
      NEMOCLAW_PROVIDER: "ollama",
      NEMOCLAW_OLLAMA_PULL_TIMEOUT: "2400",
      NEMOCLAW_SANDBOX_NAME: "e2e-gpu-ollama",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("full-e2e", {
    displayName: "OpenClaw: installs, onboards, and completes an agent turn",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 75,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: [
      "test/e2e/live/launch-agent-turn.ts",
      "test/e2e/live/pr-base-comparison.ts",
      "src/lib/tunnel/gateway-stop-script.ts",
    ],
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-full",
    },
  }),
  target("gateway-guard-recovery", {
    displayName: "Gateway: restores the guard chain after recreation",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 45,
    installMode: "authenticated",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: ["test/e2e/live/gateway-guard-legacy-keepalive-fixture.ts"],
    environment: {
      ...hostedInference,
      ...nonInteractive,
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("hermes-discord", {
    displayName: "Messaging: Hermes preserves Discord configuration across rebuild",
    agentRuntime: "hermes",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and Discord",
    profile: "nvidia-inference",
    prAdvisorSelectable: true,
    timeoutMinutes: 90,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    runnerKey: "hermes-discord",
    hostPreparation: "hermes-swap",
    runnerComparison: true,
    environment: {
      ...hostedInference,
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_POLICY_TIER: "open",
      NEMOCLAW_SANDBOX_NAME: "e2e-hermes-discord",
      OPENSHELL_GATEWAY: "nemoclaw",
      DISCORD_BOT_TOKEN: "test-fake-discord-token-hermes-e2e",
      DISCORD_SERVER_IDS: "1491590992753590594",
      DISCORD_ALLOWED_IDS: "1005536447329222676",
      DISCORD_REQUIRE_MENTION: "0",
    },
  }),
  target("hermes-inference-switch", {
    displayName: "Inference: Hermes switches to an Anthropic-compatible endpoint",
    agentRuntime: "hermes",
    environmentOrInferenceEndpoint: "Ubuntu; Anthropic-compatible inference fixture",
    profile: "standard",
    timeoutMinutes: 55,
    installMode: "authenticated",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    runnerKey: "hermes-inference-switch",
    hostPreparation: "hermes-swap",
    runnerComparison: true,
    shard: "anthropic",
    environment: {
      ...nonInteractive,
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_SANDBOX_NAME: "e2e-hm-inf-switch",
      NEMOCLAW_SWITCH_PROVIDER: "compatible-anthropic-endpoint",
      NEMOCLAW_SWITCH_MODEL: "mock-anthropic-model",
      NEMOCLAW_SWITCH_INFERENCE_API: "anthropic-messages",
      NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "1",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("hermes-shields-config", {
    displayName: "Shields: restores stopped Hermes across posture changes",
    agentRuntime: "hermes",
    environmentOrInferenceEndpoint: "Ubuntu Docker host; no inference endpoint",
    profile: "standard",
    timeoutMinutes: 60,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: false,
    runnerKey: "hermes-shields-config",
    hostPreparation: "hermes-swap",
    runnerComparison: true,
    environment: {
      ...nonInteractive,
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_SANDBOX_NAME: "e2e-hermes-shields",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("hermes-slack", {
    displayName: "Messaging: isolates Hermes Slack credentials and reaches Slack APIs",
    agentRuntime: "hermes",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and Slack",
    profile: "nvidia-inference",
    runner: "linux-amd64-cpu4",
    testFile: "test/e2e/live/hermes-slack-e2e.test.ts",
    timeoutMinutes: 75,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: ["test/e2e/live/hermes-slack-e2e-helpers.ts"],
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_POLICY_TIER: "open",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-hermes-slack",
      OPENSHELL_GATEWAY: "nemoclaw",
      SLACK_APP_TOKEN: "xapp-test-hermes-slack-app-token",
      SLACK_BOT_TOKEN: "xoxb-test-hermes-slack-token",
    },
  }),
  target("issue-2478-crash-loop-recovery", {
    displayName: "Gateway: recovers after process termination and remains stable",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu Docker host; local gateway; no inference endpoint",
    profile: "standard",
    timeoutMinutes: 30,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-2478",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("issue-4462-scope-upgrade-approval", {
    displayName: "Authorization: approves a write-scope upgrade without operator.admin",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 90,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-issue-4462",
    },
  }),
  target("inference-routing", {
    displayName: "Inference: rejects unsafe routes and proves runtime identities",
    agentRuntime: "openclaw + langchain-deepagents-code",
    environmentOrInferenceEndpoint: "Ubuntu; local compatible and HTTPS inference fixtures",
    profile: "standard",
    timeoutMinutes: ONBOARD_SINGLE_FINAL_HANDOFF_TARGET_TIMEOUT_MINUTES,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: false,
    cloudflared: true,
    owningPaths: ["tools/e2e/onboard-timeout-contract.mts"],
  }),
  target("kimi-inference-compat", {
    displayName: "Inference: configures a Kimi-compatible endpoint",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; Kimi-compatible inference fixture",
    profile: "standard",
    timeoutMinutes: 50,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-kimi-compat",
      NEMOCLAW_E2E_INFERENCE_MODE: "mock",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("llama-cpp-generic-gpu", {
    displayName: "Inference: completes an agent turn with llama.cpp on a generic NVIDIA GPU",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "NVIDIA GPU runner; local llama.cpp",
    profile: "standard",
    runner: "linux-amd64-gpu-rtxpro6000-latest-1",
    timeoutMinutes: 120,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...nonInteractive,
      NEMOCLAW_PROVIDER: "install-llama-cpp",
      NEMOCLAW_LLAMACPP_RECIPE: "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1",
      NEMOCLAW_SANDBOX_NAME: "e2e-llamacpp-gpu",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("messaging-compatible-endpoint", {
    displayName: "Messaging: routes Telegram through a compatible endpoint",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; compatible inference and Telegram fixtures",
    profile: "standard",
    timeoutMinutes: 45,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      NEMOCLAW_SANDBOX_NAME: "e2e-msg-compat",
      OPENSHELL_GATEWAY: "nemoclaw",
      NEMOCLAW_COMPAT_MOCK_API_KEY: "fake-compatible-key-e2e",
      TELEGRAM_ALLOWED_IDS: "123456789",
      TELEGRAM_BOT_TOKEN: "test-fake-telegram-token-e2e",
    },
  }),
  target("model-router-provider-routed-inference", {
    displayName: "Inference: Model Router returns a provider-routed response",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA API and Model Router",
    profile: "nvidia-api",
    timeoutMinutes: 45,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    environment: { OPENSHELL_GATEWAY: "nemoclaw" },
  }),
  target("network-policy", {
    displayName: "Network policy: enforces restricted allow and deny rules",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and network probes",
    profile: "nvidia-inference",
    timeoutMinutes: 90,
    installMode: "credential-free",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    hostPackages: ["expect"],
    selector: "^network-policy:.+probes$",
    owningPaths: [
      "test/e2e/live/network-policy-denied-log.ts",
      "test/e2e/live/network-policy-inference.ts",
      "test/e2e/live/network-policy-interactive.ts",
      "test/e2e/live/network-policy-transient-provider.ts",
      "test/e2e/live/package-database-read-only.ts",
      "test/e2e/live/policy-list-state.ts",
      "test/e2e/live/restricted-onboard-helpers.ts",
    ],
    environment: {
      ...hostedInference,
      NEMOCLAW_E2E_SHARD: "live-probes",
      NEMOCLAW_SANDBOX_NAME: "e2e-net-policy",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("ollama-auth-proxy", {
    displayName: "Inference: Ollama proxy enforces and preserves authentication",
    agentRuntime: "none",
    environmentOrInferenceEndpoint: "Ubuntu Docker host; local Ollama proxy",
    profile: "standard",
    timeoutMinutes: 45,
    installMode: "none",
    restoreCli: false,
    exposeCliBin: false,
    environment: {
      NEMOCLAW_E2E_OLLAMA_PORT: "11434",
      NEMOCLAW_E2E_OLLAMA_PROXY_PORT: "11435",
    },
  }),
  target("onboard-repair", {
    displayName: "Onboarding: repairs a missing sandbox and rejects conflicting resume input",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu Docker host; local onboarding fixtures",
    profile: "standard",
    timeoutMinutes: 75,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: { ...nonInteractive, NEMOCLAW_SANDBOX_NAME: "e2e-repair" },
  }),
  target("onboard-policy-preset-sequencing", {
    displayName: "Onboarding: preserves policy preset step order",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; no inference endpoint",
    profile: "standard",
    timeoutMinutes: 60,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: ["test/e2e/live/onboard-interactive-pty.ts"],
    environment: { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" },
  }),
  target("onboard-resume", {
    displayName: "Onboarding: resumes interrupted setup from recorded progress",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu Docker host; local onboarding fixtures",
    profile: "standard",
    timeoutMinutes: ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    installMode: "credential-free",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: ["tools/e2e/onboard-timeout-contract.mts"],
    environment: { ...nonInteractive, NEMOCLAW_SANDBOX_NAME: "e2e-resume" },
  }),
  target("openclaw-discord-pairing", {
    displayName: "Messaging: shares OpenClaw Discord pairing approval",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and Discord",
    profile: "nvidia-inference",
    timeoutMinutes: 60,
    installMode: "credential-free",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-oc-disc-pair",
      OPENSHELL_GATEWAY: "nemoclaw",
      DISCORD_BOT_TOKEN: "test-fake-discord-pairing-e2e",
    },
  }),
  target("openclaw-skill-cli", {
    displayName: "Skills: OpenClaw installs and inspects workspace skills",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 60,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...hostedInference,
      NEMOCLAW_SANDBOX_NAME: "e2e-oc-skill-cli",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("openclaw-inference-switch", {
    displayName: "Inference: OpenClaw switches providers and remains responsive",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; compatible inference fixtures",
    profile: "standard",
    timeoutMinutes: 90,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: ["test/e2e/live/openclaw-inference-switch-helpers.ts"],
    environment: {
      ...nonInteractive,
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_E2E_SHARD: "anthropic",
      NEMOCLAW_SANDBOX_NAME: "e2e-oc-inf-switch",
      NEMOCLAW_SWITCH_PROVIDER: "compatible-anthropic-endpoint",
      NEMOCLAW_SWITCH_MODEL: "mock-anthropic-model",
      NEMOCLAW_SWITCH_INFERENCE_API: "anthropic-messages",
      NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "1",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("openclaw-tui-chat-correlation", {
    displayName: "TUI: keeps rapid OpenClaw turns correlated",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 75,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    hostPackages: ["expect"],
    owningPaths: [
      "test/e2e/live/issue-6194-tui-expect.ts",
      "test/e2e/live/openclaw-tui-ref-fidelity.ts",
      "test/e2e/live/openclaw-tui-run-classification.ts",
      "test/e2e/support/issue-4434-tui-capture.ts",
    ],
    environment: {
      ...hostedInference,
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_PREFERRED_API: "openai-completions",
    },
  }),
  target("openclaw-slack-pairing", {
    displayName: "Messaging: shares OpenClaw Slack pairing approval",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and Slack",
    profile: "nvidia-inference",
    timeoutMinutes: 60,
    installMode: "credential-free",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-oc-slack-pair",
      OPENSHELL_GATEWAY: "nemoclaw",
      SLACK_BOT_TOKEN: "xoxb-fake-slack-pairing-e2e",
      SLACK_APP_TOKEN: "xapp-fake-slack-pairing-e2e",
    },
  }),
  target("pi-agent-qualification-amd64", {
    targetId: "pi-agent-qualification",
    displayName: "Pi: qualifies managed runtime on Linux AMD64",
    agentRuntime: "pi",
    environmentOrInferenceEndpoint: "Linux AMD64 Docker; NVIDIA hosted inference",
    profile: "nvidia-api",
    testFile: "test/e2e/live/pi-agent-qualification.test.ts",
    timeoutMinutes: 100,
    installMode: "authenticated",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    runner: "ubuntu-24.04",
    shard: "linux-amd64",
    owningPaths: [
      ...PI_IMAGE_SOURCE_OWNING_PATHS,
      "ci/pi-agent-qualification-v1-linux-amd64.json",
      "src/lib/agent/candidate-authority.ts",
      "src/lib/agent/candidate.ts",
      "src/lib/onboard/managed-workload/",
      "src/lib/onboard/workload/",
      "test/e2e/live/pi-agent-qualification-events.ts",
    ],
    environment: {
      ...nonInteractive,
      NEMOCLAW_CANDIDATE_AGENTS: "1",
      NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT: "ci/pi-agent-qualification-v1-linux-amd64.json",
      NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia",
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_PI_QUALIFICATION_PLATFORM: "linux/amd64",
      NEMOCLAW_SANDBOX_NAME: "e2e-pi-qual-amd64",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("pi-agent-qualification-arm64", {
    targetId: "pi-agent-qualification",
    displayName: "Pi: qualifies managed runtime on Linux ARM64",
    agentRuntime: "pi",
    environmentOrInferenceEndpoint: "Linux ARM64 Docker; NVIDIA hosted inference",
    profile: "nvidia-api",
    testFile: "test/e2e/live/pi-agent-qualification.test.ts",
    timeoutMinutes: 100,
    installMode: "authenticated",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    runner: "ubuntu-24.04-arm",
    shard: "linux-arm64",
    owningPaths: [
      ...PI_IMAGE_SOURCE_OWNING_PATHS,
      "ci/pi-agent-qualification-v1-linux-arm64.json",
      "src/lib/agent/candidate-authority.ts",
      "src/lib/agent/candidate.ts",
      "src/lib/onboard/managed-workload/",
      "src/lib/onboard/workload/",
      "test/e2e/live/pi-agent-qualification-events.ts",
    ],
    environment: {
      ...nonInteractive,
      NEMOCLAW_CANDIDATE_AGENTS: "1",
      NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT: "ci/pi-agent-qualification-v1-linux-arm64.json",
      NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia",
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_PI_QUALIFICATION_PLATFORM: "linux/arm64",
      NEMOCLAW_SANDBOX_NAME: "e2e-pi-qual-arm64",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  ...GATEWAY_UPGRADE_TARGETS,
  target("rebuild-openclaw", {
    displayName: "Rebuild: preserves OpenClaw state and rotates the gateway token",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 130,
    installMode: "credential-free",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: [
      "test/e2e/live/rebuild-openclaw-old-base-context.ts",
      "src/lib/core/shell-quote.ts",
    ],
    environment: hostedInference,
  }),
  target("rebuild-hermes", {
    displayName: "Rebuild: preserves Hermes state and recovers cron dispatch",
    agentRuntime: "hermes",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    prAdvisorSelectable: true,
    owningPaths: ["test/e2e/live/rebuild-hermes-cron-restore.ts"],
    timeoutMinutes: 90,
    installMode: "credential-free",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    runnerKey: "rebuild-hermes",
    hostPreparation: "rebuild-swap",
    runnerComparison: true,
    runnerPressure: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_SANDBOX_NAME: "e2e-rebuild-hermes",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("rebuild-hermes-stale-base", {
    displayName: "Rebuild: refreshes a stale Hermes base and restores state",
    agentRuntime: "hermes",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    prAdvisorSelectable: true,
    testFile: "test/e2e/live/rebuild-hermes.test.ts",
    owningPaths: ["test/e2e/live/rebuild-hermes-cron-restore.ts"],
    timeoutMinutes: 90,
    installMode: "credential-free",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    runnerKey: "rebuild-hermes-stale-base",
    hostPreparation: "rebuild-swap",
    runnerComparison: true,
    runnerPressure: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_HERMES_STALE_BASE_REBUILD_E2E: "1",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_SANDBOX_NAME: "e2e-rebuild-base",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("sandbox-survival", {
    displayName: "Lifecycle: preserves sandbox state after an OpenShell gateway restart",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 30,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: false,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-survival",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("sandbox-operations", {
    displayName: "Sandbox: preserves lifecycle and multi-sandbox operations",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 120,
    installMode: "credential-free",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      // Open policy permits the inference and log probes.
      // TC-SBX-11 verifies sandbox-to-sandbox network isolation.
      NEMOCLAW_POLICY_TIER: "open",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("security-posture-openclaw", {
    targetId: "security-posture",
    displayName: "Security: OpenClaw retains the required sandbox posture",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    prAdvisorSelectable: true,
    testFile: "test/e2e/live/full-e2e.test.ts",
    timeoutMinutes: 75,
    installMode: "credential-free",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    shard: "openclaw",
    artifactLayout: "flat-shard",
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS: "1",
      NEMOCLAW_E2E_EXPECT_NON_ROOT_HOST: "1",
      NEMOCLAW_E2E_SECURITY_POSTURE: "1",
      NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS: "60",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-oc-security",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("security-posture-hermes", {
    targetId: "security-posture",
    displayName: "Security: Hermes retains the required sandbox posture",
    agentRuntime: "hermes",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    prAdvisorSelectable: true,
    testFile: "test/e2e/live/hermes-e2e.test.ts",
    timeoutMinutes: 75,
    installMode: "credential-free",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    runnerKey: "security-posture-hermes",
    hostPreparation: "hermes-swap",
    runnerComparison: true,
    shard: "hermes",
    artifactLayout: "flat-shard",
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS: "1",
      NEMOCLAW_E2E_EXPECT_NON_ROOT_HOST: "1",
      NEMOCLAW_E2E_SECURITY_POSTURE: "1",
      NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS: "60",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-hm-security",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("sessions-agents-cli", {
    displayName: "CLI: routes sessions and agents to OpenClaw",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 70,
    installMode: "credential-free",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: ["test/e2e/live/json-envelope.ts"],
    environment: {
      ...hostedInference,
      NEMOCLAW_SANDBOX_NAME: "e2e-sessions-cli",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("shields-config", {
    displayName: "Shields: restores stopped OpenClaw across posture changes",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 45,
    installMode: "none",
    restoreCli: false,
    exposeCliBin: false,
    owningPaths: ["test/e2e/live/json-envelope.ts"],
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-shields",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("snapshot-commands", {
    displayName: "Snapshot: restores selected sandbox state without credential leaks",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu Docker host; no inference endpoint",
    profile: "standard",
    timeoutMinutes: 40,
    installMode: "none",
    restoreCli: false,
    exposeCliBin: false,
    owningPaths: [
      "test/e2e/live/snapshot-credential-scanner.ts",
      "src/lib/actions/sandbox/auto-pair-approval.ts",
      "src/lib/actions/sandbox/restore-gateway-pairing.ts",
      "src/lib/adapters/openshell/restore-gateway-pairing.ts",
    ],
    environment: {
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-snapshot",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("spark-install", {
    displayName: "Install: leaves NemoClaw and OpenShell usable after standard installation",
    agentRuntime: "unresolved",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    unresolvedReason: "The test asserts CLI usability but does not assert an agent runtime",
    profile: "nvidia-inference",
    timeoutMinutes: 45,
    installMode: "none",
    restoreCli: false,
    exposeCliBin: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_FRESH: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-spark-install",
      NEMOCLAW_PROVIDER: "cloud",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("skill-agent", {
    displayName: "Skills: OpenClaw reads an injected sandbox skill",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    prAdvisorSelectable: true,
    timeoutMinutes: 30,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: hostedInference,
  }),
  target("state-backup-restore", {
    displayName: "Backup: restores workspace files and memory",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference",
    profile: "nvidia-inference",
    timeoutMinutes: 60,
    installMode: "credential-free",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-state-backup",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("telegram-injection", {
    displayName: "Messaging: treats Telegram shell metacharacters as data",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and Telegram fixture",
    profile: "nvidia-inference",
    timeoutMinutes: 45,
    installMode: "credential-free",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-tg-injection",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("token-rotation", {
    displayName: "Messaging: rotates one provider token without rebuilding siblings",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; no inference endpoint",
    profile: "github-read",
    timeoutMinutes: 45,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      TELEGRAM_BOT_TOKEN_A: "test-fake-token-A-rotation-e2e",
      TELEGRAM_BOT_TOKEN_B: "test-fake-token-B-rotation-e2e",
      DISCORD_BOT_TOKEN_A: "dc-a-rotation-e2e",
      DISCORD_BOT_TOKEN_B: "dc-b-rotation-e2e",
      SLACK_BOT_TOKEN_A: "xoxb-fake-A-rotation-e2e",
      SLACK_BOT_TOKEN_B: "xoxb-fake-B-rotation-e2e",
      SLACK_APP_TOKEN_A: "xapp-fake-A-rotation-e2e",
      SLACK_APP_TOKEN_B: "xapp-fake-B-rotation-e2e",
    },
  }),
  target("tunnel-lifecycle", {
    displayName: "Tunnel: starts, probes, and stops a public dashboard tunnel",
    agentRuntime: "openclaw",
    environmentOrInferenceEndpoint: "Ubuntu; NVIDIA hosted inference and Cloudflare tunnel",
    profile: "nvidia-inference",
    timeoutMinutes: 75,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    cloudflared: true,
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-tunnel-life",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("whatsapp-qr-compact", {
    displayName: "Messaging: renders a compact WhatsApp pairing QR code",
    agentRuntime: "none",
    environmentOrInferenceEndpoint: "Ubuntu; no sandbox or inference endpoint",
    profile: "standard",
    timeoutMinutes: 15,
    installMode: "none",
    restoreCli: false,
    exposeCliBin: false,
  }),
] as const;

export const E2E_CATALOGUE_SHARED_PATHS = [
  ".github/actions/host-dependency-setup/",
  ".github/scripts/host-dependency-setup.sh",
  ".github/workflows/e2e-standard-profile.yaml",
  "scripts/install-openshell.sh",
  "tools/e2e/target-catalogue.mts",
] as const;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DISPLAY_NAME_PATTERN = /^[A-Z][A-Za-z0-9 .'+()-]+: [^/\r\n]{1,72}$/u;
const DISPLAY_NAME_METADATA_PATTERN = /\b(?:catalogue|e2e|live)\b|(?:issue[-\s]*|#\s*)\d+/iu;
const TEST_FILE_PATTERN = /^test\/e2e\/live\/[A-Za-z0-9._-]+[.]test[.]ts$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const SELECTOR_PATTERN = /^[A-Za-z0-9_./^$=:@+-]+$/u;
const E2E_CATALOGUE_RUNNER_KEY_SET = new Set<string>(E2E_CATALOGUE_RUNNER_KEYS);

export function pathMatches(file: string, owner: string): boolean {
  return owner.endsWith("/") ? file.startsWith(owner) : file === owner;
}

export function validateE2eTargetCatalogue(
  targets: readonly E2eCatalogueTarget[],
): readonly E2eCatalogueTarget[] {
  const ids = new Set<string>();
  const displayNames = new Set<string>();
  const evidencePaths = new Set<string>();
  for (const entry of targets) {
    if (!ID_PATTERN.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`E2E target catalogue contains an invalid or duplicate ID: ${entry.id}`);
    }
    ids.add(entry.id);
    if (!ID_PATTERN.test(entry.targetId)) {
      throw new Error(`E2E target ${entry.id} has an invalid evidence target ID`);
    }
    const displayName = entry.displayName.toLowerCase();
    const implementationIdentifiers = [
      entry.id,
      entry.runner,
      entry.environment.NEMOCLAW_SANDBOX_NAME,
    ].filter((identifier): identifier is string => identifier !== undefined);
    if (
      !DISPLAY_NAME_PATTERN.test(entry.displayName) ||
      DISPLAY_NAME_METADATA_PATTERN.test(entry.displayName) ||
      implementationIdentifiers.some((identifier) =>
        displayName.includes(identifier.toLowerCase()),
      ) ||
      displayNames.has(entry.displayName)
    ) {
      throw new Error(
        `E2E target ${entry.id} has an invalid or duplicate display name: ${entry.displayName}`,
      );
    }
    displayNames.add(entry.displayName);
    if (!TEST_FILE_PATTERN.test(entry.testFile)) {
      throw new Error(`E2E target ${entry.id} has an invalid test file`);
    }
    if (!E2E_EXECUTION_PROFILES.includes(entry.profile)) {
      throw new Error(`E2E target ${entry.id} has an invalid execution profile`);
    }
    if (!/^[A-Za-z0-9._-]+$/u.test(entry.runner)) {
      throw new Error(`E2E target ${entry.id} has an invalid runner`);
    }
    if (
      entry.runnerKey !== "" &&
      (!ID_PATTERN.test(entry.runnerKey) || !E2E_CATALOGUE_RUNNER_KEY_SET.has(entry.runnerKey))
    ) {
      throw new Error(`E2E target ${entry.id} has an invalid runner routing key`);
    }
    if (!E2E_HOST_PREPARATIONS.includes(entry.hostPreparation)) {
      throw new Error(`E2E target ${entry.id} has an invalid host preparation`);
    }
    if (!ID_PATTERN.test(entry.shard)) {
      throw new Error(`E2E target ${entry.id} has an invalid shard`);
    }
    if (!E2E_ARTIFACT_LAYOUTS.includes(entry.artifactLayout)) {
      throw new Error(`E2E target ${entry.id} has an invalid artifact layout`);
    }
    if (entry.artifactLayout === "flat-shard" && entry.shard === "default") {
      throw new Error(`E2E target ${entry.id} flat artifact layout requires a named shard`);
    }
    const evidencePath = `${entry.targetId}/${entry.shard}`;
    if (evidencePaths.has(evidencePath)) {
      throw new Error(`E2E target ${entry.id} duplicates an evidence target and shard`);
    }
    evidencePaths.add(evidencePath);
    if (!E2E_INSTALL_MODES.includes(entry.installMode)) {
      throw new Error(`E2E target ${entry.id} has an invalid install mode`);
    }
    if (
      new Set(entry.hostPackages).size !== entry.hostPackages.length ||
      entry.hostPackages.some((packageName) => !E2E_HOST_PACKAGES.includes(packageName))
    ) {
      throw new Error(`E2E target ${entry.id} has invalid or duplicate host packages`);
    }
    if (
      new Set(entry.requiredOptionalCredentials).size !==
        entry.requiredOptionalCredentials.length ||
      entry.requiredOptionalCredentials.some(
        (credential) => !E2E_OPTIONAL_CREDENTIALS.includes(credential),
      )
    ) {
      throw new Error(`E2E target ${entry.id} has invalid optional credential requirements`);
    }
    if (entry.selector !== undefined && !SELECTOR_PATTERN.test(entry.selector)) {
      throw new Error(`E2E target ${entry.id} has an invalid test selector`);
    }
    if (!Number.isInteger(entry.timeoutMinutes) || entry.timeoutMinutes < 1) {
      throw new Error(`E2E target ${entry.id} has an invalid timeout`);
    }
    if (
      entry.id === "onboard-policy-preset-sequencing" &&
      (entry.installNonInteractive || entry.environment.NEMOCLAW_NON_INTERACTIVE !== undefined)
    ) {
      throw new Error(
        "E2E target onboard-policy-preset-sequencing requires interactive installation and execution",
      );
    }
    if (
      entry.id === "inference-routing" &&
      (entry.profile !== "standard" ||
        entry.testFile !== "test/e2e/live/inference-routing.test.ts" ||
        !entry.cloudflared)
    ) {
      throw new Error(
        "E2E target inference-routing must remain credential-free with reviewed cloudflared",
      );
    }
    if (
      entry.targetId === "openshell-gateway-upgrade" ||
      entry.id.startsWith("openshell-gateway-upgrade-")
    ) {
      const expected = GATEWAY_UPGRADE_TARGET_BY_ID.get(entry.id);
      if (!expected || !isDeepStrictEqual(entry, expected)) {
        throw new Error(
          `E2E target ${entry.id} must match the exact reviewed gateway-upgrade fixture`,
        );
      }
    }
    if (entry.owningPaths.length === 0 || !entry.owningPaths.includes(entry.testFile)) {
      throw new Error(`E2E target ${entry.id} must own its test file`);
    }
    for (const owner of entry.owningPaths) {
      if (owner.startsWith("/") || owner.split("/").includes("..") || owner.includes("\n")) {
        throw new Error(`E2E target ${entry.id} has an invalid owning path`);
      }
    }
    for (const [name, value] of Object.entries(entry.environment)) {
      if (!ENVIRONMENT_NAME_PATTERN.test(name) || value.includes("\n") || value.includes("\r")) {
        throw new Error(`E2E target ${entry.id} has an invalid environment entry`);
      }
    }
    validateE2eExecutionMetadata(
      {
        agentRuntime: entry.agentRuntime,
        environmentOrInferenceEndpoint: entry.environmentOrInferenceEndpoint,
        observableOutcome: entry.displayName,
        unresolvedReason: entry.unresolvedReason,
      },
      `E2E target ${entry.id}`,
    );
  }
  return targets;
}

validateE2eTargetCatalogue(E2E_TARGET_CATALOGUE);

export function catalogueTarget(id: string): E2eCatalogueTarget {
  const canonicalId = normalizeE2eSelectorId(id);
  const entry = E2E_TARGET_CATALOGUE.find((candidate) => candidate.id === canonicalId);
  if (!entry) throw new Error(`Unknown catalogue E2E target: ${id}`);
  return entry;
}

export function isPrCandidateCatalogueTarget(target: E2eCatalogueTarget): boolean {
  return target.profile === "standard";
}

export function isPrAdvisorSelectableCatalogueTarget(target: E2eCatalogueTarget): boolean {
  return target.prAdvisorSelectable || isPrCandidateCatalogueTarget(target);
}

export function catalogueRecommendationSelectorIds(): string[] {
  return [
    ...new Set(
      E2E_TARGET_CATALOGUE.filter(isPrAdvisorSelectableCatalogueTarget).map(
        ({ targetId }) => targetId,
      ),
    ),
  ].sort();
}

export function catalogueTargetsForChangedFiles(
  changedFiles: readonly string[],
): E2eCatalogueTarget[] {
  const files = [...new Set(changedFiles)];
  if (files.some((file) => E2E_CATALOGUE_SHARED_PATHS.some((owner) => pathMatches(file, owner)))) {
    return [...E2E_TARGET_CATALOGUE];
  }
  return E2E_TARGET_CATALOGUE.filter((entry) =>
    files.some((file) => entry.owningPaths.some((owner) => pathMatches(file, owner))),
  );
}

export function catalogueMatrix(
  profile: E2eExecutionProfile,
  targets: readonly E2eCatalogueTarget[],
): E2eCatalogueMatrixRow[] {
  return targets
    .filter((entry) => entry.profile === profile)
    .map((entry) => ({
      id: entry.id,
      target_id: entry.targetId,
      display_name: entry.displayName,
      agent_runtime: entry.agentRuntime,
      observable_outcome: entry.displayName,
      environment_or_inference_endpoint: entry.environmentOrInferenceEndpoint,
      unresolved_reason: entry.unresolvedReason,
      runner: entry.runner,
      runner_key: entry.runnerKey,
      test_file: entry.testFile,
      timeout_minutes: entry.timeoutMinutes,
      install_mode: entry.installMode,
      install_non_interactive: entry.installNonInteractive,
      restore_cli: entry.restoreCli,
      cloudflared: entry.cloudflared,
      host_packages: entry.hostPackages.join(" "),
      host_preparation: entry.hostPreparation,
      runner_comparison: entry.runnerComparison,
      runner_pressure: entry.runnerPressure,
      compatible_api_key: entry.compatibleApiKey,
      shard: entry.shard,
      artifact_layout: entry.artifactLayout,
    }));
}

export async function runCatalogueTarget(id: string, testFile: string): Promise<number> {
  const entry = catalogueTarget(id);
  if (entry.testFile !== testFile) {
    throw new Error(`E2E target ${id} does not own test file ${testFile}`);
  }
  Object.assign(process.env, entry.environment);
  if (entry.exposeCliBin) {
    process.env.NEMOCLAW_CLI_BIN = path.join(process.cwd(), "bin", "nemoclaw.js");
  }
  const runPressureCommand = (command: string): void => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "tools/e2e/runner-pressure.mts", command],
      { env: process.env, stdio: "inherit", timeout: 60_000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `runner pressure ${command} exited with status ${result.status ?? "unknown"}`,
      );
    }
  };
  if (entry.runnerPressure) {
    const artifactDirectory = process.env.E2E_ARTIFACT_DIR;
    if (!artifactDirectory) throw new Error("runner pressure requires E2E_ARTIFACT_DIR");
    fs.mkdirSync(artifactDirectory, { recursive: true });
    Object.assign(process.env, {
      DOCKER_OOM_CONTAINER: entry.environment.NEMOCLAW_SANDBOX_NAME,
      E2E_PHASE: `${entry.targetId}.workflow`,
      E2E_RESOURCE_BASELINE_FILE: path.join(artifactDirectory, "runner-pressure-baseline.jsonl"),
      E2E_RESOURCE_PHASE_BASELINES_FILE: path.join(
        artifactDirectory,
        "runner-pressure-phase-baselines.jsonl",
      ),
      E2E_TERMINAL_CLASSIFICATION_FILE: path.join(
        artifactDirectory,
        "runner-pressure-classification.jsonl",
      ),
      E2E_TEST_OUTCOME_FILE: path.join(artifactDirectory, "live-test-outcome.json"),
    });
    runPressureCommand("snapshot");
    runPressureCommand("initialize-evidence");
  }
  const { runLiveVitestCommand } = await import("./live-vitest-invocation.mts");
  process.env.NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST = "1";
  const selector = entry.selector ? ["--selector", entry.selector] : [];
  const exitCode = await runLiveVitestCommand(["run", "--test-path", entry.testFile, ...selector]);
  if (entry.runnerPressure && exitCode !== 0) {
    runPressureCommand("classify");
    runPressureCommand("validate-classification");
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, id, testFile] = process.argv.slice(2);
  if (command !== "run" || !id || !testFile) {
    throw new Error("Usage: target-catalogue.mts run <target-id> <test-file>");
  }
  void runCatalogueTarget(id, testFile).then((exitCode) => process.exit(exitCode));
}
