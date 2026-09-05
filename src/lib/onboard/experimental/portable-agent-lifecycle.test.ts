// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isLifecycleLockHeld: vi.fn(),
  inspect: vi.fn(),
  inspectClassification: vi.fn(),
  inspectRequalification: vi.fn(),
  hasCandidate: vi.fn(),
  readRegistry: vi.fn(),
  buildOpenShellCommandAuthority: vi.fn(),
  buildOpenShellEnv: vi.fn(),
  assertHermesAuthority: vi.fn(),
  recoverHermes: vi.fn(),
  requalifyHermes: vi.fn(),
  retainOperatingAuthority: vi.fn(),
  qualifyOperatingAuthority: vi.fn(),
  recoverOpenClaw: vi.fn(),
  stopHermes: vi.fn(),
  stopOpenClaw: vi.fn(),
}));

vi.mock("../../state/mcp-lifecycle-lock-acquisition", () => ({
  isMcpLifecycleLockHeld: mocks.isLifecycleLockHeld,
}));

vi.mock("./hermes-portable-receipt", () => ({
  hasHermesPortableReceiptCandidate: mocks.hasCandidate,
  inspectPortableAgentReceiptAuthority: mocks.inspect,
  inspectPortableAgentReceiptAuthorityForClassification: mocks.inspectClassification,
  inspectPortableAgentReceiptAuthorityForRequalification: mocks.inspectRequalification,
}));
vi.mock("./hermes-portable-lifecycle", () => ({
  assertHermesPortableSandboxLifecycleAuthority: mocks.assertHermesAuthority,
  buildHermesPortableOpenShellCommandAuthority: mocks.buildOpenShellCommandAuthority,
  buildHermesPortableOpenShellEnv: mocks.buildOpenShellEnv,
  recoverHermesPortableSandboxLifecycle: mocks.recoverHermes,
  requalifyHermesPortableSandboxAuthority: mocks.requalifyHermes,
  retainRequalifiedOperatingAuthority: mocks.retainOperatingAuthority,
  stopHermesPortableSandboxLifecycle: mocks.stopHermes,
}));
vi.mock("./hermes-portable-operating-authority", () => ({
  qualifyHermesPortableOperatingAuthority: mocks.qualifyOperatingAuthority,
}));
vi.mock("./portable-demo-lifecycle", () => ({
  recoverPortableDemoSandboxLifecycle: mocks.recoverOpenClaw,
  stopPortableDemoSandboxLifecycle: mocks.stopOpenClaw,
}));

import {
  buildHermesPortableCommandAuthority,
  buildHermesPortableCommandEnvironment,
  buildHermesPortableOnboardingCommandAuthority,
  assertHermesPortableAgentLifecycleAuthority,
  inspectPortableAgentReceiptDisposition,
  qualifyHermesPortableAcceptedReadinessAuthority,
  qualifyPortableAgentLifecycleAuthority,
  qualifyHermesPortableOperatingCommandAuthority,
  recoverPortableAgentSandboxLifecycle,
  requalifyPortableAgentSandboxAuthority,
  requireHermesPortableActiveLifecycleAuthority,
  stopPortableAgentSandboxLifecycle,
} from "./portable-agent-lifecycle";

const context = {
  agent: "hermes",
  gatewayName: "nemoclaw",
  lifecycleGeneration: "generation-1",
  openshellDriver: "docker",
  provider: "ollama",
};

function hermes(phase: "pending" | "configuring" | "active") {
  return {
    kind: "hermes",
    snapshot: {
      receipt: {
        phase,
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
        runtimeAuthority: {
          homeDir: "/home/test",
          configHome: "/home/test/.config",
          runtimeDir: "/run/user/1000",
        },
        ...(phase === "pending" ? {} : { container: { sandboxId: "sandbox-id" } }),
      },
    },
  };
}

function hermesDisposition(phase: "pending" | "configuring" | "active") {
  return {
    kind: "hermes" as const,
    phase,
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    liveIdentityFingerprint:
      phase === "pending" ? null : createHash("sha256").update("sandbox-id").digest("hex"),
  };
}

function hermesRegistryEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: "alpha",
    agent: "hermes",
    openshellDriver: "docker",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: createHash("sha256").update("sandbox-id").digest("hex"),
    ...overrides,
  };
}

const lifecycleAuthorityDeps = {
  readRegistry: (sandboxName: string) => mocks.readRegistry(sandboxName),
};

describe("portable agent lifecycle dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectClassification.mockImplementation((...args) => mocks.inspect(...args));
    mocks.inspectRequalification.mockImplementation((...args) => mocks.inspect(...args));
    mocks.hasCandidate.mockReturnValue(true);
    mocks.buildOpenShellEnv.mockImplementation(
      (env: NodeJS.ProcessEnv, authority: Record<string, string>) => ({
        PATH: env.PATH,
        HOME: authority.homeDir,
        XDG_CONFIG_HOME: authority.configHome,
        XDG_RUNTIME_DIR: authority.runtimeDir,
      }),
    );
    mocks.recoverHermes.mockReturnValue({ kind: "already-running" });
    mocks.stopHermes.mockReturnValue({ kind: "stopped" });
    mocks.isLifecycleLockHeld.mockReturnValue(true);
    mocks.buildOpenShellCommandAuthority.mockReturnValue({
      env: { HOME: "/home/test" },
      executablePath: "/usr/bin/openshell",
    });
    mocks.qualifyOperatingAuthority.mockImplementation((snapshot) => ({
      receipt: snapshot.receipt,
      assertTransactionCurrent: vi.fn(),
      assertCurrent: vi.fn(),
    }));
    mocks.retainOperatingAuthority.mockImplementation(
      (_sandboxName, _stateDir, _snapshot, assertOperatingAuthority) => assertOperatingAuthority,
    );
    mocks.readRegistry.mockReturnValue(null);
  });

  it("directs copied active schema-7 authority to probe instead of migrating on launch (#10423)", () => {
    mocks.isLifecycleLockHeld.mockReturnValue(true);
    mocks.inspectClassification.mockReturnValue({
      kind: "hermes",
      snapshot: { receipt: { phase: "active" } },
    });
    mocks.inspect.mockImplementation(() => {
      throw new Error("durable policy source disagrees with its receipt authority");
    });

    expect(() => buildHermesPortableCommandAuthority("alpha", {}, "/state")).toThrow(
      "nemoclaw alpha connect --probe-only",
    );
    expect(mocks.requalifyHermes).not.toHaveBeenCalled();
  });

  it("routes probe-only schema migration to the exact Hermes lifecycle owner (#10423)", () => {
    const receiptAuthority = hermes("active");
    const entry = hermesRegistryEntry({ provider: "ollama-local" });
    mocks.inspectClassification.mockReturnValue(receiptAuthority);
    mocks.inspectRequalification.mockReturnValue(receiptAuthority);
    mocks.readRegistry.mockReturnValue(entry);
    const requalified = { kind: "migrated", snapshot: {}, assertCurrent: vi.fn() };
    mocks.requalifyHermes.mockReturnValue(requalified);

    const classified = qualifyPortableAgentLifecycleAuthority("alpha", lifecycleAuthorityDeps);
    expect(classified).toEqual({ ...hermesDisposition("active"), entry });
    expect(
      requalifyPortableAgentSandboxAuthority("alpha", {
        ...lifecycleAuthorityDeps,
        stateDir: "/state",
      }),
    ).toEqual(requalified);
    expect(mocks.requalifyHermes).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        agent: "hermes",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
      }),
      expect.objectContaining({ stateDir: "/state" }),
    );
    expect(mocks.inspectClassification).toHaveBeenCalledWith("alpha", expect.any(String));
    expect(mocks.inspectRequalification).toHaveBeenCalledWith("alpha", "/state");
    expect(mocks.recoverOpenClaw).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "none" }, { kind: "absent" }],
    [{ kind: "openclaw" }, { kind: "openclaw" }],
    [hermes("pending"), hermesDisposition("pending")],
    [hermes("configuring"), hermesDisposition("configuring")],
    [hermes("active"), hermesDisposition("active")],
  ])("strictly classifies receipt authority %# (#9203)", (authority, expected) => {
    mocks.inspect.mockReturnValue(authority);
    expect(inspectPortableAgentReceiptDisposition("alpha")).toEqual(expected);
  });

  it.each(["configuring", "active"] as const)(
    "returns the matching schema-7 %s receipt and registry authority (#9203)",
    (phase) => {
      mocks.inspect.mockReturnValue(hermes(phase));
      const entry = hermesRegistryEntry();
      mocks.readRegistry.mockReturnValue(entry);

      expect(qualifyPortableAgentLifecycleAuthority("alpha", lifecycleAuthorityDeps)).toEqual({
        ...hermesDisposition(phase),
        entry,
      });
    },
  );

  it("uses operation-local schema-8 authority for a direct command (#10423)", () => {
    const historical = hermes("active").snapshot.receipt;
    const current = { ...historical, socketAuthority: { dev: "current" } };
    const assertTransactionCurrent = vi.fn();
    const assertCurrent = vi.fn();
    mocks.inspect.mockReturnValue({
      kind: "hermes",
      snapshot: { receipt: historical, successor: { receipt: { schemaVersion: 8 } } },
    });
    mocks.qualifyOperatingAuthority.mockReturnValue({
      receipt: current,
      assertTransactionCurrent,
      assertCurrent,
    });

    expect(buildHermesPortableCommandAuthority("alpha", { HOME: "/home/test" }, "/state")).toEqual({
      env: { HOME: "/home/test" },
      executablePath: "/usr/bin/openshell",
    });
    expect(mocks.buildOpenShellCommandAuthority).toHaveBeenCalledWith(current, {
      HOME: "/home/test",
    });
    expect(assertCurrent).toHaveBeenCalledOnce();
  });

  it("retains one operation-local schema-6 command generation for recovery (#10423)", () => {
    const historical = hermes("active").snapshot.receipt;
    const current = { ...historical, socketAuthority: { dev: "current" } };
    const assertTransactionCurrent = vi.fn();
    const assertCurrent = vi.fn();
    mocks.inspect.mockReturnValue({
      kind: "hermes",
      snapshot: { receipt: historical, successor: { receipt: { schemaVersion: 6 } } },
    });
    mocks.qualifyOperatingAuthority.mockReturnValue({
      receipt: current,
      assertTransactionCurrent,
      assertCurrent,
    });

    const qualified = qualifyHermesPortableOperatingCommandAuthority(
      "alpha",
      { HOME: "/home/test" },
      "/state",
    );
    qualified.assertTransactionCurrent();
    qualified.assertCurrent();

    expect(qualified).toMatchObject({
      env: { HOME: "/home/test" },
      executablePath: "/usr/bin/openshell",
    });
    expect(mocks.qualifyOperatingAuthority).toHaveBeenCalledOnce();
    expect(assertTransactionCurrent).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("classifies active schema-5 readiness authority for bounded requalification (#10423)", () => {
    mocks.inspectClassification.mockReturnValue(hermes("active"));

    expect(
      qualifyHermesPortableAcceptedReadinessAuthority("alpha", {
        env: { HOME: "/home/test" },
        stateDir: "/state",
      }),
    ).toEqual({ kind: "requalification-required" });

    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.qualifyOperatingAuthority).not.toHaveBeenCalled();
  });

  it("retains current schema-6 command authority for accepted readiness (#10423)", () => {
    const historical = hermes("active").snapshot.receipt;
    const current = { ...historical, socketAuthority: { dev: "current" } };
    const assertTransactionCurrent = vi.fn();
    const assertCurrent = vi.fn();
    const authority = {
      kind: "hermes",
      snapshot: { receipt: historical, successor: { receipt: { schemaVersion: 6 } } },
    };
    mocks.inspectClassification.mockReturnValue(authority);
    mocks.inspect.mockReturnValue(authority);
    mocks.qualifyOperatingAuthority.mockReturnValue({
      receipt: current,
      assertTransactionCurrent,
      assertCurrent,
    });

    const accepted = qualifyHermesPortableAcceptedReadinessAuthority("alpha", {
      env: { HOME: "/home/test" },
      stateDir: "/state",
    });

    expect(accepted).toMatchObject({
      kind: "current",
      commandAuthority: {
        env: { HOME: "/home/test" },
        executablePath: "/usr/bin/openshell",
      },
    });
    const currentAuthority = accepted as Extract<typeof accepted, { kind: "current" }>;
    currentAuthority.commandAuthority.assertTransactionCurrent();
    currentAuthority.commandAuthority.assertCurrent();
    expect(assertTransactionCurrent).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledTimes(3);
    expect(mocks.retainOperatingAuthority).toHaveBeenCalledTimes(4);
  });

  it("retains migrated receipt currentness with accepted schema-6 authority (#10423)", () => {
    const authority = {
      kind: "hermes",
      snapshot: {
        ...hermes("active").snapshot,
        successor: { receipt: { schemaVersion: 6 } },
      },
    };
    const assertPriorReceiptCurrent = vi.fn();
    const priorReceiptAuthority = {
      snapshot: authority.snapshot,
      assertCurrent: assertPriorReceiptCurrent,
    };
    const commandCurrent = vi.fn();
    mocks.inspectClassification.mockReturnValue(authority);
    mocks.inspect.mockReturnValue(authority);
    mocks.qualifyOperatingAuthority.mockReturnValue({
      receipt: authority.snapshot.receipt,
      assertTransactionCurrent: vi.fn(),
      assertCurrent: commandCurrent,
    });

    const accepted = qualifyHermesPortableAcceptedReadinessAuthority("alpha", {
      env: { HOME: "/home/test" },
      stateDir: "/state",
      priorReceiptAuthority: priorReceiptAuthority as never,
    });
    expect(accepted.kind).toBe("current");
    const current = accepted as Extract<typeof accepted, { kind: "current" }>;
    current.commandAuthority.assertCurrent();

    expect(assertPriorReceiptCurrent).toHaveBeenCalledTimes(3);
    expect(commandCurrent).toHaveBeenCalledTimes(3);
  });

  it("permits an incomplete receipt without a registry row and rejects active absence (#9203)", () => {
    mocks.inspect.mockReturnValue(hermes("pending"));
    expect(qualifyPortableAgentLifecycleAuthority("alpha", lifecycleAuthorityDeps)).toEqual({
      ...hermesDisposition("pending"),
      entry: null,
    });

    mocks.inspect.mockReturnValue(hermes("active"));
    expect(() => qualifyPortableAgentLifecycleAuthority("alpha", lifecycleAuthorityDeps)).toThrow(
      "active receipt is missing its registry authority",
    );
  });

  it.each([
    { name: "other-sandbox" },
    { agent: "openclaw" },
    { openshellDriver: "kubernetes" },
    { gatewayName: "other-gateway" },
    { lifecycleGeneration: "generation-2" },
    { lifecycleLiveIdentityFingerprint: "other-fingerprint" },
  ])("rejects schema-7 receipt and registry disagreement %# (#9203)", (overrides) => {
    mocks.inspect.mockReturnValue(hermes("active"));
    mocks.readRegistry.mockReturnValue(hermesRegistryEntry(overrides));

    expect(() => qualifyPortableAgentLifecycleAuthority("alpha", lifecycleAuthorityDeps)).toThrow(
      "receipt and registry authority disagree",
    );
  });

  it("rejects a registry row while the schema-7 receipt is pending (#9203)", () => {
    mocks.inspect.mockReturnValue(hermes("pending"));
    mocks.readRegistry.mockReturnValue(hermesRegistryEntry());

    expect(() => qualifyPortableAgentLifecycleAuthority("alpha", lifecycleAuthorityDeps)).toThrow(
      "pending receipt conflicts with an existing registry entry",
    );
  });

  it("requalifies the exact active receipt and registry authority (#9203)", () => {
    mocks.inspect.mockReturnValue(hermes("active"));
    const entry = hermesRegistryEntry();
    mocks.readRegistry.mockReturnValue(entry);
    const expected = requireHermesPortableActiveLifecycleAuthority(
      "alpha",
      undefined,
      lifecycleAuthorityDeps,
    );

    expect(expected.entry).toEqual(entry);
    expect(expected.entry).not.toBe(entry);
    expect(
      requireHermesPortableActiveLifecycleAuthority("alpha", expected, lifecycleAuthorityDeps)
        .entry,
    ).toEqual(entry);

    mocks.readRegistry.mockReturnValue(hermesRegistryEntry({ model: "model-changed" }));
    expect(() =>
      requireHermesPortableActiveLifecycleAuthority("alpha", expected, lifecycleAuthorityDeps),
    ).toThrow("changed during verification");

    mocks.inspect.mockReturnValue({
      ...hermes("active"),
      snapshot: {
        receipt: {
          ...hermes("active").snapshot.receipt,
          lifecycleGeneration: "generation-2",
        },
      },
    });
    mocks.readRegistry.mockReturnValue(
      hermesRegistryEntry({ lifecycleGeneration: "generation-2" }),
    );
    expect(() =>
      requireHermesPortableActiveLifecycleAuthority("alpha", expected, lifecycleAuthorityDeps),
    ).toThrow("changed during verification");
  });

  it("binds schema-7 command children to the receipt runtime namespace (#9203)", () => {
    mocks.inspect.mockReturnValue(hermes("active"));
    expect(
      buildHermesPortableCommandEnvironment("alpha", {
        HOME: "/home/test",
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: "/home/test/.config",
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_CACHE_HOME: "/tmp/ambient-cache",
      }),
    ).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/home/test/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });

  it.each(["configuring", "active"] as const)(
    "builds exact OpenShell command authority for the locked %s phase (#9203)",
    (phase) => {
      const receipt = hermes(phase);
      mocks.inspect.mockReturnValue(receipt);

      expect(
        buildHermesPortableCommandAuthority("alpha", { HOME: "/home/test" }, "/state"),
      ).toEqual({
        env: { HOME: "/home/test" },
        executablePath: "/usr/bin/openshell",
      });
      expect(mocks.buildOpenShellCommandAuthority).toHaveBeenCalledWith(receipt.snapshot.receipt, {
        HOME: "/home/test",
      });
    },
  );

  it("rejects command authority before the lifecycle lock or configuring phase (#9203)", () => {
    mocks.inspect.mockReturnValue(hermes("pending"));
    expect(() =>
      buildHermesPortableCommandAuthority("alpha", { HOME: "/home/test" }, "/state"),
    ).toThrow("missing or incomplete");

    mocks.inspect.mockReturnValue(hermes("configuring"));
    mocks.isLifecycleLockHeld.mockReturnValue(false);
    expect(() =>
      buildHermesPortableCommandAuthority("alpha", { HOME: "/home/test" }, "/state"),
    ).toThrow("requires the sandbox lifecycle lock");
    expect(mocks.buildOpenShellCommandAuthority).not.toHaveBeenCalled();
  });

  it.each(["pending", "configuring"] as const)(
    "builds exact onboarding-only command authority for the locked %s phase (#9203)",
    (phase) => {
      const receipt = hermes(phase);
      mocks.inspect.mockReturnValue(receipt);

      expect(
        buildHermesPortableOnboardingCommandAuthority(
          "alpha",
          "nemoclaw",
          "generation-1",
          { HOME: "/home/test" },
          "/state",
        ),
      ).toEqual({ env: { HOME: "/home/test" }, executablePath: "/usr/bin/openshell" });
      expect(mocks.buildOpenShellCommandAuthority).toHaveBeenCalledWith(receipt.snapshot.receipt, {
        HOME: "/home/test",
      });
    },
  );

  it("rejects active or mismatched onboarding command authority (#9203)", () => {
    mocks.inspect.mockReturnValue(hermes("active"));
    expect(() =>
      buildHermesPortableOnboardingCommandAuthority(
        "alpha",
        "nemoclaw",
        "generation-1",
        {},
        "/state",
      ),
    ).toThrow("missing or disagrees");

    mocks.inspect.mockReturnValue(hermes("pending"));
    expect(() =>
      buildHermesPortableOnboardingCommandAuthority(
        "alpha",
        "other-gateway",
        "generation-1",
        {},
        "/state",
      ),
    ).toThrow("missing or disagrees");
    expect(mocks.buildOpenShellCommandAuthority).not.toHaveBeenCalled();
  });

  it("routes active Hermes recovery without OpenClaw or Docker fallthrough (#9203)", () => {
    mocks.inspect.mockReturnValue(hermes("active"));

    expect(recoverPortableAgentSandboxLifecycle("alpha", context)).toEqual({
      kind: "already-running",
    });
    expect(mocks.recoverHermes).toHaveBeenCalledOnce();
    expect(mocks.recoverOpenClaw).not.toHaveBeenCalled();
  });

  it("delegates active Hermes authority to the exact lifecycle qualifier (#9203)", () => {
    mocks.inspect.mockReturnValue(hermes("active"));

    expect(() =>
      assertHermesPortableAgentLifecycleAuthority("alpha", context, {
        stateDir: "/state",
      }),
    ).not.toThrow();

    expect(mocks.assertHermesAuthority).toHaveBeenCalledWith(
      "alpha",
      context,
      expect.objectContaining({ stateDir: "/state" }),
    );
  });

  it.each([
    [{ kind: "none" }, context, "missing or incomplete"],
    [hermes("configuring"), context, "missing or incomplete"],
    [hermes("active"), { ...context, agent: "openclaw" }, "does not match registry agent"],
  ] as const)(
    "rejects invalid Hermes command authority %# (#9203)",
    (authority, authorityContext, message) => {
      mocks.inspect.mockReturnValue(authority);

      expect(() =>
        assertHermesPortableAgentLifecycleAuthority("alpha", authorityContext, {
          stateDir: "/state",
        }),
      ).toThrow(message);
      expect(mocks.assertHermesAuthority).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "configuring"] as const)(
    "rejects incomplete Hermes phase %s before recovery (#9203)",
    (phase) => {
      mocks.inspect.mockReturnValue(hermes(phase));
      expect(() => recoverPortableAgentSandboxLifecycle("alpha", context)).toThrow(
        `phase '${phase}' is incomplete`,
      );
      expect(mocks.recoverHermes).not.toHaveBeenCalled();
      expect(mocks.recoverOpenClaw).not.toHaveBeenCalled();
    },
  );

  it("stops active Hermes without invoking the Docker-capable channel callback (#9203)", () => {
    mocks.inspect.mockReturnValue(hermes("active"));
    const beforeStop = vi.fn();

    expect(stopPortableAgentSandboxLifecycle("alpha", context, beforeStop)).toEqual({
      kind: "stopped",
      portableAgent: "hermes",
    });
    expect(mocks.stopHermes).toHaveBeenCalledOnce();
    const hermesBeforeStop = mocks.stopHermes.mock.calls[0]?.[2] as () => void;
    hermesBeforeStop();
    expect(beforeStop).not.toHaveBeenCalled();
    expect(mocks.stopOpenClaw).not.toHaveBeenCalled();
  });

  it("preserves schema-4 OpenClaw dispatch and its stop callback (#9203)", () => {
    mocks.inspect.mockReturnValue({ kind: "openclaw" });
    mocks.stopOpenClaw.mockReturnValue({ kind: "stopped" });
    const beforeStop = vi.fn();

    stopPortableAgentSandboxLifecycle("alpha", { ...context, agent: "openclaw" }, beforeStop);
    expect(mocks.stopOpenClaw).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ agent: "openclaw" }),
      beforeStop,
      expect.any(Object),
    );
    expect(mocks.stopHermes).not.toHaveBeenCalled();
  });
});
