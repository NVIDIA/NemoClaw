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
  hasRequiredOpenshellMessagingFeatures,
  REQUIRED_OPENSHELL_MCP_FEATURES,
} from "../../../src/lib/onboard/openshell-feature-gate.ts";
import {
  prebuildSandboxImageIfEligible,
  type SandboxPrebuildResult,
} from "../../../src/lib/onboard/sandbox-prebuild.ts";
import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../../../src/lib/sandbox/build-context.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  createOpenShellDriverConfigTestWrapper,
  resolveOpenShellSiblingComponents,
  type OpenShellDriverConfigTestWrapper,
} from "./openshell-driver-config-test-wrapper.ts";

export const DELEGATED_CAPABILITY_COMMENT_PREFIX =
  "# TEST-ONLY delegated-capability marker from validated canonical OpenShell: ";
export const TRUSTED_PLUGIN_FIXTURE_IMAGE_DIR = "/usr/local/share/nemoclaw-e2e/weather-plugin";
const TRUSTED_PLUGIN_RUNTIME_STAGE_DIR = "/tmp/nemoclaw-e2e-weather-plugin-runtime";

export type TrustedPluginFixtureImage = {
  imageId: string;
  imageRef: string;
};

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
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/package.json \
    /opt/weather/package-lock.json \
    /opt/weather/openclaw.plugin.json \
    ${TRUSTED_PLUGIN_RUNTIME_STAGE_DIR}/
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather-runtime-dist/ ${TRUSTED_PLUGIN_RUNTIME_STAGE_DIR}/dist/
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/node_modules/ ${TRUSTED_PLUGIN_RUNTIME_STAGE_DIR}/node_modules/

USER sandbox
RUN HOME=/sandbox openclaw plugins install ${TRUSTED_PLUGIN_RUNTIME_STAGE_DIR} \
    && HOME=/sandbox openclaw plugins enable weather \
    && rm -rf ${TRUSTED_PLUGIN_RUNTIME_STAGE_DIR}

# Enabling the plugin changes openclaw.json after the managed runtime hashes it.
# The runtime test copies this fixture from OpenShell's read-only /usr policy tree
# into tmpfs after the sandbox starts.
# hadolint ignore=DL3002
USER root
RUN chown sandbox:sandbox /sandbox/.openclaw/openclaw.json \
    && chmod 660 /sandbox/.openclaw/openclaw.json \
    && sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \
    && chown sandbox:sandbox /sandbox/.openclaw/.config-hash \
    && chmod 660 /sandbox/.openclaw/.config-hash
`;
  return runtime.trimEnd() + extension;
}

const TRUSTED_EXDEV_IMAGE_REF_PATTERN = new RegExp(
  `^${LOCAL_SANDBOX_IMAGE_REPO}:[a-z0-9_][a-z0-9_.-]{0,127}$`,
);

export type OpenShellTrustedImageWrapper = OpenShellDriverConfigTestWrapper & {
  selectImage(image: TrustedPluginFixtureImage): void;
};

export function trustedExdevImageRef(tag: string): string {
  const imageRef = `${LOCAL_SANDBOX_IMAGE_REPO}:${tag}`;
  assert.match(imageRef, TRUSTED_EXDEV_IMAGE_REF_PATTERN);
  return imageRef;
}

export function createOpenShellTrustedImageWrapper(options: {
  driverConfigJson: string;
  imageInspectorPath?: string;
  realOpenshellPath: string;
}): OpenShellTrustedImageWrapper {
  const canonicalComponents = resolveOpenShellSiblingComponents(options.realOpenshellPath);
  assert(
    hasRequiredOpenshellMessagingFeatures({
      gatewayBin: canonicalComponents.gateway,
      openshellBin: canonicalComponents.cli,
      sandboxBin: canonicalComponents.sandbox,
    }),
    "trusted EXDEV image wrapper requires feature-complete canonical OpenShell components",
  );
  const delegated = createOpenShellDriverConfigTestWrapper({
    delegatedCapabilityMarkers: REQUIRED_OPENSHELL_MCP_FEATURES,
    driverConfigJson: options.driverConfigJson,
    label: "exdev",
    realOpenshellPath: options.realOpenshellPath,
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-image-wrapper-"));
  const imageInspectorPath = options.imageInspectorPath ?? "docker";
  const imageSelectionPath = path.join(directory, "selected-image.json");
  const rewriterPath = path.join(directory, "rewrite-from.cjs");
  const executable = path.join(directory, "openshell");
  fs.writeFileSync(imageSelectionPath, "{}\n", { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(
    rewriterPath,
    `const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "create") {
  const fromIndexes = args.flatMap((argument, index) => argument === "--from" ? [index] : []);
  if (fromIndexes.length !== 1 || fromIndexes[0] + 1 >= args.length) {
    process.stderr.write("trusted EXDEV image handoff requires exactly one --from value\\n");
    process.exit(64);
  }
  let selected;
  try {
    selected = JSON.parse(fs.readFileSync(${JSON.stringify(imageSelectionPath)}, "utf8"));
  } catch {}
  if (!selected || !${TRUSTED_EXDEV_IMAGE_REF_PATTERN.toString()}.test(selected.imageRef)) {
    process.stderr.write("trusted EXDEV image handoff rejected the selected image ref\\n");
    process.exit(64);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(selected.imageId)) {
    process.stderr.write("trusted EXDEV image handoff rejected the selected image ID\\n");
    process.exit(64);
  }
  const inspected = spawnSync(
    ${JSON.stringify(imageInspectorPath)},
    ["image", "inspect", "--format", "{{.Id}}", selected.imageRef],
    { encoding: "utf8" },
  );
  if (inspected.error || inspected.status !== 0 || inspected.stdout.trim() !== selected.imageId) {
    process.stderr.write("trusted EXDEV image handoff detected an immutable identity mismatch\\n");
    process.exit(64);
  }
  args[fromIndexes[0] + 1] = selected.imageId;
}
const result = spawnSync(${JSON.stringify(delegated.executable)}, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
    { encoding: "utf8", mode: 0o600 },
  );
  const capabilityComments = REQUIRED_OPENSHELL_MCP_FEATURES.map(
    (marker) => `${DELEGATED_CAPABILITY_COMMENT_PREFIX}${marker}`,
  ).join("\n");
  fs.writeFileSync(
    executable,
    `#!/bin/sh
${capabilityComments}
set -eu
exec ${shellQuote(process.execPath)} ${shellQuote(rewriterPath)} "$@"
`,
    { encoding: "utf8", mode: 0o700 },
  );

  return {
    directory,
    executable,
    selectImage: (image) => {
      assert.match(image.imageRef, TRUSTED_EXDEV_IMAGE_REF_PATTERN);
      assert.match(image.imageId, /^sha256:[0-9a-f]{64}$/);
      fs.writeFileSync(imageSelectionPath, `${JSON.stringify(image)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
    remove: () => {
      fs.rmSync(directory, { recursive: true, force: true });
      delegated.remove();
    },
  };
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
  assert(options.prebuild.imageRef, "trusted EXDEV fixture prebuild must return a local image ref");
  const imageRef = options.prebuild.imageRef;
  assert.match(imageRef, TRUSTED_EXDEV_IMAGE_REF_PATTERN);
  options.images.track(imageRef, options.version);
  assert.deepEqual(options.prebuild.createArgs, [
    "--from",
    imageRef,
    "--name",
    options.sandboxName,
  ]);
  const imageId = String(options.prebuild.imageId);
  assert.match(
    imageId,
    /^sha256:[0-9a-f]{64}$/,
    "trusted EXDEV fixture prebuild must retain its immutable local image identity",
  );
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
  assert.match(endpointUrl, /^http:\/\//);
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
