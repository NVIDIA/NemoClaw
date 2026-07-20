// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerSpawn, dockerSpawnSync } from "../adapters/docker/exec";
import { LOCAL_SANDBOX_IMAGE_REPO } from "../domain/sandbox/image-tag";
import { ROOT } from "../runner";
import {
  SANDBOX_BUILD_CONTEXT_PREFIX,
  type SandboxBuildContextOrigin,
} from "../sandbox/build-context";
import { buildSubprocessEnv } from "../subprocess-env";
import { isImmutableDockerImageId } from "./openshell-docker-sandbox-containers";

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_FLAG_VALUES = new Set(["0", "false", "no", "off"]);
const LOCAL_IMAGE_REPO = LOCAL_SANDBOX_IMAGE_REPO;
const DOCKER_ENV_NAMES = [
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
] as const;

export interface SandboxPrebuildInput {
  buildCtx: string;
  buildId: string;
  createArgs: readonly string[];
  sandboxName: string;
  dockerDriverGateway: boolean;
  origin: SandboxBuildContextOrigin;
  /** Builder already proven against this retained rebuild context. */
  builder?: "legacy";
  /** Sanitized Docker endpoint/config environment used by that builder proof. */
  dockerEnv?: Readonly<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
  buildImage?: (
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
  ) => Promise<number | null>;
  inspectImageId?: (imageRef: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => string;
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
export function dockerBuildSubprocessEnv(): Record<string, string> {
  const env = buildSubprocessEnv();
  for (const key of DOCKER_ENV_NAMES) {
    const value = process.env[key];
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
  return env;
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

export function sandboxLocalImageRef(sandboxName: string, buildId: string): string {
  const sanitize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "-")
      .replace(/^[-.]+/, "");
  const buildPart = sanitize(buildId).slice(-32) || "build";
  const namePart = sanitize(sandboxName).slice(0, 127 - buildPart.length) || "sandbox";
  return `${LOCAL_IMAGE_REPO}:${namePart}-${buildPart}`;
}

/**
 * Build a NemoClaw-generated staged context with BuildKit on the shared local
 * Docker daemon. User-supplied Dockerfiles stay on the OpenShell gateway
 * builder trust boundary. Ordinary onboarding preserves that path on local
 * build failure; a builder proven by rebuild preflight instead fails closed.
 * Remove this bridge once OpenShell uses BuildKit for this local-driver path;
 * extraction and observable retirement criteria are tracked by #6258.
 */
export async function prebuildSandboxImageIfEligible(
  input: SandboxPrebuildInput,
): Promise<SandboxPrebuildResult> {
  const createArgs = [...input.createArgs];
  const env = input.env ?? process.env;
  const log = input.log ?? console.log;
  const requiredBuilder = input.builder ?? null;
  const failPreparedBuild = (detail: string): never => {
    throw new Error(`Prepared rebuild image cannot be recreated safely: ${detail}`);
  };
  if (
    (requiredBuilder &&
      (!input.dockerEnv ||
        !Object.isFrozen(input.dockerEnv) ||
        Object.values(input.dockerEnv).some((value) => typeof value !== "string"))) ||
    (!requiredBuilder && input.dockerEnv)
  ) {
    failPreparedBuild("the verified Docker environment is missing or invalid");
  }
  if (!resolveSandboxPrebuildEnabled(env, input.dockerDriverGateway)) {
    if (requiredBuilder) {
      failPreparedBuild("the verified local Docker builder is not enabled");
    }
    return { createArgs, imageRef: null, imageId: null };
  }
  if (input.origin !== "generated") {
    if (requiredBuilder) {
      failPreparedBuild("the retained build context is not NemoClaw-generated");
    }
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
    if (requiredBuilder) {
      failPreparedBuild("sandbox create arguments no longer select the retained Dockerfile");
    }
    return { createArgs, imageRef: null, imageId: null };
  }
  let trustedContext: TrustedStagedBuildContext | null;
  try {
    trustedContext = resolveTrustedStagedBuildContext(input.buildCtx);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (requiredBuilder) {
      failPreparedBuild(`the retained build context could not be inspected (${detail})`);
    }
    log(
      `  Local BuildKit build skipped: staged build context could not be inspected (${detail}); using the gateway builder instead.`,
    );
    return { createArgs, imageRef: null, imageId: null };
  }
  if (!trustedContext) {
    if (requiredBuilder) {
      failPreparedBuild("the retained build context failed trust validation");
    }
    log(
      "  Local BuildKit build skipped: staged build context failed trust validation; using the gateway builder instead.",
    );
    return { createArgs, imageRef: null, imageId: null };
  }

  const imageRef = sandboxLocalImageRef(input.sandboxName, input.buildId);
  const dockerEnv = requiredBuilder
    ? (input.dockerEnv as Readonly<Record<string, string>>)
    : dockerBuildSubprocessEnv();
  const buildImage =
    input.buildImage ??
    ((args, options) =>
      new Promise<number | null>((resolve, reject) => {
        const child = dockerSpawn(args, { ...options, shell: false });
        child.once("error", reject);
        child.once("close", resolve);
      }));
  const builder = requiredBuilder ?? "buildkit";
  log(
    builder === "legacy"
      ? "  Building sandbox image with Docker's legacy builder (matches rebuild preflight)..."
      : "  Building sandbox image with BuildKit (skips the slower in-gateway builder)...",
  );

  let status: number | null;
  try {
    status = await buildImage(
      ["build", "-t", imageRef, "-f", trustedContext.dockerfile, trustedContext.buildCtx],
      {
        cwd: ROOT,
        env: {
          ...dockerEnv,
          DOCKER_BUILDKIT: builder === "legacy" ? "0" : "1",
        },
        stdio: "inherit",
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (requiredBuilder) {
      failPreparedBuild(`the verified ${builder} builder could not start (${detail})`);
    }
    log(`  Local BuildKit build could not start (${detail}); using the gateway builder instead.`);
    return { createArgs, imageRef: null, imageId: null };
  }

  if (status !== 0) {
    const detail = status === null ? " without an exit status" : ` (exit ${status})`;
    if (requiredBuilder) {
      failPreparedBuild(`the verified ${builder} builder failed${detail}`);
    }
    log(`  Local BuildKit build failed${detail}; using the gateway builder instead.`);
    return { createArgs, imageRef: null, imageId: null };
  }

  createArgs[fromIndex + 1] = imageRef;
  const inspectImageId =
    input.inspectImageId ??
    ((ref: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      const inspected = dockerSpawnSync(["image", "inspect", "--format", "{{.Id}}", ref], {
        ...options,
        encoding: "utf8",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return inspected.status === 0 && !inspected.error
        ? String(inspected.stdout ?? "").trim()
        : "";
    });
  let imageId: string | null = null;
  try {
    const inspected = inspectImageId(imageRef, { cwd: ROOT, env: dockerEnv }).trim();
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
