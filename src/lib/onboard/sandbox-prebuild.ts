// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createCredentialFreeDockerConfig,
  dockerBuildSubprocessEnv,
  prepareDockerBuildEnvironment,
  type PreparedDockerBuildEnvironment,
  warnIfDockerBuildEnvironmentCleanupFailed,
} from "../adapters/docker/client-isolation";
import { dockerSpawn } from "../adapters/docker/exec";
import { dockerImageInspectFormat } from "../adapters/docker/inspect";
import { LOCAL_SANDBOX_IMAGE_REPO } from "../domain/sandbox/image-tag";
import {
  SANDBOX_BUILD_CONTEXT_PREFIX,
  type SandboxBuildContextOrigin,
} from "../sandbox/build-context";
import { isPortableExperimentalProfile, PORTABLE_LOCAL_REGISTRY } from "./docker-driver-platform";
import { isImmutableDockerImageId } from "./openshell-docker-sandbox-containers";

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_FLAG_VALUES = new Set(["0", "false", "no", "off"]);

export interface SandboxPrebuildInput {
  buildCtx: string;
  buildId: string;
  /** Deferred Portable path only. Ordinary creation passes the typed source reference. */
  createArgs?: readonly string[];
  sourceReference?: string;
  sandboxName: string;
  dockerDriverGateway: boolean;
  /** Driver selected for the gateway that will consume the image. */
  gatewayDriver?: string;
  origin: SandboxBuildContextOrigin;
  env?: NodeJS.ProcessEnv;
  buildImage?: (
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
  ) => Promise<number | null>;
  publishImage?: (
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
  ) => Promise<number | null>;
  inspectImageId?: (imageRef: string) => string;
  credentialHelperResponds?: (credsStore: string) => boolean;
  dockerContextIsDefault?: (env: NodeJS.ProcessEnv) => boolean;
  isWslHost?: boolean;
  log?: (message: string) => void;
}

export interface SandboxPrebuildResult {
  createArgs: string[];
  /** Final source for callers that keep the ordinary create plan typed. */
  sourceReference?: string;
  imageRef: string | null;
  /** Immutable local image identity; mutable tags never authorize fallback. */
  imageId: string | null;
}

interface TrustedStagedBuildContext {
  buildCtx: string;
  dockerfile: string;
}

function createHostImageCommand(
  command: "docker" | "podman",
): NonNullable<SandboxPrebuildInput["buildImage"]> {
  return (args, options) =>
    new Promise<number | null>((resolve, reject) => {
      const spawnOptions: SpawnOptions = {
        ...options,
        // Build output can contain values printed by a Dockerfile or client.
        // Report only the bounded phase result, never unfiltered diagnostics.
        stdio: ["ignore", "ignore", "ignore"],
        shell: false,
      };
      const child =
        command === "podman"
          ? spawn(command, [...args], spawnOptions)
          : dockerSpawn(args, spawnOptions);
      child.once("error", reject);
      child.once("close", resolve);
    });
}

/**
 * Resolve the private staged context before handing it to the host Docker daemon.
 * The context stagers create direct children of the OS temp directory with this
 * prefix; fail closed if a future caller supplies anything else.
 */
function resolveTrustedStagedBuildContext(buildCtx: string): TrustedStagedBuildContext | null {
  let descriptor: number | undefined;
  try {
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const resolvedBuildCtx = fs.realpathSync(buildCtx);
    const context = fs.statSync(resolvedBuildCtx);
    if (
      path.dirname(resolvedBuildCtx) !== temporaryRoot ||
      !path.basename(resolvedBuildCtx).startsWith(SANDBOX_BUILD_CONTEXT_PREFIX) ||
      !context.isDirectory() ||
      (context.mode & 0o022) !== 0
    ) {
      return null;
    }

    const dockerfile = path.join(resolvedBuildCtx, "Dockerfile");
    const resolvedDockerfile = fs.realpathSync(dockerfile);
    if (path.dirname(resolvedDockerfile) !== resolvedBuildCtx) return null;

    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") return null;
    const nonBlocking = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;

    descriptor = fs.openSync(dockerfile, fs.constants.O_RDONLY | noFollow | nonBlocking);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) return null;

    return { buildCtx: resolvedBuildCtx, dockerfile: resolvedDockerfile };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function resolveSandboxPrebuildEnabled(
  env: NodeJS.ProcessEnv,
  dockerDriverGateway: boolean,
): boolean {
  // A registry-less local image is never visible to k3s or remote gateways.
  // Keep this invariant ahead of every environment override.
  if (!dockerDriverGateway) return false;

  const override = String(env.NEMOCLAW_SANDBOX_PREBUILD ?? "")
    .trim()
    .toLowerCase();
  if (FALSY_FLAG_VALUES.has(override)) return false;
  if (TRUTHY_FLAG_VALUES.has(override)) return true;
  return !env.VITEST && env.NODE_ENV !== "test";
}

/** Bind Portable build and push tags to the same registry authority used by readiness checks. */
export function sandboxLocalImageRef(
  sandboxName: string,
  buildId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const sanitize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "-")
      .replace(/^[-.]+/, "");
  const buildPart = sanitize(buildId).slice(-32) || "build";
  const namePart = sanitize(sandboxName).slice(0, 127 - buildPart.length) || "sandbox";
  const repository = isPortableExperimentalProfile(env)
    ? `${PORTABLE_LOCAL_REGISTRY}/${LOCAL_SANDBOX_IMAGE_REPO}`
    : LOCAL_SANDBOX_IMAGE_REPO;
  return `${repository}:${namePart}-${buildPart}`;
}

/**
 * Build a NemoClaw-generated staged context with the shared local container
 * runtime. Docker uses BuildKit; the portable profile uses native rootless
 * Podman. Generated images must be present in the gateway's selected engine
 * before OpenShell receives their image reference.
 * Portable builds require HTTP 200 from the managed IPv4 registry before any
 * build or publication operation. Unavailable registries reject without fallback.
 * @throws When the portable registry is unavailable or a required build fails.
 * @returns The prebuilt image identity, or unchanged arguments for a custom source.
 */
export async function prebuildSandboxImageIfEligible(
  input: SandboxPrebuildInput,
): Promise<SandboxPrebuildResult> {
  const createArgs = [...(input.createArgs ?? [])];
  const fromIndex = createArgs.indexOf("--from");
  const initialSourceReference = input.sourceReference ?? createArgs[fromIndex + 1];
  const result = (
    sourceReference: string | undefined,
    imageRef: string | null,
    imageId: string | null,
  ): SandboxPrebuildResult => ({
    createArgs,
    ...(input.sourceReference !== undefined && sourceReference ? { sourceReference } : {}),
    imageRef,
    imageId,
  });
  const env = input.env ?? process.env;
  const log = input.log ?? console.log;
  const portable = isPortableExperimentalProfile(env);
  if (input.origin !== "generated") {
    log(
      "  Local BuildKit build skipped for a custom Dockerfile; using the gateway builder instead.",
    );
    return result(initialSourceReference, null, null);
  }
  if (!input.dockerDriverGateway) {
    throw new Error(
      "Generated Dockerfile onboarding requires a local Docker or Podman gateway; no image distribution path is configured for this gateway.",
    );
  }
  const selectedEngine = portable ? "podman" : "docker";
  if (input.gatewayDriver !== undefined && input.gatewayDriver !== selectedEngine) {
    throw new Error(
      `Generated Dockerfile build requires the selected ${input.gatewayDriver} gateway engine; refusing a ${selectedEngine} build.`,
    );
  }
  if (!portable && !env.DOCKER_HOST && env.DOCKER_CONTEXT && env.DOCKER_CONTEXT !== "default") {
    throw new Error(
      "Generated Dockerfile build cannot prove that the selected Docker context shares the local gateway engine.",
    );
  }
  if (!resolveSandboxPrebuildEnabled(env, input.dockerDriverGateway)) {
    throw new Error(
      "Generated Dockerfile image build is required before sandbox creation; enable local prebuild.",
    );
  }
  const fromDockerfile = initialSourceReference;
  if (
    !fromDockerfile ||
    path.resolve(fromDockerfile) !== path.resolve(input.buildCtx, "Dockerfile")
  ) {
    throw new Error("Generated image build requires the selected staged Dockerfile.");
  }
  let trustedContext: TrustedStagedBuildContext | null;
  try {
    trustedContext = resolveTrustedStagedBuildContext(input.buildCtx);
  } catch (error) {
    throw new Error(
      "Generated image build could not inspect the staged context; sandbox creation stopped.",
      { cause: error },
    );
  }
  if (!trustedContext) {
    throw new Error("Generated image build rejected the staged context trust boundary.");
  }

  const imageRef = sandboxLocalImageRef(input.sandboxName, input.buildId, env);
  if (portable) {
    const registryUrl = new URL("/v2/", `http://${PORTABLE_LOCAL_REGISTRY}`);
    try {
      const response = await fetch(registryUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      if (response.status !== 200) throw new Error("Registry is not ready");
    } catch {
      throw new Error(
        `Managed local registry at ${registryUrl.origin} is unavailable. Sandbox image build has not started. Restore the managed registry, then verify that ${registryUrl.href} returns HTTP 200 before retrying.`,
      );
    }
  }
  const builderName = portable ? "rootless Podman" : "BuildKit";
  const buildImage = input.buildImage ?? createHostImageCommand(portable ? "podman" : "docker");
  log(`  Building sandbox image with ${builderName}...`);

  let status: number | null;
  let preparedDockerEnvironment: PreparedDockerBuildEnvironment | null = null;
  try {
    preparedDockerEnvironment = portable
      ? null
      : prepareDockerBuildEnvironment({
          env,
          credentialHelperResponds: input.credentialHelperResponds,
          dockerContextIsDefault: input.dockerContextIsDefault,
          isWslHost: input.isWslHost,
        });
    const buildEnv = preparedDockerEnvironment?.env ?? dockerBuildSubprocessEnv(env);
    if (preparedDockerEnvironment?.isolatedCredentialConfig) {
      log(
        "  Docker Desktop credential helper is unavailable in this WSL session; using an isolated credential-free config for the generated sandbox image build.",
      );
    }
    status = await buildImage(
      ["build", "-t", imageRef, "-f", trustedContext.dockerfile, trustedContext.buildCtx],
      {
        env: buildEnv,
        stdio: "inherit",
      },
    );
  } catch (error) {
    throw new Error(
      `Local ${builderName} build could not start; check the selected engine and retry.`,
      { cause: error },
    );
  } finally {
    if (preparedDockerEnvironment) {
      warnIfDockerBuildEnvironmentCleanupFailed(
        preparedDockerEnvironment.cleanup(),
        `generated sandbox image '${imageRef}'`,
      );
    }
  }

  if (status !== 0) {
    const detail = status === null ? " without an exit status" : ` (exit ${status})`;
    throw new Error(
      `Local ${builderName} build failed${detail}; check the Dockerfile and selected engine before retrying.`,
    );
  }
  log(`  ${builderName} build completed for ${imageRef}.`);

  if (portable) {
    const publishImage = input.publishImage ?? buildImage;
    log("  Publishing sandbox image to the managed local registry...");
    let publishStatus: number | null;
    const credentialFreeDockerConfig = createCredentialFreeDockerConfig("portable");
    try {
      publishStatus = await publishImage(["push", imageRef], {
        env: {
          ...dockerBuildSubprocessEnv(env),
          DOCKER_CONFIG: credentialFreeDockerConfig,
          REGISTRY_AUTH_FILE: path.join(credentialFreeDockerConfig, "config.json"),
        },
        stdio: "inherit",
      });
    } catch (error) {
      throw new Error(
        "Managed local registry publish could not start; check the local registry and retry.",
        { cause: error },
      );
    } finally {
      fs.rmSync(credentialFreeDockerConfig, { recursive: true, force: true });
    }
    if (publishStatus !== 0) {
      const detail =
        publishStatus === null ? " without an exit status" : ` (exit ${publishStatus})`;
      throw new Error(`Managed local registry publish failed${detail}`);
    }
  }

  if (fromIndex >= 0) createArgs[fromIndex + 1] = imageRef;
  const inspectImageId =
    input.inspectImageId ??
    ((ref: string) => {
      if (!portable)
        return dockerImageInspectFormat("{{.Id}}", ref, {
          env: dockerBuildSubprocessEnv(env),
          replaceEnv: true,
          ignoreError: true,
        }).trim();
      const inspection = spawnSync("podman", ["image", "inspect", "--format", "{{.Id}}", ref], {
        env: dockerBuildSubprocessEnv(env),
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4096,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return inspection.status === 0 ? inspection.stdout.trim() : "";
    });
  let imageId: string | null;
  try {
    const inspected = inspectImageId(imageRef).trim();
    imageId = isImmutableDockerImageId(inspected) ? inspected.toLowerCase() : null;
  } catch {
    imageId = null;
  }
  if (!imageId) {
    throw new Error(
      `Built image ${imageRef} is not visible in the selected ${selectedEngine} engine; sandbox creation stopped.`,
    );
  }
  return result(imageRef, imageRef, imageId);
}
