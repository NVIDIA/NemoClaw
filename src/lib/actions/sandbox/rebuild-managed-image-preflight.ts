// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dockerBuild, dockerRmi } from "../../adapters/docker";
import type { AgentDefinition } from "../../agent/defs";
import { createAgentSandbox } from "../../agent/onboard";
import {
  type PreparedSandboxBuildContext,
  stageCreateSandboxBuildContext,
} from "../../onboard/build-context-stage";
import { prepareSandboxDockerfilePatch } from "../../onboard/sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { ROOT, redact } from "../../runner";
import {
  formatBuildFailureDiagnostics,
  OPENCLAW_SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
} from "../../sandbox-base-image";
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";

export type ManagedDcodeRebuildImageInput = {
  agent: AgentDefinition;
  model: string;
  provider: string;
  preferredInferenceApi: string | null;
  sandboxGpuConfig: SandboxGpuConfig;
};

export type ManagedDcodeRebuildImageDeps = {
  stageBuildContext?: typeof stageCreateSandboxBuildContext;
  prepareDockerfilePatch?: typeof prepareSandboxDockerfilePatch;
  buildImage?: typeof dockerBuild;
  removeImage?: typeof dockerRmi;
  createImageTag?: () => string;
};

export type PreparedDcodeRebuildImage = PreparedSandboxBuildContext & {
  contextFingerprint: string;
  dockerGpuPatchNetwork: string | null;
};

export type ManagedDcodeRebuildImageResult =
  | { ok: true; prepared: PreparedDcodeRebuildImage }
  | { ok: false; detail: string };

function errorDetail(error: unknown): string {
  if (error === null || error === undefined) return "";
  return redact(error instanceof Error ? error.message : String(error)).trim();
}

function buildResultDetail(result: {
  error?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  status?: unknown;
}): string {
  const detail = [errorDetail(result.error), formatBuildFailureDiagnostics(result)]
    .filter(Boolean)
    .join("; ");
  return detail || `docker build exited with status ${String(result.status ?? "unknown")}`;
}

function defaultImageTag(): string {
  return `nemoclaw-rebuild-preflight:${String(process.pid)}-${crypto.randomUUID()}`;
}

function sameBuildContextEntry(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readStableBuildContextFile(absolutePath: string, expected: fs.Stats): Buffer {
  const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameBuildContextEntry(expected, opened)) {
      throw new Error("build-context file changed before fingerprinting");
    }
    const contents = fs.readFileSync(descriptor);
    if (
      !sameBuildContextEntry(opened, fs.fstatSync(descriptor)) ||
      !sameBuildContextEntry(opened, fs.lstatSync(absolutePath))
    ) {
      throw new Error("build-context file changed during fingerprinting");
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function fingerprintBuildContext(buildCtx: string): string {
  const hash = crypto.createHash("sha256");
  const visit = (relativePath: string): void => {
    const absolutePath = path.join(buildCtx, relativePath);
    const stat = fs.lstatSync(absolutePath);
    const kind = stat.isDirectory()
      ? "dir"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "link"
          : "other";
    hash.update(`${kind}\0${relativePath}\0${String(stat.mode & 0o777)}\0${String(stat.size)}\0`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(relativePath ? path.join(relativePath, name) : name);
      }
    } else if (stat.isFile()) {
      hash.update(readStableBuildContextFile(absolutePath, stat));
    } else if (stat.isSymbolicLink()) {
      hash.update(fs.readlinkSync(absolutePath));
    } else {
      throw new Error(`unsupported build-context entry: ${relativePath || "."}`);
    }
    hash.update("\0");
  };
  visit("");
  return hash.digest("hex");
}

/** Confirm that the retained, private build context still matches the prebuilt input. */
export function verifyPreparedDcodeRebuildImage(prepared: PreparedDcodeRebuildImage): boolean {
  try {
    return fingerprintBuildContext(prepared.buildCtx) === prepared.contextFingerprint;
  } catch {
    return false;
  }
}

function createIdempotentBuildContextCleanup(cleanup: () => boolean): () => boolean {
  let cleaned = false;
  const dispose = () => {
    if (cleaned) return true;
    const succeeded = cleanup();
    if (succeeded) {
      cleaned = true;
      process.removeListener("exit", dispose);
    }
    return succeeded;
  };
  process.on("exit", dispose);
  return dispose;
}

/** Dispose the retained context after onboard consumes it or rebuild aborts. */
export function disposePreparedDcodeRebuildImage(prepared: PreparedDcodeRebuildImage): boolean {
  return prepared.cleanupBuildCtx();
}

/**
 * Stage, patch, and successfully build the managed DCode replacement inputs
 * while the current sandbox is still intact. OpenShell performs the final build,
 * so the pinned base and fingerprinted context are retained and revalidated.
 */
export async function prepareManagedDcodeRebuildImage(
  input: ManagedDcodeRebuildImageInput,
  deps: ManagedDcodeRebuildImageDeps = {},
): Promise<ManagedDcodeRebuildImageResult> {
  if (input.agent.name !== DCODE_AGENT_NAME) {
    return { ok: false, detail: `managed DCode image expected agent '${DCODE_AGENT_NAME}'` };
  }

  const stage = deps.stageBuildContext ?? stageCreateSandboxBuildContext;
  const preparePatch = deps.prepareDockerfilePatch ?? prepareSandboxDockerfilePatch;
  const buildImage = deps.buildImage ?? dockerBuild;
  const removeImage = deps.removeImage ?? dockerRmi;
  const imageTag = (deps.createImageTag ?? defaultImageTag)();
  const previousDockerGpuPatchNetwork = process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
  let cleanupBuildContext: (() => boolean) | null = null;
  let imageBuilt = false;
  let retainBuildContext = false;

  try {
    // Recompute the patch decision from the recorded target rather than a
    // caller's unrelated ambient rebuild environment.
    delete process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;

    const staged = stage({
      root: ROOT,
      fromDockerfile: null,
      agent: input.agent,
      createAgentSandbox,
      log: () => {},
      warn: () => {},
      error: () => {},
      exit: (code): never => {
        throw new Error(`managed build-context staging exited with code ${String(code ?? 1)}`);
      },
    });
    cleanupBuildContext = createIdempotentBuildContextCleanup(staged.cleanupBuildCtx);

    const { buildId } = await preparePatch({
      agent: input.agent,
      fromDockerfile: null,
      sandboxBaseImage: OPENCLAW_SANDBOX_BASE_IMAGE,
      sandboxBaseTag: SANDBOX_BASE_TAG,
      stagedDockerfile: staged.stagedDockerfile,
      model: input.model,
      chatUiUrl: "",
      provider: input.provider,
      preferredInferenceApi: input.preferredInferenceApi,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig: input.sandboxGpuConfig,
      log: () => {},
      warn: () => {},
    });

    const contextFingerprint = fingerprintBuildContext(staged.buildCtx);
    const result = buildImage(staged.stagedDockerfile, imageTag, staged.buildCtx, {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) return { ok: false, detail: buildResultDetail(result) };
    imageBuilt = true;
    if (fingerprintBuildContext(staged.buildCtx) !== contextFingerprint) {
      return { ok: false, detail: "managed DCode build context changed during preflight" };
    }

    retainBuildContext = true;
    return {
      ok: true,
      prepared: {
        ...staged,
        cleanupBuildCtx: cleanupBuildContext,
        buildId,
        contextFingerprint,
        dockerGpuPatchNetwork: process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK || null,
      },
    };
  } catch (error) {
    return { ok: false, detail: errorDetail(error) || "managed DCode image preflight failed" };
  } finally {
    let imageRemoved = false;
    try {
      imageRemoved =
        removeImage(imageTag, { ignoreError: true, suppressOutput: true }).status === 0;
    } catch {
      // Best effort; build-context and environment cleanup must still run.
    }
    if (imageBuilt && !imageRemoved) {
      console.warn(`  Warning: failed to remove temporary DCode preflight image '${imageTag}'.`);
      process.once("exit", () => {
        try {
          removeImage(imageTag, { ignoreError: true, suppressOutput: true });
        } catch {
          // Best effort process-exit retry.
        }
      });
    }
    if (!retainBuildContext && cleanupBuildContext) {
      try {
        cleanupBuildContext();
      } catch {
        // Preserve the original preflight error.
      }
    }
    if (previousDockerGpuPatchNetwork === undefined) {
      delete process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
    } else {
      process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK = previousDockerGpuPatchNetwork;
    }
  }
}
