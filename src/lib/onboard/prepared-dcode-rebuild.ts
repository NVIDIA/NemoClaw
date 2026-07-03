// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import { ROOT } from "../runner";
import { OPENCLAW_SANDBOX_BASE_IMAGE, SANDBOX_BASE_TAG } from "../sandbox-base-image";
import type {
  CreateSandboxBuildContextInput,
  CreateSandboxBuildContextResult,
  PreparedSandboxBuildContext,
} from "./build-context-stage";
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
}

export interface PreparedDcodeRebuildOptions {
  resume?: boolean;
  recreateSandbox?: boolean;
  agent?: string | null;
  preparedDcodeRebuild?: PreparedDcodeRebuildHandoff;
}

export interface PreparedDcodeRebuildDeps {
  createAgentSandbox?: CreateAgentSandbox;
  onExit?(cleanup: () => boolean): void;
  prepareSandboxDockerfilePatch?: PrepareSandboxDockerfilePatch;
  stageCreateSandboxBuildContext?: StageCreateSandboxBuildContext;
}

export interface PreparedDcodeRebuildRuntime {
  applyGatewayEnv(env: NodeJS.ProcessEnv): void;
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

function assertPreparedDcodeTarget(
  preparedBuildContext: PreparedSandboxBuildContext | null,
  agent: AgentDefinition | null | undefined,
  fromDockerfile: string | null,
): void {
  if (preparedBuildContext && (agent?.name !== DCODE_AGENT || fromDockerfile)) {
    throw new Error("A prepared DCode build context cannot be used for this sandbox target.");
  }
}

export function createPreparedDcodeRebuildRuntime(
  options: PreparedDcodeRebuildOptions,
  expectedGatewayName: string,
): PreparedDcodeRebuildRuntime {
  const prepared = options.preparedDcodeRebuild ?? null;
  if (
    prepared &&
    (options.resume !== true || options.recreateSandbox !== true || options.agent !== DCODE_AGENT)
  ) {
    throw new Error("A prepared DCode rebuild can only be used by DCode resume recreation.");
  }
  if (prepared && typeof prepared.gatewayName !== "string") {
    throw new Error("Prepared DCode rebuild gateway is missing or invalid.");
  }
  const gatewayName = prepared?.gatewayName.trim() ?? null;
  if (gatewayName !== null && gatewayName !== expectedGatewayName) {
    throw new Error(
      `Prepared DCode rebuild gateway '${gatewayName}' does not match '${expectedGatewayName}'.`,
    );
  }

  let pendingBuildContext = prepared?.buildContext ?? null;
  return {
    applyGatewayEnv(env) {
      if (gatewayName) env.OPENSHELL_GATEWAY = gatewayName;
      else delete env.OPENSHELL_GATEWAY;
    },
    bindCreateSandbox(createSandbox) {
      return (...args) => {
        const buildContext = pendingBuildContext;
        pendingBuildContext = null;
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
  if (preparedBuildContext) return preparedBuildContext;

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
  if (preparedBuildContext) return preparedBuildContext.buildId;

  const result: SandboxDockerfilePatchResult = await (
    deps.prepareSandboxDockerfilePatch ?? loadPrepareSandboxDockerfilePatch()
  )({
    ...patchInput,
    sandboxBaseImage: OPENCLAW_SANDBOX_BASE_IMAGE,
    sandboxBaseTag: SANDBOX_BASE_TAG,
  });
  return result.buildId;
}
