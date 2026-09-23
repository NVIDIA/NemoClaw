// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { bindGatewayAuthorityToCheckpoint } from "../../src/lib/onboard/gateway-authority-checkpoint";
import { createSession } from "../../src/lib/state/onboard-session";

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
