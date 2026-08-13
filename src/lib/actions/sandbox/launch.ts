// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as agentRuntime from "../../agent/runtime";
import { requireCuaLifecycleReadiness } from "../../cua/lifecycle-readiness";
import { resolveSandboxGatewayName } from "../../gateway-runtime-action";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import { withMcpLifecycleLock as withSandboxMutationLock } from "../../state/mcp-lifecycle-lock-acquisition";
import {
  completeInteractiveSessionSetup,
  prepareInteractiveSession,
  printInteractiveSessionHints,
} from "./connect";
import { prepareHermesLightTerminalSkin } from "./connect-hermes-light-skin";
import { execSandbox } from "./exec";
import { getKnownSandboxTarget } from "./gateway-target";
import {
  inspectLaunchReadiness,
  publicationFromDecision,
  publishLaunchReadiness,
} from "./launch-readiness";

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

export async function launchSandbox(
  sandboxName: string,
  deps: LaunchSandboxDeps = {},
): Promise<void> {
  const decision = await (deps.inspectLaunchReadiness ?? inspectLaunchReadiness)(sandboxName);
  const session =
    decision.kind === "accepted"
      ? (() => {
          printInteractiveSessionHints(sandboxName);
          completeInteractiveSessionSetup(sandboxName, decision.sb);
          return { agent: decision.agent, sb: decision.sb };
        })()
      : await prepareInteractiveSession(sandboxName);
  if (decision.kind === "fallback" && decision.fence) {
    const publication = await (deps.publishLaunchReadiness ?? publishLaunchReadiness)(
      publicationFromDecision(sandboxName, decision),
    );
    if (publication.kind === "validation-failed") {
      throw new Error(
        `Launch readiness final validation failed due to ${publication.category}. Retry launch.`,
      );
    }
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
  prepareHermesLightTerminalSkin(sandboxName, agent, process.env);

  // Run the agent through a login shell. execSandbox wraps every command in
  // wrapExecCommandWithRuntimeEnv (runtime-env.ts), which sources
  // /tmp/nemoclaw-proxy-env.sh and then unsets OPENCLAW_GATEWAY_TOKEN so
  // ordinary caller argv cannot inherit it (#6291). The SSH path that
  // `connect` uses keeps the token because the login shell re-sources that
  // file through the profile. Passing bare argv here would silently start the
  // agent under a different auth mode than `connect` gives it, so `-l` is
  // load-bearing: do not flatten this to `bash -c` or to the split command.
  if (isCua) {
    await launchCuaUnderMutationLocks(sandboxName, deps);
    return;
  }
  const command = ["bash", "-lc", agentCommand];
  await execSandbox(sandboxName, command, {
    tty: true,
    stdin: true,
    // 0 means no timeout. Any other value kills a long interactive session.
    timeoutSeconds: 0,
  });
}
