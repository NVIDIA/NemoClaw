// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as agentRuntime from "../../agent/runtime";
import type { AgentDefinition } from "../../agent/definition-types";
import { spawnExitCode } from "../../core/process-exit";
import { requireCuaLifecycleReadiness } from "../../cua/lifecycle-readiness";
import { resolveSandboxGatewayName } from "../../gateway-runtime-action";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import type { SandboxEntry } from "../../state/registry";
import {
  completeReadinessQualifiedInteractiveSessionSetup,
  prepareInteractiveSession,
  printInteractiveSessionHints,
} from "./connect";
import { prepareHermesLightTerminalSkin } from "./connect-hermes-light-skin";
import {
  buildOpenshellExecArgs,
  execSandbox,
  runSandboxExecChild,
  wrapExecCommandWithRuntimeEnv,
} from "./exec";
import {
  buildHermesPortableCommandAuthority,
  inspectPortableAgentReceiptDisposition,
  recoverPortableDemoSandboxLifecycleForConnect,
  withSandboxLifecycleLock as withSandboxMutationLock,
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
  beforeOrdinaryLaunch?: () => void,
): Promise<void> {
  const lockSandbox = deps.withSandboxMutationLock ?? withSandboxMutationLock;
  const lockGateway = deps.withGatewayRouteMutationLock ?? withGatewayRouteMutationLock;
  const getSandbox = deps.getSandbox ?? getKnownSandboxTarget;
  const resolveGateway = deps.resolveSandboxGatewayName ?? resolveSandboxGatewayName;
  await lockSandbox(sandboxName, async () => {
    if (inspectPortableAgentReceiptDisposition(sandboxName).kind === "hermes") {
      throw new Error("Hermes portable lifecycle authority changed before agent launch.");
    }
    beforeOrdinaryLaunch?.();
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
  hermesPortableSnapshot: boolean,
  command: readonly string[],
  deps: LaunchSandboxDeps,
  beforeOrdinaryLaunch?: () => void,
): Promise<void> {
  const runOrdinaryAgent = async (): Promise<void> => {
    prepareHermesLightTerminalSkin(sandboxName, agent, process.env);
    await execSandbox(sandboxName, command, {
      tty: true,
      stdin: true,
      timeoutSeconds: 0,
    });
  };
  const runHermesPortableAgent = async (gatewayName: string): Promise<void> => {
    const commandAuthority = buildHermesPortableCommandAuthority(sandboxName);
    const options = {
      tty: true,
      stdin: true,
      timeoutSeconds: 0,
      subprocessEnv: commandAuthority.env,
    } as const;
    const result = await runSandboxExecChild(
      commandAuthority.executablePath,
      buildOpenshellExecArgs(
        sandboxName,
        wrapExecCommandWithRuntimeEnv(command),
        options,
        gatewayName,
      ),
      options,
    );
    try {
      if (result.error) throw result.error;
      const exitCode = spawnExitCode(result);
      if (exitCode !== 0) process.exit(exitCode);
    } finally {
      result.releaseSignals?.();
    }
  };
  const lockSandbox = deps.withSandboxMutationLock ?? withSandboxMutationLock;
  await lockSandbox(sandboxName, async () => {
    const current = inspectPortableAgentReceiptDisposition(sandboxName);
    if ((current.kind === "hermes") !== hermesPortableSnapshot) {
      throw new Error("Hermes portable lifecycle authority changed before agent launch.");
    }
    if (current.kind !== "hermes") {
      beforeOrdinaryLaunch?.();
      await runOrdinaryAgent();
      return;
    }
    if (current.phase !== "active") {
      throw new Error("Hermes portable lifecycle authority changed before agent launch.");
    }
    const getSandbox = deps.getSandbox ?? getKnownSandboxTarget;
    const registered = getSandbox(sandboxName);
    if (
      agent?.name !== "hermes" ||
      entry?.agent !== "hermes" ||
      !registered ||
      registered.agent !== "hermes" ||
      registered.gatewayName !== entry.gatewayName ||
      registered.lifecycleGeneration !== entry.lifecycleGeneration ||
      current.gatewayName !== entry.gatewayName ||
      current.lifecycleGeneration !== entry.lifecycleGeneration
    ) {
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
    const finalRecovery = recoverPortableDemoSandboxLifecycleForConnect(
      sandboxName,
      registered,
      gatewayName,
    );
    if (finalRecovery.kind === "not-installed") {
      throw new Error("Hermes portable lifecycle authority disappeared at agent launch.");
    }
    await runHermesPortableAgent(gatewayName);
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
  let acceptedReadinessSetup: (() => void) | undefined;
  while (true) {
    if (decision.kind === "accepted") {
      const acceptedDecision = decision;
      const disposition = inspectPortableAgentReceiptDisposition(sandboxName);
      const hermesPortable = disposition.kind === "hermes";
      acceptedReadinessSetup = () => {
        printInteractiveSessionHints(sandboxName);
        completeReadinessQualifiedInteractiveSessionSetup(
          sandboxName,
          acceptedDecision.agent,
          acceptedDecision.sb,
        );
      };
      session = {
        agent: acceptedDecision.agent,
        sb: acceptedDecision.sb,
        hermesPortable,
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
  const { agent, sb, hermesPortable = false } = session;
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
    await launchCuaUnderMutationLocks(sandboxName, deps, () => {
      acceptedReadinessSetup?.();
      prepareHermesLightTerminalSkin(sandboxName, agent, process.env);
    });
    return;
  }
  const command = ["bash", "-lc", agentCommand];
  await launchAgentWithPortableAuthority(
    sandboxName,
    agent,
    sb,
    hermesPortable,
    command,
    deps,
    acceptedReadinessSetup,
  );
}
