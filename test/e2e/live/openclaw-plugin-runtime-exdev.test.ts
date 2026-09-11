// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveOpenshell } from "../../../src/lib/adapters/openshell/resolve.ts";
import { DASHBOARD_PORT } from "../../../src/lib/core/ports.ts";
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
import { captureIssue4462FailureDiagnostics } from "../fixtures/issue-4462-diagnostics.ts";
import { runOpenClawPluginWithFailureEvidence } from "../fixtures/openclaw-plugin-runtime-exdev-onboard.ts";
import {
  type OpenShellComponents,
  resolveOpenShellSiblingComponents,
  withCanonicalOpenShellEnv,
} from "../../helpers/openshell-components.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { parseJsonFromText } from "./json-envelope.ts";
import {
  buildOpenClawPluginLifecycleOnboardArgs,
  buildTrustedPluginFixtureImage,
  createTrustedPluginFixtureDockerfile,
  createTrustedPluginFixtureHandoff,
  createTrustedPluginFixtureHostMountSource,
  crossDevicePluginInstall,
  extractTrustedPluginFixtureToHost,
  normalizeSandboxStdoutFrames,
  parseCrossDeviceInstallEvidence,
  registerTrustedPluginFixtureImageCleanup,
  writeTrustedPluginFixtureHandoff,
} from "./openclaw-plugin-runtime-exdev-trusted-prebuild.ts";

// Keep this contract as a focused live test: build a deterministic custom plugin
// on top of the complete managed runtime, install it across a real filesystem
// boundary, and prove it survives restart and recreation.

const WEATHER_FIXTURE_DIR = path.join(REPO_ROOT, "test/e2e/fixtures/plugins/weather");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-oc-exdev";
const ONBOARD_TIMEOUT_MS = execTimeout(25 * 60_000);
const LIVE_TIMEOUT_MS = testTimeout(65 * 60_000);
const PROBE_TIMEOUT_MS = 60_000;
const EXDEV_API_KEY = "nemoclaw-exdev-dummy-key";
type WeatherFixtureVersion = "v1" | "v1-exdev" | "v2";
validateSandboxName(SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

function liveEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_DASHBOARD_PORT: String(DASHBOARD_PORT),
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
    artifactName: "install-openshell-for-exdev-lifecycle",
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
  crossDeviceVersionSourcePath: string;
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
    crossDeviceVersionSourcePath: path.join(
      sourceRoot,
      `e2e-weather-plugin-cross-device-version-${nonce}.ts`,
    ),
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
  stageWeatherPluginFixture(context);
  writeCustomPluginVersion(context.versionSourcePath, "v1", true);
  writeCustomPluginVersion(context.crossDeviceVersionSourcePath, "v1-exdev", true);
  fs.writeFileSync(
    context.dockerfilePath,
    createTrustedPluginFixtureDockerfile({
      crossDeviceVersionSourceName: path.basename(context.crossDeviceVersionSourcePath),
      pluginDirName: path.basename(context.pluginDirPath),
      source,
      versionSourceName: path.basename(context.versionSourcePath),
    }),
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
}

type GatewayToolInvocation = {
  ok?: unknown;
  result?: { details?: unknown };
};

async function assertWeatherPluginRuntime(
  sandbox: SandboxClient,
  phase: string,
  expectedFixtureVersion: WeatherFixtureVersion,
): Promise<unknown> {
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

  return (invocation.result?.details as { fixtureVersion?: unknown } | undefined)?.fixtureVersion;
}

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
    apiKey: EXDEV_API_KEY,
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
    COMPATIBLE_API_KEY: EXDEV_API_KEY,
    NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
    NEMOCLAW_MODEL: "nemoclaw-exdev-probe",
    NEMOCLAW_PROVIDER_KEY: EXDEV_API_KEY,
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
  "the current-lifecycle custom plugin survives restart and recreation across filesystems (#6108, #11547)",
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm Docker CLI and clear the current plugin sandbox",
        "clone and prepare the current plugin fixture",
        "install and validate current OpenShell",
        "build and onboard plugin v1",
        "install a distinct plugin payload across filesystems",
        "restart the gateway and confirm the installed payload",
        "recreate the sandbox with plugin v2",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
    await artifacts.target.declare({
      id: "openclaw-plugin-runtime-exdev",
      boundary: "fresh-openclaw-sandbox-exec",
      regressionTargets: ["#6108", "#11547"],
      contract: [
        "the current checkout builds and onboards the weather plugin as v1",
        "tools.invoke proves the distinct cross-device payload survives restart and recreation installs v2",
        "the repository-controlled fixture is prebuilt with local BuildKit and handed to canonical OpenShell through an immutable custom image",
        "the EXDEV source is a stable read-only host mount carried through recreation",
        "the sandbox proves the mounted source and OpenClaw extension target are distinct devices",
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
    const imageHandoff = createTrustedPluginFixtureHandoff(cleanup);
    const hostMountSource = createTrustedPluginFixtureHostMountSource(cleanup);
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
    const sandboxEnv = withCanonicalOpenShellEnv(deploymentEnv, openshell);
    const capturePairingDiagnostics = () =>
      captureIssue4462FailureDiagnostics(sandbox, {
        env: sandboxEnv,
        redactionValues: [EXDEV_API_KEY],
        sandboxName: SANDBOX_NAME,
      });

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
    writeTrustedPluginFixtureHandoff(imageHandoff, pluginImageV1);
    await extractTrustedPluginFixtureToHost({
      environment: liveEnv(),
      host,
      image: pluginImageV1,
      sourceDirectory: hostMountSource,
    });
    const onboard = await runOpenClawPluginWithFailureEvidence({
      operation: "openclaw-plugin-runtime-exdev.onboard-pairing",
      sandboxName: SANDBOX_NAME,
      run: () =>
        host.command(
          "node",
          buildOpenClawPluginLifecycleOnboardArgs({
            cliEntrypoint: CLI_ENTRYPOINT,
            dockerfilePath: imageHandoff.dockerfilePath,
            hostMountSource,
            recreate: false,
            sandboxName: SANDBOX_NAME,
          }),
          {
            artifactName: "openclaw-plugin-exdev-onboard",
            env: sandboxEnv,
            timeoutMs: ONBOARD_TIMEOUT_MS,
          },
        ),
      captureDiagnostics: capturePairingDiagnostics,
      onEvidence: async (evidence) => {
        await artifacts.writeJson("retry/openclaw-plugin-exdev-onboard-retry.json", evidence);
      },
    });
    const onboardText = onboard.value ? resultText(onboard.value) : "onboard returned no result";
    expect(onboard.outcome, onboardText).toBe("passed");
    const weatherAfterOnboard = await assertWeatherPluginRuntime(sandbox, "after-onboard", "v1");
    progress.phase("install a distinct plugin payload across filesystems");
    const crossDeviceInstall = await sandbox.execShell(SANDBOX_NAME, crossDevicePluginInstall, {
      artifactName: "openclaw-plugin-exdev-production-install",
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const crossDeviceInstallText = resultText(crossDeviceInstall);
    const { sourceDevice, targetDevice } = parseCrossDeviceInstallEvidence(crossDeviceInstallText);
    expect(
      crossDeviceInstall.exitCode === 0 &&
        sourceDevice !== null &&
        targetDevice !== null &&
        sourceDevice !== targetDevice,
      crossDeviceInstallText,
    ).toBe(true);

    progress.phase("restart the gateway and confirm the installed payload");
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
    const weatherAfterRestart = await assertWeatherPluginRuntime(
      sandbox,
      "after-restart",
      "v1-exdev",
    );

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
    writeTrustedPluginFixtureHandoff(imageHandoff, pluginImageV2);
    const recreate = await runOpenClawPluginWithFailureEvidence({
      operation: "openclaw-plugin-runtime-exdev.recreate-pairing",
      captureDiagnostics: capturePairingDiagnostics,
      run: () =>
        host.command(
          "node",
          buildOpenClawPluginLifecycleOnboardArgs({
            cliEntrypoint: CLI_ENTRYPOINT,
            dockerfilePath: imageHandoff.dockerfilePath,
            hostMountSource,
            recreate: true,
            sandboxName: SANDBOX_NAME,
          }),
          {
            artifactName: "openclaw-weather-plugin-recreate",
            env: sandboxEnv,
            timeoutMs: ONBOARD_TIMEOUT_MS,
          },
        ),
      sandboxName: SANDBOX_NAME,
      onEvidence: async (evidence) => {
        await artifacts.writeJson("retry/openclaw-weather-plugin-recreate-retry.json", evidence);
      },
    });
    const recreateText = recreate.value
      ? resultText(recreate.value)
      : "recreate returned no result";
    expect(recreate.outcome, recreateText).toBe("passed");
    const weatherAfterRecreate = await assertWeatherPluginRuntime(sandbox, "after-recreate", "v2");

    await artifacts.target.complete({
      id: "openclaw-plugin-runtime-exdev",
      onboardExitCode: onboard.value!.exitCode,
      crossDeviceInstallExitCode: crossDeviceInstall.exitCode,
      restartExitCode: restart.exitCode,
      recreateExitCode: recreate.value!.exitCode,
      hostMountSourceDevice: sourceDevice,
      extensionTargetDevice: targetDevice,
      assertions: {
        initialImagePluginV1: weatherAfterOnboard === "v1",
        crossDevicePayloadSurvivedRestart: weatherAfterRestart === "v1-exdev",
        recreationInstalledV2: weatherAfterRecreate === "v2",
        distinctDevices: sourceDevice !== targetDevice,
        productionInstallCompleted: crossDeviceInstall.exitCode === 0,
      },
    });
  },
);
