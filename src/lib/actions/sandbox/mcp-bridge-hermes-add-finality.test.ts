// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    adapter: false,
    attachment: false,
    finality: "committed" as "absent" | "committed" | "unknown",
    identityChanged: false,
    policy: "absent" as "absent" | "bound" | "capability",
    provider: false,
    providerIdentityChanged: false,
    readinessDelayObservations: 0,
    registerFailure: "relay" as "generic" | "relay",
    revision: "v7",
    useRealAdapterFlow: false,
    readinessAttemptLimit: 12,
  };
  return {
    applyGeneratedPolicy: vi.fn(),
    assertAgentMcpMutationRuntimeCapability: vi.fn(),
    attachProvider: vi.fn(),
    detachProvider: vi.fn(),
    inspectAgentAdapterRegistration: vi.fn(),
    inspectHermesMcpReloadFinality: vi.fn(),
    observeMcpCredentialRevision: vi.fn(),
    observeStableMcpCredentialRevision: vi.fn(),
    observeSandboxOnGateway: vi.fn(),
    registerAgentAdapterAtCurrentCredentialRevision: vi.fn(),
    removeGeneratedPolicy: vi.fn(),
    runOpenshellProviderCommand: vi.fn(),
    state,
    unregisterAgentAdapter: vi.fn(),
    upsertMcpProvider: vi.fn(),
    waitForMcpBridgeConditionAsync: vi.fn(
      async (condition: () => Promise<boolean>, _options?: unknown) => {
        let matched = false;
        for (let attempt = 0; attempt < state.readinessAttemptLimit && !matched; attempt += 1) {
          matched = await condition();
        }
        return matched;
      },
    ),
  };
});

vi.mock("../../adapters/openshell/provider-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/provider-command")>()),
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: (_sandbox: string, operation: () => unknown) => operation(),
}));

vi.mock("../../state/mcp-lifecycle-lock/credential-ownership", () => ({
  withMcpCredentialOwnershipLock: (operation: () => unknown) => operation(),
}));

vi.mock("../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
}));

vi.mock("../../onboard/sandbox-recreate-probe", () => ({
  observeSandboxOnGateway: mocks.observeSandboxOnGateway,
}));

vi.mock("./mcp-bridge-adapters", async (importOriginal) => {
  const original = await importOriginal<typeof import("./mcp-bridge-adapters")>();
  return {
    ...original,
    assertAgentMcpMutationRuntimeCapability: mocks.assertAgentMcpMutationRuntimeCapability,
    inspectAgentAdapterRegistration: mocks.inspectAgentAdapterRegistration,
    inspectHermesMcpReloadFinality: (
      ...args: Parameters<typeof original.inspectHermesMcpReloadFinality>
    ) =>
      mocks.state.useRealAdapterFlow
        ? original.inspectHermesMcpReloadFinality(...args)
        : mocks.inspectHermesMcpReloadFinality(...args),
    observeStableMcpCredentialRevision: mocks.observeStableMcpCredentialRevision,
    registerAgentAdapterAtCurrentCredentialRevision: (
      ...args: Parameters<typeof original.registerAgentAdapterAtCurrentCredentialRevision>
    ) =>
      mocks.state.useRealAdapterFlow
        ? original.registerAgentAdapterAtCurrentCredentialRevision(...args)
        : mocks.registerAgentAdapterAtCurrentCredentialRevision(...args),
    reloadOpenClawGatewayAfterMcpMutation: vi.fn(),
    unregisterAgentAdapter: mocks.unregisterAgentAdapter,
  };
});

vi.mock("./mcp-bridge/timing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge/timing")>()),
  waitForMcpBridgeConditionAsync: mocks.waitForMcpBridgeConditionAsync,
}));

vi.mock("./mcp-bridge-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-status")>()),
  assertUnchangedStableMcpCredentialAuthorized: vi.fn(),
}));

vi.mock("./mcp-bridge-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-policy")>()),
  applyGeneratedPolicy: mocks.applyGeneratedPolicy,
  assertGeneratedPolicyMutationSafe: vi.fn(),
  removeGeneratedPolicy: mocks.removeGeneratedPolicy,
}));

vi.mock("../../policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../policy")>()),
  getPresetContentGatewayState: vi.fn((_sandbox: string, content: string) => {
    const requested = content.includes("credential_binding") ? "bound" : "capability";
    return mocks.state.policy === requested ? "match" : "absent";
  }),
}));

vi.mock("./mcp-bridge-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-provider")>()),
  assertMcpProviderRecoverable: vi.fn(() => ({ exists: true })),
  assertNoProviderCredentialCollisions: vi.fn(),
  attachProvider: mocks.attachProvider,
  detachProvider: mocks.detachProvider,
  ensureMcpBridgeProviderProfile: vi.fn(),
  getMcpProviderInspectionRuntimeSelection: vi.fn(() => ({
    gatewayName: "nemoclaw-9090",
    workspace: "default",
  })),
  inspectMcpProvider: vi.fn(() =>
    mocks.state.provider
      ? {
          credentialKeys: ["GITHUB_TOKEN"],
          exists: true,
          id: mocks.state.providerIdentityChanged
            ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
            : "11111111-2222-4333-8444-555555555555",
          resourceVersion: 7,
          type: "nemoclaw-mcp-v1",
        }
      : {
          credentialKeys: null,
          exists: false,
          id: null,
          resourceVersion: null,
          type: null,
        },
  ),
  inspectMcpProviderAttachments: vi.fn(() => ({
    attachments: mocks.state.attachment
      ? [
          {
            credentialKeys: ["GITHUB_TOKEN"],
            name: "alpha-mcp-github",
            providerId: "11111111-2222-4333-8444-555555555555",
          },
        ]
      : [],
  })),
  observeMcpCredentialRevision: mocks.observeMcpCredentialRevision,
  refreshMcpProviderEnvironment: vi.fn(),
  upsertMcpProvider: mocks.upsertMcpProvider,
  waitForAttachedMcpCredential: vi.fn(() => "v7"),
  waitForDetachedMcpCredential: vi.fn(),
}));

function configureUpsertMcpProviderMock(): void {
  mocks.upsertMcpProvider.mockImplementation(
    async (...args: Parameters<typeof upsertMcpProvider>) => {
      const [, , options] = args;
      const updating = mocks.state.provider;
      const action = updating ? "updated" : "created";
      await options.prepareMutation?.(updating ? "update" : "create");
      mocks.state.provider = true;
      return {
        action,
        inspection: {
          credentialKeys: ["GITHUB_TOKEN"],
          exists: true,
          id: "11111111-2222-4333-8444-555555555555",
          resourceVersion: 7,
          type: "nemoclaw-mcp-v1",
        },
      };
    },
  );
}

vi.mock("./mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-state")>()),
  assertNoDerivedResourceCollision: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn(),
  getBridgeAdapter: vi.fn(() => "hermes-config"),
  getSandboxAgent: vi.fn(() => ({ name: "hermes" })),
  getSandboxOrThrow: vi.fn(() => ({
    agent: "hermes",
    gatewayName: "nemoclaw-9090",
    gatewayPort: 9090,
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
    name: "alpha",
  })),
}));

vi.mock("./mcp-bridge-source", () => ({
  inspectPolicyOnlyMcpEntry: vi.fn(() => null),
  inspectSourceBridgeState: vi.fn(() => ({
    bridges: {},
    sources: { legacy: {}, native: {} },
  })),
}));

vi.mock("./mcp-bridge-url-validation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-url-validation")>()),
  preflightMcpServerUrlResolvedTarget: vi.fn(() => ({ addresses: ["8.8.8.8"] })),
}));

vi.mock("./mcp-bridge-validation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-validation")>()),
  assertMcpCredentialBoundaryRuntimeVersion: vi.fn(),
}));

import { HermesMcpReloadRelayLossError } from "./mcp-bridge-adapters";
import { addMcpBridge } from "./mcp-bridge-add-restart";
import {
  inspectMcpProvider,
  inspectMcpProviderAttachments,
  upsertMcpProvider,
} from "./mcp-bridge-provider";
import * as policies from "../../policy";

async function runAdd(): Promise<void> {
  await addMcpBridge("alpha", {
    env: [{ name: "GITHUB_TOKEN" }],
    server: "github",
    url: "https://8.8.8.8/mcp",
  });
}

describe("Hermes MCP add reload finality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureUpsertMcpProviderMock();
    Object.assign(mocks.state, {
      adapter: false,
      attachment: false,
      finality: "committed",
      identityChanged: false,
      policy: "absent",
      provider: false,
      providerIdentityChanged: false,
      readinessDelayObservations: 0,
      registerFailure: "relay",
      revision: "v7",
      useRealAdapterFlow: false,
      readinessAttemptLimit: 12,
    });
    process.env.GITHUB_TOKEN = "host-only-secret";
    delete process.env.NEMOCLAW_TRUSTED_PRIVATE_HOSTS;

    mocks.assertAgentMcpMutationRuntimeCapability.mockResolvedValue(undefined);

    mocks.applyGeneratedPolicy.mockImplementation((_sandbox, _entry, _target, options = {}) => {
      mocks.state.policy = options.bindCredential === false ? "capability" : "bound";
    });
    mocks.attachProvider.mockImplementation(() => {
      mocks.state.attachment = true;
    });
    mocks.detachProvider.mockImplementation(() => {
      mocks.state.attachment = false;
      return "detached";
    });
    mocks.inspectAgentAdapterRegistration.mockImplementation(() => ({
      state: mocks.state.adapter ? "registered" : "absent",
    }));
    mocks.inspectHermesMcpReloadFinality.mockImplementation(() =>
      mocks.state.finality === "unknown"
        ? { state: "unknown", detail: "read-only helper could not prove finality" }
        : { state: mocks.state.finality },
    );
    mocks.observeMcpCredentialRevision.mockImplementation(() => mocks.state.revision);
    mocks.observeStableMcpCredentialRevision.mockImplementation(async () => mocks.state.revision);
    vi.mocked(inspectMcpProvider)
      .mockReset()
      .mockImplementation(async () =>
        mocks.state.provider
          ? {
              credentialKeys: ["GITHUB_TOKEN"],
              exists: true,
              id: mocks.state.providerIdentityChanged
                ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
                : "11111111-2222-4333-8444-555555555555",
              resourceVersion: 7,
              type: "nemoclaw-mcp-v1",
            }
          : {
              credentialKeys: null,
              exists: false,
              id: null,
              resourceVersion: null,
              type: null,
            },
      );
    vi.mocked(inspectMcpProviderAttachments)
      .mockReset()
      .mockImplementation(async () => ({
        attachments: mocks.state.attachment
          ? [
              {
                credentialKeys: ["GITHUB_TOKEN"],
                name: "alpha-mcp-github",
                providerId: "11111111-2222-4333-8444-555555555555",
              },
            ]
          : [],
      }));
    vi.mocked(policies.getPresetContentGatewayState)
      .mockReset()
      .mockImplementation(async (_sandbox: string, content: string) => {
        const requested = content.includes("credential_binding") ? "bound" : "capability";
        return mocks.state.policy === requested ? "match" : "absent";
      });
    mocks.runOpenshellProviderCommand.mockReset();
    let identityObservations = 0;
    mocks.observeSandboxOnGateway.mockImplementation(() => {
      identityObservations += 1;
      return {
        liveIdentityFingerprint:
          mocks.state.identityChanged && identityObservations > 1 ? "b".repeat(64) : "a".repeat(64),
        state:
          identityObservations > 1 &&
          identityObservations <= 1 + mocks.state.readinessDelayObservations
            ? "not_ready"
            : "ready",
      };
    });
    mocks.registerAgentAdapterAtCurrentCredentialRevision.mockImplementation(() => {
      const failures = {
        generic: () => new Error("generic adapter failure"),
        relay: () => {
          mocks.state.adapter = mocks.state.finality === "committed";
          return new HermesMcpReloadRelayLossError("v7");
        },
      };
      throw failures[mocks.state.registerFailure]();
    });
    mocks.removeGeneratedPolicy.mockImplementation(() => {
      mocks.state.policy = "absent";
    });
    mocks.unregisterAgentAdapter.mockImplementation(() => {
      mocks.state.adapter = false;
      return "removed";
    });
  });

  it("leaves all MCP state unchanged when a legacy Hermes helper lacks finality capability", async () => {
    mocks.assertAgentMcpMutationRuntimeCapability.mockRejectedValue(
      new Error(
        "Hermes sandbox 'alpha' does not provide managed MCP reconcile-finality capability version 1. Rebuild the sandbox before changing authenticated MCP state.",
      ),
    );

    await expect(runAdd()).rejects.toThrow(
      "does not provide managed MCP reconcile-finality capability version 1. Rebuild the sandbox",
    );
    expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.upsertMcpProvider).not.toHaveBeenCalled();
    expect(mocks.attachProvider).not.toHaveBeenCalled();
    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
  });

  it("accepts exact committed state without repeating or rolling back the mutation", async () => {
    await expect(runAdd()).resolves.toBeUndefined();

    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).toHaveBeenCalledOnce();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("waits for the same sandbox identity to return ready before proving finality", async () => {
    mocks.state.readinessDelayObservations = 2;

    await expect(runAdd()).resolves.toBeUndefined();

    expect(mocks.observeSandboxOnGateway).toHaveBeenCalledTimes(5);
    expect(mocks.inspectHermesMcpReloadFinality).toHaveBeenCalledOnce();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("uses one fake-clock deadline when readiness takes longer than thirty seconds", async () => {
    let nowMs = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    mocks.state.readinessDelayObservations = 31;
    mocks.state.readinessAttemptLimit = 40;
    mocks.waitForMcpBridgeConditionAsync.mockImplementationOnce(
      async (condition: () => Promise<boolean>, optionsValue?: unknown) => {
        const options = optionsValue as { deadlineMs: number; now: () => number };
        expect(options.deadlineMs).toBe(621_000);
        expect(options.now()).toBe(nowMs);
        const attempt = async (remaining: number): Promise<boolean> =>
          remaining <= 0 || nowMs >= options.deadlineMs
            ? false
            : (await condition())
              ? true
              : ((nowMs += 1_000), attempt(remaining - 1));
        return attempt(40);
      },
    );

    await expect(runAdd()).resolves.toBeUndefined();

    expect(nowMs).toBeGreaterThan(31_000);
    expect(mocks.observeSandboxOnGateway.mock.calls[1]?.[3]).toBe(620_000);
    expect(mocks.inspectHermesMcpReloadFinality).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ server: "github" }),
      "v7",
      expect.any(Object),
      { deadlineMs: 676_000, readinessDeadlineMs: 621_000 },
    );
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("returns unknown without cleanup when external proof crosses the finality deadline", async () => {
    let nowMs = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    mocks.inspectAgentAdapterRegistration.mockImplementation((...args: unknown[]) => {
      nowMs = args[5] === undefined ? nowMs : 676_000;
      return { state: mocks.state.adapter ? "registered" : "absent" };
    });

    try {
      await expect(runAdd()).rejects.toThrow(/outcome.*unknown.*did not roll back or repeat/iu);

      expect(
        mocks.inspectAgentAdapterRegistration.mock.calls.filter((args) => args[5] !== undefined),
      ).toHaveLength(1);
      expect(
        vi.mocked(inspectMcpProvider).mock.calls.filter((args) => args[3] !== undefined),
      ).toHaveLength(0);
      expect(
        vi
          .mocked(policies.getPresetContentGatewayState)
          .mock.calls.filter((args) => args[4] !== undefined),
      ).toHaveLength(0);
      expect(
        vi.mocked(inspectMcpProviderAttachments).mock.calls.filter((args) => args[3] !== undefined),
      ).toHaveLength(0);
      expect(mocks.observeStableMcpCredentialRevision).not.toHaveBeenCalled();
      expect(mocks.observeSandboxOnGateway).toHaveBeenCalledTimes(2);
      expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.detachProvider).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("decreases the shared timeout across every external recovery transport", async () => {
    let nowMs = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    mocks.inspectAgentAdapterRegistration.mockImplementation((...args: unknown[]) => {
      nowMs += args[5] === undefined ? 0 : 1_000;
      return { state: mocks.state.adapter ? "registered" : "absent" };
    });
    vi.mocked(inspectMcpProvider).mockImplementation(async (...args: unknown[]) => {
      nowMs += args[3] === undefined ? 0 : 1_000;
      return mocks.state.provider
        ? {
            credentialKeys: ["GITHUB_TOKEN"],
            exists: true,
            id: "11111111-2222-4333-8444-555555555555",
            resourceVersion: 7,
            type: "nemoclaw-mcp-v1",
          }
        : {
            credentialKeys: null,
            exists: false,
            id: null,
            resourceVersion: null,
            type: null,
          };
    });
    vi.mocked(policies.getPresetContentGatewayState).mockImplementation(
      async (_sandbox: string, content: string, ...args: unknown[]) => {
        nowMs += args[2] === undefined ? 0 : 1_000;
        const requested = content.includes("credential_binding") ? "bound" : "capability";
        return mocks.state.policy === requested ? "match" : "absent";
      },
    );
    vi.mocked(inspectMcpProviderAttachments).mockImplementation(async (...args: unknown[]) => {
      nowMs += args[3] === undefined ? 0 : 1_000;
      return {
        attachments: mocks.state.attachment
          ? [
              {
                credentialKeys: ["GITHUB_TOKEN"],
                name: "alpha-mcp-github",
                providerId: "11111111-2222-4333-8444-555555555555",
              },
            ]
          : [],
      };
    });

    try {
      await expect(runAdd()).resolves.toBeUndefined();

      expect(
        mocks.inspectAgentAdapterRegistration.mock.calls.find((args) => args[5] !== undefined)?.[5],
      ).toBe(675_000);
      expect(
        vi.mocked(inspectMcpProvider).mock.calls.find((args) => args[3] !== undefined)?.[3],
      ).toBe(674_000);
      expect(
        vi
          .mocked(policies.getPresetContentGatewayState)
          .mock.calls.find((args) => args[4] !== undefined)?.[4],
      ).toBe(673_000);
      expect(
        vi
          .mocked(inspectMcpProviderAttachments)
          .mock.calls.find((args) => args[3] !== undefined)?.[3],
      ).toBe(672_000);
      expect(mocks.observeSandboxOnGateway.mock.calls.at(-1)?.[3]).toBe(671_000);
      expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.detachProvider).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("returns unknown without cleanup when credential stability crosses the finality deadline", async () => {
    let nowMs = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    mocks.observeStableMcpCredentialRevision.mockImplementation(async () => {
      nowMs = 676_000;
      return "v7";
    });

    try {
      await expect(runAdd()).rejects.toThrow(/outcome.*unknown.*did not roll back or repeat/iu);

      expect(mocks.observeStableMcpCredentialRevision).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({ server: "github" }),
        expect.any(Object),
        30,
        "v7",
        expect.objectContaining({ deadlineMs: 676_000 }),
      );
      expect(mocks.observeSandboxOnGateway).toHaveBeenCalledTimes(2);
      expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
      expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
      expect(mocks.detachProvider).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("hands the exact relay loss to the real adapter finality inspection", async () => {
    mocks.state.useRealAdapterFlow = true;
    const relayLoss = `Error: × code: 'The service is currently unavailable', message: "exec relay closed before the command reported an exit status"\n`;
    mocks.runOpenshellProviderCommand.mockImplementation((args: string[]) => {
      switch (args.find((arg) => arg === "add" || arg === "reconcile")) {
        case "add":
          mocks.state.adapter = true;
          return { status: 1, stdout: "", stderr: relayLoss };
        case "reconcile":
          return {
            status: 0,
            stdout: '{"ok":true,"state":"committed"}\n',
            stderr: "",
          };
        default:
          throw new Error(`unexpected Hermes MCP command: ${JSON.stringify(args)}`);
      }
    });

    await expect(runAdd()).resolves.toBeUndefined();

    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledTimes(2);
    expect(mocks.runOpenshellProviderCommand.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["add"]),
    );
    expect(mocks.runOpenshellProviderCommand.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(["reconcile"]),
    );
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("keeps cleanup suppressed when the real adapter cannot prove relay-loss finality", async () => {
    mocks.state.useRealAdapterFlow = true;
    const relayLoss = `Error: × code: 'The service is currently unavailable', message: "exec relay closed before the command reported an exit status"\n`;
    mocks.runOpenshellProviderCommand.mockImplementation((args: string[]) => {
      switch (args.find((arg) => arg === "add" || arg === "reconcile")) {
        case "add":
          return { status: 1, stdout: "", stderr: relayLoss };
        case "reconcile":
          return { status: 2, stdout: "", stderr: "config mismatch" };
        default:
          throw new Error(`unexpected Hermes MCP command: ${JSON.stringify(args)}`);
      }
    });

    await expect(runAdd()).rejects.toThrow(/outcome.*unknown.*did not roll back or repeat/iu);

    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledTimes(3);
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("rolls back external state only after the helper proves exact absence", async () => {
    mocks.state.finality = "absent";

    await expect(runAdd()).rejects.toBeInstanceOf(HermesMcpReloadRelayLossError);

    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).toHaveBeenCalledOnce();
    expect(mocks.detachProvider).toHaveBeenCalledOnce();
  });

  it.each([
    ["read-only proof is unavailable", () => (mocks.state.finality = "unknown")],
    [
      "the read-only proof throws",
      () => {
        mocks.inspectHermesMcpReloadFinality.mockImplementation(() => {
          throw new Error("read-only inspection failed");
        });
      },
    ],
    ["the sandbox identity changes", () => (mocks.state.identityChanged = true)],
    [
      "the same sandbox identity does not return ready",
      () => (mocks.state.readinessDelayObservations = 1_000),
    ],
    [
      "the readiness observation throws",
      () =>
        mocks.observeSandboxOnGateway
          .mockImplementationOnce(() => ({
            liveIdentityFingerprint: "a".repeat(64),
            state: "ready",
          }))
          .mockImplementationOnce(() => {
            throw new Error("readiness observation failed");
          }),
    ],
    ["the credential revision changes", () => (mocks.state.revision = "v8")],
    [
      "the credential revision drifts from v7 to v8 after two matching observations",
      () => {
        mocks.observeStableMcpCredentialRevision.mockRejectedValue(
          new Error("Hermes MCP credential observations v7,v7,v8 did not stabilize"),
        );
      },
    ],
    ["the provider identity changes", () => (mocks.state.providerIdentityChanged = true)],
    [
      "absence is paired with credential revision drift",
      () => {
        mocks.state.finality = "absent";
        mocks.state.revision = "v8";
      },
    ],
    [
      "external state is partial",
      () => {
        mocks.registerAgentAdapterAtCurrentCredentialRevision.mockImplementation(() => {
          mocks.state.adapter = true;
          mocks.state.attachment = false;
          throw new HermesMcpReloadRelayLossError("v7");
        });
      },
    ],
  ])("performs no cleanup mutation when %s", async (_label, arrange) => {
    arrange();

    await expect(runAdd()).rejects.toThrow(/outcome.*unknown.*did not roll back or repeat/iu);

    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).toHaveBeenCalledOnce();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.detachProvider).not.toHaveBeenCalled();
  });

  it("keeps ordinary failures on the existing rollback path", async () => {
    mocks.state.registerFailure = "generic";

    await expect(runAdd()).rejects.toThrow("generic adapter failure");

    expect(mocks.unregisterAgentAdapter).toHaveBeenCalledOnce();
    expect(mocks.removeGeneratedPolicy).toHaveBeenCalledOnce();
    expect(mocks.detachProvider).toHaveBeenCalledOnce();
  });

  it("does not expose the host credential in an unknown-outcome diagnostic", async () => {
    mocks.state.finality = "unknown";

    let failure: unknown;
    try {
      await runAdd();
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("did not roll back or repeat the mutation");
    expect(String(failure)).not.toContain("host-only-secret");
  });
});
