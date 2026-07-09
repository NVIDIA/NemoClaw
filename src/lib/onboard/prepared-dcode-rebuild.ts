// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { AgentDefinition } from "../agent/defs";
import { ROOT } from "../runner";
import { OPENCLAW_SANDBOX_BASE_IMAGE, SANDBOX_BASE_TAG } from "../sandbox-base-image";
import type {
  CreateSandboxBuildContextInput,
  CreateSandboxBuildContextResult,
  PreparedSandboxBuildContext,
} from "./build-context-stage";
import { type DcodeAutoApprovalMode, normalizeDcodeAutoApprovalMode } from "./dcode-auto-approval";
import type {
  PrepareSandboxDockerfilePatchInput,
  SandboxDockerfilePatchResult,
} from "./sandbox-dockerfile-patch-flow";

const DCODE_AGENT = "langchain-deepagents-code";

type StageCreateSandboxBuildContext =
  typeof import("./build-context-stage").stageCreateSandboxBuildContext;
type PrepareSandboxDockerfilePatch =
  typeof import("./sandbox-dockerfile-patch-flow").prepareSandboxDockerfilePatch;
type CreateAgentSandbox = CreateSandboxBuildContextInput["createAgentSandbox"];

export interface PreparedDcodeRebuildHandoff {
  buildContext: PreparedSandboxBuildContext;
  gatewayName: string;
  dcodeAutoApprovalMode: DcodeAutoApprovalMode;
}

export interface PreparedImageRebuildHandoff {
  buildContext: PreparedSandboxBuildContext;
  gatewayName: string;
}

export interface PreparedDcodeRebuildOptions {
  resume?: boolean;
  recreateSandbox?: boolean;
  authoritativeResumeConfig?: boolean;
  onboardLockAlreadyHeld?: boolean;
  agent?: string | null;
  fromDockerfile?: string | null;
  dcodeAutoApprovalMode?: DcodeAutoApprovalMode | null;
  preparedDcodeRebuild?: PreparedDcodeRebuildHandoff;
  preparedImageRebuild?: PreparedImageRebuildHandoff;
}

export interface PreparedDcodeRebuildDeps {
  createAgentSandbox?: CreateAgentSandbox;
  onExit?(cleanup: () => boolean): void;
  prepareSandboxDockerfilePatch?: PrepareSandboxDockerfilePatch;
  stageCreateSandboxBuildContext?: StageCreateSandboxBuildContext;
}

export interface PreparedDcodeRebuildRuntime {
  applyGatewayEnv(env: NodeJS.ProcessEnv): void;
  resolveDockerfileProbePath(fromDockerfile: string): string;
  bindCreateSandbox<Args extends unknown[], Result>(
    createSandbox: (
      ...args: [...Args, preparedBuildContext: PreparedSandboxBuildContext | null]
    ) => Promise<Result>,
  ): (...args: Args) => Promise<Result>;
}

function loadCreateAgentSandbox(): CreateAgentSandbox {
  return (require("../agent/onboard") as typeof import("../agent/onboard")).createAgentSandbox;
}

function loadStageCreateSandboxBuildContext(): StageCreateSandboxBuildContext {
  return (require("./build-context-stage") as typeof import("./build-context-stage"))
    .stageCreateSandboxBuildContext;
}

function loadPrepareSandboxDockerfilePatch(): PrepareSandboxDockerfilePatch {
  return (
    require("./sandbox-dockerfile-patch-flow") as typeof import("./sandbox-dockerfile-patch-flow")
  ).prepareSandboxDockerfilePatch;
}

function normalizedDockerfilePath(fromDockerfile: string | null | undefined): string | null {
  return fromDockerfile ? path.resolve(fromDockerfile) : null;
}

function normalizedAgentIdentity(agentName: string | null | undefined): string {
  return agentName?.trim() || "openclaw";
}

function assertPreparedTargetIdentity(
  preparedBuildContext: PreparedSandboxBuildContext,
  agentName: string | null,
  fromDockerfile: string | null,
): void {
  const target = preparedBuildContext.rebuildTarget;
  if (target) {
    if (
      normalizedAgentIdentity(target.agentName) !== normalizedAgentIdentity(agentName) ||
      target.fromDockerfile !== normalizedDockerfilePath(fromDockerfile)
    ) {
      throw new Error("A prepared rebuild image cannot be used for this sandbox target.");
    }
    return;
  }
  if (agentName !== DCODE_AGENT || fromDockerfile) {
    throw new Error("A prepared DCode build context cannot be used for this sandbox target.");
  }
}

function verifyPreparedBuildContextForUse(preparedBuildContext: PreparedSandboxBuildContext): void {
  if (
    typeof preparedBuildContext.verifyBuildCtx === "function" &&
    !preparedBuildContext.verifyBuildCtx()
  ) {
    throw new Error("Prepared rebuild image context changed before use.");
  }
}

export function assertPreparedDcodeTarget(
  preparedBuildContext: PreparedSandboxBuildContext | null,
  agent: AgentDefinition | null | undefined,
  fromDockerfile: string | null,
): void {
  if (preparedBuildContext) {
    assertPreparedTargetIdentity(preparedBuildContext, agent?.name ?? null, fromDockerfile);
  }
}

export function createPreparedDcodeRebuildRuntime(
  options: PreparedDcodeRebuildOptions,
  expectedGatewayName: string,
): PreparedDcodeRebuildRuntime {
  const preparedDcode = options.preparedDcodeRebuild ?? null;
  const preparedImage = options.preparedImageRebuild ?? null;
  if (preparedDcode && preparedImage) {
    throw new Error("Only one prepared rebuild image handoff may be provided.");
  }
  if (
    preparedDcode &&
    (options.resume !== true || options.recreateSandbox !== true || options.agent !== DCODE_AGENT)
  ) {
    throw new Error("A prepared DCode rebuild can only be used by DCode resume recreation.");
  }
  if (
    preparedDcode &&
    preparedDcode.dcodeAutoApprovalMode !==
      normalizeDcodeAutoApprovalMode(options.dcodeAutoApprovalMode)
  ) {
    throw new Error(
      "Prepared DCode rebuild auto-approval mode does not match the authoritative onboard request.",
    );
  }
  if (
    preparedImage &&
    (options.resume !== true ||
      options.recreateSandbox !== true ||
      options.authoritativeResumeConfig !== true ||
      options.onboardLockAlreadyHeld !== true)
  ) {
    throw new Error(
      "A prepared rebuild image can only be used by authoritative resume recreation.",
    );
  }
  if (preparedImage) {
    if (!preparedImage.buildContext.rebuildTarget) {
      throw new Error("Prepared rebuild image target is missing or invalid.");
    }
    if (typeof preparedImage.buildContext.verifyBuildCtx !== "function") {
      throw new Error("Prepared rebuild image verifier is missing or invalid.");
    }
    assertPreparedTargetIdentity(
      preparedImage.buildContext,
      options.agent ?? null,
      normalizedDockerfilePath(options.fromDockerfile),
    );
  }
  const prepared = preparedImage ?? preparedDcode;
  const preparedLabel = preparedImage ? "Prepared rebuild image" : "Prepared DCode rebuild";
  if (prepared && typeof prepared.gatewayName !== "string") {
    throw new Error(`${preparedLabel} gateway is missing or invalid.`);
  }
  const gatewayName = prepared?.gatewayName.trim() ?? null;
  if (gatewayName !== null && gatewayName !== expectedGatewayName) {
    throw new Error(
      `${preparedLabel} gateway '${gatewayName}' does not match '${expectedGatewayName}'.`,
    );
  }

  const retainedBuildContext = preparedImage?.buildContext ?? null;
  let pendingBuildContext = prepared?.buildContext ?? null;
  return {
    applyGatewayEnv(env) {
      if (gatewayName) env.OPENSHELL_GATEWAY = gatewayName;
      else delete env.OPENSHELL_GATEWAY;
    },
    resolveDockerfileProbePath(fromDockerfile) {
      const resolvedDockerfile = path.resolve(fromDockerfile);
      if (!retainedBuildContext) return resolvedDockerfile;
      assertPreparedTargetIdentity(retainedBuildContext, options.agent ?? null, resolvedDockerfile);
      return retainedBuildContext.rebuildTarget?.fromDockerfile
        ? retainedBuildContext.stagedDockerfile
        : resolvedDockerfile;
    },
    bindCreateSandbox(createSandbox) {
      return async (...args) => {
        const buildContext = pendingBuildContext;
        pendingBuildContext = null;
        if (buildContext) verifyPreparedBuildContextForUse(buildContext);
        return createSandbox(...args, buildContext);
      };
    },
  };
}

export function resolveSandboxBuildContext(
  input: {
    preparedBuildContext: PreparedSandboxBuildContext | null;
    agent: AgentDefinition | null | undefined;
    fromDockerfile: string | null;
  },
  deps: PreparedDcodeRebuildDeps = {},
): CreateSandboxBuildContextResult {
  const { preparedBuildContext, agent, fromDockerfile } = input;
  assertPreparedDcodeTarget(preparedBuildContext, agent, fromDockerfile);
  if (preparedBuildContext) {
    verifyPreparedBuildContextForUse(preparedBuildContext);
    return preparedBuildContext;
  }

  const staged = (deps.stageCreateSandboxBuildContext ?? loadStageCreateSandboxBuildContext())({
    root: ROOT,
    fromDockerfile,
    agent,
    createAgentSandbox: deps.createAgentSandbox ?? loadCreateAgentSandbox(),
  });
  (deps.onExit ?? ((cleanup) => process.on("exit", cleanup)))(staged.cleanupBuildCtx);
  return staged;
}

type ResolveSandboxBuildIdInput = Omit<
  PrepareSandboxDockerfilePatchInput,
  "deps" | "log" | "sandboxBaseImage" | "sandboxBaseTag" | "warn"
> & {
  preparedBuildContext: PreparedSandboxBuildContext | null;
};

export async function resolveSandboxBuildId(
  input: ResolveSandboxBuildIdInput,
  deps: PreparedDcodeRebuildDeps = {},
): Promise<string> {
  const { preparedBuildContext, ...patchInput } = input;
  assertPreparedDcodeTarget(preparedBuildContext, patchInput.agent, patchInput.fromDockerfile);
  if (preparedBuildContext) {
    verifyPreparedBuildContextForUse(preparedBuildContext);
    return preparedBuildContext.buildId;
  }

  const result: SandboxDockerfilePatchResult = await (
    deps.prepareSandboxDockerfilePatch ?? loadPrepareSandboxDockerfilePatch()
  )({
    ...patchInput,
    sandboxBaseImage: OPENCLAW_SANDBOX_BASE_IMAGE,
    sandboxBaseTag: SANDBOX_BASE_TAG,
  });
  return result.buildId;
}
