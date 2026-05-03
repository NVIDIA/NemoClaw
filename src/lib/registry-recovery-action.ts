// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { recoverNamedGatewayRuntime } from "./gateway-runtime-action";
import type { RecoveryResult } from "./inventory-commands";
import * as onboardSession from "./onboard-session";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./openshell-timeouts";
import { captureOpenshell } from "./openshell-runtime";
import * as registry from "./registry";
import type { SandboxEntry } from "./registry";
import { resolveOpenshell } from "./resolve-openshell";
import { parseLiveSandboxNames } from "./runtime-recovery";
import { validateName } from "./runner";

type Session = ReturnType<typeof onboardSession.loadSession>;

type RecoveredSandboxMetadata = Partial<
  Pick<SandboxEntry, "model" | "provider" | "gpuEnabled" | "policies" | "nimContainer" | "agent">
> & {
  policyPresets?: string[] | null;
};

function buildRecoveredSandboxEntry(
  name: string,
  metadata: RecoveredSandboxMetadata = {},
): SandboxEntry {
  return {
    name,
    model: metadata.model || null,
    provider: metadata.provider || null,
    gpuEnabled: metadata.gpuEnabled === true,
    policies: Array.isArray(metadata.policies)
      ? metadata.policies
      : Array.isArray(metadata.policyPresets)
        ? metadata.policyPresets
        : [],
    nimContainer: metadata.nimContainer || null,
    agent: metadata.agent || null,
  };
}

function upsertRecoveredSandbox(name: string, metadata: RecoveredSandboxMetadata = {}) {
  let validName;
  try {
    validName = validateName(name, "sandbox name");
  } catch {
    return false;
  }

  const entry = buildRecoveredSandboxEntry(validName, metadata);
  if (registry.getSandbox(validName)) {
    registry.updateSandbox(validName, entry);
    return false;
  }
  registry.registerSandbox(entry);
  return true;
}

function shouldRecoverRegistryEntries(
  current: { sandboxes: Array<{ name: string }>; defaultSandbox?: string | null },
  session: Session | null,
  requestedSandboxName: string | null,
) {
  const sessionSandboxName = session?.sandboxName ?? null;
  const hasSessionSandbox = Boolean(sessionSandboxName);
  const missingSessionSandbox =
    hasSessionSandbox && !current.sandboxes.some((sandbox) => sandbox.name === sessionSandboxName);
  const missingRequestedSandbox =
    Boolean(requestedSandboxName) &&
    !current.sandboxes.some((sandbox) => sandbox.name === requestedSandboxName);
  const hasRecoverySeed =
    current.sandboxes.length > 0 || hasSessionSandbox || Boolean(requestedSandboxName);
  return {
    missingRequestedSandbox,
    shouldRecover:
      hasRecoverySeed &&
      (current.sandboxes.length === 0 || missingRequestedSandbox || missingSessionSandbox),
  };
}

/**
 * #2753: a session that records sandboxName but never completed the sandbox
 * step is a phantom from an interrupted onboard. Going forward, the onboard
 * fix prevents such writes; this guard catches stale on-disk sessions that
 * pre-date the fix so `nemoclaw list` does not resurrect them.
 */
function isSessionSandboxConfirmed(session: Session | null): boolean {
  if (!session?.sandboxName) return false;
  return session.steps?.sandbox?.status === "complete";
}

function seedRecoveryMetadata(
  current: { sandboxes: SandboxEntry[] },
  session: Session | null,
  requestedSandboxName: string | null,
) {
  const metadataByName = new Map<string, RecoveredSandboxMetadata>(
    current.sandboxes.map((sandbox: SandboxEntry) => [sandbox.name, sandbox]),
  );
  let recoveredFromSession = false;

  if (!isSessionSandboxConfirmed(session) || !session?.sandboxName) {
    return { metadataByName, recoveredFromSession };
  }

  metadataByName.set(
    session.sandboxName,
    buildRecoveredSandboxEntry(session.sandboxName, {
      model: session.model || null,
      provider: session.provider || null,
      nimContainer: session.nimContainer || null,
      policyPresets: session.policyPresets || null,
    }),
  );
  const sessionSandboxMissing = !current.sandboxes.some(
    (sandbox: { name: string }) => sandbox.name === session.sandboxName,
  );
  const shouldRecoverSessionSandbox =
    current.sandboxes.length === 0 ||
    sessionSandboxMissing ||
    requestedSandboxName === session.sandboxName;
  if (shouldRecoverSessionSandbox) {
    recoveredFromSession = upsertRecoveredSandbox(
      session.sandboxName,
      metadataByName.get(session.sandboxName),
    );
  }
  return { metadataByName, recoveredFromSession };
}

async function recoverRegistryFromLiveGateway(
  metadataByName: Map<string, RecoveredSandboxMetadata>,
) {
  if (!resolveOpenshell()) {
    return 0;
  }
  const recovery = await recoverNamedGatewayRuntime();
  const canInspectLiveGateway =
    recovery.recovered ||
    recovery.before?.state === "healthy_named" ||
    recovery.after?.state === "healthy_named";
  if (!canInspectLiveGateway) {
    return 0;
  }

  let recoveredFromGateway = 0;
  const liveList = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  const liveNames = Array.from<string>(parseLiveSandboxNames(liveList.output));
  for (const name of liveNames) {
    const metadata = metadataByName.get(name) || undefined;
    if (upsertRecoveredSandbox(name, metadata)) {
      recoveredFromGateway += 1;
    }
  }
  return recoveredFromGateway;
}

function applyRecoveredDefault(
  currentDefaultSandbox: string | null,
  requestedSandboxName: string | null,
  session: Session | null,
) {
  const recovered = registry.listSandboxes();
  const preferredDefault =
    requestedSandboxName || (!currentDefaultSandbox ? session?.sandboxName || null : null);
  if (
    preferredDefault &&
    recovered.sandboxes.some((sandbox: { name: string }) => sandbox.name === preferredDefault)
  ) {
    registry.setDefault(preferredDefault);
  }
  return registry.listSandboxes();
}

export async function recoverRegistryEntries({
  requestedSandboxName = null,
}: { requestedSandboxName?: string | null } = {}) {
  const current = registry.listSandboxes();
  const session = onboardSession.loadSession();
  const recoveryCheck = shouldRecoverRegistryEntries(current, session, requestedSandboxName);
  if (!recoveryCheck.shouldRecover) {
    return { ...current, recoveredFromSession: false, recoveredFromGateway: 0 };
  }

  const seeded = seedRecoveryMetadata(current, session, requestedSandboxName);
  const shouldProbeLiveGateway =
    current.sandboxes.length > 0 || Boolean(session?.sandboxName) || Boolean(requestedSandboxName);
  const recoveredFromGateway = shouldProbeLiveGateway
    ? await recoverRegistryFromLiveGateway(seeded.metadataByName)
    : 0;
  const recovered = applyRecoveredDefault(current.defaultSandbox, requestedSandboxName, session);
  return {
    ...recovered,
    recoveredFromSession: seeded.recoveredFromSession,
    recoveredFromGateway,
  };
}
