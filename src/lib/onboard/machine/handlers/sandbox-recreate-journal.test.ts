// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { decisionSelected } from "../../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../../state/onboard-checkpoint-migrate";
import { createSession, type Session } from "../../../state/onboard-session";
import { fingerprintSandboxRecreateValue } from "../../sandbox-recreate-transaction";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

it("journals not-ready repair on the selected non-default gateway (#6492)", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  session.steps.sandbox.status = "complete";
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw-31818",
      gatewayPort: 31818,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  const sourceEntry = {
    name: "saved",
    provider: "provider",
    model: "model",
    endpointUrl: null,
    preferredInferenceApi: "openai-completions",
    webSearchEnabled: false,
    toolDisclosure: "progressive" as const,
    fromDockerfile: null,
    hermesAuthMethod: null,
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
  };
  const phases: Array<string | null> = [];
  const updateSession = vi.fn((mutator: (value: Session) => Session | void) => {
    mutator(session);
    phases.push(session.checkpoint?.sandboxRecreate?.phase ?? null);
    return session;
  });
  const getSandboxRecreateObservation = vi.fn(
    () =>
      ({
        state: "not_ready",
        liveIdentityFingerprint: fingerprintSandboxRecreateValue("openshell-source-id"),
      }) as const,
  );
  const createSandbox = vi.fn(async () => "saved");
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation,
      getSandboxRegistryEntry: () => sourceEntry,
      updateSession,
      createSandbox,
    },
    session,
  );

  await handleSandboxState({
    ...baseOptions(deps, session),
    resume: true,
    sandboxName: "saved",
    gatewayName: "nemoclaw-31818",
  });

  expect(calls.repairSandbox).not.toHaveBeenCalled();
  expect(createSandbox).toHaveBeenCalledOnce();
  const createIntent = createSandbox.mock.calls[0]?.at(-1);
  expect(createIntent).toMatchObject({
    recreate: true,
    recreateTransaction: {
      id: expect.any(String),
      targetGeneration: expect.any(String),
      targetIntentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  expect(getSandboxRecreateObservation).toHaveBeenCalledWith("saved");
  expect(phases).toEqual(
    expect.arrayContaining(["planned", "registry_committing", "completed", null]),
  );
  expect(session.checkpoint?.sandboxRecreate).toBeNull();
});
