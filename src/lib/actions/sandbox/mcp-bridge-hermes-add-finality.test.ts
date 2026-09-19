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
  };
  return {
    applyGeneratedPolicy: vi.fn(),
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
    waitForMcpBridgeConditionAsync: vi.fn(async (condition: () => Promise<boolean>) => {
      let matched = false;
      for (let attempt = 0; attempt < 12 && !matched; attempt += 1) {
        matched = await condition();
      }
      return matched;
    }),
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
    assertAgentMcpMutationRuntimeCapability: vi.fn(),
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
  upsertMcpProvider: vi.fn(async (_name, _env, options) => {
    const action = mocks.state.provider ? "updated" : "created";
    await options.prepareMutation?.(action);
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
  }),
  waitForAttachedMcpCredential: vi.fn(() => "v7"),
  waitForDetachedMcpCredential: vi.fn(),
}));

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
    });
    process.env.GITHUB_TOKEN = "host-only-secret";
    delete process.env.NEMOCLAW_TRUSTED_PRIVATE_HOSTS;

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
      () => (mocks.state.readinessDelayObservations = 20),
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
