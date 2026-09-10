// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
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
import { redirectInheritedChildStdoutToStderr } from "../cli/stdout-guard";
import {
  LOCAL_SANDBOX_IMAGE_REPO,
  PORTABLE_LOCAL_SANDBOX_IMAGE_REPO,
} from "../domain/sandbox/image-tag";
import {
  SANDBOX_BUILD_CONTEXT_PREFIX,
  type SandboxBuildContextOrigin,
} from "../sandbox/build-context";
import { isPortableExperimentalProfile } from "./docker-driver-platform";
import { isImmutableDockerImageId } from "./openshell-docker-sandbox-containers";

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_FLAG_VALUES = new Set(["0", "false", "no", "off"]);

export interface SandboxPrebuildInput {
  buildCtx: string;
  buildId: string;
  createArgs: readonly string[];
  sandboxName: string;
  dockerDriverGateway: boolean;
  origin: SandboxBuildContextOrigin;
  /** The selected generated Dockerfile cannot be built by OpenShell's classic Docker builder. */
  requiresLocalBuildKit?: boolean;
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
      const spawnOptions = {
        ...options,
        stdio: redirectInheritedChildStdoutToStderr(options.stdio),
        shell: false,
      } as const;
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
    ? PORTABLE_LOCAL_SANDBOX_IMAGE_REPO
    : LOCAL_SANDBOX_IMAGE_REPO;
  return `${repository}:${namePart}-${buildPart}`;
}

/**
 * Build a NemoClaw-generated staged context with the shared local container
 * runtime. Docker uses BuildKit; the portable profile uses native rootless
 * Podman. User-supplied Dockerfiles stay on the OpenShell gateway builder trust
 * boundary. Generated OpenClaw and Hermes Dockerfiles fail closed when their
 * required local BuildKit build cannot complete because the gateway's classic
 * Docker builder cannot preserve their archive-mode, per-step network, and
 * mount contracts.
 * Remove this bridge once OpenShell uses BuildKit for this local-driver path;
 * extraction and observable retirement criteria are tracked by #6258.
 */
export async function prebuildSandboxImageIfEligible(
  input: SandboxPrebuildInput,
): Promise<SandboxPrebuildResult> {
  const createArgs = [...input.createArgs];
  const env = input.env ?? process.env;
  const log = input.log ?? console.log;
  const portable = isPortableExperimentalProfile(env);
  const requiresLocalBuildKit =
    input.origin === "generated" &&
    input.requiresLocalBuildKit === true &&
    input.dockerDriverGateway &&
    !portable;
  if (!resolveSandboxPrebuildEnabled(env, input.dockerDriverGateway)) {
    if (requiresLocalBuildKit) {
      throw new Error("Local BuildKit is required for this generated sandbox image");
    }
    return { createArgs, imageRef: null, imageId: null };
  }
  if (input.origin !== "generated") {
    log(
      "  Local BuildKit build skipped for a custom Dockerfile; using the gateway builder instead.",
    );
    return { createArgs, imageRef: null, imageId: null };
  }
  const fromIndex = createArgs.indexOf("--from");
  const fromDockerfile = createArgs[fromIndex + 1];
  if (
    fromIndex < 0 ||
    !fromDockerfile ||
    path.resolve(fromDockerfile) !== path.resolve(input.buildCtx, "Dockerfile")
  ) {
    if (requiresLocalBuildKit) {
      throw new Error("Local BuildKit requires the generated staged Dockerfile");
    }
    return { createArgs, imageRef: null, imageId: null };
  }
  let trustedContext: TrustedStagedBuildContext | null;
  try {
    trustedContext = resolveTrustedStagedBuildContext(input.buildCtx);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (requiresLocalBuildKit) {
      throw new Error(`Local BuildKit could not inspect the staged build context: ${detail}`, {
        cause: error,
      });
    }
    log(
      `  Local BuildKit build skipped: staged build context could not be inspected (${detail}); using the gateway builder instead.`,
    );
    return { createArgs, imageRef: null, imageId: null };
  }
  if (!trustedContext) {
    if (requiresLocalBuildKit) {
      throw new Error("Local BuildKit rejected the staged build context trust boundary");
    }
    log(
      "  Local BuildKit build skipped: staged build context failed trust validation; using the gateway builder instead.",
    );
    return { createArgs, imageRef: null, imageId: null };
  }

  const imageRef = sandboxLocalImageRef(input.sandboxName, input.buildId, env);
  const builderName = portable ? "rootless Podman" : "BuildKit";
  const buildImage = input.buildImage ?? createHostImageCommand(portable ? "podman" : "docker");
  log(`  Building sandbox image with ${builderName} (skips the slower in-gateway builder)...`);

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
    const detail = error instanceof Error ? error.message : String(error);
    if (requiresLocalBuildKit) {
      throw new Error(`Local BuildKit build could not start: ${detail}`, { cause: error });
    }
    log(
      `  Local ${builderName} build could not start (${detail}); using the gateway builder instead.`,
    );
    return { createArgs, imageRef: null, imageId: null };
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
    if (requiresLocalBuildKit) {
      throw new Error(`Local BuildKit build failed${detail}`);
    }
    log(`  Local ${builderName} build failed${detail}; using the gateway builder instead.`);
    return { createArgs, imageRef: null, imageId: null };
  }

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
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Managed local registry publish could not start: ${detail}`);
    } finally {
      fs.rmSync(credentialFreeDockerConfig, { recursive: true, force: true });
    }
    if (publishStatus !== 0) {
      const detail =
        publishStatus === null ? " without an exit status" : ` (exit ${publishStatus})`;
      throw new Error(`Managed local registry publish failed${detail}`);
    }
  }

  createArgs[fromIndex + 1] = imageRef;
  const inspectImageId =
    input.inspectImageId ??
    ((ref: string) =>
      dockerImageInspectFormat("{{.Id}}", ref, {
        ignoreError: true,
      }).trim());
  let imageId: string | null = null;
  try {
    const inspected = inspectImageId(imageRef).trim();
    if (isImmutableDockerImageId(inspected)) imageId = inspected.toLowerCase();
  } catch {
    // Native creation can still use the local tag. Automatic compatibility
    // fallback will refuse it unless the exact container supplies an immutable
    // image ID before cleanup.
  }
  if (!imageId) {
    log(
      "  Local image identity could not be proven; an operator-authorized GPU compatibility fallback may fail closed if no exact native container identity becomes available.",
    );
  }
  return {
    createArgs,
    imageRef,
    imageId,
  };
}
