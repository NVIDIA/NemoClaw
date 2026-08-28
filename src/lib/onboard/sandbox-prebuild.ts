// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerImageInspectFormat } from "../adapters/docker";
import {
  dockerDesktopCredentialHelperResponds,
  readDockerCredentialStore,
} from "../adapters/docker/credential-store";
import { dockerSpawn } from "../adapters/docker/exec";
import { redirectInheritedChildStdoutToStderr } from "../cli/stdout-guard";
import {
  LOCAL_SANDBOX_IMAGE_REPO,
  PORTABLE_LOCAL_SANDBOX_IMAGE_REPO,
} from "../domain/sandbox/image-tag";
import { DOCKER_DESKTOP_CREDENTIAL_STORE_NAMES } from "../domain/docker-host";
import { isWsl } from "../platform";
import {
  SANDBOX_BUILD_CONTEXT_PREFIX,
  type SandboxBuildContextOrigin,
} from "../sandbox/build-context";
import { buildSubprocessEnv } from "../subprocess-env";
import { isPortableExperimentalProfile } from "./docker-driver-platform";
import { isImmutableDockerImageId } from "./openshell-docker-sandbox-containers";

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_FLAG_VALUES = new Set(["0", "false", "no", "off"]);
const DOCKER_ENV_NAMES = [
  "CONTAINERS_CONF",
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
] as const;

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
  isWslHost?: boolean;
  log?: (message: string) => void;
}

export interface SandboxPrebuildResult {
  createArgs: string[];
  imageRef: string | null;
  /** Immutable local image identity; mutable tags never authorize fallback. */
  imageId: string | null;
}

export interface DockerBuildEnvironmentInput {
  env?: NodeJS.ProcessEnv;
  credentialHelperResponds?: (credsStore: string) => boolean;
  isWslHost?: boolean;
  allowCredentialIsolation?: boolean;
}

export interface PreparedDockerBuildEnvironment {
  env: NodeJS.ProcessEnv;
  isolatedCredentialConfig: boolean;
  cleanup(): void;
}

interface TrustedStagedBuildContext {
  buildCtx: string;
  dockerfile: string;
}

function createCredentialFreeDockerConfig(purpose: "portable" | "wsl-buildkit"): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `nemoclaw-${purpose}-docker-config-`),
  );
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, "config.json"), '{"auths":{}}\n', {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });
  return directory;
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

/** Restrict the host Docker build to environment values used by Docker itself. */
export function dockerBuildSubprocessEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = buildSubprocessEnv();
  for (const key of DOCKER_ENV_NAMES) {
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (
      key === "KUBECONFIG" ||
      key === "SSH_AUTH_SOCK" ||
      key === "RUST_LOG" ||
      key === "RUST_BACKTRACE" ||
      key.startsWith("OPENSHELL_") ||
      key.startsWith("GRPC_")
    ) {
      delete env[key];
    }
  }
  // Match the runner and Docker probe contract: an explicitly selected host
  // owns daemon authority, so an ambient context and its credentials must not
  // redirect the build to another daemon.
  if (env.DOCKER_HOST !== undefined) {
    delete env.DOCKER_CONFIG;
    delete env.DOCKER_CONTEXT;
  }
  return env;
}

function requiresCredentialFreeWslBuildConfig(
  env: NodeJS.ProcessEnv,
  helperResponds: (credsStore: string) => boolean,
  isWslHost?: boolean,
): boolean {
  if (!isWsl({ env, isWsl: isWslHost })) return false;
  const { credsStore } = readDockerCredentialStore(env, fs.readFileSync);
  return (
    credsStore !== undefined &&
    DOCKER_DESKTOP_CREDENTIAL_STORE_NAMES.has(credsStore) &&
    !helperResponds(credsStore)
  );
}

function dockerDesktopCredentialHelperRespondsFromBuild(
  credsStore: string,
  env: NodeJS.ProcessEnv,
): boolean {
  return dockerDesktopCredentialHelperResponds(credsStore, (command, options) => {
    const [executable, ...args] = command;
    if (!executable) return null;
    const result = spawnSync(executable, args, {
      encoding: "utf-8",
      env: dockerBuildSubprocessEnv(env),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: options?.timeout,
    });
    return result.error || result.status !== 0 ? null : result.stdout;
  });
}

/**
 * Prepare the Docker environment shared by normal creation and rebuild image
 * preflight. Docker Desktop can leave WSL pointing at a Windows credential
 * helper that is unavailable from the current session; generated image builds
 * do not need registry credentials, so isolate that case without modifying the
 * user's Docker config.
 */
export function prepareDockerBuildEnvironment(
  input: DockerBuildEnvironmentInput = {},
): PreparedDockerBuildEnvironment {
  const sourceEnv = input.env ?? process.env;
  const helperResponds =
    input.credentialHelperResponds ??
    ((credsStore: string) => dockerDesktopCredentialHelperRespondsFromBuild(credsStore, sourceEnv));
  const credentialFreeConfig =
    input.allowCredentialIsolation !== false &&
    requiresCredentialFreeWslBuildConfig(sourceEnv, helperResponds, input.isWslHost)
    ? createCredentialFreeDockerConfig("wsl-buildkit")
    : null;
  return {
    env: {
      ...dockerBuildSubprocessEnv(sourceEnv),
      DOCKER_BUILDKIT: "1",
      ...(credentialFreeConfig ? { DOCKER_CONFIG: credentialFreeConfig } : {}),
    },
    isolatedCredentialConfig: credentialFreeConfig !== null,
    cleanup: () => {
      if (credentialFreeConfig !== null) {
        fs.rmSync(credentialFreeConfig, { recursive: true, force: true });
      }
    },
  };
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
    preparedDockerEnvironment?.cleanup();
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
