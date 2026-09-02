// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import * as agentRuntime from "../../agent/runtime";
import type { AgentDefinition } from "../../agent/definition-types";
import { spawnExitCode } from "../../core/process-exit";
import { resolveSandboxGatewayName } from "../../gateway-runtime-action";
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
  inspectPortableAgentReceiptDisposition,
  captureHermesPortableAcceptedReadinessObservation,
  policyObservationRecoveryAction,
  qualifyHermesPortableAcceptedReadinessAuthority,
  qualifyHermesPortableOperatingCommandAuthority,
  requalifyPortableAgentSandboxAuthority,
  recoverPortableDemoSandboxLifecycleForConnect,
  requireHermesPortableActiveLifecycleAuthority,
  type HermesPortableActiveLifecycleAuthority,
  withSandboxLifecycleLock as withSandboxMutationLock,
} from "./gateway-state";
import { getKnownSandboxTarget } from "./gateway-target";
import {
  createBoundLaunchReadinessDeps,
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
  resolveSandboxGatewayName?: typeof resolveSandboxGatewayName;
  withSandboxMutationLock?: typeof withSandboxMutationLock;
  inspectLaunchReadiness?: typeof inspectLaunchReadiness;
  publishLaunchReadiness?: typeof publishLaunchReadiness;
  withLaunchReadinessMutationGate?: typeof withLaunchReadinessMutationGate;
  now?: () => number;
  writeLaunchTiming?: (line: string) => void;
}

type LaunchReadinessAction = "accepted" | "prepared";

function createLaunchPreExecTiming(deps: LaunchSandboxDeps): {
  emit(action: LaunchReadinessAction): void;
} {
  const now = deps.now ?? (() => performance.now());
  const write = deps.writeLaunchTiming ?? ((line: string) => console.log(line));
  const safeNow = (): number | null => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
  const startedAt = safeNow();
  let emitted = false;
  return {
    emit(action): void {
      if (emitted) return;
      emitted = true;
      try {
        const finishedAt = safeNow();
        const elapsedMs =
          startedAt === null || finishedAt === null
            ? 0
            : Math.max(0, Math.round(finishedAt - startedAt));
        write(`  Launch timing: preExec=${String(elapsedMs)}ms readinessAction=${action}`);
      } catch {
        // Timing evidence must never change launch behavior.
      }
    },
  };
}

type HermesPortableReadinessCommandAuthority = ReturnType<
  typeof qualifyHermesPortableOperatingCommandAuthority
>;

type HermesPortableAcceptedLaunchAuthority = {
  readonly active: HermesPortableActiveLifecycleAuthority;
  readonly command: HermesPortableReadinessCommandAuthority;
};

async function inspectLaunchReadinessForLaunch(
  sandboxName: string,
  deps: LaunchSandboxDeps,
): Promise<{
  readonly decision: Awaited<ReturnType<typeof inspectLaunchReadiness>>;
  readonly hermesAuthority: HermesPortableAcceptedLaunchAuthority | null;
}> {
  const inspect = deps.inspectLaunchReadiness ?? inspectLaunchReadiness;
  const readSandbox = deps.getSandbox ?? getKnownSandboxTarget;
  if (inspectPortableAgentReceiptDisposition(sandboxName).kind !== "hermes") {
    return { decision: await inspect(sandboxName), hermesAuthority: null };
  }
  if (readSandbox(sandboxName)?.agent !== "hermes") {
    throw new Error("Hermes portable registry authority changed before launch readiness.");
  }

  const lockSandbox = deps.withSandboxMutationLock ?? withSandboxMutationLock;
  return lockSandbox(sandboxName, async () => {
    const lifecycleDeps = { readRegistry: readSandbox };
    let active = requireHermesPortableActiveLifecycleAuthority(
      sandboxName,
      undefined,
      lifecycleDeps,
    );
    let qualified = qualifyHermesPortableAcceptedReadinessAuthority(sandboxName);
    if (qualified.kind === "requalification-required") {
      const requalified = requalifyPortableAgentSandboxAuthority(sandboxName, lifecycleDeps);
      if (requalified.kind === "not-installed" || requalified.kind === "not-hermes") {
        throw new Error("Hermes portable lifecycle authority changed before launch readiness.");
      }
      active = requireHermesPortableActiveLifecycleAuthority(sandboxName, active, lifecycleDeps);
      qualified = qualifyHermesPortableAcceptedReadinessAuthority(sandboxName, {
        priorReceiptAuthority: requalified,
      });
      if (qualified.kind === "requalification-required") {
        throw new Error("Hermes portable schema-6 authority was not published before launch.");
      }
    }
    const command = qualified.commandAuthority;
    const capture = (args: string[], options = {}) =>
      captureHermesPortableAcceptedReadinessObservation(command, args, options);
    command.assertCurrent();
    const decision = await inspect(sandboxName, {
      ...createBoundLaunchReadinessDeps(capture),
      getSandbox: readSandbox,
      withSandboxLock: async (_name, operation) => operation(),
    });
    command.assertCurrent();
    const current = requireHermesPortableActiveLifecycleAuthority(
      sandboxName,
      active,
      lifecycleDeps,
    );
    if (decision.kind === "accepted" && !isDeepStrictEqual(decision.sb, current.entry)) {
      throw new Error("Hermes portable registry authority changed during launch readiness.");
    }
    return {
      decision,
      hermesAuthority: decision.kind === "accepted" ? { active: current, command } : null,
    };
  });
}

async function launchAgentWithPortableAuthority(
  sandboxName: string,
  agent: AgentDefinition | null,
  entry: SandboxEntry | null,
  hermesPortableSnapshot: boolean,
  command: readonly string[],
  deps: LaunchSandboxDeps,
  acceptedHermesAuthority: HermesPortableAcceptedLaunchAuthority | null,
  beforeOrdinaryLaunch?: () => void,
  beforeAgentExec?: () => void,
): Promise<void> {
  const runOrdinaryAgent = async (): Promise<void> => {
    prepareHermesLightTerminalSkin(sandboxName, agent, process.env);
    beforeAgentExec?.();
    await execSandbox(sandboxName, command, {
      tty: true,
      stdin: true,
      timeoutSeconds: 0,
    });
  };
  const runHermesPortableAgent = async (
    gatewayName: string,
    commandAuthority: HermesPortableReadinessCommandAuthority,
  ): Promise<void> => {
    const options = {
      tty: true,
      stdin: true,
      timeoutSeconds: 0,
      subprocessEnv: commandAuthority.env,
    } as const;
    commandAuthority.assertCurrent();
    beforeAgentExec?.();
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
    const readSandbox = deps.getSandbox ?? getKnownSandboxTarget;
    const registered = readSandbox(sandboxName);
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
    if (acceptedHermesAuthority) {
      requireHermesPortableActiveLifecycleAuthority(sandboxName, acceptedHermesAuthority.active, {
        readRegistry: readSandbox,
      });
      if (!isDeepStrictEqual(registered, acceptedHermesAuthority.active.entry)) {
        throw new Error("Hermes portable registry authority changed before agent launch.");
      }
      acceptedHermesAuthority.command.assertCurrent();
      await runHermesPortableAgent(gatewayName, acceptedHermesAuthority.command);
      return;
    }
    const recovery = recoverPortableDemoSandboxLifecycleForConnect(
      sandboxName,
      registered,
      gatewayName,
    );
    if (recovery.kind === "not-installed") {
      throw new Error("Hermes portable lifecycle authority disappeared before agent launch.");
    }
    const finalReceipt = inspectPortableAgentReceiptDisposition(sandboxName);
    const finalRegistered = readSandbox(sandboxName);
    if (
      finalReceipt.kind !== "hermes" ||
      finalReceipt.phase !== "active" ||
      !finalRegistered ||
      finalRegistered.agent !== "hermes" ||
      finalRegistered.gatewayName !== registered.gatewayName ||
      finalRegistered.lifecycleGeneration !== registered.lifecycleGeneration ||
      finalRegistered.lifecycleLiveIdentityFingerprint !==
        registered.lifecycleLiveIdentityFingerprint ||
      finalRegistered.openshellDriver !== registered.openshellDriver ||
      finalRegistered.openshellVersion !== registered.openshellVersion ||
      finalReceipt.gatewayName !== registered.gatewayName ||
      finalReceipt.lifecycleGeneration !== registered.lifecycleGeneration ||
      finalReceipt.liveIdentityFingerprint !== registered.lifecycleLiveIdentityFingerprint
    ) {
      throw new Error("Hermes portable lifecycle authority changed at agent launch.");
    }
    await runHermesPortableAgent(
      gatewayName,
      qualifyHermesPortableOperatingCommandAuthority(sandboxName),
    );
  });
}

export async function launchSandbox(
  sandboxName: string,
  deps: LaunchSandboxDeps = {},
): Promise<void> {
  const launchTiming = createLaunchPreExecTiming(deps);
  const enterMutationGate = deps.withLaunchReadinessMutationGate ?? withLaunchReadinessMutationGate;
  let inspection = await inspectLaunchReadinessForLaunch(sandboxName, deps);
  let decision = inspection.decision;
  let acceptedHermesAuthority = inspection.hermesAuthority;
  let session: Awaited<ReturnType<typeof prepareInteractiveSession>>;
  let acceptedReadinessSetup: (() => void) | undefined;
  let readinessAction: LaunchReadinessAction = "prepared";
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
      readinessAction = "accepted";
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
      inspection = await inspectLaunchReadinessForLaunch(sandboxName, deps);
      decision = inspection.decision;
      acceptedHermesAuthority = inspection.hermesAuthority;
      continue;
    }
    if (gated.kind === "unsafe") throw new Error(LAUNCH_READINESS_FENCE_REPAIR);
    if (gated.value.publication?.kind === "policy-observation-failed") {
      const gatewayName = publicationRequest.gatewayName ?? "the recorded gateway";
      throw new Error(
        [
          `Launch readiness final policy validation failed for sandbox '${sandboxName}' on gateway '${gatewayName}': ${gated.value.publication.error.message}`,
          policyObservationRecoveryAction(
            gated.value.publication.error,
            sandboxName,
            publicationRequest.gatewayName ?? undefined,
            "launch",
          ),
        ].join("\n"),
      );
    }
    if (gated.value.publication?.kind === "validation-failed") {
      throw new Error(
        `Launch readiness final validation failed due to ${gated.value.publication.category}. Retry launch.`,
      );
    }
    session = gated.value.prepared;
    break;
  }
  const { agent, sb, hermesPortable = false } = session;
  const agentCommand = agentRuntime.getInteractiveAgentCommand(agent, sb?.agent);
  if (!agentCommand) {
    throw new Error(`Cannot resolve an interactive command for sandbox '${sandboxName}'.`);
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
  const command = ["bash", "-lc", agentCommand];
  await launchAgentWithPortableAuthority(
    sandboxName,
    agent,
    sb,
    hermesPortable,
    command,
    deps,
    acceptedHermesAuthority,
    acceptedReadinessSetup,
    () => launchTiming.emit(readinessAction),
  );
}
