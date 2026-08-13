// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

export const E2E_EXECUTION_PROFILES = ["standard", "nvidia-api", "nvidia-inference"] as const;
export type E2eExecutionProfile = (typeof E2E_EXECUTION_PROFILES)[number];

export const E2E_INSTALL_MODES = ["none", "authenticated", "credential-free"] as const;
export type E2eInstallMode = (typeof E2E_INSTALL_MODES)[number];

export const E2E_HOST_PACKAGES = ["expect", "iptables"] as const;
export type E2eHostPackage = (typeof E2E_HOST_PACKAGES)[number];

export interface E2eCatalogueTarget {
  id: string;
  testFile: string;
  profile: E2eExecutionProfile;
  runner: string;
  owningPaths: readonly string[];
  releaseRequired: boolean;
  timeoutMinutes: number;
  installMode: E2eInstallMode;
  installNonInteractive: boolean;
  restoreCli: boolean;
  exposeCliBin: boolean;
  hostPackages: readonly E2eHostPackage[];
  selector?: string;
  environment: Readonly<Record<string, string>>;
}

export interface E2eCatalogueMatrixRow {
  id: string;
  runner: string;
  test_file: string;
  timeout_minutes: number;
  install_mode: E2eInstallMode;
  install_non_interactive: boolean;
  restore_cli: boolean;
  host_packages: string;
}

type TargetOptions = Omit<
  E2eCatalogueTarget,
  | "id"
  | "testFile"
  | "owningPaths"
  | "releaseRequired"
  | "environment"
  | "hostPackages"
  | "installNonInteractive"
  | "runner"
> & {
  owningPaths?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  hostPackages?: readonly E2eHostPackage[];
  installNonInteractive?: boolean;
  runner?: string;
};

function target(id: string, options: TargetOptions): E2eCatalogueTarget {
  const testFile = `test/e2e/live/${id}.test.ts`;
  const {
    owningPaths = [],
    environment = {},
    hostPackages = [],
    installNonInteractive = false,
    runner = "ubuntu-latest",
    ...execution
  } = options;
  return {
    id,
    testFile,
    owningPaths: [testFile, ...owningPaths],
    releaseRequired: true,
    runner,
    environment,
    hostPackages,
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

export const E2E_TARGET_CATALOGUE: readonly E2eCatalogueTarget[] = [
  target("channels-add-remove", {
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
  target("cloud-inference", {
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
  target("concurrent-gateway-ports", {
    profile: "standard",
    timeoutMinutes: 90,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: nonInteractive,
  }),
  target("cron-preflight-inference-local", {
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
    profile: "standard",
    timeoutMinutes: 90,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: nonInteractive,
  }),
  target("gpu-double-onboard", {
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
    profile: "standard",
    runner: "linux-amd64-gpu-rtxpro6000-latest-1",
    timeoutMinutes: 90,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: {
      ...nonInteractive,
      E2E_LLAMA_CPP_DEDICATED_LANE: "1",
      NEMOCLAW_MODEL: "qwen3.5:9b",
      NEMOCLAW_PROVIDER: "ollama",
      NEMOCLAW_OLLAMA_PULL_TIMEOUT: "2400",
      NEMOCLAW_SANDBOX_NAME: "e2e-gpu-ollama",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("full-e2e", {
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
  target("issue-2478-crash-loop-recovery", {
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
  target("issue-4434-tui-unreachable-inference", {
    profile: "nvidia-inference",
    timeoutMinutes: 120,
    installMode: "authenticated",
    installNonInteractive: true,
    restoreCli: true,
    exposeCliBin: true,
    hostPackages: ["expect", "iptables"],
    owningPaths: ["test/e2e/support/issue-4434-tui-capture.ts"],
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_ISSUE_4434_LIVE: "1",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("kimi-inference-compat", {
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
    profile: "nvidia-api",
    timeoutMinutes: 45,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    environment: { OPENSHELL_GATEWAY: "nemoclaw" },
  }),
  target("network-policy", {
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
    profile: "standard",
    timeoutMinutes: 75,
    installMode: "authenticated",
    restoreCli: true,
    exposeCliBin: true,
    environment: { ...nonInteractive, NEMOCLAW_SANDBOX_NAME: "e2e-repair" },
  }),
  target("onboard-resume", {
    profile: "standard",
    timeoutMinutes: 45,
    installMode: "credential-free",
    restoreCli: true,
    exposeCliBin: true,
    environment: { ...nonInteractive, NEMOCLAW_SANDBOX_NAME: "e2e-resume" },
  }),
  target("openclaw-discord-pairing", {
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
  target("openclaw-tui-chat-correlation", {
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
  target("overlayfs-autofix", {
    profile: "nvidia-inference",
    timeoutMinutes: 90,
    installMode: "none",
    restoreCli: true,
    exposeCliBin: true,
    owningPaths: [
      "test/e2e/live/overlayfs-autofix-cleanup.ts",
      "test/e2e/live/overlayfs-autofix-outcome.ts",
      "src/lib/onboard/docker-driver-platform.ts",
    ],
    environment: {
      ...hostedInference,
      ...nonInteractive,
      NEMOCLAW_SANDBOX_NAME: "e2e-overlayfs",
      NEMOCLAW_E2E_TIMEOUT_SECONDS: "1500",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
  }),
  target("rebuild-openclaw", {
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
  target("sandbox-survival", {
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
  target("sessions-agents-cli", {
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
  target("state-backup-restore", {
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
  target("whatsapp-qr-compact", {
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
const TEST_FILE_PATTERN = /^test\/e2e\/live\/[A-Za-z0-9._-]+[.]test[.]ts$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const SELECTOR_PATTERN = /^[A-Za-z0-9_./^$=:@+-]+$/u;

export function pathMatches(file: string, owner: string): boolean {
  return owner.endsWith("/") ? file.startsWith(owner) : file === owner;
}

export function validateE2eTargetCatalogue(
  targets: readonly E2eCatalogueTarget[],
): readonly E2eCatalogueTarget[] {
  const ids = new Set<string>();
  for (const entry of targets) {
    if (!ID_PATTERN.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`E2E target catalogue contains an invalid or duplicate ID: ${entry.id}`);
    }
    ids.add(entry.id);
    if (!TEST_FILE_PATTERN.test(entry.testFile)) {
      throw new Error(`E2E target ${entry.id} has an invalid test file`);
    }
    if (!E2E_EXECUTION_PROFILES.includes(entry.profile)) {
      throw new Error(`E2E target ${entry.id} has an invalid execution profile`);
    }
    if (!/^[A-Za-z0-9._-]+$/u.test(entry.runner)) {
      throw new Error(`E2E target ${entry.id} has an invalid runner`);
    }
    if (!E2E_INSTALL_MODES.includes(entry.installMode)) {
      throw new Error(`E2E target ${entry.id} has an invalid install mode`);
    }
    if (
      new Set(entry.hostPackages).size !== entry.hostPackages.length ||
      entry.hostPackages.some((packageName) => !E2E_HOST_PACKAGES.includes(packageName))
    ) {
      throw new Error(`E2E target ${entry.id} has invalid or duplicate host packages`);
    }
    if (entry.selector !== undefined && !SELECTOR_PATTERN.test(entry.selector)) {
      throw new Error(`E2E target ${entry.id} has an invalid test selector`);
    }
    if (!Number.isInteger(entry.timeoutMinutes) || entry.timeoutMinutes < 1) {
      throw new Error(`E2E target ${entry.id} has an invalid timeout`);
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
  }
  return targets;
}

validateE2eTargetCatalogue(E2E_TARGET_CATALOGUE);

export function catalogueTarget(id: string): E2eCatalogueTarget {
  const entry = E2E_TARGET_CATALOGUE.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown catalogue E2E target: ${id}`);
  return entry;
}

export function isPrCandidateCatalogueTarget(target: E2eCatalogueTarget): boolean {
  return target.profile === "standard";
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
      runner: entry.runner,
      test_file: entry.testFile,
      timeout_minutes: entry.timeoutMinutes,
      install_mode: entry.installMode,
      install_non_interactive: entry.installNonInteractive,
      restore_cli: entry.restoreCli,
      host_packages: entry.hostPackages.join(" "),
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
  const { runLiveVitestCommand } = await import("./live-vitest-invocation.mts");
  const selector = entry.selector ? ["--selector", entry.selector] : [];
  return runLiveVitestCommand(["run", "--test-path", entry.testFile, ...selector]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, id, testFile] = process.argv.slice(2);
  if (command !== "run" || !id || !testFile) {
    throw new Error("Usage: target-catalogue.mts run <target-id> <test-file>");
  }
  void runCatalogueTarget(id, testFile).then((exitCode) => process.exit(exitCode));
}
