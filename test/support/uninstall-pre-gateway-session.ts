// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fingerprintOpenShellSandboxId } from "../../src/lib/domain/sandbox/openshell-identity";

import { bindGatewayAuthorityToCheckpoint } from "../../src/lib/onboard/gateway-authority-checkpoint";
import { createSession } from "../../src/lib/state/onboard-session";
import { createMcpLifecycleLockOwner } from "../../src/lib/state/mcp-lifecycle-lock-identity";
import { getMcpLifecycleLockPath } from "../../src/lib/state/mcp-lifecycle-lock-storage";

function writeCheckpointedPreGatewaySession(
  stateRoot: string,
  port: number,
  session: ReturnType<typeof createSession>,
  prepare: (session: ReturnType<typeof createSession>) => unknown = (value) => value,
): void {
  const gatewayName = `nemoclaw-${String(port)}`;
  bindGatewayAuthorityToCheckpoint(session, {
    endpoint: null,
    gatewayName,
    gatewayPort: port,
    mode: "nemoclaw-managed",
    requiredCapabilities: [],
    source: "standalone",
    stateDir: null,
    supervisor: null,
  });
  fs.writeFileSync(
    path.join(stateRoot, "onboard-session.json"),
    `${JSON.stringify(prepare(session))}\n`,
    { mode: 0o600 },
  );
}

function interruptedPreGatewaySession(): ReturnType<typeof createSession> {
  const now = new Date().toISOString();
  const session = createSession({ agent: "openclaw", mode: "non-interactive" });
  session.status = "failed";
  session.lastStepStarted = "preflight";
  session.failure = {
    interrupted: true,
    message: "Onboarding was interrupted during preflight.",
    recordedAt: now,
    step: "preflight",
  };
  session.steps.preflight = {
    completedAt: null,
    error: session.failure.message,
    startedAt: now,
    status: "failed",
  };
  session.machine = { revision: 1, state: "failed", stateEnteredAt: now, version: 1 };
  return session;
}

function completedPreGatewaySession(): ReturnType<typeof createSession> {
  const now = new Date().toISOString();
  const session = createSession({ agent: "openclaw", mode: "non-interactive" });
  session.resumable = false;
  session.status = "complete";
  session.machine = { revision: 1, state: "complete", stateEnteredAt: now, version: 1 };
  return session;
}

const PRE_GATEWAY_SESSION_WRITERS = {
  complete: (stateRoot, port) =>
    writeCheckpointedPreGatewaySession(stateRoot, port, completedPreGatewaySession()),
  future: (stateRoot, port) => {
    const session = interruptedPreGatewaySession();
    session.version = 999;
    writeCheckpointedPreGatewaySession(stateRoot, port, session);
  },
  interrupted: (stateRoot, port) =>
    writeCheckpointedPreGatewaySession(stateRoot, port, interruptedPreGatewaySession()),
  malformed: (stateRoot) =>
    fs.writeFileSync(path.join(stateRoot, "onboard-session.json"), "{}\n", { mode: 0o600 }),
  sparse: (stateRoot, port) =>
    writeCheckpointedPreGatewaySession(
      stateRoot,
      port,
      interruptedPreGatewaySession(),
      (session) => {
        Reflect.deleteProperty(session, "resumable");
        Reflect.deleteProperty(session.steps, "gateway");
        Reflect.deleteProperty(session.steps, "sandbox");
        return session;
      },
    ),
} satisfies Record<string, (stateRoot: string, port: number) => void>;

type PreGatewaySessionKind = keyof typeof PRE_GATEWAY_SESSION_WRITERS;

export function writePreGatewaySession(
  stateRoot: string,
  port: number,
  kind: PreGatewaySessionKind,
): void {
  PRE_GATEWAY_SESSION_WRITERS[kind](stateRoot, port);
}

export function writeSelectedSandboxRegistry(
  stateRoot: string,
  port: number,
  nativeId?: string,
): void {
  fs.writeFileSync(
    path.join(stateRoot, "sandboxes.json"),
    `${JSON.stringify({
      defaultSandbox: "a4-test",
      sandboxes: {
        "a4-test": {
          gatewayName: port === 8080 ? "nemoclaw" : `nemoclaw-${String(port)}`,
          gatewayPort: port,
          name: "a4-test",
          openshellDriver: "docker",
          ...(nativeId
            ? { lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId(nativeId) }
            : {}),
          createdAt: "2026-09-23T00:00:00.000Z",
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
}

export function writeRetainedUninstallState(
  stateRoot: string,
  port: number,
  withSibling = false,
): void {
  writeSelectedSandboxRegistry(stateRoot, port, withSibling ? "selected-native" : undefined);
  fs.mkdirSync(path.join(stateRoot, "backups"));
  fs.writeFileSync(path.join(stateRoot, "backups", "retained.txt"), "retained user data");
  if (withSibling)
    writeSelectedSandboxRegistry(path.resolve(stateRoot, "../.."), 8080, "sibling-native");
}

export function writeRetainedUninstallStateWithStaleLock(stateRoot: string, port: number): void {
  writeRetainedUninstallState(stateRoot, port);
  const lock = getMcpLifecycleLockPath("a4-test", path.join(stateRoot, "state"));
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    lock,
    JSON.stringify({
      ...createMcpLifecycleLockOwner("a4-test", "abandoned-uninstall"),
      pid: 2_147_483_647,
    }),
    { mode: 0o600 },
  );
}

export function writeRetainedUninstallStateWithSelectedIdentity(
  stateRoot: string,
  port: number,
): void {
  writeRetainedUninstallState(stateRoot, port);
  writeSelectedSandboxRegistry(stateRoot, port, "selected-native");
}

export function dockerSandboxInspection(containerId: string, nativeId: string): string {
  return JSON.stringify([
    containerId,
    {
      "openshell.ai/managed-by": "openshell",
      "openshell.ai/sandbox-name": "a4-test",
      "openshell.ai/sandbox-id": nativeId,
      "openshell.ai/sandbox-namespace": "retained-uninstall",
    },
  ]);
}
