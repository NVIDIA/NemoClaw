// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { prepareSandboxToolDisclosure } from "../../tool-disclosure-flow";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

vi.mock("../../sandbox-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sandbox-registration")>()),
  withSandboxImageRegistrationFence: async <T>(operation: () => Promise<T> | T) => operation(),
}));

vi.mock("../../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/registry")>()),
  getSandbox: vi.fn(() => null),
}));

vi.mock("../../../state/onboard-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/onboard-session")>()),
  loadSession: vi.fn(() => null),
  updateSession: vi.fn(),
}));

const ENV_KEY = "NEMOCLAW_TOOL_DISCLOSURE";

const registeredEntry = (name: string, toolDisclosure: "direct" | "progressive") => ({
  name,
  provider: "provider",
  model: "model",
  endpointUrl: null,
  credentialEnv: null,
  preferredInferenceApi: "openai-completions" as const,
  gatewayName: "nemoclaw",
  toolDisclosure,
});

/**
 * Hand the create intent that the sandbox step builds to the tool-disclosure
 * preparation that the create step runs, the way orchestration does.
 */
async function reOnboardRecordedSandbox(recorded: "direct" | "progressive", selection?: string) {
  const env = selection ? { [ENV_KEY]: selection } : {};
  vi.stubEnv(ENV_KEY, selection);
  // A selection also seeds the session, as the bootstrap does.
  const session = createSession(selection ? { toolDisclosure: selection as "direct" } : {});
  const { deps, calls } = createDeps(
    { getSandboxRegistryEntry: (name) => registeredEntry(name, recorded) },
    session,
  );
  await handleSandboxState({ ...baseOptions(deps, session), agent: { name: "hermes" }, env });
  const intent = (calls.createSandbox.mock.calls[0] as unknown[])[15] as {
    toolDisclosure?: "direct" | "progressive";
  };
  return prepareSandboxToolDisclosure(
    "alpha",
    null,
    false,
    () => ({
      existingEntry: registeredEntry("alpha", recorded),
      preservedMcpState: undefined,
      liveExists: true,
    }),
    intent.toolDisclosure ?? null,
  );
}

describe("re-onboarding a sandbox with a recorded tool disclosure (#13975)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ["direct", undefined],
    ["direct", "direct"],
    ["progressive", undefined],
    ["progressive", "progressive"],
  ] as const)(
    "reuses a sandbox recording %s when the selection is %s",
    async (recorded, selection) => {
      const plan = await reOnboardRecordedSandbox(recorded, selection);

      expect(plan).toMatchObject({
        effectiveToolDisclosure: recorded,
        toolDisclosureMigrationNeeded: false,
      });
    },
  );

  it("refuses an explicit mode that differs from the recorded one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(reOnboardRecordedSandbox("direct", "progressive")).rejects.toThrow("EXIT:1");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("sandbox records tool disclosure 'direct', but 'progressive'"),
    );
  });
});
