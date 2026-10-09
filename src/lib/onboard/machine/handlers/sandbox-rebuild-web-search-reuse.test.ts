// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { decisionSelected, decisionUnset } from "../../../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointSandboxRecreatePhase,
  type CheckpointSandboxRecreateTransaction,
  type OnboardCheckpoint,
} from "../../../state/onboard-checkpoint-types";
import type { SandboxEntry } from "../../../state/registry";
import { createSession, type Session } from "../../../state/onboard-session";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import { handleSandboxState } from "./sandbox";
import { fingerprintSandboxRegistryEntry } from "../../sandbox-recreate-transaction";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

vi.mocked(detectMessagingChannelsFromEnv).mockReturnValue([]);

const SANDBOX_NAME = "brave-rebuild";
const PROVIDER_NAME = `${SANDBOX_NAME}-brave-search`;
const AT = "2026-01-01T00:00:00.000Z";
const TARGET_INTENT_FINGERPRINT = "target-intent";

function sourceRegistryEntry(): SandboxEntry {
  return {
    name: SANDBOX_NAME,
    provider: "provider",
    model: "model",
    endpointUrl: null,
    preferredInferenceApi: "openai-completions",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    webSearchEnabled: false,
    toolDisclosure: "progressive",
    fromDockerfile: null,
    hermesAuthMethod: null,
  };
}

function recreateTransaction(
  overrides: Partial<CheckpointSandboxRecreateTransaction> = {},
): CheckpointSandboxRecreateTransaction {
  return {
    version: 1,
    id: "recreate-1",
    revision: 1,
    sandboxName: SANDBOX_NAME,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    sourceRegistryFingerprint: fingerprintSandboxRegistryEntry(sourceRegistryEntry()),
    sourceLiveIdentityFingerprint: null,
    sourceWorkload: null,
    targetIntentFingerprint: TARGET_INTENT_FINGERPRINT,
    targetGeneration: "target-generation",
    targetLiveIdentityFingerprint: null,
    phase: "deleted",
    startedAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function rebuiltCheckpoint(
  sandboxRecreate: CheckpointSandboxRecreateTransaction | null,
): OnboardCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    profile: { kind: "selected", value: "default" },
    runtimeAuthority: { kind: "unset" },
    sessionId: "sess-1",
    machineState: "sandbox",
    updatedAt: AT,
    sandboxIdentity: decisionSelected({
      name: SANDBOX_NAME,
      agent: "openclaw",
    }),
    webSearch: decisionUnset(),
    messaging: decisionUnset(),
    resourceProfile: decisionUnset(),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
    effectGroups: {},
    bindings: { credentialEnvs: [], registeredProviders: [] },
    sandboxRecreate,
  };
}

/**
 * The session `rebuild` hands to `onboard --resume`: it resets the session and
 * derives a fresh checkpoint after destroying the sandbox, so no staged
 * credential receipt survives and the recreate journal is the only ownership
 * record left (#8717).
 */
function rebuiltSession(
  sandboxRecreate: CheckpointSandboxRecreateTransaction | null,
  stagedCredentialProviders: string[] = [],
): Session {
  const session = createSession({
    sessionId: "sess-1",
    agent: "openclaw",
    sandboxName: SANDBOX_NAME,
    stagedCredentialProviders,
  });
  session.checkpoint = rebuiltCheckpoint(sandboxRecreate);
  return session;
}

function recreateWebSearch(
  session: Session,
  overrides: {
    env?: NodeJS.ProcessEnv;
    recreateJournalTargetIntentFingerprint?: string | null;
    providerMatchesGatewayCredential?: (
      name: string,
      type: string,
      credentialEnv: string,
    ) => boolean;
  } = {},
) {
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "missing",
      getSandboxRegistryEntry: sourceRegistryEntry,
      providerMatchesGatewayCredential:
        overrides.providerMatchesGatewayCredential ??
        ((name, type, credentialEnv) =>
          name === PROVIDER_NAME && type === "brave" && credentialEnv === "BRAVE_API_KEY"),
    },
    session,
  );
  const run = handleSandboxState({
    ...baseOptions(deps, session),
    resume: true,
    sandboxName: SANDBOX_NAME,
    webSearchConfig: { fetchEnabled: true, provider: "brave" },
    env: overrides.env ?? {},
    // `rebuild` hands the journaled fingerprint to the recreate it drives.
    recreateJournalTargetIntentFingerprint:
      overrides.recreateJournalTargetIntentFingerprint === undefined
        ? TARGET_INTENT_FINGERPRINT
        : overrides.recreateJournalTargetIntentFingerprint,
  });
  return { run, calls };
}

describe("rebuild web-search credential reuse", () => {
  it("reuses the registered gateway credential when the recreate journal owns the deleted sandbox (#8717)", async () => {
    const { run, calls } = recreateWebSearch(rebuiltSession(recreateTransaction()));

    await run;

    expect(calls.validateBrave).not.toHaveBeenCalled();
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Reusing Brave Search credential registered with OpenShell.",
    );
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
  });

  it.each<CheckpointSandboxRecreatePhase>(["planned", "deleting"])(
    "revalidates while the recreate journal is still at phase %s",
    async (phase) => {
      const { run, calls } = recreateWebSearch(rebuiltSession(recreateTransaction({ phase })));

      await run;

      expect(calls.validateBrave).toHaveBeenCalledTimes(1);
    },
  );

  it("never reuses on a recreate journal that names a different sandbox", async () => {
    const { run, calls } = recreateWebSearch(
      rebuiltSession(recreateTransaction({ sandboxName: "other-sandbox" })),
    );

    await expect(run).rejects.toThrow("has a different recreate transaction in progress");

    expect(calls.validateBrave).toHaveBeenCalledTimes(1);
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("revalidates when no recreate journal and no staged receipt vouch for the provider", async () => {
    const { run, calls } = recreateWebSearch(rebuiltSession(null));

    await run;

    expect(calls.validateBrave).toHaveBeenCalledTimes(1);
  });

  it("never lets journal ownership alone stand in for a matching gateway binding", async () => {
    const { run, calls } = recreateWebSearch(rebuiltSession(recreateTransaction()), {
      providerMatchesGatewayCredential: () => false,
    });

    await expect(run).rejects.toThrow("exit 1");

    expect(calls.validateBrave).toHaveBeenCalledTimes(1);
    expect(calls.error).toHaveBeenCalledWith(
      "  OpenShell did not retain the selected credential bindings.",
    );
  });

  it("never reuses on a resident journal that this run was not handed", async () => {
    const { run, calls } = recreateWebSearch(rebuiltSession(recreateTransaction()), {
      recreateJournalTargetIntentFingerprint: null,
    });

    await expect(run).rejects.toThrow("has a different recreate transaction in progress");

    expect(calls.validateBrave).toHaveBeenCalledTimes(1);
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("never reuses on a handed-off journal whose target intent no longer matches", async () => {
    const { run, calls } = recreateWebSearch(
      rebuiltSession(recreateTransaction({ targetIntentFingerprint: "stale-intent" })),
    );

    await expect(run).rejects.toThrow("has a different recreate transaction in progress");

    expect(calls.validateBrave).toHaveBeenCalledTimes(1);
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("lets a host credential beat every reuse path", async () => {
    const { run, calls } = recreateWebSearch(rebuiltSession(recreateTransaction()), {
      env: { BRAVE_API_KEY: "host-key" },
    });

    await run;

    expect(calls.validateBrave).toHaveBeenCalledTimes(1);
  });

  it("keeps reusing a staged receipt without any recreate journal", async () => {
    const { run, calls } = recreateWebSearch(rebuiltSession(null, [PROVIDER_NAME]));

    await run;

    expect(calls.validateBrave).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
  });
});
