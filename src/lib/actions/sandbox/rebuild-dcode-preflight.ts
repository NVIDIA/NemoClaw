// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { dockerBuild, dockerImageInspectFormat, dockerRmi } from "../../adapters/docker";
import { loadAgent } from "../../agent/defs";
import { RD as _RD, R } from "../../cli/terminal-style";
import { recoverNamedGatewayRuntime } from "../../gateway-runtime-action";
import * as nim from "../../inference/nim";
import type { WebSearchConfig } from "../../inference/web-search";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import {
  getResumeSandboxGpuOverrides,
  resolveSandboxGpuConfig,
} from "../../onboard/sandbox-gpu-mode";
import { ROOT } from "../../runner";
import { redact } from "../../security/redact";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import * as sandboxState from "../../state/sandbox";
import type { ToolDisclosure } from "../../tool-disclosure";
import {
  DCODE_AGENT_NAME,
  type ResolvedDcodeRebuildTarget,
  resolveDcodeRebuildTarget,
} from "./rebuild-dcode-target";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { preflightRebuildInferenceRoute } from "./rebuild-inference-preflight";
import {
  disposePreparedDcodeRebuildImage,
  type PreparedDcodeRebuildImage,
  prepareManagedDcodeRebuildImage,
  verifyPreparedDcodeRebuildImage,
} from "./rebuild-managed-image-preflight";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

export type DcodeRebuildPreflightBail = (message: string, code?: number) => never;

type PinnedDcodeBaseImage = {
  readonly imageRef: string;
  dispose(): boolean;
  verify(): boolean;
};

export type PreparedDcodeReplacement = {
  readonly buildContext: PreparedDcodeRebuildImage;
  readonly gatewayName: string;
  readonly toolDisclosure: ToolDisclosure;
  readonly dcodeAutoApprovalMode: DcodeAutoApprovalMode;
  dispose(): boolean;
  verify(): boolean;
};

export type DcodeReplacementPreflightInput = {
  sandboxName: string;
  entry: RebuildSandboxEntry;
  resumeConfig: RebuildResumeConfig;
  toolDisclosure: ToolDisclosure;
  dcodeAutoApprovalMode: DcodeAutoApprovalMode;
  skipLiveRoute: boolean;
  /** Authoritative persisted gateway port carried by the rebuild target. */
  gatewayPort?: number;
  log(message: string): void;
  bail: DcodeRebuildPreflightBail;
  checkGatewaySchema(): boolean;
};

export type DcodeReplacementPreparationInput = DcodeReplacementPreflightInput & {
  webSearchConfig: WebSearchConfig | null;
};

export type DcodeRebuildPreflightScope = {
  readonly enabled: boolean;
  readonly bail: DcodeRebuildPreflightBail;
  readonly preparedBuildContext: PreparedDcodeRebuildImage | null;
  readonly preparedReplacement: PreparedDcodeReplacement | null;
  adopt(prepared: PreparedDcodeReplacement): void;
  cleanup(): void;
  applyDockerGpuPatchNetwork(): () => void;
};

/** Own process-local DCode preflight state until the rebuild transaction ends. */
export function createDcodeRebuildPreflightScope(
  enabled: boolean,
  bail: DcodeRebuildPreflightBail,
  env: NodeJS.ProcessEnv = process.env,
): DcodeRebuildPreflightScope {
  const previousOpenshellGateway = env.OPENSHELL_GATEWAY;
  let preparedReplacement: PreparedDcodeReplacement | null = null;
  let gatewayRestored = false;
  let cleaned = false;
  const cleanup = () => {
    if (!enabled || cleaned) return;
    let disposed = true;
    try {
      if (preparedReplacement) disposed = preparedReplacement.dispose();
      if (!disposed) {
        console.warn("  Warning: temporary DCode rebuild inputs could not be fully removed.");
      }
    } finally {
      if (!gatewayRestored) {
        gatewayRestored = true;
        if (previousOpenshellGateway === undefined) delete env.OPENSHELL_GATEWAY;
        else env.OPENSHELL_GATEWAY = previousOpenshellGateway;
      }
      cleaned = disposed;
    }
  };

  return {
    enabled,
    bail: enabled
      ? (message, code) => {
          cleanup();
          return bail(message, code);
        }
      : bail,
    get preparedBuildContext() {
      return preparedReplacement?.buildContext ?? null;
    },
    get preparedReplacement() {
      return preparedReplacement;
    },
    adopt(prepared) {
      preparedReplacement = prepared;
    },
    cleanup,
    applyDockerGpuPatchNetwork() {
      const preparedBuildContext = preparedReplacement?.buildContext;
      if (!preparedBuildContext) return () => undefined;
      const previous = env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
      if (preparedBuildContext.dockerGpuPatchNetwork) {
        env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK = preparedBuildContext.dockerGpuPatchNetwork;
      } else {
        delete env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
      }
      return () => {
        if (previous === undefined) delete env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
        else env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK = previous;
      };
    },
  };
}

function fail(detail: string, bail: DcodeRebuildPreflightBail, failure = detail): never {
  console.error("");
  console.error(`  ${_RD}Rebuild preflight failed:${R} ${redact(detail)}`);
  console.error("  Sandbox is untouched — no data was lost.");
  return bail(redact(failure));
}

/** Select and health-check the gateway recorded for this DCode sandbox. */
export async function ensureDcodeRebuildTargetGatewaySelected(
  sandboxName: string,
  entry: RebuildSandboxEntry,
  log: (message: string) => void,
  bail: DcodeRebuildPreflightBail,
): Promise<boolean> {
  let gatewayName: string;
  try {
    gatewayName = resolveSandboxGatewayName(entry);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), bail);
  }

  const recovery = await recoverNamedGatewayRuntime({
    gatewayName,
    recoverableStates: ["missing_named", "named_unhealthy", "named_unreachable", "connected_other"],
  });
  const beforeState = recovery.before?.state ?? "unknown";
  const afterState = recovery.after?.state ?? "unknown";
  if (!recovery.recovered || afterState !== "healthy_named") {
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} could not select the target gateway '${gatewayName}'.`,
    );
    console.error(`  Gateway state before: ${beforeState}; after: ${afterState}.`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(`Could not select healthy gateway '${gatewayName}' for sandbox '${sandboxName}'`);
    return false;
  }
  process.env.OPENSHELL_GATEWAY = gatewayName;
  log(`Pinned rebuild subprocesses to target gateway '${gatewayName}'`);
  return true;
}

function resolveTarget(
  entry: RebuildSandboxEntry,
  resumeConfig: RebuildResumeConfig,
  bail: DcodeRebuildPreflightBail,
  gatewayPort?: number,
): ResolvedDcodeRebuildTarget {
  try {
    return resolveDcodeRebuildTarget(entry, resumeConfig, gatewayPort);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), bail);
  }
}

function requireInferenceRoute(
  sandboxName: string,
  target: ResolvedDcodeRebuildTarget,
  bail: DcodeRebuildPreflightBail,
): void {
  const result = preflightRebuildInferenceRoute({ sandboxName, ...target });
  if (!result.ok) {
    fail(
      `recorded inference credentials or route were rejected: ${result.detail}`,
      bail,
      "Recorded inference route smoke check failed",
    );
  }
}

function loadMatchingDcodeSession(
  sandboxName: string,
): ReturnType<typeof onboardSession.loadSession> {
  const session = onboardSession.loadSession();
  return session?.sandboxName === sandboxName ? session : null;
}

function requireCurrentTarget(
  sandboxName: string,
  entry: RebuildSandboxEntry,
  target: ResolvedDcodeRebuildTarget,
  resumeConfig: RebuildResumeConfig,
  bail: DcodeRebuildPreflightBail,
  gatewayPort?: number,
): void {
  const currentEntry = registry.getSandbox(sandboxName) as RebuildSandboxEntry | null;
  if (!currentEntry || !isDeepStrictEqual(currentEntry, entry)) {
    fail("the recorded sandbox target changed during preflight", bail);
  }
  const currentTarget = resolveTarget(currentEntry, resumeConfig, bail, gatewayPort);
  if (!isDeepStrictEqual(currentTarget, target)) {
    fail("the resolved DCode target changed during preflight", bail);
  }
}

function getRecordedGpuConfig(
  sandboxName: string,
  entry: RebuildSandboxEntry,
  session: ReturnType<typeof onboardSession.loadSession>,
) {
  const overrides = getResumeSandboxGpuOverrides(
    entry,
    session?.sandboxName === sandboxName ? session.gpuPassthrough : undefined,
  );
  return resolveSandboxGpuConfig(nim.detectGpu(), {
    flag: overrides.flag,
    device: overrides.device,
    env: {},
  });
}

function inspectLocalImageId(imageRef: string): string {
  try {
    return dockerImageInspectFormat("{{.Id}}", imageRef, {
      ignoreError: true,
    }).trim();
  } catch {
    return "";
  }
}

function buildPinnedDcodeBaseImage(bail: DcodeRebuildPreflightBail): PinnedDcodeBaseImage {
  const agent = loadAgent(DCODE_AGENT_NAME);
  if (!agent.dockerfileBasePath) {
    fail("DCode is missing its sandbox base Dockerfile", bail);
  }
  const imageRef = `nemoclaw-dcode-rebuild-base:${String(process.pid)}-${crypto.randomUUID()}`;
  const result = dockerBuild(agent.dockerfileBasePath, imageRef, ROOT, {
    ignoreError: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error || result.status !== 0) {
    try {
      dockerRmi(imageRef, { ignoreError: true, suppressOutput: true });
    } catch {
      // The build failure is the actionable error.
    }
    const detail = result.error
      ? `: ${result.error.message}`
      : ` (exit ${String(result.status ?? "unknown")})`;
    fail(`DCode base image could not be built${detail}`, bail);
  }
  const imageId = inspectLocalImageId(imageRef);
  if (!imageId) {
    try {
      dockerRmi(imageRef, { ignoreError: true, suppressOutput: true });
    } catch {
      // The identity failure is the actionable error.
    }
    fail("DCode base image identity could not be verified", bail);
  }

  let removed = false;
  let warned = false;
  const dispose = (): boolean => {
    if (removed) return true;
    try {
      const removal = dockerRmi(imageRef, { ignoreError: true, suppressOutput: true });
      if (removal.status === 0) {
        removed = true;
        process.removeListener("exit", dispose);
        return true;
      }
    } catch {
      // Report the same safe warning below.
    }
    if (!warned) {
      warned = true;
      console.warn(`  Warning: failed to remove temporary DCode base image '${imageRef}'.`);
    }
    return false;
  };
  process.on("exit", dispose);
  return {
    imageRef,
    dispose,
    verify: () => inspectLocalImageId(imageRef) === imageId,
  };
}

async function withPinnedBaseImage<T>(
  pinned: PinnedDcodeBaseImage,
  action: () => Promise<T>,
): Promise<T> {
  const envName = "NEMOCLAW_LANGCHAIN_DEEPAGENTS_CODE_SANDBOX_BASE_IMAGE_REF";
  const hadPrevious = Object.hasOwn(process.env, envName);
  const previous = process.env[envName];
  process.env[envName] = pinned.imageRef;
  try {
    return await action();
  } finally {
    if (hadPrevious && previous !== undefined) process.env[envName] = previous;
    else delete process.env[envName];
  }
}

function disposePreparation(
  buildContext: PreparedDcodeRebuildImage | null,
  pinnedBase: PinnedDcodeBaseImage | null,
): boolean {
  let contextDisposed = true;
  let baseDisposed = true;
  if (buildContext) contextDisposed = disposePreparedDcodeRebuildImage(buildContext);
  if (pinnedBase) baseDisposed = pinnedBase.dispose();
  return contextDisposed && baseDisposed;
}

/** Prebuild and revalidate the managed DCode replacement inputs before mutation. */
export async function prepareDcodeReplacementBeforeMutation(
  input: DcodeReplacementPreparationInput,
): Promise<PreparedDcodeReplacement | null> {
  const {
    sandboxName,
    entry,
    resumeConfig,
    webSearchConfig,
    skipLiveRoute,
    gatewayPort,
    log,
    bail,
  } = input;
  let buildContext: PreparedDcodeRebuildImage | null = null;
  let pinnedBase: PinnedDcodeBaseImage | null = null;
  let transferred = false;
  try {
    if (!sandboxState.hasPositiveManagedImageEvidence(entry)) {
      fail(
        "the registry has no NemoClaw-managed image fingerprint; custom and legacy images cannot be safely prebuilt and recreated automatically",
        bail,
      );
    }

    const session = loadMatchingDcodeSession(sandboxName);
    const target = resolveTarget(entry, resumeConfig, bail, gatewayPort);
    if (!skipLiveRoute) requireInferenceRoute(sandboxName, target, bail);

    pinnedBase = buildPinnedDcodeBaseImage(bail);
    const sandboxGpuConfig = getRecordedGpuConfig(sandboxName, entry, session);
    if (sandboxGpuConfig.errors.length > 0) fail(sandboxGpuConfig.errors.join(" "), bail);
    const imageResult = await withPinnedBaseImage(pinnedBase, () =>
      prepareManagedDcodeRebuildImage({
        agent: loadAgent(DCODE_AGENT_NAME),
        provider: target.provider,
        model: target.model,
        preferredInferenceApi: target.preferredInferenceApi,
        compatibleEndpointReasoning: resumeConfig.compatibleEndpointReasoning,
        webSearchConfig,
        toolDisclosure: input.toolDisclosure,
        dcodeAutoApprovalMode: input.dcodeAutoApprovalMode,
        sandboxGpuConfig,
        gatewayPort,
      }),
    );
    if (!imageResult.ok) fail(imageResult.detail, bail);
    buildContext = imageResult.prepared;

    if (!(await ensureDcodeRebuildTargetGatewaySelected(sandboxName, entry, log, bail))) {
      return null;
    }
    if (!input.checkGatewaySchema()) return null;
    if (!skipLiveRoute) requireInferenceRoute(sandboxName, target, bail);
    requireCurrentTarget(sandboxName, entry, target, resumeConfig, bail, gatewayPort);
    if (!verifyPreparedDcodeRebuildImage(buildContext) || !pinnedBase.verify()) {
      fail("the prepared DCode replacement inputs changed during preflight", bail);
    }

    const preparedBuildContext = buildContext;
    const preparedBase = pinnedBase;
    const replacement: PreparedDcodeReplacement = {
      buildContext: preparedBuildContext,
      gatewayName: target.gatewayName,
      toolDisclosure: input.toolDisclosure,
      dcodeAutoApprovalMode: input.dcodeAutoApprovalMode,
      dispose: () => disposePreparation(preparedBuildContext, preparedBase),
      verify: () => verifyPreparedDcodeRebuildImage(preparedBuildContext) && preparedBase.verify(),
    };
    transferred = true;
    return replacement;
  } finally {
    if (!transferred) disposePreparation(buildContext, pinnedBase);
  }
}

/** Recheck long-running backup inputs at the last safe point before deletion. */
export async function revalidateDcodeReplacementAtMutationEdge(
  input: DcodeReplacementPreflightInput & { replacement: PreparedDcodeReplacement },
): Promise<boolean> {
  const { sandboxName, entry, resumeConfig, skipLiveRoute, gatewayPort, log, bail, replacement } =
    input;
  const target = resolveTarget(entry, resumeConfig, bail, gatewayPort);
  if (replacement.gatewayName !== target.gatewayName) {
    fail("the prepared DCode gateway changed before deletion", bail);
  }
  if (replacement.toolDisclosure !== input.toolDisclosure) {
    fail("the prepared DCode tool-disclosure mode changed before deletion", bail);
  }
  if (replacement.dcodeAutoApprovalMode !== input.dcodeAutoApprovalMode) {
    fail("the prepared DCode auto-approval mode changed before deletion", bail);
  }
  if (!(await ensureDcodeRebuildTargetGatewaySelected(sandboxName, entry, log, bail))) {
    return false;
  }
  if (!input.checkGatewaySchema()) return false;
  if (!skipLiveRoute) requireInferenceRoute(sandboxName, target, bail);
  requireCurrentTarget(sandboxName, entry, target, resumeConfig, bail, gatewayPort);
  if (!replacement.verify()) {
    fail("the prepared DCode replacement inputs changed before deletion", bail);
  }
  return true;
}
