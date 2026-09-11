// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LOCAL_SANDBOX_IMAGE_REPO } from "../../../src/lib/domain/sandbox/image-tag.ts";
import { createCustomBuildContextFilter } from "../../../src/lib/onboard/custom-build-context.ts";
import { patchStagedDockerfile } from "../../../src/lib/onboard/dockerfile-patch.ts";
import {
  prebuildSandboxImageIfEligible,
  type SandboxPrebuildResult,
} from "../../../src/lib/onboard/sandbox-prebuild.ts";
import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../../../src/lib/sandbox/build-context.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";

export const TRUSTED_PLUGIN_FIXTURE_IMAGE_DIR = "/usr/local/share/nemoclaw-e2e/weather-plugin";
export const TRUSTED_PLUGIN_FIXTURE_MOUNT_DIR = "/sandbox/nemoclaw-exdev-source";

const TRUSTED_EXDEV_IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requireTrustedExdevImageId(imageId: string): void {
  assert.match(
    imageId,
    TRUSTED_EXDEV_IMAGE_ID_PATTERN,
    "trusted EXDEV fixture requires an immutable local image ID",
  );
}

export type TrustedPluginFixtureImage = {
  imageId: string;
  imageRef: string;
};

export type TrustedPluginFixtureHandoff = {
  directory: string;
  dockerfilePath: string;
};

export type CrossDeviceInstallEvidence = {
  sourceDevice: string | null;
  targetDevice: string | null;
};

export const crossDevicePluginInstall = trustedSandboxShellScript(`set -eu
source_device=$(stat -c '%d' ${TRUSTED_PLUGIN_FIXTURE_MOUNT_DIR})
target_device=$(stat -c '%d' /sandbox/.openclaw/extensions)
printf 'source_device=%s target_device=%s\n' "$source_device" "$target_device"
HOME=/sandbox openclaw plugins install ${TRUSTED_PLUGIN_FIXTURE_MOUNT_DIR} --force
(cd /sandbox/.openclaw && sha256sum openclaw.json > .config-hash)`);

export function normalizeSandboxStdoutFrames(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\[stdout\]|stdout:)\s*/i, ""))
    .join("\n");
}

export function parseCrossDeviceInstallEvidence(output: string): CrossDeviceInstallEvidence {
  const match = /source_device=(\d+) target_device=(\d+)/.exec(output);
  return {
    sourceDevice: match?.[1] ?? null,
    targetDevice: match?.[2] ?? null,
  };
}

export function buildOpenClawPluginLifecycleOnboardArgs(options: {
  cliEntrypoint: string;
  dockerfilePath: string;
  hostMountSource: string;
  recreate: boolean;
  sandboxName: string;
}): string[] {
  return [
    options.cliEntrypoint,
    "onboard",
    "--fresh",
    ...(options.recreate ? ["--recreate-sandbox"] : []),
    "--non-interactive",
    "--yes",
    "--yes-i-accept-third-party-software",
    "--name",
    options.sandboxName,
    "--agent",
    "openclaw",
    "--from",
    options.dockerfilePath,
    "--host-mount",
    `${options.hostMountSource}:${TRUSTED_PLUGIN_FIXTURE_MOUNT_DIR}`,
  ];
}

export function createTrustedPluginFixtureDockerfile(options: {
  crossDeviceVersionSourceName: string;
  pluginDirName: string;
  source: string;
  versionSourceName: string;
}): string {
  const runtimeAnchor = "FROM ${BASE_IMAGE}\n";
  assert(
    options.source.includes(runtimeAnchor),
    "trusted EXDEV fixture requires the managed runtime anchor",
  );
  const runtime = options.source.replace(runtimeAnchor, "FROM ${BASE_IMAGE} AS nemoclaw-runtime\n");
  const extension = String.raw`

# Build the deterministic custom-plugin fixture used by this live contract.
FROM builder AS weather-plugin-builder
WORKDIR /opt/weather
COPY ${options.pluginDirName}/package.json ${options.pluginDirName}/package-lock.json ${options.pluginDirName}/tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY ${options.pluginDirName}/openclaw.plugin.json ./
COPY ${options.pluginDirName}/src/ ./src/
COPY ${options.versionSourceName} ./src/version.ts
RUN npm run build \
    && cp -R /opt/weather/dist /opt/weather-runtime-dist
COPY ${options.crossDeviceVersionSourceName} ./src/version.ts
RUN npm run build \
    && npm prune --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund

# Extend the completed managed runtime so its entrypoint, health check, config
# generation, and permissions remain the source of truth.
FROM nemoclaw-runtime AS weather-runtime
ARG NEMOCLAW_TOOL_DISCLOSURE=progressive
ENV NEMOCLAW_TOOL_DISCLOSURE=${"${NEMOCLAW_TOOL_DISCLOSURE}"}
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/package.json \
    /opt/weather/package-lock.json \
    /opt/weather/openclaw.plugin.json \
    ${TRUSTED_PLUGIN_FIXTURE_IMAGE_DIR}/
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/dist/ ${TRUSTED_PLUGIN_FIXTURE_IMAGE_DIR}/dist/
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/node_modules/ ${TRUSTED_PLUGIN_FIXTURE_IMAGE_DIR}/node_modules/

USER sandbox
RUN --mount=type=bind,from=weather-plugin-builder,source=/opt/weather-runtime-dist,target=${TRUSTED_PLUGIN_FIXTURE_IMAGE_DIR}/dist,ro \
    HOME=/sandbox openclaw plugins install ${TRUSTED_PLUGIN_FIXTURE_IMAGE_DIR} \
    && HOME=/sandbox openclaw plugins enable weather

# Enabling the plugin changes openclaw.json after the managed runtime hashes it.
# The runtime test extracts the second build into its read-only host mount
# before it installs the plugin across the filesystem boundary.
# hadolint ignore=DL3002
USER root
RUN chown sandbox:sandbox /sandbox/.openclaw/openclaw.json \
    && chmod 660 /sandbox/.openclaw/openclaw.json \
    && sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \
    && chown sandbox:sandbox /sandbox/.openclaw/.config-hash \
    && chmod 660 /sandbox/.openclaw/.config-hash
USER sandbox
`;
  return runtime.trimEnd() + extension;
}

const TRUSTED_EXDEV_IMAGE_REF_PATTERN = new RegExp(
  `^${LOCAL_SANDBOX_IMAGE_REPO}:[a-z0-9_][a-z0-9_.-]{0,127}$`,
);

export function trustedExdevImageRef(tag: string): string {
  return `${LOCAL_SANDBOX_IMAGE_REPO}:${tag}`;
}

export function renderTrustedPluginFixtureHandoffDockerfile(imageId: string): string {
  requireTrustedExdevImageId(imageId);
  return `FROM ${imageId}\nARG NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV NEMOCLAW_TOOL_DISCLOSURE=\${NEMOCLAW_TOOL_DISCLOSURE}\n`;
}

export function createTrustedPluginFixtureHandoff(
  cleanup: CleanupRegistry,
): TrustedPluginFixtureHandoff {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-handoff-"));
  const handoff = { directory, dockerfilePath: path.join(directory, "Dockerfile") };
  cleanup.add("remove trusted EXDEV image handoff", () =>
    fs.rmSync(directory, { recursive: true, force: true }),
  );
  return handoff;
}

export function writeTrustedPluginFixtureHandoff(
  handoff: TrustedPluginFixtureHandoff,
  image: TrustedPluginFixtureImage,
): void {
  const source = renderTrustedPluginFixtureHandoffDockerfile(image.imageId);
  const temporaryPath = path.join(handoff.directory, `.Dockerfile.${randomUUID()}.temporary`);
  try {
    fs.writeFileSync(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporaryPath, handoff.dockerfilePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function createTrustedPluginFixtureHostMountSource(
  cleanup: CleanupRegistry,
  sourceRoot = "/dev/shm",
): string {
  const resolvedRoot = path.resolve(sourceRoot);
  const directory = fs.mkdtempSync(path.join(resolvedRoot, "nemoclaw-exdev-source-"));
  fs.chmodSync(directory, 0o755);
  cleanup.add("remove trusted EXDEV host mount source", () =>
    fs.rmSync(directory, { recursive: true, force: true }),
  );
  return directory;
}

function normalizeExtractedFixtureTree(directory: string): void {
  let problem: string | null = null;
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        problem ??= `trusted EXDEV fixture contains an unsupported entry: ${entry.name}`;
        continue;
      }
      if (entry.isDirectory()) {
        fs.chmodSync(candidate, 0o755);
        visit(candidate);
      } else {
        fs.chmodSync(candidate, 0o644);
      }
    }
  };
  visit(directory);
  for (const expected of [
    "package.json",
    "openclaw.plugin.json",
    "dist/index.js",
    "dist/version.js",
  ]) {
    const candidate = path.join(directory, expected);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      problem ??= `trusted EXDEV fixture is missing ${expected}`;
    }
  }
  assert.equal(problem, null, problem ?? undefined);
}

export async function extractTrustedPluginFixtureToHost(options: {
  environment: NodeJS.ProcessEnv;
  host: Pick<HostCliClient, "command">;
  image: TrustedPluginFixtureImage;
  sourceDirectory: string;
}): Promise<void> {
  requireTrustedExdevImageId(options.image.imageId);
  const sourceDirectory = path.resolve(options.sourceDirectory);
  const sourceStat = fs.lstatSync(sourceDirectory);
  assert(
    sourceStat.isDirectory() &&
      !sourceStat.isSymbolicLink() &&
      fs.realpathSync(sourceDirectory) === sourceDirectory &&
      fs.readdirSync(sourceDirectory).length === 0,
    "trusted EXDEV extraction destination must be an empty canonical directory",
  );
  const containerIdentityDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-exdev-container-identity-"),
  );
  const containerIdPath = path.join(containerIdentityDirectory, "container.cid");
  const failures: string[] = [];
  let containerId: string | null = null;
  try {
    let create: Awaited<ReturnType<HostCliClient["command"]>> | null = null;
    try {
      create = await options.host.command(
        "docker",
        [
          "create",
          "--cidfile",
          containerIdPath,
          "--entrypoint",
          "/bin/true",
          options.image.imageId,
        ],
        {
          artifactName: "create-trusted-exdev-source-container",
          env: options.environment,
          timeoutMs: 60_000,
        },
      );
    } catch (error) {
      failures.push(`create trusted EXDEV source container: ${String(error)}`);
    }
    const createdId = fs.existsSync(containerIdPath)
      ? fs.readFileSync(containerIdPath, "utf8").trim()
      : "";
    if (/^[0-9a-f]{64}$/.test(createdId)) {
      containerId = createdId;
    } else {
      failures.push("create trusted EXDEV source container returned an invalid identity");
    }
    if (create && create.exitCode !== 0) {
      failures.push(`create trusted EXDEV source container: ${resultText(create).trim()}`);
    } else if (create?.exitCode === 0 && containerId) {
      try {
        const copy = await options.host.command(
          "docker",
          ["cp", `${containerId}:${TRUSTED_PLUGIN_FIXTURE_IMAGE_DIR}/.`, sourceDirectory],
          {
            artifactName: "copy-trusted-exdev-source-from-container",
            env: options.environment,
            timeoutMs: 60_000,
          },
        );
        if (copy.exitCode !== 0) {
          failures.push(`copy trusted EXDEV source from container: ${resultText(copy).trim()}`);
        }
      } catch (error) {
        failures.push(`copy trusted EXDEV source from container: ${String(error)}`);
      }
    }

    if (containerId) {
      try {
        const remove = await options.host.command("docker", ["rm", containerId], {
          artifactName: "remove-trusted-exdev-source-container",
          env: options.environment,
          timeoutMs: 60_000,
        });
        if (remove.exitCode !== 0) {
          failures.push(`remove trusted EXDEV source container: ${resultText(remove).trim()}`);
        }
      } catch (error) {
        failures.push(`remove trusted EXDEV source container: ${String(error)}`);
      }
    }
  } finally {
    fs.rmSync(containerIdentityDirectory, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], "trusted EXDEV fixture extraction failed");
  normalizeExtractedFixtureTree(sourceDirectory);
}

type TrustedPluginFixtureBuildContext = {
  dockerfilePath: string;
  sourceRoot: string;
};

export type TrustedPluginFixtureImageCleanup = {
  track(imageRef: string, version: "v1" | "v2"): void;
};

export function registerTrustedPluginFixtureImageCleanup(options: {
  cleanup: CleanupRegistry;
  environment: NodeJS.ProcessEnv;
  host: Pick<HostCliClient, "command">;
}): TrustedPluginFixtureImageCleanup {
  const images: Array<{ imageRef: string; version: "v1" | "v2" }> = [];
  options.cleanup.add("remove trusted EXDEV fixture images", async () => {
    const failures: string[] = [];
    for (const image of [...images].reverse()) {
      const result = await options.host.command(
        "docker",
        ["image", "rm", "--force", image.imageRef],
        {
          artifactName: `cleanup-trusted-exdev-image-${image.version}`,
          env: options.environment,
          timeoutMs: 60_000,
        },
      );
      if (result.exitCode !== 0) {
        const detail =
          resultText(result).trim() ||
          (result.signal ? `signal=${result.signal}` : `exit=${result.exitCode ?? "unknown"}`);
        failures.push(`${image.imageRef}: ${detail}`);
      }
    }
    assert.deepEqual(failures, [], "failed to remove trusted EXDEV fixture images");
  });
  return {
    track: (imageRef, version) => {
      assert.match(imageRef, TRUSTED_EXDEV_IMAGE_REF_PATTERN);
      images.push({ imageRef, version });
    },
  };
}

export function acceptTrustedPluginFixturePrebuild(options: {
  images: TrustedPluginFixtureImageCleanup;
  prebuild: SandboxPrebuildResult;
  sandboxName: string;
  version: "v1" | "v2";
}): { imageId: string; imageRef: string } {
  const imageRef = String(options.prebuild.imageRef ?? "");
  options.images.track(imageRef, options.version);
  const imageId = String(options.prebuild.imageId);
  requireTrustedExdevImageId(imageId);
  return { imageId, imageRef };
}

export async function buildTrustedPluginFixtureImage(options: {
  artifacts: ArtifactSink;
  baseImageRef: string;
  cleanup: CleanupRegistry;
  context: TrustedPluginFixtureBuildContext;
  deploymentEnv: NodeJS.ProcessEnv;
  environment: NodeJS.ProcessEnv;
  images: TrustedPluginFixtureImageCleanup;
  sandboxName: string;
  version: "v1" | "v2";
}): Promise<TrustedPluginFixtureImage> {
  const buildId = `exdev-${options.version}-${randomUUID()}`;
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  options.cleanup.add(`remove trusted EXDEV fixture context ${options.version}`, () =>
    fs.rmSync(buildCtx, { recursive: true, force: true }),
  );
  fs.cpSync(options.context.sourceRoot, buildCtx, {
    recursive: true,
    filter: createCustomBuildContextFilter(options.context.sourceRoot),
  });
  fs.copyFileSync(
    path.join(buildCtx, path.basename(options.context.dockerfilePath)),
    stagedDockerfile,
  );
  const endpointUrl = String(options.deploymentEnv.NEMOCLAW_ENDPOINT_URL);
  patchStagedDockerfile(
    stagedDockerfile,
    "nemoclaw-exdev-probe",
    "http://127.0.0.1:18789",
    buildId,
    "custom",
    "openai-completions",
    null,
    options.baseImageRef,
    false,
    null,
    [],
    {
      buildIdPolicy: "rewrite",
      requireToolDisclosureContract: true,
      upstreamEndpointUrl: endpointUrl,
    },
  );
  const prebuild = await prebuildSandboxImageIfEligible({
    buildCtx,
    buildId,
    createArgs: ["--from", stagedDockerfile, "--name", options.sandboxName],
    dockerDriverGateway: true,
    env: { ...options.environment, NEMOCLAW_SANDBOX_PREBUILD: "1" },
    // The staged source is owned by this E2E fixture. User custom Dockerfiles
    // remain origin=custom and never cross this local-build trust boundary.
    origin: "generated",
    requiresLocalBuildKit: true,
    sandboxName: options.sandboxName,
  });
  const { imageId, imageRef } = acceptTrustedPluginFixturePrebuild({
    images: options.images,
    prebuild,
    sandboxName: options.sandboxName,
    version: options.version,
  });
  await options.artifacts.writeJson(`trusted-exdev-image-${options.version}.json`, {
    baseImageRef: options.baseImageRef,
    buildId,
    imageId,
    imageRef,
    sourceDockerfile: options.context.dockerfilePath,
    stagedDockerfile,
    version: options.version,
  });
  return { imageId, imageRef };
}
