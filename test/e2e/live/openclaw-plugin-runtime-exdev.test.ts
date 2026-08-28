// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveOpenshell } from "../../../src/lib/adapters/openshell/resolve.ts";
import { pullAndResolveBaseImageDigest } from "../../../src/lib/onboard/base-image.ts";
import {
  hasRequiredOpenshellMessagingFeatures,
  REQUIRED_OPENSHELL_MCP_FEATURES,
} from "../../../src/lib/onboard/openshell-feature-gate.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { parseJsonFromText } from "./json-envelope.ts";
import {
  CURRENT_LIFECYCLE_TEST_SELECTOR,
  type OpenClawPluginRuntimeExdevFixture,
  RELEASE_BASELINE_TEST_SELECTOR,
  RELEASE_SANDBOX_BASE_IMAGE_REF,
  resolveOpenClawPluginRuntimeExdevFixture,
} from "./openclaw-plugin-runtime-exdev-fixture.ts";
import {
  CURRENT_LIFECYCLE_PHASES,
  currentLifecycleCommands,
  type WeatherFixtureVersion,
} from "./openclaw-plugin-runtime-exdev-lifecycle.ts";
import {
  buildTrustedPluginFixtureImage,
  createOpenShellTrustedImageWrapper,
  DELEGATED_CAPABILITY_COMMENT_PREFIX,
  registerTrustedPluginFixtureImageCleanup,
  trustedExdevImageRef,
  withEnabledLocalBaseImageBuild,
} from "./openclaw-plugin-runtime-exdev-trusted-prebuild.ts";
import {
  createOpenShellDriverConfigTestWrapper,
  type OpenShellComponents,
  type OpenShellDriverConfigTestWrapper,
  resolveOpenShellSiblingComponents,
  withOpenShellDriverConfigWrapperEnv,
} from "./openshell-driver-config-test-wrapper.ts";

// Keep this contract as a focused live test: build a deterministic custom plugin
// on top of the complete managed runtime, prove it survives restart/recreation, then
// run the in-sandbox Node replacement probe that guards #3513/#3127's EXDEV
// cross-device runtime-deps failure mode. No registry or ledger is required.

const WEATHER_FIXTURE_DIR = path.join(REPO_ROOT, "test/e2e/fixtures/plugins/weather");
const WEATHER_FIXTURE_PACKAGE_PATH = path.join(WEATHER_FIXTURE_DIR, "package.json");
const WEATHER_FIXTURE_PACKAGE = JSON.parse(
  fs.readFileSync(WEATHER_FIXTURE_PACKAGE_PATH, "utf8"),
) as {
  openclaw?: { build?: { openclawVersion?: unknown } };
  devDependencies?: { openclaw?: unknown };
};
const EXPECTED_RELEASE_OPENCLAW_VERSION = "2026.5.27";
const weatherOpenClawVersion = WEATHER_FIXTURE_PACKAGE.openclaw?.build?.openclawVersion;
assert.equal(
  typeof weatherOpenClawVersion,
  "string",
  "weather fixture must declare an OpenClaw build version",
);
const WEATHER_OPENCLAW_VERSION = String(weatherOpenClawVersion);
assert.match(
  WEATHER_OPENCLAW_VERSION,
  /^\d+(?:\.\d+)+$/,
  "weather fixture must declare a canonical OpenClaw build version",
);
assert.equal(
  WEATHER_OPENCLAW_VERSION,
  EXPECTED_RELEASE_OPENCLAW_VERSION,
  "weather fixture must match the OpenClaw runtime pinned by NemoClaw v0.0.71",
);
const NEMOCLAW_RELEASE_TAG = "v0.0.71";
const NEMOCLAW_RELEASE_COMMIT = "e4b9111f5f0535c2fc3d6fbe8dc8dca101a6fdce";
const NEMOCLAW_RELEASE_OPENSHELL_VERSION = "0.0.71";
const CURRENT_OPENSHELL_VERSION = "0.0.106";
const NEMOCLAW_SOURCE_REPOSITORY = "https://github.com/NVIDIA/NemoClaw.git";
const RELEASE_BUILDER_IMAGE_REF =
  "node:22-trixie-slim@sha256:2d9f5c76c8f4dd36e8f253bee5d828a83a6c09f36188f0b0414325232e0b175d";
const CURRENT_BUILDER_IMAGE_REF =
  "node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c";
const TOOL_DISCLOSURE_ENV_REFERENCE = "${NEMOCLAW_TOOL_DISCLOSURE}";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-oc-exdev";
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
const EXDEV_TMPFS_MOUNT = "/tmp/nemoclaw-exdev-tmpfs";
const EXDEV_TMPFS_SOURCE = `${EXDEV_TMPFS_MOUNT}/source`;
const EXDEV_TMPFS_MOUNT_CONFIG = {
  type: "tmpfs",
  target: EXDEV_TMPFS_MOUNT,
  // tmpfs is read-write by default. Docker's MountTmpfsOptions rejects `rw`,
  // `nosuid`, and `nodev`; `noexec` is supported by both pinned drivers.
  options: ["noexec"],
  size_bytes: 16_777_216,
  mode: 0o1777,
} as const;
const EXDEV_TMPFS_DRIVER_CONFIG = JSON.stringify({
  docker: {
    mounts: [EXDEV_TMPFS_MOUNT_CONFIG],
  },
  podman: {
    mounts: [EXDEV_TMPFS_MOUNT_CONFIG],
  },
});
const STOCK_OPENCLAW_POLICY_PATHS = [
  path.join(REPO_ROOT, "agents", "openclaw", "policy-permissive.yaml"),
  path.join(REPO_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
  path.join(REPO_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"),
] as const;
validateSandboxName(SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

const EXDEV_PATTERNS = [
  /EXDEV: cross-device link not permitted/i,
  /cross-device link not permitted/i,
];
const GATEWAY_CATALOG_CALL_SOURCE = String.raw`
import { Buffer } from "node:buffer";
import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function findOnPath(command) {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("Could not find " + command + " on PATH");
}

const port = process.env.OPENCLAW_GATEWAY_PORT || "18789";
if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
  throw new Error("OPENCLAW_GATEWAY_PORT must be a canonical TCP port in 1..65535");
}
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
if (!token) throw new Error("OPENCLAW_GATEWAY_TOKEN is required");

const openclawBin = realpathSync(findOnPath("openclaw"));
const requireFromOpenclaw = createRequire(openclawBin);
const runtimePath = requireFromOpenclaw.resolve("openclaw/plugin-sdk/gateway-runtime");
const { callGatewayFromCli } = await import(pathToFileURL(runtimePath).href);
const params = JSON.parse(
  Buffer.from(process.env.NEMOCLAW_E2E_GATEWAY_PARAMS_B64 || "e30=", "base64").toString("utf8"),
);
const result = await callGatewayFromCli(
  "tools.catalog",
  { url: "ws://127.0.0.1:" + port, token, timeout: "30000", json: true },
  params,
  { clientName: "gateway-client", mode: "backend", scopes: ["operator.read"], progress: false },
);
process.stdout.write(JSON.stringify(result) + "\n");
`.trim();

function normalizeSandboxStdoutFrames(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\[stdout\]|stdout:)\s*/i, ""))
    .join("\n");
}

function liveEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

async function ignoreCleanupError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort: local machines may not have a completed install or an
    // OpenShell gateway yet, and cleanup should not mask the real assertion.
  }
}

type OpenShellTmpfsWrapper = OpenShellDriverConfigTestWrapper;
type PinnedOpenShellComponents = OpenShellComponents;

function createOpenShellTmpfsWrapper(realOpenshellPath: string): OpenShellTmpfsWrapper {
  return createOpenShellDriverConfigTestWrapper({
    delegatedCapabilityMarkers: REQUIRED_OPENSHELL_MCP_FEATURES,
    driverConfigJson: EXDEV_TMPFS_DRIVER_CONFIG,
    label: "exdev",
    realOpenshellPath,
  });
}

function withOpenShellWrapperEnv(
  env: NodeJS.ProcessEnv,
  wrapper: OpenShellTmpfsWrapper,
  components: PinnedOpenShellComponents,
): NodeJS.ProcessEnv {
  return withOpenShellDriverConfigWrapperEnv(env, wrapper, components);
}

function resolvePinnedOpenShellComponents(openshellPath: string): PinnedOpenShellComponents {
  return resolveOpenShellSiblingComponents(openshellPath);
}

async function installAndResolvePinnedOpenShell(
  host: HostCliClient,
  installScriptPath: string,
  artifactLabel: string,
  expectedVersion: string,
): Promise<PinnedOpenShellComponents> {
  const install = await host.command("bash", [installScriptPath], {
    artifactName: `install-${artifactLabel}-openshell-for-exdev-wrapper`,
    env: liveEnv(),
    timeoutMs: 5 * 60_000,
  });
  expect(install.exitCode, resultText(install)).toBe(0);
  const resolved = resolveOpenshell();
  expect(resolved, "pinned OpenShell installer did not leave an executable CLI").not.toBeNull();
  const components = resolvePinnedOpenShellComponents(resolved as string);
  const version = await host.command(components.cli, ["--version"], {
    artifactName: `verify-${artifactLabel}-openshell-version`,
    env: liveEnv(),
    timeoutMs: 30_000,
  });
  expect(version.exitCode, resultText(version)).toBe(0);
  expect(resultText(version)).toMatch(
    new RegExp(`\\b${expectedVersion.replaceAll(".", "\\.")}\\b`),
  );
  return components;
}

async function stopOpenShellGatewayBeforeVersionSwitch(
  host: HostCliClient,
  artifactLabel: string,
  env: NodeJS.ProcessEnv = liveEnv(),
): Promise<void> {
  const openshellPath = resolveOpenshell();
  if (!openshellPath) return;
  await host.command(openshellPath, ["gateway", "stop", "-g", "nemoclaw"], {
    artifactName: `stop-${artifactLabel}-openshell-gateway-before-version-switch`,
    env,
    timeoutMs: 60_000,
  });
}

type PolicySourceSnapshot = ReadonlyArray<{ policyPath: string; bytes: Buffer }>;

function snapshotPolicySources(): PolicySourceSnapshot {
  return STOCK_OPENCLAW_POLICY_PATHS.map((policyPath) => ({
    policyPath,
    bytes: fs.readFileSync(policyPath),
  }));
}

function assertPolicySourcesUnchanged(snapshot: PolicySourceSnapshot, phase: string): void {
  for (const { policyPath, bytes } of snapshot) {
    expect(fs.readFileSync(policyPath), `${policyPath} changed during ${phase}`).toEqual(bytes);
  }
}

function runWrapper(wrapper: string, args: readonly string[]): string[] {
  const result = spawnSync(wrapper, args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trimEnd().split("\n");
}

test(
  "OpenShell wrapper injects the reviewed tmpfs config and selected fixture image",
  {
    meta: {
      e2ePhases: [
        "create fake OpenShell delegates",
        "inspect wrapper capabilities and environment",
        "verify sandbox-create argument injection",
        "reject duplicate driver config and remove the fixture",
      ],
    },
  },
  ({ progress }) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-wrapper-contract-"));
    const delegate = path.join(fixture, "real-openshell");
    const gateway = path.join(fixture, "openshell-gateway");
    const sandbox = path.join(fixture, "openshell-sandbox");
    const executableSource = "#!/bin/sh\nprintf '%s\\n' \"$@\"\n";
    [delegate, gateway, sandbox].forEach((executable) => {
      fs.writeFileSync(executable, executableSource, {
        encoding: "utf8",
        mode: 0o700,
      });
    });
    const components = resolvePinnedOpenShellComponents(delegate);
    const wrapper = createOpenShellTrustedImageWrapper({
      driverConfigJson: EXDEV_TMPFS_DRIVER_CONFIG,
      realOpenshellPath: components.cli,
    });
    try {
      const imageRef = trustedExdevImageRef("wrapper-contract-v1");
      progress.phase("inspect wrapper capabilities and environment");
      const missingImage = spawnSync(
        wrapper.executable,
        ["sandbox", "create", "--from", "/tmp/staged/Dockerfile"],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );
      expect(missingImage.status).toBe(64);
      expect(missingImage.stderr).toContain("rejected the selected image ref");
      expect(() => wrapper.selectImage("docker.io/untrusted:latest")).toThrow();
      wrapper.selectImage(imageRef);
      const wrapperSource = fs.readFileSync(wrapper.executable, "utf8");
      expect(
        wrapperSource
          .split("\n")
          .filter((line) => line.startsWith(DELEGATED_CAPABILITY_COMMENT_PREFIX)),
      ).toEqual(
        REQUIRED_OPENSHELL_MCP_FEATURES.map(
          (marker) => `${DELEGATED_CAPABILITY_COMMENT_PREFIX}${marker}`,
        ),
      );
      expect(REQUIRED_OPENSHELL_MCP_FEATURES.every((marker) => wrapperSource.split(marker).length === 2)).toBe(true);
      expect(components).toEqual({
        cli: fs.realpathSync(delegate),
        gateway: fs.realpathSync(gateway),
        sandbox: fs.realpathSync(sandbox),
      });
      expect(withOpenShellWrapperEnv({ PATH: "/usr/bin" }, wrapper, components)).toMatchObject({
        PATH: `${wrapper.directory}${path.delimiter}/usr/bin`,
        NEMOCLAW_OPENSHELL_BIN: wrapper.executable,
        NEMOCLAW_OPENSHELL_GATEWAY_BIN: components.gateway,
        NEMOCLAW_OPENSHELL_SANDBOX_BIN: components.sandbox,
      });
      expect(EXDEV_TMPFS_MOUNT_CONFIG.options).toEqual(["noexec"]);
      expect(JSON.parse(EXDEV_TMPFS_DRIVER_CONFIG)).toEqual({
        docker: { mounts: [EXDEV_TMPFS_MOUNT_CONFIG] },
        podman: { mounts: [EXDEV_TMPFS_MOUNT_CONFIG] },
      });
      progress.phase("verify sandbox-create argument injection");
      expect(
        runWrapper(wrapper.executable, [
          "sandbox",
          "create",
          "--from",
          "/tmp/staged/Dockerfile",
          "--name",
          "demo",
          "--",
          "sh",
          "-lc",
          "printf value",
        ]),
      ).toEqual([
        "sandbox",
        "create",
        "--driver-config-json",
        EXDEV_TMPFS_DRIVER_CONFIG,
        "--from",
        imageRef,
        "--name",
        "demo",
        "--",
        "sh",
        "-lc",
        "printf value",
      ]);
      const deleted = runWrapper(wrapper.executable, ["sandbox", "delete", "demo"]);
      expect(deleted).toEqual(["sandbox", "delete", "demo"]);
      expect(runWrapper(wrapper.executable, ["--version"])).toEqual(["--version"]);
      progress.phase("reject duplicate driver config and remove the fixture");
      const duplicateConfig = spawnSync(
        wrapper.executable,
        ["sandbox", "create", "--from", "/tmp/staged/Dockerfile", "--driver-config-json", "{}"],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );
      expect(duplicateConfig.status).toBe(64);
      expect(duplicateConfig.stderr).toContain("refusing duplicate --driver-config-json");
    } finally {
      wrapper.remove();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
    expect(fs.existsSync(wrapper.directory)).toBe(false);
  },
);

type CustomPluginBuildContext = {
  sourceParentDir: string;
  sourceRoot: string;
  cliEntrypoint: string;
  dockerfilePath: string;
  versionSourcePath: string;
  pluginDirPath: string;
};

type PreparedCustomPluginBuildContext = CustomPluginBuildContext & {
  runtimeOpenClawVersion: string;
};

function createCustomPluginBuildContext(): CustomPluginBuildContext {
  const nonce = randomUUID();
  const sourceParentDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-weather-plugin-"));
  const sourceRoot = path.join(sourceParentDir, "NemoClaw");
  return {
    sourceParentDir,
    sourceRoot,
    cliEntrypoint: path.join(sourceRoot, "bin", "nemoclaw.js"),
    dockerfilePath: path.join(sourceRoot, `Dockerfile.e2e-weather-plugin-${nonce}`),
    versionSourcePath: path.join(sourceRoot, `e2e-weather-plugin-version-${nonce}.ts`),
    pluginDirPath: path.join(sourceRoot, `e2e-weather-plugin-${nonce}`),
  };
}

test(
  "custom plugin build paths are collision-safe and outside the checkout",
  {
    meta: {
      e2ePhases: [
        "allocate isolated plugin build contexts",
        "verify unique paths outside the checkout",
        "remove the plugin build contexts",
      ],
    },
  },
  ({ progress }) => {
    const first = createCustomPluginBuildContext();
    const second = createCustomPluginBuildContext();
    try {
      progress.phase("verify unique paths outside the checkout");
      expect(first.sourceParentDir).not.toBe(second.sourceParentDir);
      expect(first.sourceParentDir.startsWith(`${REPO_ROOT}${path.sep}`)).toBe(false);
      expect(second.sourceParentDir.startsWith(`${REPO_ROOT}${path.sep}`)).toBe(false);
      expect(fs.statSync(first.sourceParentDir).isDirectory()).toBe(true);
      expect(fs.statSync(second.sourceParentDir).isDirectory()).toBe(true);
      progress.phase("remove the plugin build contexts");
    } finally {
      fs.rmSync(first.sourceParentDir, { recursive: true, force: true });
      fs.rmSync(second.sourceParentDir, { recursive: true, force: true });
    }
  },
);

function copyFixtureFileExclusive(source: string, target: string): void {
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

function stageWeatherPluginFixture(context: CustomPluginBuildContext): void {
  fs.mkdirSync(context.pluginDirPath);
  fs.mkdirSync(path.join(context.pluginDirPath, "src"));
  for (const fileName of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "openclaw.plugin.json",
  ]) {
    copyFixtureFileExclusive(
      path.join(WEATHER_FIXTURE_DIR, fileName),
      path.join(context.pluginDirPath, fileName),
    );
  }
  copyFixtureFileExclusive(
    path.join(WEATHER_FIXTURE_DIR, "src", "index.ts"),
    path.join(context.pluginDirPath, "src", "index.ts"),
  );
}

function writeCustomPluginVersion(
  versionSourcePath: string,
  version: WeatherFixtureVersion,
  exclusive = false,
): void {
  fs.writeFileSync(
    versionSourcePath,
    `// Generated by the OpenClaw plugin lifecycle E2E.\nexport const WEATHER_FIXTURE_VERSION = ${JSON.stringify(version)};\n`,
    { encoding: "utf8", flag: exclusive ? "wx" : "w" },
  );
}

function createCustomPluginDockerfile(
  context: CustomPluginBuildContext,
  fixture: OpenClawPluginRuntimeExdevFixture,
): string {
  const sourceDockerfile = path.join(context.sourceRoot, "Dockerfile");
  const source = fs.readFileSync(sourceDockerfile, "utf8");
  const baseImageAnchor = "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n";
  const builderImageRef =
    fixture.source === "release" ? RELEASE_BUILDER_IMAGE_REF : CURRENT_BUILDER_IMAGE_REF;
  const builderImageAnchor = `FROM ${builderImageRef} AS builder\n`;
  const runtimeAnchor = "FROM ${BASE_IMAGE}\n";
  expect(
    source.match(/^ARG BASE_IMAGE=ghcr\.io\/nvidia\/nemoclaw\/sandbox-base:latest$/gm)?.length,
  ).toBe(1);
  expect(source.split(builderImageAnchor)).toHaveLength(2);
  expect(source.match(/^FROM \$\{BASE_IMAGE\}$/gm)?.length, "expected one runtime stage").toBe(1);
  const runtimeOpenClawDeclarations = [...source.matchAll(/^ARG OPENCLAW_VERSION=([0-9.]+)$/gm)];
  expect(runtimeOpenClawDeclarations, "expected one OpenClaw version declaration").toHaveLength(1);
  const runtimeOpenClawVersion = runtimeOpenClawDeclarations[0]?.[1];
  expect(runtimeOpenClawVersion, "source Dockerfile must declare an OpenClaw version").toMatch(
    /^\d+(?:\.\d+)+$/,
  );
  expect(
    fixture.source !== "release" || runtimeOpenClawVersion === WEATHER_OPENCLAW_VERSION,
    "weather fixture SDK must match the v0.0.71 managed runtime target",
  ).toBe(true);
  expect(
    WEATHER_FIXTURE_PACKAGE.devDependencies?.openclaw,
    "weather fixture devDependency must match its declared OpenClaw build target",
  ).toBe(WEATHER_OPENCLAW_VERSION);

  const selectedSource =
    fixture.source === "release"
      ? source.replace(baseImageAnchor, `ARG BASE_IMAGE=${RELEASE_SANDBOX_BASE_IMAGE_REF}\n`)
      : source;
  const runtime = selectedSource.replace(runtimeAnchor, "FROM ${BASE_IMAGE} AS nemoclaw-runtime\n");
  const pluginDirName = path.basename(context.pluginDirPath);
  const versionSourceName = path.basename(context.versionSourcePath);
  const extension = String.raw`

# Build the deterministic custom-plugin fixture used by this live contract.
FROM builder AS weather-plugin-builder
WORKDIR /opt/weather
COPY ${pluginDirName}/package.json ${pluginDirName}/package-lock.json ${pluginDirName}/tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY ${pluginDirName}/openclaw.plugin.json ./
COPY ${pluginDirName}/src/ ./src/
COPY ${versionSourceName} ./src/version.ts
RUN npm run build \
    && npm prune --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund \
    && test ! -e node_modules/openclaw \
    && sha256sum dist/index.js dist/version.js | sha256sum | cut -d ' ' -f 1 > e2e-weather-plugin.sha256

# Extend the completed managed runtime so its entrypoint, health check, config
# generation, and permissions remain the source of truth.
FROM nemoclaw-runtime AS weather-runtime
ARG NEMOCLAW_TOOL_DISCLOSURE=progressive
ENV NEMOCLAW_TOOL_DISCLOSURE=${TOOL_DISCLOSURE_ENV_REFERENCE}
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/package.json \
    /opt/weather/package-lock.json \
    /opt/weather/openclaw.plugin.json \
    /opt/weather-plugin/
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/dist/ /opt/weather-plugin/dist/
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/node_modules/ /opt/weather-plugin/node_modules/
COPY --from=weather-plugin-builder \
    /opt/weather/e2e-weather-plugin.sha256 \
    /usr/local/share/nemoclaw/e2e-weather-plugin.sha256

USER sandbox
RUN test ! -e /opt/weather-plugin/node_modules/openclaw \
    && HOME=/sandbox openclaw plugins install /opt/weather-plugin \
    && test -L /sandbox/.openclaw/extensions/weather/node_modules/openclaw \
    && test "$(realpath /sandbox/.openclaw/extensions/weather/node_modules/openclaw)" = "${fixture.openClawModulePath}" \
    && HOME=/sandbox openclaw plugins enable weather \
    && HOME=/sandbox openclaw plugins inspect weather --json > /dev/null

# Enabling the plugin changes openclaw.json after the managed runtime hashes it.
# hadolint ignore=DL3002
USER root
RUN chown sandbox:sandbox /sandbox/.openclaw/openclaw.json \
    && chmod 660 /sandbox/.openclaw/openclaw.json \
    && sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \
    && chown sandbox:sandbox /sandbox/.openclaw/.config-hash \
    && chmod 660 /sandbox/.openclaw/.config-hash
`;
  stageWeatherPluginFixture(context);
  writeCustomPluginVersion(context.versionSourcePath, "v1", true);
  fs.writeFileSync(context.dockerfilePath, runtime.trimEnd() + extension, {
    encoding: "utf8",
    flag: "wx",
  });
  return String(runtimeOpenClawVersion);
}

async function buildAndVerifyTaggedCli(
  host: HostCliClient,
  context: CustomPluginBuildContext,
): Promise<void> {
  const workingDirectory = await host.command(
    "node",
    ["-e", "process.stdout.write(process.cwd())"],
    {
      artifactName: "verify-v0-0-71-nemoclaw-cli-working-directory",
      cwd: context.sourceRoot,
      env: liveEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(workingDirectory.exitCode, resultText(workingDirectory)).toBe(0);
  expect(workingDirectory.stdout).toBe(context.sourceRoot);

  const install = await host.command("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    artifactName: "install-v0-0-71-nemoclaw-cli",
    cwd: context.sourceRoot,
    env: liveEnv(),
    timeoutMs: 10 * 60_000,
  });
  expect(install.exitCode, resultText(install)).toBe(0);
  const build = await host.command("npm", ["run", "build:cli"], {
    artifactName: "build-v0-0-71-nemoclaw-cli",
    cwd: context.sourceRoot,
    env: liveEnv(),
    timeoutMs: 5 * 60_000,
  });
  expect(build.exitCode, resultText(build)).toBe(0);

  const version = await host.command("node", [context.cliEntrypoint, "--version"], {
    artifactName: "version-v0-0-71-nemoclaw-cli",
    cwd: context.sourceRoot,
    env: liveEnv(),
    timeoutMs: 30_000,
  });
  expect(version.exitCode, resultText(version)).toBe(0);
  expect(resultText(version)).toMatch(/\bv0\.0\.71\b/);
  const help = await host.command("node", [context.cliEntrypoint, "onboard", "--help"], {
    artifactName: "help-v0-0-71-nemoclaw-cli",
    cwd: context.sourceRoot,
    env: liveEnv(),
    timeoutMs: 30_000,
  });
  expect(help.exitCode, resultText(help)).toBe(0);
  for (const option of [
    "--from",
    "--fresh",
    "--name",
    "--no-gpu",
    "--yes-i-accept-third-party-software",
  ]) {
    expect(resultText(help)).toContain(option);
  }
}

type WeatherPluginInspect = {
  plugin?: { id?: unknown; status?: unknown; toolNames?: unknown };
  tools?: Array<{ names?: unknown }>;
};

type GatewayToolCatalog = {
  groups?: Array<{ tools?: Array<{ id?: unknown }> }>;
};

type GatewayToolInvocation = {
  ok?: unknown;
  result?: { details?: unknown };
};

type WeatherRuntimeProof = {
  imageMarker: string;
  fixtureVersion: WeatherFixtureVersion;
  inspectLoaded: boolean;
  catalogToolIds: string[];
  toolInvoked: boolean;
};

function gatewayCatalogCallScript(params: Record<string, unknown>) {
  const encodedParams = Buffer.from(JSON.stringify(params), "utf8").toString("base64");
  return trustedSandboxShellScript(`set -eu
. /tmp/nemoclaw-proxy-env.sh
export HOME=/sandbox
export NO_PROXY=127.0.0.1,localhost
export no_proxy="$NO_PROXY"
export NEMOCLAW_E2E_GATEWAY_PARAMS_B64='${encodedParams}'
exec node --input-type=module <<'NEMOCLAW_GATEWAY_CATALOG_PROBE'
${GATEWAY_CATALOG_CALL_SOURCE}
NEMOCLAW_GATEWAY_CATALOG_PROBE`);
}

async function assertWeatherPluginRuntime(
  sandbox: SandboxClient,
  phase: string,
  expectedFixtureVersion: WeatherFixtureVersion,
  expectedOpenClawVersion: string,
  expectedOpenClawModulePath: OpenClawPluginRuntimeExdevFixture["openClawModulePath"],
): Promise<WeatherRuntimeProof> {
  const imageProbe = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(`set -eu
test -s /tmp/gateway.log
test -s /usr/local/share/nemoclaw/e2e-weather-plugin.sha256
test "$(openclaw --version 2>/dev/null | awk '{print $2}')" = "${expectedOpenClawVersion}"
test -L /sandbox/.openclaw/extensions/weather/node_modules/openclaw
test "$(realpath /sandbox/.openclaw/extensions/weather/node_modules/openclaw)" = "${expectedOpenClawModulePath}"
expected=$(cat /usr/local/share/nemoclaw/e2e-weather-plugin.sha256)
actual=$(cd /sandbox/.openclaw/extensions/weather && sha256sum dist/index.js dist/version.js | sha256sum | cut -d ' ' -f 1)
[ "$expected" = "$actual" ]
printf '%s\\n' "$actual"`),
    {
      artifactName: `openclaw-weather-plugin-image-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(imageProbe.exitCode, resultText(imageProbe)).toBe(0);
  const imageMarker = normalizeSandboxStdoutFrames(imageProbe.stdout).match(
    /(?:^|\n)([a-f0-9]{64})(?:\r?\n|$)/,
  )?.[1];
  expect(imageMarker).toMatch(/^[a-f0-9]{64}$/);

  const inspectProbe = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript("HOME=/sandbox openclaw plugins inspect weather --runtime --json"),
    {
      artifactName: `openclaw-weather-plugin-inspect-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(inspectProbe.exitCode, resultText(inspectProbe)).toBe(0);
  const inspect = parseJsonFromText(
    normalizeSandboxStdoutFrames(inspectProbe.stdout),
  ) as WeatherPluginInspect;
  expect(inspect.plugin?.id).toBe("weather");
  expect(inspect.plugin?.status).toBe("loaded");
  expect(inspect.plugin?.toolNames).toContain("get_weather");
  expect(inspect.tools?.flatMap((tool) => (Array.isArray(tool.names) ? tool.names : []))).toContain(
    "get_weather",
  );

  // Exercise OpenClaw's documented HTTP tool surface with the managed bearer
  // token supplied on stdin so the credential never enters process arguments.
  const invokeProbe = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `. /tmp/nemoclaw-proxy-env.sh && printf 'header = "Authorization: Bearer %s"\\n' "$OPENCLAW_GATEWAY_TOKEN" | curl --noproxy '*' --max-time 30 --silent --show-error --fail-with-body --config - -H 'Content-Type: application/json' --data '{"agentId":"main","tool":"get_weather","args":{"location":"Santa Clara"}}' "http://127.0.0.1:\${OPENCLAW_GATEWAY_PORT:-18789}/tools/invoke"`,
    ),
    {
      artifactName: `openclaw-weather-plugin-invoke-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(invokeProbe.exitCode, resultText(invokeProbe)).toBe(0);
  const invocation = parseJsonFromText(
    normalizeSandboxStdoutFrames(invokeProbe.stdout),
  ) as GatewayToolInvocation;
  expect(invocation).toMatchObject({
    ok: true,
    result: {
      details: {
        location: "Santa Clara",
        condition: "clear",
        temperatureC: 21,
        fixtureVersion: expectedFixtureVersion,
      },
    },
  });

  // Mirror NemoClaw's trusted internal read-only gateway client for the RPC
  // catalog proof without creating a user-facing CLI device or weakening auth.
  const catalogProbe = await sandbox.execShell(
    SANDBOX_NAME,
    gatewayCatalogCallScript({ agentId: "main", includePlugins: true }),
    {
      artifactName: `openclaw-weather-plugin-catalog-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(catalogProbe.exitCode, resultText(catalogProbe)).toBe(0);
  const catalog = parseJsonFromText(
    normalizeSandboxStdoutFrames(catalogProbe.stdout),
  ) as GatewayToolCatalog;
  const catalogToolIds = (catalog.groups ?? []).flatMap((group) =>
    (group.tools ?? []).map((tool) => tool.id).filter((id): id is string => typeof id === "string"),
  );
  expect(catalogToolIds).toContain("get_weather");
  return {
    imageMarker: imageMarker ?? "",
    fixtureVersion: expectedFixtureVersion,
    inspectLoaded: true,
    catalogToolIds,
    toolInvoked: true,
  };
}

async function assertExdevTmpfsMounted(sandbox: SandboxClient, phase: string): Promise<boolean> {
  const result = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(`set -eu
awk -v target='${EXDEV_TMPFS_MOUNT}' '$5 == target { found = 1 } END { exit found ? 0 : 1 }' /proc/self/mountinfo
mkdir -p ${EXDEV_TMPFS_SOURCE}
test -d ${EXDEV_TMPFS_SOURCE}
mount_device=$(stat -c '%d' ${EXDEV_TMPFS_MOUNT})
tmp_device=$(stat -c '%d' /tmp)
test "$mount_device" != "$tmp_device"
printf 'tmpfs_mount=%s source=%s mount_device=%s tmp_device=%s\n' '${EXDEV_TMPFS_MOUNT}' '${EXDEV_TMPFS_SOURCE}' "$mount_device" "$tmp_device"`),
    {
      artifactName: `openclaw-plugin-exdev-tmpfs-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(resultText(result)).toContain(`tmpfs_mount=${EXDEV_TMPFS_MOUNT}`);
  expect(resultText(result)).toContain(`source=${EXDEV_TMPFS_SOURCE}`);
  return true;
}

async function writeWorkspaceMarker(sandbox: SandboxClient, marker: string): Promise<void> {
  const markerPath = "/sandbox/.openclaw/workspace/plugin-lifecycle-marker.txt";
  const result = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `mkdir -p -- /sandbox/.openclaw/workspace && printf %s ${shellQuote(marker)} > ${shellQuote(markerPath)}`,
    ),
    {
      artifactName: "openclaw-plugin-write-workspace-marker",
      env: liveEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
}

async function assertWorkspaceMarker(
  sandbox: SandboxClient,
  phase: string,
  marker: string,
): Promise<void> {
  const markerPath = "/sandbox/.openclaw/workspace/plugin-lifecycle-marker.txt";
  const result = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(`cat -- ${shellQuote(markerPath)}`),
    {
      artifactName: `openclaw-plugin-workspace-marker-${phase}`,
      env: liveEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(normalizeSandboxStdoutFrames(result.stdout).trim()).toBe(marker);
}

const runtimeDepsReplacementProbeSource = `set -eu
rm -rf /sandbox/.openclaw/plugin-runtime-deps/exdev-guard 2>/dev/null || true
rm -rf ${EXDEV_TMPFS_SOURCE}
mkdir -p ${EXDEV_TMPFS_SOURCE} /sandbox/.openclaw/plugin-runtime-deps/exdev-guard
printf 'ok\n' >${EXDEV_TMPFS_SOURCE}/package.txt
source_device=$(stat -c '%d' ${EXDEV_TMPFS_SOURCE})
target_device=$(stat -c '%d' /sandbox/.openclaw/plugin-runtime-deps/exdev-guard)
printf 'source_device=%s target_device=%s\n' "$source_device" "$target_device"
if [ "$source_device" = "$target_device" ]; then
  printf 'EXDEV guard did not get distinct filesystems for ${EXDEV_TMPFS_SOURCE} and /sandbox plugin-runtime-deps\n' >&2
  exit 2
fi
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
function assertLegacySourceSideStagingFailsWithExdev(targetDir, sourceDir) {
  const sourceParentDir = path.dirname(sourceDir);
  const tempDir = fs.mkdtempSync(path.join(sourceParentDir, '.openclaw-runtime-deps-source-side-'));
  const stagedDir = path.join(tempDir, 'node_modules');
  try {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    const sourceDevice = fs.statSync(sourceDir).dev;
    const stagedDevice = fs.statSync(stagedDir).dev;
    const targetParentDevice = fs.statSync(path.dirname(targetDir)).dev;
    if (stagedDevice !== sourceDevice || stagedDevice === targetParentDevice) {
      throw new Error(
        'legacy self-check lost cross-device layout: source=' +
          sourceDevice +
          ' staged=' +
          stagedDevice +
          ' target_parent=' +
          targetParentDevice,
      );
    }
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(stagedDir, targetDir);
      throw new Error('legacy source-side staging unexpectedly renamed across devices');
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        console.log('source-side staging failure self-check completed');
        return;
      }
      throw error;
    }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.dirname(targetDir), { recursive: true, force: true }); } catch {}
  }
}
function replaceNodeModulesDir(targetDir, sourceDir) {
  const targetParentDir = path.dirname(targetDir);
  fs.mkdirSync(targetParentDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(targetParentDir, '.openclaw-runtime-deps-copy-'));
  const stagedDir = path.join(tempDir, 'node_modules');
  try {
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}
assertLegacySourceSideStagingFailsWithExdev(
  '/sandbox/.openclaw/plugin-runtime-deps/exdev-guard/source-side-regression/node_modules',
  '${EXDEV_TMPFS_SOURCE}',
);
replaceNodeModulesDir('/sandbox/.openclaw/plugin-runtime-deps/exdev-guard/node_modules', '${EXDEV_TMPFS_SOURCE}');
console.log('runtime deps replacement completed');
NODE`;

const runtimeDepsReplacementProbe = trustedSandboxShellScript(runtimeDepsReplacementProbeSource);

async function prepareCustomPluginSource(
  host: HostCliClient,
  cleanup: CleanupRegistry,
  fixture: OpenClawPluginRuntimeExdevFixture,
): Promise<PreparedCustomPluginBuildContext> {
  const context = createCustomPluginBuildContext();
  cleanup.add(`remove ${fixture.source} custom-plugin source clone`, () =>
    fs.rmSync(context.sourceParentDir, { recursive: true, force: true }),
  );
  const currentHead = await host.command("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    artifactName: "resolve-current-nemoclaw-plugin-source",
    env: liveEnv(),
    timeoutMs: 30_000,
  });
  expect(currentHead.exitCode, resultText(currentHead)).toBe(0);
  const expectedSourceHead =
    fixture.source === "release" ? NEMOCLAW_RELEASE_COMMIT : currentHead.stdout.trim();
  const cloneArgs =
    fixture.source === "release"
      ? [
          "clone",
          "--depth",
          "1",
          "--branch",
          NEMOCLAW_RELEASE_TAG,
          "--single-branch",
          NEMOCLAW_SOURCE_REPOSITORY,
          context.sourceRoot,
        ]
      : ["clone", "--local", "--no-hardlinks", REPO_ROOT, context.sourceRoot];
  const cloneSource = await host.command("git", cloneArgs, {
    artifactName: `clone-${fixture.source}-nemoclaw-plugin-source`,
    env: liveEnv(),
    timeoutMs: 180_000,
  });
  expect(cloneSource.exitCode, resultText(cloneSource)).toBe(0);
  const sourceHead = await host.command("git", ["-C", context.sourceRoot, "rev-parse", "HEAD"], {
    artifactName: `verify-${fixture.source}-nemoclaw-plugin-source`,
    env: liveEnv(),
    timeoutMs: 30_000,
  });
  expect(sourceHead.exitCode, resultText(sourceHead)).toBe(0);
  expect(sourceHead.stdout.trim()).toBe(expectedSourceHead);
  const runtimeOpenClawVersion = createCustomPluginDockerfile(context, fixture);
  return { ...context, runtimeOpenClawVersion };
}

async function startDeploymentFixture(
  artifacts: ArtifactSink,
  cleanup: CleanupRegistry,
  progress: TestProgress,
  fixture: OpenClawPluginRuntimeExdevFixture,
): Promise<NodeJS.ProcessEnv> {
  const fake = await startFakeOpenAiCompatibleServer({
    apiKey: "nemoclaw-exdev-dummy-key",
    host: "0.0.0.0",
    model: "nemoclaw-exdev-probe",
    progress,
    publicHost: "host.openshell.internal",
    responseText: "ok",
  });
  await artifacts.writeJson("fake-openai-compatible.json", { baseUrl: fake.baseUrl });
  cleanup.add("close EXDEV compatible endpoint mock", async () => {
    try {
      await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
    } finally {
      await fake.close();
    }
  });

  return liveEnv({
    ...fixture.baseImageEnv,
    COMPATIBLE_API_KEY: "nemoclaw-exdev-dummy-key",
    NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
    NEMOCLAW_MODEL: "nemoclaw-exdev-probe",
    NEMOCLAW_PROVIDER_KEY: "nemoclaw-exdev-dummy-key",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
  });
}

async function requireDocker(
  host: HostCliClient,
  artifactName: string,
  reason: string,
  skip: (note?: string) => never,
): Promise<void> {
  const docker = await host.command("docker", ["info"], {
    artifactName,
    env: liveEnv(),
    timeoutMs: 30_000,
  });
  if (docker.exitCode === 0) return;
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error(`${reason}: ${resultText(docker)}`);
  }
  skip(reason);
}

test(
  "the release-baseline custom plugin loads with its exact NemoClaw and OpenShell versions (#6108)",
  {
    timeout: ONBOARD_TIMEOUT_MS + 15 * 60_000,
    meta: {
      e2ePhases: [
        "confirm Docker CLI and clear the release plugin sandbox",
        "clone and build the tagged plugin fixture",
        "install tagged OpenShell and onboard the release sandbox",
        "verify the tagged plugin and remove the release sandbox",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
    const fixture = resolveOpenClawPluginRuntimeExdevFixture(RELEASE_BASELINE_TEST_SELECTOR);
    await artifacts.target.declare({
      id: "openclaw-plugin-runtime-exdev-release",
      boundary: "fresh-openclaw-sandbox-exec",
      regressionTargets: ["#6108"],
      contract: [
        "the exact NemoClaw v0.0.71 checkout installs, builds, and reports its tagged CLI version",
        "the tagged CLI uses OpenShell 0.0.71 with matching source, base image, and OpenClaw runtime",
        "release-matched peer/dev dependencies prune private OpenClaw and link the host runtime",
        "the release weather plugin loads from the custom image without an EXDEV bootstrap failure",
      ],
      selector: fixture.selector,
      nemoclawSourceRelease: NEMOCLAW_RELEASE_TAG,
      nemoclawSourceCommit: NEMOCLAW_RELEASE_COMMIT,
      taggedOpenshellVersion: NEMOCLAW_RELEASE_OPENSHELL_VERSION,
      sandboxBaseImageRef: RELEASE_SANDBOX_BASE_IMAGE_REF,
      openclawVersion: WEATHER_OPENCLAW_VERSION,
    });

    await requireDocker(
      host,
      "prereq-docker-info-openclaw-plugin-exdev-release",
      "Docker is required for the OpenClaw plugin release baseline",
      skip,
    );

    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-openshell-delete-openclaw-plugin-exdev-release",
        env: liveEnv(),
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy-openclaw-plugin-exdev-release",
      env: liveEnv(),
      timeoutMs: 120_000,
    });
    await ignoreCleanupError(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-delete-openclaw-plugin-exdev-release",
        env: liveEnv(),
        timeoutMs: 60_000,
      }),
    );

    progress.phase("clone and build the tagged plugin fixture");
    const customPluginContext = await prepareCustomPluginSource(host, cleanup, fixture);
    await buildAndVerifyTaggedCli(host, customPluginContext);
    progress.phase("install tagged OpenShell and onboard the release sandbox");
    await stopOpenShellGatewayBeforeVersionSwitch(host, "existing");
    const taggedPinnedOpenshell = await installAndResolvePinnedOpenShell(
      host,
      path.join(customPluginContext.sourceRoot, "scripts", "install-openshell.sh"),
      "v0-0-71",
      NEMOCLAW_RELEASE_OPENSHELL_VERSION,
    );
    const taggedOpenShellWrapper = createOpenShellTmpfsWrapper(taggedPinnedOpenshell.cli);
    cleanup.add("remove v0.0.71 EXDEV OpenShell PATH wrapper", taggedOpenShellWrapper.remove);
    const deploymentEnv = await startDeploymentFixture(artifacts, cleanup, progress, fixture);
    const taggedSandboxEnv = withOpenShellWrapperEnv(
      deploymentEnv,
      taggedOpenShellWrapper,
      taggedPinnedOpenshell,
    );

    const taggedOnboard = await host.command(
      "node",
      [
        customPluginContext.cliEntrypoint,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
        "--no-gpu",
        "--name",
        SANDBOX_NAME,
        "--from",
        customPluginContext.dockerfilePath,
      ],
      {
        artifactName: "v0-0-71-openclaw-plugin-onboard",
        cwd: customPluginContext.sourceRoot,
        env: taggedSandboxEnv,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const taggedOnboardText = resultText(taggedOnboard);
    expect(taggedOnboard.exitCode, taggedOnboardText).toBe(0);
    expect(taggedOnboardText).toContain("Deployment verified");

    progress.phase("verify the tagged plugin and remove the release sandbox");
    const taggedRuntimeVersion = await sandbox.exec(SANDBOX_NAME, ["openclaw", "--version"], {
      artifactName: "v0-0-71-openclaw-version",
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const taggedRuntimeVersionText = resultText(taggedRuntimeVersion);
    expect(taggedRuntimeVersion.exitCode, taggedRuntimeVersionText).toBe(0);
    expect(taggedRuntimeVersionText).toContain(EXPECTED_RELEASE_OPENCLAW_VERSION);
    const taggedPlugin = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript("HOME=/sandbox openclaw plugins inspect weather --runtime --json"),
      {
        artifactName: "v0-0-71-weather-plugin-inspect",
        env: liveEnv(),
        timeoutMs: PROBE_TIMEOUT_MS,
      },
    );
    expect(taggedPlugin.exitCode, resultText(taggedPlugin)).toBe(0);
    const taggedPluginInspect = parseJsonFromText(
      normalizeSandboxStdoutFrames(taggedPlugin.stdout),
    ) as WeatherPluginInspect;
    expect(taggedPluginInspect.plugin?.id).toBe("weather");
    expect(taggedPluginInspect.plugin?.status).toBe("loaded");
    expect(taggedPluginInspect.plugin?.toolNames).toContain("get_weather");
    const taggedDestroy = await host.command(
      "node",
      [customPluginContext.cliEntrypoint, SANDBOX_NAME, "destroy", "--yes"],
      {
        artifactName: "v0-0-71-openclaw-plugin-destroy",
        cwd: customPluginContext.sourceRoot,
        env: taggedSandboxEnv,
        timeoutMs: 120_000,
      },
    );
    expect(taggedDestroy.exitCode, resultText(taggedDestroy)).toBe(0);
    await artifacts.target.complete({
      id: "openclaw-plugin-runtime-exdev-release",
      taggedOnboardExitCode: taggedOnboard.exitCode,
      taggedDestroyExitCode: taggedDestroy.exitCode,
      assertions: {
        taggedReleaseRuntimeMatched: taggedRuntimeVersionText.includes(
          EXPECTED_RELEASE_OPENCLAW_VERSION,
        ),
        taggedReleasePluginLoaded:
          taggedPluginInspect.plugin?.id === "weather" &&
          taggedPluginInspect.plugin?.status === "loaded" &&
          Array.isArray(taggedPluginInspect.plugin?.toolNames) &&
          taggedPluginInspect.plugin.toolNames.includes("get_weather"),
      },
    });
  },
);

test(
  "the current-lifecycle custom plugin survives restart and recreation without EXDEV failures (#6108)",
  {
    timeout: ONBOARD_TIMEOUT_MS * 2 + 15 * 60_000,
    meta: {
      e2ePhases: [...CURRENT_LIFECYCLE_PHASES],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
    const fixture = resolveOpenClawPluginRuntimeExdevFixture(CURRENT_LIFECYCLE_TEST_SELECTOR);
    await artifacts.target.declare({
      id: "openclaw-plugin-runtime-exdev",
      boundary: "fresh-openclaw-sandbox-exec",
      regressionTargets: ["#6108", "#3513", "#3127"],
      contract: [
        "the current CLI uses OpenShell 0.0.106 for current lifecycle coverage",
        "the CLI and Dockerfile use the same checkout source and a compatible sandbox base image",
        "gateway log, runtime inspection, tools.catalog, and tools.invoke prove weather/get_weather",
        "custom-plugin v1 survives restart and recreation installs v2",
        "the repository-controlled fixture is prebuilt with local BuildKit and handed to OpenShell as a local image",
        "workspace state survives onboarding recreation",
        `test-only driver config mounts tmpfs at ${EXDEV_TMPFS_MOUNT} without changing production policies`,
        "stock OpenClaw policy source bytes remain unchanged through onboard and recreation",
        `sandbox proves ${EXDEV_TMPFS_SOURCE} and plugin-runtime-deps are distinct devices`,
        `legacy source-side staging fails with EXDEV across the same ${EXDEV_TMPFS_SOURCE} to plugin-runtime-deps boundary`,
        "OpenClaw-style target-side plugin runtime-deps replacement completes without EXDEV",
      ],
      selector: fixture.selector,
      nemoclawSource: "current-checkout",
      currentOpenshellVersion: CURRENT_OPENSHELL_VERSION,
      sandboxBaseImageResolution: "current-cli",
      pluginBuildOpenClawVersion: WEATHER_OPENCLAW_VERSION,
      runtimeOpenClawVersionSource: "current-source",
    });

    await requireDocker(
      host,
      "prereq-docker-info-openclaw-plugin-exdev",
      "Docker is required for the OpenClaw plugin EXDEV live guard",
      skip,
    );

    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "bin/nemoclaw.js missing — run npm run build:cli before this live target",
    ).toBe(true);

    // Cleanup is LIFO: delete the sandbox before reclaiming its exact image tags.
    const trustedFixtureImages = registerTrustedPluginFixtureImageCleanup({
      cleanup,
      environment: liveEnv(),
      host,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-openshell-delete-openclaw-plugin-exdev",
        env: liveEnv(),
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy-openclaw-plugin-exdev",
      env: liveEnv(),
      timeoutMs: 120_000,
    });

    await ignoreCleanupError(() =>
      host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-nemoclaw-destroy-openclaw-plugin-exdev",
        env: liveEnv(),
        timeoutMs: 120_000,
      }),
    );
    await ignoreCleanupError(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-delete-openclaw-plugin-exdev",
        env: liveEnv(),
        timeoutMs: 60_000,
      }),
    );

    progress.phase("clone and prepare the current plugin fixture");
    const policySourceSnapshot = snapshotPolicySources();
    const customPluginContext = await prepareCustomPluginSource(host, cleanup, fixture);
    const deploymentEnv = await startDeploymentFixture(artifacts, cleanup, progress, fixture);
    progress.phase("install and validate current OpenShell");
    await stopOpenShellGatewayBeforeVersionSwitch(host, "existing");
    const pinnedOpenshell = await installAndResolvePinnedOpenShell(
      host,
      path.join(REPO_ROOT, "scripts", "install-openshell.sh"),
      "current",
      CURRENT_OPENSHELL_VERSION,
    );
    expect(
      hasRequiredOpenshellMessagingFeatures({
        openshellBin: pinnedOpenshell.cli,
        gatewayBin: pinnedOpenshell.gateway,
        sandboxBin: pinnedOpenshell.sandbox,
      }),
      "current pinned OpenShell components must pass coherence preflight before delegation",
    ).toBe(true);
    const openshellWrapper = createOpenShellTrustedImageWrapper({
      driverConfigJson: EXDEV_TMPFS_DRIVER_CONFIG,
      realOpenshellPath: pinnedOpenshell.cli,
    });
    cleanup.add("remove current EXDEV OpenShell PATH wrapper", openshellWrapper.remove);
    expect(
      hasRequiredOpenshellMessagingFeatures({
        openshellBin: openshellWrapper.executable,
        gatewayBin: pinnedOpenshell.gateway,
        sandboxBin: pinnedOpenshell.sandbox,
        allowExternalGatewayBin: true,
        allowExternalSandboxBin: true,
      }),
      "current OpenShell wrapper and components must pass onboard coherence preflight",
    ).toBe(true);
    const sandboxEnv = withOpenShellWrapperEnv(deploymentEnv, openshellWrapper, pinnedOpenshell);
    const lifecycleCommands = currentLifecycleCommands({
      cliEntrypoint: CLI_ENTRYPOINT,
      dockerfilePath: customPluginContext.dockerfilePath,
      sandboxName: SANDBOX_NAME,
    });

    progress.phase("build and onboard plugin v1");
    const baseImageResolution = withEnabledLocalBaseImageBuild(() =>
      pullAndResolveBaseImageDigest({
        forceRefresh: true,
        requireOpenshellSandboxAbi: true,
      }),
    );
    assert(
      baseImageResolution,
      "current CLI must resolve an OpenShell-compatible sandbox base image",
    );
    await artifacts.writeJson("trusted-exdev-base-image.json", {
      digest: baseImageResolution.digest,
      ref: baseImageResolution.ref,
      source: baseImageResolution.source,
    });
    const pluginImageV1 = await buildTrustedPluginFixtureImage({
      artifacts,
      baseImageRef: baseImageResolution.ref,
      cleanup,
      context: customPluginContext,
      deploymentEnv,
      environment: liveEnv(),
      images: trustedFixtureImages,
      sandboxName: SANDBOX_NAME,
      version: "v1",
    });
    openshellWrapper.selectImage(pluginImageV1);
    const onboard = await host.command(
      lifecycleCommands.onboard.command,
      lifecycleCommands.onboard.args,
      {
        artifactName: "openclaw-plugin-exdev-onboard",
        env: sandboxEnv,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const onboardText = resultText(onboard);
    expect(onboard.exitCode, onboardText).toBe(0);
    expect(onboardText).toMatch(/Creating sandbox|Sandbox '.+' created/);
    expect(onboardText).toContain("Deployment verified");
    const tmpfsMountedAfterOnboard = await assertExdevTmpfsMounted(sandbox, "after-onboard");
    assertPolicySourcesUnchanged(policySourceSnapshot, "onboard");

    const weatherAfterOnboard = await assertWeatherPluginRuntime(
      sandbox,
      "after-onboard",
      "v1",
      customPluginContext.runtimeOpenClawVersion,
      fixture.openClawModulePath,
    );

    progress.phase("restart the gateway and confirm plugin v1");
    const restart = await host.command(
      lifecycleCommands.restart.command,
      lifecycleCommands.restart.args,
      {
        artifactName: "openclaw-weather-plugin-gateway-restart",
        env: sandboxEnv,
        timeoutMs: 180_000,
      },
    );
    expect(restart.exitCode, resultText(restart)).toBe(0);
    const weatherAfterRestart = await assertWeatherPluginRuntime(
      sandbox,
      "after-restart",
      "v1",
      customPluginContext.runtimeOpenClawVersion,
      fixture.openClawModulePath,
    );
    expect(weatherAfterRestart.imageMarker).toBe(weatherAfterOnboard.imageMarker);

    const workspaceMarker = `plugin-lifecycle-${randomUUID()}`;
    await writeWorkspaceMarker(sandbox, workspaceMarker);

    // Change an actual build-context input so recreation must produce a distinct
    // plugin artifact. Recreation must preserve the fresh v2
    // extension instead of replacing it with the backed-up v1 directory.
    progress.phase("recreate the sandbox with plugin v2");
    writeCustomPluginVersion(customPluginContext.versionSourcePath, "v2");
    const pluginImageV2 = await buildTrustedPluginFixtureImage({
      artifacts,
      baseImageRef: baseImageResolution.ref,
      cleanup,
      context: customPluginContext,
      deploymentEnv,
      environment: liveEnv(),
      images: trustedFixtureImages,
      sandboxName: SANDBOX_NAME,
      version: "v2",
    });
    openshellWrapper.selectImage(pluginImageV2);
    const recreate = await host.command(
      lifecycleCommands.recreate.command,
      lifecycleCommands.recreate.args,
      {
        artifactName: "openclaw-weather-plugin-recreate",
        env: sandboxEnv,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    expect(recreate.exitCode, resultText(recreate)).toBe(0);
    const tmpfsMountedAfterRecreate = await assertExdevTmpfsMounted(sandbox, "after-recreate");
    assertPolicySourcesUnchanged(policySourceSnapshot, "recreate");
    const weatherAfterRecreate = await assertWeatherPluginRuntime(
      sandbox,
      "after-recreate",
      "v2",
      customPluginContext.runtimeOpenClawVersion,
      fixture.openClawModulePath,
    );
    expect(weatherAfterRecreate.imageMarker).not.toBe(weatherAfterOnboard.imageMarker);
    await assertWorkspaceMarker(sandbox, "after-recreate", workspaceMarker);

    progress.phase("prove cross-device runtime dependency replacement");
    const df = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        `mkdir -p ${EXDEV_TMPFS_SOURCE} /sandbox/.openclaw/plugin-runtime-deps && df -PT / /tmp ${EXDEV_TMPFS_MOUNT} ${EXDEV_TMPFS_SOURCE} /sandbox /sandbox/.openclaw/plugin-runtime-deps`,
      ),
      {
        artifactName: "openclaw-plugin-exdev-filesystem-layout",
        env: liveEnv(),
        timeoutMs: 30_000,
      },
    );
    await artifacts.writeText("filesystem-layout.txt", resultText(df));
    expect(df.exitCode, resultText(df)).toBe(0);
    expect(resultText(df)).toContain(EXDEV_TMPFS_MOUNT);

    const probe = await sandbox.execShell(SANDBOX_NAME, runtimeDepsReplacementProbe, {
      artifactName: "openclaw-plugin-exdev-runtime-deps-replacement",
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const probeText = resultText(probe);
    expect(
      EXDEV_PATTERNS.some((pattern) => pattern.test(probeText)),
      probeText,
    ).toBe(false);
    expect(probe.exitCode, probeText).toBe(0);
    expect(probeText).toMatch(/source_device=\d+ target_device=\d+/);
    expect(probeText).toContain("source-side staging failure self-check completed");
    expect(probeText).toContain("runtime deps replacement completed");

    await artifacts.target.complete({
      id: "openclaw-plugin-runtime-exdev",
      onboardExitCode: onboard.exitCode,
      restartExitCode: restart.exitCode,
      recreateExitCode: recreate.exitCode,
      filesystemProbeExitCode: df.exitCode,
      runtimeDepsProbeExitCode: probe.exitCode,
      runtimeOpenClawVersion: customPluginContext.runtimeOpenClawVersion,
      testOnlyTmpfsSource: EXDEV_TMPFS_SOURCE,
      assertions: {
        weatherAfterOnboard:
          weatherAfterOnboard.inspectLoaded &&
          weatherAfterOnboard.catalogToolIds.includes("get_weather") &&
          weatherAfterOnboard.toolInvoked,
        weatherAfterRestart:
          weatherAfterRestart.inspectLoaded &&
          weatherAfterRestart.catalogToolIds.includes("get_weather") &&
          weatherAfterRestart.toolInvoked,
        weatherAfterRecreate:
          weatherAfterRecreate.inspectLoaded &&
          weatherAfterRecreate.catalogToolIds.includes("get_weather") &&
          weatherAfterRecreate.toolInvoked,
        v1MarkerStableThroughRestart:
          weatherAfterOnboard.imageMarker === weatherAfterRestart.imageMarker &&
          weatherAfterOnboard.fixtureVersion === "v1" &&
          weatherAfterRestart.fixtureVersion === "v1",
        recreatedV2ReplacedV1:
          weatherAfterRecreate.imageMarker !== weatherAfterOnboard.imageMarker &&
          weatherAfterRecreate.fixtureVersion === "v2",
        distinctDevices: /source_device=\d+ target_device=\d+/.test(probeText),
        sourceSideExdevSelfCheck: probeText.includes(
          "source-side staging failure self-check completed",
        ),
        noExdevSignature: !EXDEV_PATTERNS.some((pattern) => pattern.test(probeText)),
        successMarker: probeText.includes("runtime deps replacement completed"),
        workspaceStatePreserved: true,
        testOnlyTmpfsMounted: tmpfsMountedAfterOnboard && tmpfsMountedAfterRecreate,
        stockPolicySourcesUnchanged: true,
      },
    });
  },
);
