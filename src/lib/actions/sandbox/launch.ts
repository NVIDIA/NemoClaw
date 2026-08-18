// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as agentRuntime from "../../agent/runtime";
import type { AgentDefinition } from "../../agent/definition-types";
import { requireCuaLifecycleReadiness } from "../../cua/lifecycle-readiness";
import { resolveSandboxGatewayName } from "../../gateway-runtime-action";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import { withMcpLifecycleLock as withSandboxMutationLock } from "../../state/mcp-lifecycle-lock-acquisition";
import type { SandboxEntry } from "../../state/registry";
import {
  completeReadinessQualifiedInteractiveSessionSetup,
  prepareInteractiveSession,
  printInteractiveSessionHints,
} from "./connect";
import { prepareHermesLightTerminalSkin } from "./connect-hermes-light-skin";
import { execSandbox } from "./exec";
import {
  inspectPortableAgentReceiptDisposition,
  recoverPortableDemoSandboxLifecycleForConnect,
} from "./gateway-state";
import { getKnownSandboxTarget } from "./gateway-target";
import {
  inspectLaunchReadiness,
  publicationFromDecision,
  publishLaunchReadiness,
  withLaunchReadinessMutationGate,
} from "./launch-readiness";

const LAUNCH_READINESS_FENCE_REPAIR =
  "Launch readiness evidence could not be safely invalidated. Repair the current user's secure OS runtime authority and NemoClaw state permissions, then retry.";

/**
 * Connect to a sandbox and start its agent in one host-side step (#6006).
 *
 * Launch either validates a launch-readiness lease or runs the same complete
 * preflight as `connect` before starting the agent. Starting over `exec`
 * without either path can leave the TUI disconnected from an unhealthy
 * gateway.
 */
interface LaunchSandboxDeps {
  getSandbox?: typeof getKnownSandboxTarget;
  requireCuaReadiness?: (entry: NonNullable<ReturnType<typeof getKnownSandboxTarget>>) => unknown;
  resolveSandboxGatewayName?: typeof resolveSandboxGatewayName;
  withGatewayRouteMutationLock?: typeof withGatewayRouteMutationLock;
  withSandboxMutationLock?: typeof withSandboxMutationLock;
  inspectLaunchReadiness?: typeof inspectLaunchReadiness;
  publishLaunchReadiness?: typeof publishLaunchReadiness;
  withLaunchReadinessMutationGate?: typeof withLaunchReadinessMutationGate;
}

async function launchCuaUnderMutationLocks(
  sandboxName: string,
  deps: LaunchSandboxDeps,
): Promise<void> {
  const lockSandbox = deps.withSandboxMutationLock ?? withSandboxMutationLock;
  const lockGateway = deps.withGatewayRouteMutationLock ?? withGatewayRouteMutationLock;
  const getSandbox = deps.getSandbox ?? getKnownSandboxTarget;
  const resolveGateway = deps.resolveSandboxGatewayName ?? resolveSandboxGatewayName;
  await lockSandbox(sandboxName, async () => {
    const lockedEntry = getSandbox(sandboxName);
    if (!lockedEntry || lockedEntry.agent !== "nemocua") {
      throw new Error(
        `NemoCUA authority changed while waiting to launch sandbox '${sandboxName}'.`,
      );
    }
    const gatewayName = resolveGateway(lockedEntry);
    await lockGateway(gatewayName, async () => {
      (deps.requireCuaReadiness ?? requireCuaLifecycleReadiness)(lockedEntry);
      await execSandbox(sandboxName, ["nemocua", "interactive"], {
        tty: true,
        stdin: true,
        // 0 means no timeout. Any other value kills a long interactive session.
        timeoutSeconds: 0,
      });
    });
  });
}

async function launchAgentWithPortableAuthority(
  sandboxName: string,
  agent: AgentDefinition | null,
  entry: SandboxEntry | null,
  command: readonly string[],
  deps: LaunchSandboxDeps,
): Promise<void> {
  const runAgent = async (): Promise<void> => {
    prepareHermesLightTerminalSkin(sandboxName, agent, process.env);
    await execSandbox(sandboxName, command, {
      tty: true,
      stdin: true,
      timeoutSeconds: 0,
    });
  };
  const lockSandbox = deps.withSandboxMutationLock ?? withSandboxMutationLock;
  await lockSandbox(sandboxName, async () => {
    const current = inspectPortableAgentReceiptDisposition(sandboxName);
    if (current.kind !== "hermes") {
      await runAgent();
      return;
    }
    if (current.phase !== "active") {
      throw new Error("Hermes portable lifecycle authority changed before agent launch.");
    }
    const getSandbox = deps.getSandbox ?? getKnownSandboxTarget;
    const registered = getSandbox(sandboxName);
    if (!registered || registered.agent !== "hermes") {
      throw new Error("Hermes portable registry authority changed before agent launch.");
    }
    const gatewayName = (deps.resolveSandboxGatewayName ?? resolveSandboxGatewayName)(registered);
    const recovery = recoverPortableDemoSandboxLifecycleForConnect(
      sandboxName,
      registered,
      gatewayName,
    );
    if (recovery.kind === "not-installed") {
      throw new Error("Hermes portable lifecycle authority disappeared before agent launch.");
    }
    await runAgent();
  });
}

export async function launchSandbox(
  sandboxName: string,
  deps: LaunchSandboxDeps = {},
): Promise<void> {
  const inspect = deps.inspectLaunchReadiness ?? inspectLaunchReadiness;
  const enterMutationGate = deps.withLaunchReadinessMutationGate ?? withLaunchReadinessMutationGate;
  let decision = await inspect(sandboxName);
  let session: Awaited<ReturnType<typeof prepareInteractiveSession>>;
  while (true) {
    if (decision.kind === "accepted") {
      printInteractiveSessionHints(sandboxName);
      completeReadinessQualifiedInteractiveSessionSetup(sandboxName, decision.agent, decision.sb);
      session = {
        agent: decision.agent,
        sb: decision.sb,
        hermesPortable: inspectPortableAgentReceiptDisposition(sandboxName).kind === "hermes",
      };
      break;
    }
    if (
      decision.category === "missing" &&
      decision.gatewayName === null &&
      decision.gatewayPort === null
    ) {
      throw new Error(`Sandbox '${sandboxName}' is not registered in the local NemoClaw state.`);
    }
    if (decision.recoveryBlocked) throw new Error(LAUNCH_READINESS_FENCE_REPAIR);
    const fallbackDecision = decision;
    const publicationRequest = publicationFromDecision(sandboxName, fallbackDecision);
    const gated = await enterMutationGate(publicationRequest, async () => {
      const prepared = await prepareInteractiveSession(sandboxName);
      const publication = fallbackDecision.fence
        ? await (deps.publishLaunchReadiness ?? publishLaunchReadiness)(publicationRequest)
        : null;
      return { prepared, publication };
    });
    if (gated.kind === "changed") {
      decision = await inspect(sandboxName);
      continue;
    }
    if (gated.kind === "unsafe") throw new Error(LAUNCH_READINESS_FENCE_REPAIR);
    if (gated.value.publication?.kind === "validation-failed") {
      throw new Error(
        `Launch readiness final validation failed due to ${gated.value.publication.category}. Retry launch.`,
      );
    }
    session = gated.value.prepared;
    break;
  }
  const { agent, sb } = session;
  const isCua = sb?.agent === "nemocua";
  const agentCommand = isCua
    ? agentRuntime.getTerminalCommand(agent, "interactive")
    : agentRuntime.getInteractiveAgentCommand(agent, sb?.agent);
  if (!agentCommand) {
    throw new Error(`Cannot resolve an interactive command for sandbox '${sandboxName}'.`);
  }
  if (isCua && agentCommand !== "nemocua interactive") {
    throw new Error("NemoCUA interactive command must be exactly 'nemocua interactive'");
  }

  // `connect` runs this immediately before opening its SSH session. It is not
  // part of prepareInteractiveSession, so `launch` must call it too: without it
  // a Hermes TUI on a light-background terminal keeps the default dark skin,
  // and a switch back to a dark terminal never removes the managed skin.
  // Run the agent through a login shell. execSandbox wraps every command in
  // wrapExecCommandWithRuntimeEnv (runtime-env.ts), which sources
  // /tmp/nemoclaw-proxy-env.sh and then unsets OPENCLAW_GATEWAY_TOKEN so
  // ordinary caller argv cannot inherit it (#6291). The SSH path that
  // `connect` uses keeps the token because the login shell re-sources that
  // file through the profile. Passing bare argv here would silently start the
  // agent under a different auth mode than `connect` gives it, so `-l` is
  // load-bearing: do not flatten this to `bash -c` or to the split command.
  if (isCua) {
    prepareHermesLightTerminalSkin(sandboxName, agent, process.env);
    await launchCuaUnderMutationLocks(sandboxName, deps);
    return;
  }
  const command = ["bash", "-lc", agentCommand];
  await launchAgentWithPortableAuthority(sandboxName, agent, sb, command, deps);
}
