// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireSingleReviewedDockerfileRunCommand } from "./helpers/dockerfile-run-commands";
import { dockerRunCommandBetween, runDockerShell } from "./helpers/hermes-dockerfile-run";
import { expectManagedBootstrapNativeImageContract } from "./support/managed-bootstrap-image-contract";

const ROOT = path.resolve(import.meta.dirname, "..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");
const NPM_ROOT_ARGUMENTS = ["--npm-root", "/usr/local/lib/node_modules/npm"] as const;
const HERMES_INTEGRITY_FILES = [
  {
    arg: "NEMOCLAW_HERMES_IMAGE_BUILD_PROBES_SHA256",
    source: "agents/hermes/image-build-probes.py",
    target: "/opt/nemoclaw-hermes-config/image-build-probes.py",
  },
  {
    arg: "NEMOCLAW_HERMES_WRAPPER_SHA256",
    source: "agents/hermes/hermes-wrapper.py",
    target: "/usr/local/lib/nemoclaw/hermes-wrapper.py",
  },
  {
    arg: "NEMOCLAW_HERMES_CLI_ADAPTER_SHA256",
    source: "agents/hermes/hermes-cli-adapter-v1.json",
    target: "/usr/local/share/nemoclaw/hermes-cli-adapter-v1.json",
  },
  {
    arg: "NEMOCLAW_HERMES_CLI_ADAPTER_VALIDATOR_SHA256",
    source: "agents/hermes/validate-cli-adapter.py",
    target: "/usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py",
  },
  {
    arg: "NEMOCLAW_HERMES_VALIDATOR_SHA256",
    source: "agents/hermes/validate-env-secret-boundary.py",
    target: "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
  },
  {
    arg: "NEMOCLAW_HERMES_TIRITH_FINALIZER_SHA256",
    source: "agents/hermes/finalize-tirith-marker.py",
    target: "/usr/local/lib/nemoclaw/finalize-tirith-marker.py",
  },
  {
    arg: "NEMOCLAW_HERMES_LANGFUSE_PATCHER_SHA256",
    source: "agents/hermes/patch-langfuse-credentials.mts",
    target: "/usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts",
  },
  {
    arg: "NEMOCLAW_HERMES_DISCORD_RECOVERY_PATCHER_SHA256",
    source: "agents/hermes/patch-discord-recovery-permissions.py",
    target: "/usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py",
  },
  {
    arg: "NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256",
    source: "agents/hermes/patch-profile-policy-defaults.py",
    target: "/usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py",
  },
  {
    arg: "NEMOCLAW_HERMES_GATEWAY_RUNTIME_METADATA_PATCHER_SHA256",
    source: "agents/hermes/patch-gateway-runtime-metadata.py",
    target: "/opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py",
  },
  {
    arg: "NEMOCLAW_HERMES_GATEWAY_PROCESS_IDENTITY_PATCHER_SHA256",
    source: "agents/hermes/patch-gateway-process-identity.py",
    target: "/opt/nemoclaw-hermes-config/patch-gateway-process-identity.py",
  },
  {
    arg: "NEMOCLAW_HERMES_CRON_RUNTIME_PATCHER_SHA256",
    source: "agents/hermes/patch-cron-execution-runtime.py",
    target: "/opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py",
  },
  {
    arg: "NEMOCLAW_HERMES_CRON_RESTORE_DRAIN_PATCHER_SHA256",
    source: "agents/hermes/patch-cron-restore-drain.py",
    target: "/opt/nemoclaw-hermes-config/patch-cron-restore-drain.py",
  },
  {
    arg: "NEMOCLAW_HERMES_CRON_RESTORE_CONTROLLER_SHA256",
    source: "agents/hermes/cron-restore-control.py",
    target: "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
  },
  {
    arg: "NEMOCLAW_HERMES_NEUTRAL_PLATFORM_PATCHER_SHA256",
    source: "agents/hermes/patch-neutral-platform-env-activation.py",
    target: "/opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py",
  },
] as const;

type LegacyDataFixture =
  | "none"
  | "content"
  | "directory-symlink"
  | "entry-symlink"
  | "nested-symlink";
type OpenClawFixture = "none" | "directory" | "symlink";

interface FixturePaths {
  hermesDir: string;
  legacyDataDir: string;
  legacyTarget: string;
  openclawDir: string;
  openclawTarget: string;
}

const legacyDataSetups = {
  none: () => undefined,
  content: ({ hermesDir, legacyDataDir }: FixturePaths) => {
    fs.mkdirSync(path.join(legacyDataDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(legacyDataDir, "sessions", "legacy.json"), "{}\n");
    fs.writeFileSync(path.join(legacyDataDir, "legacy.txt"), "legacy\n");
    fs.symlinkSync(path.join(legacyDataDir, "sessions"), path.join(hermesDir, "sessions"));
    fs.symlinkSync(path.join(legacyDataDir, "legacy.txt"), path.join(hermesDir, "legacy.txt"));
    fs.mkdirSync(path.join(hermesDir, "profiles"), { recursive: true });
    fs.symlinkSync(
      path.join(legacyDataDir, "sessions"),
      path.join(hermesDir, "profiles", "legacy-sessions"),
    );
  },
  "directory-symlink": ({ legacyDataDir, legacyTarget }: FixturePaths) => {
    fs.mkdirSync(legacyTarget, { recursive: true });
    fs.writeFileSync(path.join(legacyTarget, "sentinel"), "keep\n");
    fs.symlinkSync(legacyTarget, legacyDataDir, "dir");
  },
  "entry-symlink": ({ legacyDataDir, legacyTarget }: FixturePaths) => {
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.writeFileSync(legacyTarget, "keep\n");
    fs.symlinkSync(legacyTarget, path.join(legacyDataDir, "linked-entry"));
  },
  "nested-symlink": ({ legacyDataDir, legacyTarget }: FixturePaths) => {
    fs.mkdirSync(path.join(legacyDataDir, "sessions"), { recursive: true });
    fs.writeFileSync(legacyTarget, "keep\n");
    fs.symlinkSync(legacyTarget, path.join(legacyDataDir, "sessions", "linked-entry"));
  },
} satisfies Record<LegacyDataFixture, (paths: FixturePaths) => void>;

const openclawSetups = {
  none: () => undefined,
  directory: ({ openclawDir }: FixturePaths) => {
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
  },
  symlink: ({ openclawDir, openclawTarget }: FixturePaths) => {
    fs.mkdirSync(openclawTarget, { recursive: true });
    fs.writeFileSync(path.join(openclawTarget, "sentinel"), "keep\n");
    fs.symlinkSync(openclawTarget, openclawDir, "dir");
  },
} satisfies Record<OpenClawFixture, (paths: FixturePaths) => void>;

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function indexOfRequired(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function hasBuildKitRunMount(dockerfile: string): boolean {
  return dockerfile
    .replace(/\\\r?\n[ \t]*/gu, " ")
    .split(/\r?\n/u)
    .some((instruction) => {
      const runOptionPrefix = instruction.match(/^\s*RUN((?:\s+--\S+)*)/iu)?.[1] ?? "";
      return /(?:^|\s)--mount(?:=|$)/iu.test(runOptionPrefix);
    });
}

function runFinalLayout({
  legacyData = "none",
  openclaw = "none",
}: {
  legacyData?: LegacyDataFixture;
  openclaw?: OpenClawFixture;
} = {}) {
  const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-final-layout-"));
  const sandboxRoot = path.join(tmp, "sandbox");
  const hermesDir = path.join(sandboxRoot, ".hermes");
  const legacyDataDir = path.join(sandboxRoot, ".hermes-data");
  const legacyTarget = path.join(tmp, "legacy-target");
  const openclawDir = path.join(sandboxRoot, ".openclaw");
  const openclawTarget = path.join(tmp, "openclaw-target");

  fs.mkdirSync(hermesDir, { recursive: true });
  fs.writeFileSync(path.join(hermesDir, "config.yaml"), "model: test\n");
  fs.writeFileSync(path.join(hermesDir, ".env"), "TOKEN=test\n");

  const fixturePaths = {
    hermesDir,
    legacyDataDir,
    legacyTarget,
    openclawDir,
    openclawTarget,
  };
  legacyDataSetups[legacyData](fixturePaths);
  openclawSetups[openclaw](fixturePaths);

  const layoutCommand = dockerRunCommandBetween(
    dockerfile,
    "# Flatten stale published base images",
    "# Pin config hash at build time",
  ).replaceAll("/root/.cache/pip", path.join(tmp, "root-cache", "pip"));
  const { result } = runDockerShell(layoutCommand, sandboxRoot);
  return { hermesDir, legacyTarget, openclawTarget, result, sandboxRoot, tmp };
}

describe("Hermes final image layout", () => {
  it.each([
    ["same-line", "RUN --network=none --mount=type=cache,target=/tmp true", true],
    ["line-continuation", "RUN --security=sandbox \\\n  --mount=type=secret,id=token true", true],
    ["shell-command argument", "RUN printf '%s' --mount=type=cache", false],
  ] as const)("recognizes BuildKit mounts only in the RUN option prefix for %s form (#7611)", (_form, dockerfile, expected) => {
    expect(hasBuildKitRunMount(dockerfile)).toBe(expected);
  });

  // source-shape-contract: compatibility -- Legacy-compatible grouped payload copies preserve the measured Hermes layer budget without invalidating earlier build work
  it("uses grouped legacy-compatible payload layers at their cache boundaries (#7611)", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const doctorLayer = dockerRunCommandBetween(
      dockerfile,
      "# Run Hermes' upstream repair",
      "# Install NemoClaw plugin into Hermes",
    );
    const stages = dockerfile.split(/(?=^FROM )/mu).filter((stage) => stage.startsWith("FROM "));
    const finalStageIndex = stages.findIndex((stage) => stage.startsWith("FROM ${BASE_IMAGE}"));
    const finalStage = stages[finalStageIndex] ?? "";
    const payloads = [
      {
        stage: "hermes-npm-patch-payload",
        copies: [
          "COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts",
          "COPY scripts/patch-bundled-npm-brace-expansion.mts /scripts/patch-bundled-npm-brace-expansion.mts",
          "COPY scripts/lib/patch-bundled-npm-ip-address.mts /scripts/lib/patch-bundled-npm-ip-address.mts",
          "COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts",
        ],
      },
      {
        stage: "hermes-agent-payload",
        copies: [
          "COPY agents/hermes/plugin/ /opt/nemoclaw-hermes-plugin/",
          "COPY agents/hermes/generate-config.ts /opt/nemoclaw-hermes-config/generate-config.ts",
          "COPY agents/hermes/config/ /opt/nemoclaw-hermes-config/config/",
          "COPY agents/hermes/image-build-probes.py /opt/nemoclaw-hermes-config/image-build-probes.py",
          "COPY agents/hermes/patch-gateway-runtime-metadata.py /opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py",
          "COPY agents/hermes/patch-gateway-process-identity.py /opt/nemoclaw-hermes-config/patch-gateway-process-identity.py",
          "COPY agents/hermes/patch-cron-execution-runtime.py /opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py",
          "COPY agents/hermes/patch-cron-restore-drain.py /opt/nemoclaw-hermes-config/patch-cron-restore-drain.py",
          "COPY agents/hermes/patch-neutral-platform-env-activation.py /opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py",
          "COPY agents/hermes/host/managed-tool-gateway-matrix.json /opt/nemoclaw-hermes-config/managed-tool-gateway-matrix.json",
          "COPY src/lib/hermes-managed-route.ts /src/lib/hermes-managed-route.ts",
          "COPY src/lib/tool-disclosure.ts /src/lib/tool-disclosure.ts",
          "COPY src/lib/messaging/ /src/lib/messaging/",
          "COPY scripts/lib/openclaw-npm-remediation.mts /scripts/lib/openclaw-npm-remediation.mts",
        ],
      },
      {
        stage: "hermes-runtime-payload",
        copies: [
          "COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/",
          "COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/",
          "COPY scripts/lib/sandbox-init.sh /usr/local/lib/nemoclaw/sandbox-init.sh",
          "COPY scripts/lib/entrypoint-env-wrapper.sh /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh",
          "COPY scripts/lib/gateway-supervisor.sh /usr/local/lib/nemoclaw/gateway-supervisor.sh",
          "COPY scripts/lib/sandbox-rlimits.sh /usr/local/lib/nemoclaw/sandbox-rlimits.sh",
          "COPY agents/hermes/start.sh /usr/local/bin/nemoclaw-start",
          "COPY scripts/managed-startup-hold.sh /usr/local/bin/nemoclaw-managed-startup-hold",
          "COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/bin/nemoclaw-managed-bootstrap /usr/local/bin/nemoclaw-managed-bootstrap",
          "COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh",
          "COPY --from=managed-startup-runtime-builder /out/managed-startup-image-runtime.cjs /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
          "COPY scripts/gateway-control.sh /usr/local/bin/nemoclaw-gateway-control",
          "COPY scripts/managed-gateway-control.py /usr/local/lib/nemoclaw/managed-gateway-control.py",
          "COPY agents/hermes/validate-env-secret-boundary.py /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
          "COPY agents/hermes/patch-session-list-preview.py /usr/local/lib/nemoclaw/patch-hermes-session-list-preview.py",
          "COPY agents/hermes/patch-discord-recovery-permissions.py /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py",
          "COPY agents/hermes/patch-profile-policy-defaults.py /usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py",
          "COPY agents/hermes/managed_policy.py /usr/local/lib/nemoclaw/managed_policy.py",
          "COPY agents/hermes/patch-langfuse-credentials.mts /usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts",
          "COPY agents/hermes/seed-dashboard-config.py /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py",
          "COPY agents/hermes/runtime-config-guard.py /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
          "COPY agents/hermes/finalize-tirith-marker.py /usr/local/lib/nemoclaw/finalize-tirith-marker.py",
          "COPY agents/hermes/build-mcp-digest.py /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py",
          "COPY agents/hermes/mcp-config-transaction.py /usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
          "COPY agents/hermes/cron-restore-control.py /usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
          "COPY src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.85.json /usr/local/lib/nemoclaw/openshell-child-visible-credentials.v0.0.85.json",
          "COPY scripts/state-dir-guard.py /usr/local/lib/nemoclaw/state-dir-guard.py",
          "COPY agents/hermes/state-lock-plan.json /usr/local/share/nemoclaw/state-lock-plan.json",
          "COPY nemoclaw-blueprint/scripts/*.js /usr/local/lib/nemoclaw/preloads/",
        ],
      },
      {
        stage: "hermes-wrapper-payload",
        copies: [
          "COPY agents/hermes/hermes-wrapper.py /usr/local/lib/nemoclaw/hermes-wrapper.py",
          "COPY agents/hermes/validate-cli-adapter.py /usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py",
          "COPY agents/hermes/hermes-cli-adapter-v1.json /usr/local/share/nemoclaw/hermes-cli-adapter-v1.json",
        ],
      },
      {
        stage: "hermes-scan-payload",
        copies: [
          "COPY scripts/checks/node-tar-image-scan.mts /scripts/checks/node-tar-image-scan.mts",
        ],
      },
    ] as const;
    const npmPatchCopy = "COPY --from=hermes-npm-patch-payload / /";
    const agentCopy = "COPY --from=hermes-agent-payload / /";
    const runtimeCopy = "COPY --from=hermes-runtime-payload / /";
    const wrapperCopy = "COPY --from=hermes-wrapper-payload / /";
    const scanCopy = "COPY --from=hermes-scan-payload / /";

    expect(finalStageIndex).toBe(stages.length - 1);
    expect(hasBuildKitRunMount(dockerfile)).toBe(false);
    expectManagedBootstrapNativeImageContract(dockerfile);
    for (const payload of payloads) {
      const stage = stages.find((entry) => entry.startsWith(`FROM scratch AS ${payload.stage}`));
      expect(stage?.match(/^COPY\b.*$/gmu)).toEqual(payload.copies);
      expect(finalStage).toContain(`COPY --from=${payload.stage} / /`);
    }
    expect(finalStage.match(/^COPY\b.*$/gmu)).toEqual([
      npmPatchCopy,
      agentCopy,
      runtimeCopy,
      wrapperCopy,
      scanCopy,
    ]);
    const npmPatch = indexOfRequired(finalStage, npmPatchCopy);
    const agent = indexOfRequired(finalStage, agentCopy);
    const runtime = indexOfRequired(finalStage, runtimeCopy);
    const wrapper = indexOfRequired(finalStage, wrapperCopy);
    const scan = indexOfRequired(finalStage, scanCopy);
    const tarPatch = requireSingleReviewedDockerfileRunCommand(
      finalStage,
      "node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts",
      NPM_ROOT_ARGUMENTS,
    ).commandStart;
    const certifiInstall = indexOfRequired(finalStage, "RUN _hermes_certifi=");
    const agentChmod = indexOfRequired(
      finalStage,
      "RUN chmod -R a+rX /opt/nemoclaw-hermes-plugin/",
    );
    const managedMessagingUnionInstall = indexOfRequired(
      finalStage,
      "--agent hermes --phase managed-image-capability-union",
    );
    const cronRestoreDrainPatch = indexOfRequired(
      finalStage,
      "ARG NEMOCLAW_HERMES_CRON_RESTORE_DRAIN_PATCHER_SHA256=",
    );
    const profilePolicyPatch = indexOfRequired(
      finalStage,
      "RUN /usr/bin/python3 -I /usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py",
    );
    const neutralPlatformPatch = indexOfRequired(
      finalStage,
      "ARG NEMOCLAW_HERMES_POST_PROFILE_GATEWAY_CONFIG_SHA256=",
    );
    const neutralMessagingConfig = indexOfRequired(finalStage, "neutral-platform-inertness");
    const configFind = indexOfRequired(finalStage, "RUN find /opt/nemoclaw-hermes-config");
    const blueprintChmod = indexOfRequired(
      finalStage,
      "RUN chmod -R a+rX /opt/nemoclaw-blueprint/",
    );
    const managedRuntimeDirectory = indexOfRequired(
      finalStage,
      "&& install -d -o root -g root -m 0755 /run/nemoclaw",
    );
    const runtimeModeReplay = indexOfRequired(
      finalStage,
      "RUN chmod 755 /usr/local/bin/nemoclaw-start",
    );
    const tirithFinalizerHash = indexOfRequired(
      finalStage,
      '"$NEMOCLAW_HERMES_TIRITH_FINALIZER_SHA256"',
    );
    const pythonCheck = indexOfRequired(finalStage, "RUN test -x /usr/bin/python3");
    const darwinCompatibility = indexOfRequired(
      finalStage,
      'RUN if [ "$NEMOCLAW_DARWIN_VM_COMPAT" = "1" ]',
    );
    const metadataCheck = indexOfRequired(finalStage, "RUN check_metadata()");
    const modeNormalize = indexOfRequired(finalStage, "RUN chmod 755 \\");
    const imageScan = indexOfRequired(
      finalStage,
      "node --experimental-strip-types /scripts/checks/node-tar-image-scan.mts",
    );

    expect(npmPatch).toBeLessThan(tarPatch);
    expect(agent).toBeGreaterThan(certifiInstall);
    expect(agent).toBeLessThan(agentChmod);
    expect(cronRestoreDrainPatch).toBeLessThan(profilePolicyPatch);
    expect(profilePolicyPatch).toBeLessThan(neutralPlatformPatch);
    expect(neutralPlatformPatch).toBeLessThan(neutralMessagingConfig);
    expect(managedMessagingUnionInstall).toBeLessThan(neutralMessagingConfig);
    expect(runtime).toBeGreaterThan(configFind);
    expect(runtime).toBeLessThan(managedRuntimeDirectory);
    expect(managedRuntimeDirectory).toBeLessThan(blueprintChmod);
    expect(runtime).toBeLessThan(blueprintChmod);
    expect(managedRuntimeDirectory).toBeLessThan(runtimeModeReplay);
    expect(finalStage).toContain("/usr/local/bin/nemoclaw-managed-bootstrap");
    expect(dockerfile).toContain(
      "COPY src/lib/onboard/managed-bootstrap/ ./src/lib/onboard/managed-bootstrap/",
    );
    expect(dockerfile).toContain("src/lib/onboard/managed-bootstrap/image-runtime.ts");
    expect(wrapper).toBeGreaterThan(tirithFinalizerHash);
    expect(wrapper).toBeLessThan(pythonCheck);
    expect(scan).toBeGreaterThan(darwinCompatibility);
    expect(scan).toBeLessThan(metadataCheck);
    expect(modeNormalize).toBeGreaterThan(scan);
    expect(modeNormalize).toBeLessThan(metadataCheck);
    for (const metadataContract of [
      "/scripts/patch-bundled-npm-brace-expansion.mts 'root:root 444'",
      "/scripts/lib/patch-bundled-npm-ip-address.mts 'root:root 444'",
      "/scripts/patch-bundled-npm-tar.mts 'root:root 444'",
      "/opt/nemoclaw-hermes-config/generate-config.ts 'root:root 444'",
      "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py 'root:root 755'",
      "/usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py 'root:root 755'",
      "/usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py 'root:root 755'",
      "/usr/local/lib/nemoclaw/managed_policy.py 'root:root 444'",
      "/usr/local/share/nemoclaw/hermes-managed-policy.json 'root:root 444'",
      "/usr/local/bin/nemoclaw-managed-bootstrap 'root:root 755'",
      "/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh 'root:root 444'",
      "/usr/local/bin/nemoclaw-gateway-control 'root:root 700'",
      "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py 'root:root 700'",
      "/sandbox/.nemoclaw 'root:root 1755'",
      "/usr/local/share/nemoclaw/state-lock-plan.json 'root:root 444'",
      "/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js 'root:root 444'",
      "/usr/local/lib/nemoclaw/hermes-wrapper.py 'root:root 755'",
      "/usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py 'root:root 755'",
      "/usr/local/share/nemoclaw/hermes-cli-adapter-v1.json 'root:root 444'",
      "/scripts/checks/node-tar-image-scan.mts 'root:root 755'",
    ]) {
      expect(finalStage).toContain(`check_metadata ${metadataContract}`);
    }
    expect(metadataCheck).toBeGreaterThan(scan);
    expect(metadataCheck).toBeLessThan(imageScan);
    expect(doctorLayer).toContain(
      "HERMES_HOME=/sandbox/.hermes /usr/local/bin/hermes doctor --fix",
    );
    expect(doctorLayer).toContain('if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]; then');
    expect(doctorLayer).toContain('assert m.version("microsoft-teams-apps") == "2.0.13.4"');
    expect(doctorLayer).toContain('assert m.version("aiohttp") == "3.14.3"');
    expect(doctorLayer).toContain("assert len(neutral) == 30");
    expect(finalStage).toContain("neutral-platform-inertness");
    expect(finalStage).toContain("GOOGLE_CHAT_SERVICE_ACCOUNT_JSON");
    expect(finalStage).toContain("WHATSAPP_CLOUD_ACCESS_TOKEN");
    expect(finalStage).toContain(
      "ARG NEMOCLAW_HERMES_POST_PROFILE_GATEWAY_CONFIG_SHA256=" +
        "b50a8390311c828fa9e13084e9af0caadafe2380ae161ef36dd4bdf792b22ee6",
    );
    expect(finalStage).toContain(
      "ARG NEMOCLAW_HERMES_NEUTRAL_PLATFORM_OUTPUT_SHA256=" +
        "77ad342af30d59a5b863d9f5f817247d816fd582fb12d38e074243f88d85b9f4",
    );
    expect(doctorLayer).toMatch(/generate-config[.]ts\s+&& if /u);
    expect(doctorLayer).toMatch(/fi\s+&& rm -rf \/sandbox\/[.]cache$/u);
    expect(finalStage).toContain("check_absent /opt/hermes/tests \\");
    expect(finalStage).toContain(
      "&& check_absent /opt/nemoclaw-hermes-config/image-build-probes.py \\",
    );
    expect(finalStage).toContain(
      "&& check_absent /sandbox/.nemoclaw/hermes-cron-restore-drain.json \\",
    );
    expect(finalStage).toContain("&& check_absent /sandbox/.cache \\");
    expect(finalStage).toContain("&& check_absent /sandbox/.hermes/managed-policy.json \\");
    expect(finalStage).toContain("RUN chown root:root /sandbox/.nemoclaw \\");
    expect(finalStage).toContain("&& chmod 1755 /sandbox/.nemoclaw \\");
    expect(finalStage).toContain("&& chown sandbox:sandbox /sandbox/.nemoclaw/config.json");
  });

  // source-shape-contract: security -- Exact source-to-image digests keep the reviewed Hermes runtime entrypoints bound to the files copied into the sandbox image
  it("keeps security entrypoint hashes synchronized with the copied files", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");

    for (const entry of HERMES_INTEGRITY_FILES) {
      const digest = createHash("sha256")
        .update(fs.readFileSync(path.join(ROOT, entry.source)))
        .digest("hex");
      const declaredDigest = dockerfile.match(
        new RegExp(`^ARG ${entry.arg}=([0-9a-f]{64})$`, "mu"),
      )?.[1];

      expect(dockerfile).toContain(`COPY ${entry.source} ${entry.target}`);
      expect(declaredDigest, `${entry.arg} must match ${entry.source}`).toBe(digest);
      expect(dockerfile).toContain(`"$${entry.arg}" ${entry.target}`);
    }
  });

  // source-shape-contract: security -- Adapter bytes must pass their committed integrity gate before the image build executes validator code
  it("verifies CLI adapter integrity before executing its validator", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const adapterIntegrityGate = dockerfile.match(
      /RUN printf '%s  %s\\n' \\\n\s+"\$NEMOCLAW_HERMES_WRAPPER_SHA256"[^]*?\| sha256sum -c - \\\n\s+\|\| \{ echo "ERROR: Hermes CLI adapter integrity mismatch" >&2; exit 1; \}/u,
    );
    const adapterValidation = dockerfile.indexOf(
      "RUN /opt/hermes/.venv/bin/python -I \\\n        /usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py \\",
    );

    expect(adapterIntegrityGate).not.toBeNull();
    expect(adapterValidation).toBeGreaterThan(adapterIntegrityGate?.index ?? -1);
  });

  it("rejects retired OpenClaw state represented as a directory", () => {
    const run = runFinalLayout({ openclaw: "directory" });
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain("contains retired OpenClaw state");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it("rejects retired OpenClaw state represented as a symlink without following it", () => {
    const run = runFinalLayout({ openclaw: "symlink" });
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain("contains retired OpenClaw state");
      expect(readText(path.join(run.openclawTarget, "sentinel"))).toBe("keep\n");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it("migrates legacy data into the current state directory", () => {
    const run = runFinalLayout({ legacyData: "content" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(
        fs.lstatSync(path.join(run.sandboxRoot, ".hermes-data"), {
          throwIfNoEntry: false,
        }),
      ).toBeUndefined();
      expect(fs.lstatSync(path.join(run.hermesDir, "sessions")).isDirectory()).toBe(true);
      expect(readText(path.join(run.hermesDir, "sessions", "legacy.json"))).toBe("{}\n");
      expect(fs.lstatSync(path.join(run.hermesDir, "legacy.txt")).isSymbolicLink()).toBe(false);
      expect(readText(path.join(run.hermesDir, "legacy.txt"))).toBe("legacy\n");
      const nested = path.join(run.hermesDir, "profiles", "legacy-sessions");
      expect(fs.lstatSync(nested).isDirectory()).toBe(true);
      expect(readText(path.join(nested, "legacy.json"))).toBe("{}\n");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it.each([
    "directory-symlink",
    "entry-symlink",
    "nested-symlink",
  ] as const)("refuses a legacy data %s before migration", (legacyData) => {
    const run = runFinalLayout({ legacyData });
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain("refusing legacy layout cleanup");
      const sentinel =
        legacyData === "directory-symlink"
          ? path.join(run.legacyTarget, "sentinel")
          : run.legacyTarget;
      expect(readText(sentinel)).toBe("keep\n");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });
});
