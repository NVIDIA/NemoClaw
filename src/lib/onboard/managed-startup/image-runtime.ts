// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  MANAGED_STARTUP_AGENTS,
  type ManagedStartupAgent,
  type ManagedStartupDashboard,
} from "./profile";

/**
 * This module owns only pure managed-image command construction. It does not
 * execute commands, mutate sandbox state, or activate a compute driver.
 */
export type ManagedStartupImageIdentity = "root" | "sandbox";
export type ManagedStartupMessagingAgent = "openclaw" | "hermes";

export interface ManagedStartupGenerateConfigConstructionAction {
  readonly kind: "generate-agent-config";
  readonly agent: ManagedStartupAgent;
  readonly runAs: "sandbox";
}

interface ManagedStartupApplyMessagingConstructionActionBase {
  readonly kind: "apply-messaging-plan";
  readonly agent: ManagedStartupMessagingAgent;
  readonly mode: "apply" | "clear";
}

export interface ManagedStartupApplyMessagingRuntimeConstructionAction
  extends ManagedStartupApplyMessagingConstructionActionBase {
  readonly phase: "runtime-setup";
  readonly runAs: "root";
}

export interface ManagedStartupApplyMessagingConfigConstructionAction
  extends ManagedStartupApplyMessagingConstructionActionBase {
  readonly phase: "post-agent-install";
  readonly runAs: "sandbox";
}

export type ManagedStartupApplyMessagingConstructionAction =
  | ManagedStartupApplyMessagingRuntimeConstructionAction
  | ManagedStartupApplyMessagingConfigConstructionAction;

export interface ManagedStartupConfigureDashboardConstructionAction {
  readonly kind: "configure-dashboard";
  readonly dashboard: ManagedStartupDashboard;
}

export type ManagedStartupImageConstructionAction =
  | ManagedStartupGenerateConfigConstructionAction
  | ManagedStartupApplyMessagingConstructionAction
  | ManagedStartupConfigureDashboardConstructionAction;

/**
 * The application mapper must produce this structural handoff only after it
 * decodes and revalidates the profile and its nested messaging plan.
 */
export interface ManagedStartupImageActionPlanInput {
  readonly agent: ManagedStartupAgent;
  readonly actions: readonly ManagedStartupImageConstructionAction[];
}

export interface ManagedStartupImageActionCommand {
  readonly action:
    | "generate-agent-config"
    | "messaging-runtime-setup"
    | "messaging-post-agent-install";
  readonly runAs: ManagedStartupImageIdentity;
  readonly argv: readonly string[];
}

export class ManagedStartupImageActionPlanError extends Error {
  constructor(message: string) {
    super(`Cannot build managed startup image action plan: ${message}`);
    this.name = "ManagedStartupImageActionPlanError";
  }
}

function fail(message: string): never {
  throw new ManagedStartupImageActionPlanError(message);
}

function exactAgent(value: string): ManagedStartupAgent {
  if ((MANAGED_STARTUP_AGENTS as readonly string[]).includes(value)) {
    return value as ManagedStartupAgent;
  }
  return fail(`unsupported agent ${JSON.stringify(value)}`);
}

function generatorCommand(agent: ManagedStartupAgent): readonly string[] {
  switch (agent) {
    case "openclaw":
      return [
        "/usr/local/bin/node",
        "--experimental-strip-types",
        "/scripts/generate-openclaw-config.mts",
      ];
    case "hermes":
      return [
        "/usr/local/bin/node",
        "--experimental-strip-types",
        "/opt/nemoclaw-hermes-config/generate-config.ts",
      ];
    case "langchain-deepagents-code":
      return [
        "/usr/local/bin/node",
        "--experimental-strip-types",
        "/opt/nemoclaw-deepagents-code/generate-config.ts",
      ];
  }
}

function messagingCommand(
  agent: ManagedStartupMessagingAgent,
  phase: "runtime-setup" | "post-agent-install",
): readonly string[] {
  return [
    "/usr/local/bin/node",
    "--experimental-strip-types",
    "/src/lib/messaging/applier/build/messaging-build-applier.mts",
    "--agent",
    agent,
    "--phase",
    phase,
    ...(phase === "post-agent-install" ? ["--managed-startup-runtime"] : []),
  ];
}

function assertActionAgent(
  inputAgent: ManagedStartupAgent,
  actionAgent: ManagedStartupAgent,
): void {
  if (inputAgent !== actionAgent) {
    fail(`action for ${actionAgent} cannot be used by ${inputAgent}`);
  }
}

/**
 * Convert the closed application-action vocabulary into immutable image
 * commands. The vocabulary deliberately cannot express agent installation,
 * package-manager access, command execution, or runtime activation.
 */
export function buildManagedStartupImageActionPlan(
  input: ManagedStartupImageActionPlanInput,
): readonly ManagedStartupImageActionCommand[] {
  const inputAgent = exactAgent(input.agent);
  const commands: ManagedStartupImageActionCommand[] = [];
  let dashboardActions = 0;
  let generateActions = 0;
  let runtimeMessagingActions = 0;
  let postMessagingActions = 0;

  for (const action of input.actions) {
    switch (action.kind) {
      case "configure-dashboard": {
        if (action.dashboard.agent !== input.agent) {
          fail(`dashboard for ${action.dashboard.agent} cannot be used by ${input.agent}`);
        }
        dashboardActions += 1;
        break;
      }
      case "generate-agent-config": {
        assertActionAgent(inputAgent, exactAgent(action.agent));
        if (action.runAs !== "sandbox") {
          fail("agent configuration generation must run as sandbox");
        }
        generateActions += 1;
        commands.push({
          action: "generate-agent-config",
          runAs: action.runAs,
          argv: generatorCommand(action.agent),
        });
        break;
      }
      case "apply-messaging-plan": {
        assertActionAgent(inputAgent, exactAgent(action.agent));
        if (action.mode !== "apply" && action.mode !== "clear") {
          fail("messaging intent must be apply or clear");
        }
        if (action.phase === "runtime-setup") {
          if (action.runAs !== "root") {
            fail("messaging runtime setup must run as root");
          }
          runtimeMessagingActions += 1;
          commands.push({
            action: "messaging-runtime-setup",
            runAs: action.runAs,
            argv: messagingCommand(action.agent, action.phase),
          });
        } else if (action.phase === "post-agent-install") {
          if (action.runAs !== "sandbox") {
            fail("messaging post-agent configuration must run as sandbox");
          }
          postMessagingActions += 1;
          commands.push({
            action: "messaging-post-agent-install",
            runAs: action.runAs,
            argv: messagingCommand(action.agent, action.phase),
          });
        } else {
          fail("unsupported messaging construction phase");
        }
        break;
      }
      default:
        fail("unsupported managed startup construction action");
    }
  }

  if (dashboardActions !== 1) fail("exactly one dashboard construction action is required");
  if (generateActions !== 1) fail("exactly one agent config construction action is required");
  const expectedMessagingActions = inputAgent === "langchain-deepagents-code" ? 0 : 1;
  if (
    runtimeMessagingActions !== expectedMessagingActions ||
    postMessagingActions !== expectedMessagingActions
  ) {
    fail(
      `${inputAgent} requires ${String(expectedMessagingActions)} action for each messaging phase`,
    );
  }
  const expectedOrder =
    inputAgent === "langchain-deepagents-code"
      ? ["generate-agent-config"]
      : ["messaging-runtime-setup", "generate-agent-config", "messaging-post-agent-install"];
  if (commands.some((command, index) => command.action !== expectedOrder[index])) {
    fail(`${inputAgent} image actions are not in the required construction order`);
  }

  return Object.freeze(
    commands.map((command) =>
      Object.freeze({
        ...command,
        argv: Object.freeze([...command.argv]),
      }),
    ),
  );
}
