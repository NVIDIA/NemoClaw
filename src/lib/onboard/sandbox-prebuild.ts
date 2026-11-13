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
import { localPodmanEnvironment } from "../adapters/podman";
import { isSupportedGatewayDockerHost } from "../domain/docker-host";
import { LOCAL_SANDBOX_IMAGE_REPO } from "../domain/sandbox/image-tag";
import {
  SANDBOX_BUILD_CONTEXT_PREFIX,
  type SandboxBuildContextOrigin,
} from "../sandbox/build-context";
import { isPortableExperimentalProfile, PORTABLE_LOCAL_REGISTRY } from "./docker-driver-platform";
import { isImmutableDockerImageId } from "./openshell-docker-sandbox-containers";
import type { RuntimeProviderCommandCapture } from "./runtime-provider/contract";

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_FLAG_VALUES = new Set(["0", "false", "no", "off"]);
const LOCAL_IMAGE_BUILD_TIMEOUT_MS = 20 * 60_000;

class ImageCommandDeadlineError extends Error {}
class ImageBuildFailureError extends Error {
  constructor(
    readonly status: number | null,
    readonly guidance: string,
  ) {
    super("Local image build failed");
  }
}

/** Classify untrusted build output without echoing Dockerfile commands or credential values. */
export function classifyImageBuildFailure(output: string): string {
  const diagnostic = output.slice(-8_192).toLowerCase();
  if (
    /failed to resolve source metadata|pull access denied|manifest unknown|unauthorized/.test(
      diagnostic,
    )
  ) {
    return "Check the base image reference and registry access before retrying.";
  }
  if (
    /failed to calculate checksum|not found in build context|no such file or directory/.test(
      diagnostic,
    )
  ) {
    return "Check COPY sources and the permitted build context before retrying.";
  }
  if (/no space left on device/.test(diagnostic)) {
    return "Free space in the selected engine's image store before retrying.";
  }
  return "Check the Dockerfile instructions and selected engine before retrying.";
}

// Same ID forms as the audit's ADVISORY_ID in scripts/lib/reviewed-npm-audit.mts.
const NPM_AUDIT_ID = String.raw`(?:GHSA(?:-[0-9a-z]{4}){3}|CVE-\d{4}-\d+|NPM-\d+)`;
const NPM_AUDIT_BLOCK = new RegExp(
  `([a-z0-9][a-z0-9-]{0,63}): unaccepted npm audit findings at or above (?:info|low|moderate|high|critical): (${NPM_AUDIT_ID}(?:, ${NPM_AUDIT_ID})*)`,
);

/** Name only the blocked graph and validated advisory IDs; the rest of the line is untrusted. */
function npmAuditBlockGuidance(line: string): string | null {
  const match = NPM_AUDIT_BLOCK.exec(line);
  return match
    ? `The ${match[1]} npm audit blocked ${match[2]}; update the affected dependencies before retrying.`
    : null;
}

function throwImageBuildCommandError(error: unknown, builderName: string): never {
  if (error instanceof ImageCommandDeadlineError) {
    throw new Error(
      `Local ${builderName} build timed out after 20 minutes; check the selected engine before retrying.`,
    );
  }
  if (error instanceof ImageBuildFailureError) {
    const detail = error.status === null ? " without an exit status" : ` (exit ${error.status})`;
    throw new Error(`Local ${builderName} build failed${detail}; ${error.guidance}`);
  }
  throw new Error(
    `Local ${builderName} build could not start; check the selected engine and retry.`,
    { cause: error },
  );
}

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
  /** Receipt-owned Hermes context and Podman authority under its lifecycle lock. */
  portableReceipt?: {
    readonly transactionId: string;
    readonly context: {
      readonly buildContextPath: string;
      readonly dockerfilePath: string;
      assertCurrent(): void;
    };
    readonly podman: (
      args: readonly string[],
      timeoutMs: number,
    ) => { readonly status: number | null; readonly stdout: string; readonly error?: Error };
    readonly imageAvailable: (reference: string) => Promise<boolean>;
  };
  /** Provider-bound native Podman operation using the selected gateway socket and executable. */
  nativePodmanCapture?: (
    args: readonly string[],
    timeoutMs: number,
  ) => RuntimeProviderCommandCapture;
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
        // Dockerfile commands can print arbitrary credentials. Capture only for
        // fixed-category guidance; never pass raw output to user diagnostics.
        stdio: ["ignore", "ignore", "pipe"],
        shell: false,
      };
      const child =
        command === "podman"
          ? spawn(command, [...args], spawnOptions)
          : dockerSpawn(args, spawnOptions);
      let diagnosticTail = "";
      // BuildKit echoes the failing RUN instruction after its output, which can
      // push an npm audit block out of the tail; scan each line as it arrives.
      let pendingLine = "";
      let auditGuidance: string | null = null;
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        diagnosticTail = (diagnosticTail + text).slice(-8_192);
        const lines = (pendingLine + text).split("\n");
        pendingLine = (lines.pop() ?? "").slice(-4_096);
        for (const line of lines) auditGuidance = npmAuditBlockGuidance(line) ?? auditGuidance;
      });
      let expired = false;
      const deadline = setTimeout(() => {
        expired = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // A failed signal still ends this build attempt without handing off an image.
        }
        reject(new ImageCommandDeadlineError());
      }, LOCAL_IMAGE_BUILD_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(deadline);
        if (!expired) reject(error);
      });
      child.once("close", (status) => {
        clearTimeout(deadline);
        if (!expired) {
          if (status !== 0)
            reject(
              new ImageBuildFailureError(
                status,
                auditGuidance ??
                  npmAuditBlockGuidance(pendingLine) ??
                  classifyImageBuildFailure(diagnosticTail),
              ),
            );
          else resolve(status);
        }
      });
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
 * Build a staged Dockerfile context with the selected local container
 * runtime. Docker uses BuildKit; native Podman and the portable profile use
 * rootless Podman. Built images must be present in the selected engine
 * before OpenShell receives their image reference.
 * Ordinary portable builds require HTTP 200 from the managed IPv4 registry
 * before building. The receipt-owned Hermes path proves registry visibility
 * after publication under its existing lifecycle lock.
 * @throws When the portable registry is unavailable or a required build fails.
 * @returns The built image identity and source reference for sandbox creation.
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
  const portable = Boolean(input.portableReceipt) || isPortableExperimentalProfile(env);
  const source = input.origin === "custom" ? "Custom" : "Generated";
  if (!input.dockerDriverGateway) {
    throw new Error(
      `${source} Dockerfile onboarding requires a local Docker or Podman gateway; no image distribution path is configured for this gateway.`,
    );
  }
  const selectedEngine = portable || input.gatewayDriver === "podman" ? "podman" : "docker";
  if (input.gatewayDriver !== undefined && input.gatewayDriver !== selectedEngine) {
    throw new Error(
      `${source} Dockerfile build requires the selected ${input.gatewayDriver} gateway engine; refusing a ${selectedEngine} build.`,
    );
  }
  if (input.origin === "custom" && selectedEngine === "podman") {
    // Native Podman's workload profile has legacyDockerfileBuilds: false.
    // Source resolution rejects custom Dockerfiles before this helper; keep
    // direct calls fail closed under that existing admission rule (#7744).
    throw new Error("Custom Dockerfile onboarding is unavailable with native Podman.");
  }
  if (selectedEngine === "podman" && !portable && !input.nativePodmanCapture) {
    throw new Error(
      `${source} Dockerfile build requires the selected Podman gateway image-build authority.`,
    );
  }
  const dockerHost = String(env.DOCKER_HOST ?? "").trim();
  const dockerContext = String(env.DOCKER_CONTEXT ?? "").trim();
  if (selectedEngine === "docker" && dockerHost && !isSupportedGatewayDockerHost(env.DOCKER_HOST)) {
    throw new Error(
      `${source} Dockerfile build requires a supported local Docker host; unset DOCKER_HOST or use an absolute local unix:// socket and retry.`,
    );
  }
  if (selectedEngine === "docker" && !dockerHost && dockerContext && dockerContext !== "default") {
    throw new Error(
      `${source} Dockerfile build cannot prove that the selected Docker context shares the local gateway engine.`,
    );
  }
  if (!resolveSandboxPrebuildEnabled(env, input.dockerDriverGateway)) {
    throw new Error(
      `${source} Dockerfile image build is required before sandbox creation; enable local prebuild.`,
    );
  }
  const fromDockerfile = initialSourceReference;
  if (
    !fromDockerfile ||
    path.resolve(fromDockerfile) !== path.resolve(input.buildCtx, "Dockerfile")
  ) {
    throw new Error(`${source} image build requires the selected staged Dockerfile.`);
  }
  let trustedContext: TrustedStagedBuildContext | null;
  try {
    if (input.portableReceipt) {
      const receipt = input.portableReceipt;
      if (!/^[a-f0-9-]{36}$/u.test(receipt.transactionId)) {
        throw new Error("Portable image build requires the current transaction identity.");
      }
      receipt.context.assertCurrent();
      if (
        path.resolve(input.buildCtx) !== path.resolve(receipt.context.buildContextPath) ||
        path.resolve(fromDockerfile) !== path.resolve(receipt.context.dockerfilePath)
      ) {
        throw new Error("Portable image build context changed before the selected build.");
      }
      trustedContext = {
        buildCtx: receipt.context.buildContextPath,
        dockerfile: receipt.context.dockerfilePath,
      };
    } else {
      trustedContext = resolveTrustedStagedBuildContext(input.buildCtx);
    }
  } catch (error) {
    throw new Error(
      `${source} image build could not inspect the staged context; sandbox creation stopped.`,
      { cause: error },
    );
  }
  if (!trustedContext) {
    throw new Error(`${source} image build rejected the staged context trust boundary.`);
  }

  const imageRef = input.portableReceipt
    ? `${PORTABLE_LOCAL_REGISTRY}/${LOCAL_SANDBOX_IMAGE_REPO}:${input.portableReceipt.transactionId}`
    : sandboxLocalImageRef(input.sandboxName, input.buildId, env);
  if (portable && !input.portableReceipt) {
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
  const builderName = selectedEngine === "podman" ? "rootless Podman" : "BuildKit";
  const buildImage = input.portableReceipt
    ? async (args: readonly string[]) => {
        const outcome = input.portableReceipt!.podman(
          ["build", "--quiet", ...args.slice(1)],
          LOCAL_IMAGE_BUILD_TIMEOUT_MS,
        );
        return outcome.error ? null : outcome.status;
      }
    : selectedEngine === "podman" && !portable
      ? async (args: readonly string[]) => {
          const outcome = input.nativePodmanCapture!(
            ["build", "--quiet", ...args.slice(1)],
            LOCAL_IMAGE_BUILD_TIMEOUT_MS,
          );
          if ((outcome.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
            throw new ImageCommandDeadlineError();
          }
          if (outcome.error) throw outcome.error;
          return outcome.status;
        }
      : (input.buildImage ?? createHostImageCommand(selectedEngine));
  log(`  Building sandbox image with ${builderName}...`);

  let status: number | null;
  let preparedDockerEnvironment: PreparedDockerBuildEnvironment | null = null;
  try {
    preparedDockerEnvironment =
      selectedEngine === "podman"
        ? null
        : prepareDockerBuildEnvironment({
            env,
            allowCredentialIsolation: input.origin !== "custom",
            credentialHelperResponds: input.credentialHelperResponds,
            dockerContextIsDefault: input.dockerContextIsDefault,
            isWslHost: input.isWslHost,
          });
    const buildEnv =
      preparedDockerEnvironment?.env ?? localPodmanEnvironment(dockerBuildSubprocessEnv(env));
    if (preparedDockerEnvironment?.isolatedCredentialConfig) {
      log(
        `  Docker Desktop credential helper is unavailable in this WSL session; using an isolated credential-free config for the ${source.toLowerCase()} sandbox image build.`,
      );
    }
    input.portableReceipt?.context.assertCurrent();
    status = await buildImage(
      ["build", "-t", imageRef, "-f", trustedContext.dockerfile, trustedContext.buildCtx],
      {
        env: buildEnv,
        stdio: "inherit",
      },
    );
  } catch (error) {
    throwImageBuildCommandError(error, builderName);
  } finally {
    if (preparedDockerEnvironment) {
      warnIfDockerBuildEnvironmentCleanupFailed(
        preparedDockerEnvironment.cleanup(),
        `${source.toLowerCase()} sandbox image '${imageRef}'`,
      );
    }
  }

  if (status !== 0) {
    const detail = status === null ? " without an exit status" : ` (exit ${status})`;
    throw new Error(
      input.portableReceipt
        ? `Podman image build failed${detail}; check the generated Dockerfile and selected engine before retrying.`
        : `Local ${builderName} build failed${detail}; check the Dockerfile and selected engine before retrying.`,
    );
  }
  input.portableReceipt?.context.assertCurrent();

  const inspectImageId =
    selectedEngine === "podman" && !portable
      ? (ref: string) => {
          const inspection = input.nativePodmanCapture!(
            ["image", "inspect", "--format", "{{.Id}}", ref],
            5_000,
          );
          return inspection.status === 0 && !inspection.error ? inspection.stdout.trim() : "";
        }
      : (input.inspectImageId ??
        ((ref: string) => {
          if (input.portableReceipt) {
            const inspection = input.portableReceipt.podman(
              ["image", "inspect", "--format", "{{.Id}}", ref],
              5_000,
            );
            return inspection.status === 0 ? inspection.stdout.trim() : "";
          }
          if (selectedEngine === "docker")
            return dockerImageInspectFormat("{{.Id}}", ref, {
              env: dockerBuildSubprocessEnv(env),
              replaceEnv: true,
              ignoreError: true,
            }).trim();
          const inspection = spawnSync("podman", ["image", "inspect", "--format", "{{.Id}}", ref], {
            env: localPodmanEnvironment(dockerBuildSubprocessEnv(env)),
            encoding: "utf8",
            timeout: 5_000,
            maxBuffer: 4096,
            stdio: ["ignore", "pipe", "ignore"],
          });
          return inspection.status === 0 ? inspection.stdout.trim() : "";
        }));
  let imageId: string | null;
  try {
    const inspected = inspectImageId(imageRef).trim();
    const normalized =
      selectedEngine === "podman" && /^[0-9a-f]{64}$/i.test(inspected)
        ? `sha256:${inspected}`
        : inspected;
    imageId = isImmutableDockerImageId(normalized) ? normalized.toLowerCase() : null;
  } catch {
    imageId = null;
  }
  if (!imageId) {
    throw new Error(
      input.portableReceipt
        ? "Built image is unavailable in the selected Podman store; sandbox creation stopped."
        : `Built image ${imageRef} is not visible in the selected ${selectedEngine} engine; sandbox creation stopped.`,
    );
  }
  log(`  ${builderName} build completed for ${imageRef}.`);

  if (portable) {
    const publishImage =
      input.publishImage ??
      (input.portableReceipt
        ? async (args: readonly string[]) => {
            const outcome = input.portableReceipt!.podman(
              ["push", "--quiet", ...args.slice(1)],
              5 * 60_000,
            );
            return outcome.error ? null : outcome.status;
          }
        : buildImage);
    log("  Publishing sandbox image to the managed local registry...");
    let publishStatus: number | null;
    const credentialFreeDockerConfig = createCredentialFreeDockerConfig("portable");
    try {
      publishStatus = await publishImage(["push", imageRef], {
        env: {
          ...localPodmanEnvironment(dockerBuildSubprocessEnv(env)),
          DOCKER_CONFIG: credentialFreeDockerConfig,
          REGISTRY_AUTH_FILE: path.join(credentialFreeDockerConfig, "config.json"),
        },
        stdio: "inherit",
      });
    } catch (error) {
      if (error instanceof ImageCommandDeadlineError) {
        throw new Error(
          "Managed local registry publish timed out after 20 minutes; check the local registry before retrying.",
        );
      }
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
      throw new Error(
        input.portableReceipt
          ? `Podman image publication to the managed local registry failed${detail}; sandbox creation stopped.`
          : `Managed local registry publish failed${detail}`,
      );
    }
    if (input.portableReceipt && !(await input.portableReceipt.imageAvailable(imageRef))) {
      throw new Error(
        "Built image is not visible in the managed local registry; sandbox creation stopped.",
      );
    }
  }
  input.portableReceipt?.context.assertCurrent();

  if (fromIndex >= 0) createArgs[fromIndex + 1] = imageRef;
  return result(imageRef, imageRef, imageId);
}
