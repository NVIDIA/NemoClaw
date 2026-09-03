// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveOpenshell } from "../../../src/lib/adapters/openshell/resolve.ts";
import { pullAndResolveBaseImageDigest } from "../../../src/lib/onboard/base-image.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { resultText } from "../fixtures/clients/command.ts";
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
  buildTrustedPluginFixtureImage,
  createOpenShellTrustedImageWrapper,
  registerTrustedPluginFixtureImageCleanup,
} from "./openclaw-plugin-runtime-exdev-trusted-prebuild.ts";
import {
  type OpenShellComponents,
  resolveOpenShellSiblingComponents,
  withOpenShellDriverConfigWrapperEnv,
} from "./openshell-driver-config-test-wrapper.ts";

// Keep this contract as a focused live test: build a deterministic custom plugin
// on top of the complete managed runtime, install it across a real filesystem
// boundary, and prove it survives restart and recreation.

const WEATHER_FIXTURE_DIR = path.join(REPO_ROOT, "test/e2e/fixtures/plugins/weather");
const TOOL_DISCLOSURE_ENV_REFERENCE = "${NEMOCLAW_TOOL_DISCLOSURE}";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-oc-exdev";
const ONBOARD_TIMEOUT_MS = execTimeout(25 * 60_000);
const LIVE_TIMEOUT_MS = testTimeout(65 * 60_000);
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
type WeatherFixtureVersion = "v1" | "v2";
validateSandboxName(SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

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

async function installAndResolveOpenShell(
  host: HostCliClient,
  installScriptPath: string,
): Promise<OpenShellComponents> {
  const install = await host.command("bash", [installScriptPath], {
    artifactName: "install-openshell-for-exdev-wrapper",
    env: liveEnv(),
    timeoutMs: 5 * 60_000,
  });
  expect(install.exitCode, resultText(install)).toBe(0);
  const resolved = resolveOpenshell();
  assert(resolved, "OpenShell installer did not leave an executable CLI");
  return resolveOpenShellSiblingComponents(resolved);
}

async function stopOpenShellGatewayBeforeInstall(
  host: HostCliClient,
  env: NodeJS.ProcessEnv = liveEnv(),
): Promise<void> {
  const openshellPath = resolveOpenshell();
  if (!openshellPath) return;
  const stop = await host.command(openshellPath, ["gateway", "stop", "-g", "nemoclaw"], {
    artifactName: "stop-openshell-gateway-before-install",
    env,
    timeoutMs: 60_000,
  });
  const diagnostic = resultText(stop);
  assert(
    stop.exitCode === 0 || /^No gateway metadata found(?: for nemoclaw)?[.!]?$/i.test(diagnostic),
    diagnostic,
  );
}

type CustomPluginBuildContext = {
  sourceParentDir: string;
  sourceRoot: string;
  dockerfilePath: string;
  versionSourcePath: string;
  pluginDirPath: string;
};

function createCustomPluginBuildContext(): CustomPluginBuildContext {
  const nonce = randomUUID();
  const sourceParentDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-weather-plugin-"));
  const sourceRoot = path.join(sourceParentDir, "NemoClaw");
  return {
    sourceParentDir,
    sourceRoot,
    dockerfilePath: path.join(sourceRoot, `Dockerfile.e2e-weather-plugin-${nonce}`),
    versionSourcePath: path.join(sourceRoot, `e2e-weather-plugin-version-${nonce}.ts`),
    pluginDirPath: path.join(sourceRoot, `e2e-weather-plugin-${nonce}`),
  };
}

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

function createCustomPluginDockerfile(context: CustomPluginBuildContext): void {
  const sourceDockerfile = path.join(context.sourceRoot, "Dockerfile");
  const source = fs.readFileSync(sourceDockerfile, "utf8");
  const runtimeAnchor = "FROM ${BASE_IMAGE}\n";
  const runtime = source.replace(runtimeAnchor, "FROM ${BASE_IMAGE} AS nemoclaw-runtime\n");
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
    && npm prune --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund

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

USER sandbox
RUN HOME=/sandbox openclaw plugins install /opt/weather-plugin \
    && HOME=/sandbox openclaw plugins enable weather

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
}

type GatewayToolInvocation = {
  ok?: unknown;
  result?: { details?: unknown };
};

type WeatherRuntimeProof = {
  fixtureVersion: WeatherFixtureVersion;
  toolInvoked: boolean;
};

async function assertWeatherPluginRuntime(
  sandbox: SandboxClient,
  phase: string,
  expectedFixtureVersion: WeatherFixtureVersion,
): Promise<WeatherRuntimeProof> {
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
        fixtureVersion: expectedFixtureVersion,
      },
    },
  });

  return {
    fixtureVersion: expectedFixtureVersion,
    toolInvoked: true,
  };
}

const crossDevicePluginInstallSource = `set -eu
rm -rf ${EXDEV_TMPFS_SOURCE}
mkdir -p ${EXDEV_TMPFS_SOURCE} /sandbox/.openclaw/extensions
cp -R /opt/weather-plugin/. ${EXDEV_TMPFS_SOURCE}/
source_device=$(stat -c '%d' ${EXDEV_TMPFS_SOURCE})
target_device=$(stat -c '%d' /sandbox/.openclaw/extensions)
printf 'source_device=%s target_device=%s\n' "$source_device" "$target_device"
if [ "$source_device" = "$target_device" ]; then
  printf 'EXDEV guard did not get distinct filesystems for ${EXDEV_TMPFS_SOURCE} and /sandbox extensions\n' >&2
  exit 2
fi
HOME=/sandbox openclaw plugins install ${EXDEV_TMPFS_SOURCE} --force
(cd /sandbox/.openclaw && sha256sum openclaw.json > .config-hash)`;

const crossDevicePluginInstall = trustedSandboxShellScript(crossDevicePluginInstallSource);

async function prepareCustomPluginSource(
  host: HostCliClient,
  cleanup: CleanupRegistry,
): Promise<CustomPluginBuildContext> {
  const context = createCustomPluginBuildContext();
  cleanup.add("remove current custom-plugin source clone", () =>
    fs.rmSync(context.sourceParentDir, { recursive: true, force: true }),
  );
  const cloneSource = await host.command(
    "git",
    ["clone", "--local", "--no-hardlinks", REPO_ROOT, context.sourceRoot],
    {
      artifactName: "clone-current-nemoclaw-plugin-source",
      env: liveEnv(),
      timeoutMs: 180_000,
    },
  );
  expect(cloneSource.exitCode, resultText(cloneSource)).toBe(0);
  createCustomPluginDockerfile(context);
  return context;
}

async function startDeploymentFixture(
  artifacts: ArtifactSink,
  cleanup: CleanupRegistry,
  progress: TestProgress,
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
  "the current-lifecycle custom plugin survives restart and recreation without EXDEV failures (#6108)",
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm Docker CLI and clear the current plugin sandbox",
        "clone and prepare the current plugin fixture",
        "install and validate current OpenShell",
        "build and onboard plugin v1",
        "install plugin v1 across filesystems",
        "restart the gateway and confirm plugin v1",
        "recreate the sandbox with plugin v2",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
    await artifacts.target.declare({
      id: "openclaw-plugin-runtime-exdev",
      boundary: "fresh-openclaw-sandbox-exec",
      regressionTargets: ["#6108"],
      contract: [
        "the current checkout builds and onboards the weather plugin as v1",
        "tools.invoke proves v1 survives restart and recreation installs v2",
        "the repository-controlled fixture is prebuilt with local BuildKit and handed to OpenShell as a local image",
        `test-only driver config mounts tmpfs at ${EXDEV_TMPFS_MOUNT}`,
        `sandbox proves ${EXDEV_TMPFS_SOURCE} and the OpenClaw extension target are distinct devices`,
        "OpenClaw installs the weather plugin across that boundary before restart",
      ],
      selector: "current-lifecycle",
      nemoclawSource: "current-checkout",
      sandboxBaseImageResolution: "current-cli",
    });

    await requireDocker(
      host,
      "prereq-docker-info-openclaw-plugin-exdev",
      "Docker is required for the OpenClaw plugin EXDEV live guard",
      skip,
    );

    // Cleanup is LIFO: managed destroy runs while the gateway is registered,
    // then direct OpenShell deletion provides a fallback before gateway and image cleanup.
    const trustedFixtureImages = registerTrustedPluginFixtureImageCleanup({
      cleanup,
      environment: liveEnv(),
      host,
    });
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-trusted-exdev-gateway-nemoclaw",
      env: liveEnv(),
      timeoutMs: 60_000,
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
    const customPluginContext = await prepareCustomPluginSource(host, cleanup);
    const deploymentEnv = await startDeploymentFixture(artifacts, cleanup, progress);
    progress.phase("install and validate current OpenShell");
    await stopOpenShellGatewayBeforeInstall(host);
    const openshell = await installAndResolveOpenShell(
      host,
      path.join(REPO_ROOT, "scripts", "install-openshell.sh"),
    );
    const openshellWrapper = createOpenShellTrustedImageWrapper({
      driverConfigJson: EXDEV_TMPFS_DRIVER_CONFIG,
      realOpenshellPath: openshell.cli,
    });
    cleanup.add("remove current EXDEV OpenShell PATH wrapper", openshellWrapper.remove);
    const sandboxEnv = withOpenShellDriverConfigWrapperEnv(
      deploymentEnv,
      openshellWrapper,
      openshell,
    );

    progress.phase("build and onboard plugin v1");
    const previousLocalBaseImageBuild = process.env.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD;
    process.env.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD = "1";
    let baseImageResolution;
    try {
      baseImageResolution = pullAndResolveBaseImageDigest({
        forceRefresh: true,
        requireOpenshellSandboxAbi: true,
      });
    } finally {
      Reflect.deleteProperty(process.env, "NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD");
      Object.assign(
        process.env,
        previousLocalBaseImageBuild === undefined
          ? {}
          : { NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: previousLocalBaseImageBuild },
      );
    }
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
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
        "--agent",
        "openclaw",
        "--from",
        customPluginContext.dockerfilePath,
      ],
      {
        artifactName: "openclaw-plugin-exdev-onboard",
        env: sandboxEnv,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const onboardText = resultText(onboard);
    expect(onboard.exitCode, onboardText).toBe(0);
    const weatherAfterOnboard = await assertWeatherPluginRuntime(sandbox, "after-onboard", "v1");

    progress.phase("install plugin v1 across filesystems");
    const crossDeviceInstall = await sandbox.execShell(SANDBOX_NAME, crossDevicePluginInstall, {
      artifactName: "openclaw-plugin-exdev-production-install",
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const crossDeviceInstallText = resultText(crossDeviceInstall);
    expect(crossDeviceInstall.exitCode, crossDeviceInstallText).toBe(0);
    expect(crossDeviceInstallText).toMatch(/source_device=\d+ target_device=\d+/);

    progress.phase("restart the gateway and confirm plugin v1");
    const restart = await host.command(
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "gateway", "restart"],
      {
        artifactName: "openclaw-weather-plugin-gateway-restart",
        env: sandboxEnv,
        timeoutMs: 180_000,
      },
    );
    expect(restart.exitCode, resultText(restart)).toBe(0);
    const weatherAfterRestart = await assertWeatherPluginRuntime(sandbox, "after-restart", "v1");

    // Change an actual build-context input so recreation must produce a distinct
    // plugin artifact and expose v2 through the same runtime boundary.
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
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--recreate-sandbox",
        "--non-interactive",
        "--yes",
        "--yes-i-accept-third-party-software",
        "--name",
        SANDBOX_NAME,
        "--agent",
        "openclaw",
        "--from",
        customPluginContext.dockerfilePath,
      ],
      {
        artifactName: "openclaw-weather-plugin-recreate",
        env: sandboxEnv,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    expect(recreate.exitCode, resultText(recreate)).toBe(0);
    const weatherAfterRecreate = await assertWeatherPluginRuntime(sandbox, "after-recreate", "v2");

    await artifacts.target.complete({
      id: "openclaw-plugin-runtime-exdev",
      onboardExitCode: onboard.exitCode,
      crossDeviceInstallExitCode: crossDeviceInstall.exitCode,
      restartExitCode: restart.exitCode,
      recreateExitCode: recreate.exitCode,
      testOnlyTmpfsSource: EXDEV_TMPFS_SOURCE,
      assertions: {
        weatherAfterOnboard: weatherAfterOnboard.toolInvoked,
        weatherAfterRestart: weatherAfterRestart.toolInvoked,
        weatherAfterRecreate: weatherAfterRecreate.toolInvoked,
        v1SurvivedRestart:
          weatherAfterOnboard.fixtureVersion === "v1" &&
          weatherAfterRestart.fixtureVersion === "v1",
        recreationInstalledV2: weatherAfterRecreate.fixtureVersion === "v2",
        distinctDevices: /source_device=\d+ target_device=\d+/.test(crossDeviceInstallText),
        productionInstallCompleted: crossDeviceInstall.exitCode === 0,
      },
    });
  },
);
