// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-build the sandbox image locally with BuildKit, then hand the resulting
 * image reference to `openshell sandbox create --from <ref>` so openshell skips
 * its own build.
 *
 * Why: openshell builds the sandbox image with the **classic** Docker builder,
 * which commits one image layer per instruction. The sandbox Dockerfile has ~100
 * instructions, so on a cold host the build is dominated by per-layer commit
 * overhead — measured at ~6m30s classic vs ~2m20s BuildKit for the identical
 * image (a 2.8× reduction that brings the build under the #6002 3-minute
 * budget). openshell exposes no way to enable BuildKit, but it *does* accept a
 * pre-existing image reference for `--from`, and NemoClaw already force-enables
 * BuildKit in its `dockerBuild` helper.
 *
 * Scope + safety:
 *   - Only runs on the Docker-driver path, where the gateway shares the local
 *     Docker daemon and can therefore see a locally-built (registry-less) image.
 *     On k3s / remote gateways a local image is not visible, so we keep the
 *     existing openshell build.
 *   - If the local build is ineligible or fails for any reason, we return the
 *     original create args unchanged so onboarding falls back to today's
 *     behavior — a slow build, never a broken one.
 *   - Opt out entirely with `NEMOCLAW_SANDBOX_PREBUILD=0`; force on with `=1`.
 */

import { streamSandboxCreate } from "../sandbox/create-stream";
import { buildSubprocessEnv } from "../subprocess-env";
import { addTraceEvent } from "./tracing";

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_FLAG_VALUES = new Set(["0", "false", "no", "off"]);

const FROM_FLAG = "--from";
const LOCAL_IMAGE_REPO = "nemoclaw-sandbox-local";

export interface StreamBuildResult {
  status: number;
  output: string;
}

export interface SandboxPrebuildInput {
  /** Staged build-context directory (contains the patched `Dockerfile`). */
  buildCtx: string;
  /** Create args as produced for `openshell sandbox create` (includes `--from <buildCtx>/Dockerfile`). */
  createArgs: readonly string[];
  sandboxName: string;
  /** True when the Docker-driver gateway (local daemon) is in use. */
  dockerDriverGateway: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Runs a shell build command and streams its progress; returns the exit
   * status + output. Defaults to streaming through `streamSandboxCreate` (so
   * the build gets the same progress/heartbeat handling as the create).
   * Injectable for tests.
   */
  streamBuild?: (command: string) => Promise<StreamBuildResult>;
  log?: (message: string) => void;
}

function defaultStreamBuild(command: string): Promise<StreamBuildResult> {
  // Run the build under the sanitized subprocess allowlist (PATH/HOME/DOCKER_HOST
  // etc.) rather than raw process.env, so host secrets (e.g. NVIDIA_API_KEY)
  // never enter the build subprocess. Then drop the host-infrastructure
  // credentials the openshell create also strips (KUBECONFIG, SSH_AUTH_SOCK) —
  // a `docker build` needs neither. DOCKER_BUILDKIT is set inline in the
  // command, so BuildKit is still used.
  const env = buildSubprocessEnv();
  delete env.KUBECONFIG;
  delete env.SSH_AUTH_SOCK;
  return streamSandboxCreate(command, env, {
    initialPhase: "build",
    traceEvent: addTraceEvent,
  });
}

export interface SandboxPrebuildResult {
  /** Create args, rewritten to `--from <image-ref>` when the local build succeeded. */
  createArgs: string[];
  /** The locally-built image ref, or null when the openshell build path is used. */
  imageRef: string | null;
}

export function resolveSandboxPrebuildEnabled(
  env: NodeJS.ProcessEnv,
  dockerDriverGateway: boolean,
): boolean {
  const override = String(env.NEMOCLAW_SANDBOX_PREBUILD ?? "")
    .trim()
    .toLowerCase();
  if (TRUTHY_FLAG_VALUES.has(override)) return true;
  if (FALSY_FLAG_VALUES.has(override)) return false;
  // Inert under the Vitest runner (unless explicitly forced above): onboard
  // integration tests drive the real create flow and inspect the Dockerfile
  // through the `--from <ctx>/Dockerfile` create arg, which this optimization
  // rewrites to an image ref. Real CLI/E2E runs have no VITEST and get the
  // speedup; E2E can force it with NEMOCLAW_SANDBOX_PREBUILD=1.
  if (env.VITEST || env.NODE_ENV === "test") return false;
  return dockerDriverGateway;
}

/** Derive a stable, docker-valid local image tag keyed to the sandbox name. */
export function sandboxLocalImageRef(sandboxName: string): string {
  const tag =
    sandboxName
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "-")
      .replace(/^[-.]+/, "")
      .slice(0, 100) || "sandbox";
  return `${LOCAL_IMAGE_REPO}:${tag}`;
}

// Single-quote a value for safe interpolation into the `bash -lc` build command.
// The interpolated values here (the mkdtemp build-context dir and the
// name-derived image tag) are internal, not user-controlled, but they are
// quoted defensively so a path containing shell metacharacters can never break
// out of the command.
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildKitBuildCommand(buildCtx: string, imageRef: string): string {
  const dockerfile = `${buildCtx}/Dockerfile`;
  // DOCKER_BUILDKIT=1 is set inline so the build uses BuildKit regardless of the
  // daemon's default builder. `--progress=plain` keeps the streamed output
  // line-oriented so the create-stream progress parser can track build steps.
  return [
    "DOCKER_BUILDKIT=1",
    "docker",
    "build",
    "--progress=plain",
    "-t",
    shellSingleQuote(imageRef),
    "-f",
    shellSingleQuote(dockerfile),
    shellSingleQuote(buildCtx),
  ].join(" ");
}

/** Replace the `--from <buildCtx>/Dockerfile` value with the prebuilt image ref. */
export function rewriteCreateArgsWithImage(
  createArgs: readonly string[],
  buildCtx: string,
  imageRef: string,
): string[] {
  const dockerfilePath = `${buildCtx}/Dockerfile`;
  const next = [...createArgs];
  const flagIndex = next.indexOf(FROM_FLAG);
  if (flagIndex >= 0 && flagIndex + 1 < next.length && next[flagIndex + 1] === dockerfilePath) {
    next[flagIndex + 1] = imageRef;
  }
  return next;
}

export async function prebuildSandboxImageIfEligible(
  input: SandboxPrebuildInput,
): Promise<SandboxPrebuildResult> {
  const env = input.env ?? process.env;
  const log = input.log ?? ((message: string) => console.log(message));
  const streamBuild = input.streamBuild ?? defaultStreamBuild;
  const createArgs = [...input.createArgs];

  if (!resolveSandboxPrebuildEnabled(env, input.dockerDriverGateway)) {
    return { createArgs, imageRef: null };
  }

  const imageRef = sandboxLocalImageRef(input.sandboxName);
  log("  Building sandbox image with BuildKit (skips the slower in-gateway builder)...");

  let result: StreamBuildResult;
  try {
    result = await streamBuild(buildKitBuildCommand(input.buildCtx, imageRef));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`  Local BuildKit build could not start (${detail}); using the gateway builder instead.`);
    return { createArgs, imageRef: null };
  }

  if (result.status !== 0) {
    log(
      `  Local BuildKit build failed (exit ${result.status}); using the gateway builder instead.`,
    );
    return { createArgs, imageRef: null };
  }

  return {
    createArgs: rewriteCreateArgsWithImage(createArgs, input.buildCtx, imageRef),
    imageRef,
  };
}
