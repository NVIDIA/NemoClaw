// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isLifecycleLockHeld: vi.fn(),
  inspect: vi.fn(),
  buildOpenShellCommandAuthority: vi.fn(),
  buildOpenShellEnv: vi.fn(),
  assertHermesAuthority: vi.fn(),
  recoverHermes: vi.fn(),
  recoverOpenClaw: vi.fn(),
  stopHermes: vi.fn(),
  stopOpenClaw: vi.fn(),
}));

vi.mock("../../state/mcp-lifecycle-lock-acquisition", () => ({
  isMcpLifecycleLockHeld: mocks.isLifecycleLockHeld,
}));

vi.mock("./hermes-portable-receipt", () => ({
  inspectPortableAgentReceiptAuthority: mocks.inspect,
}));
vi.mock("./hermes-portable-lifecycle", () => ({
  assertHermesPortableSandboxLifecycleAuthority: mocks.assertHermesAuthority,
  buildHermesPortableOpenShellCommandAuthority: mocks.buildOpenShellCommandAuthority,
  buildHermesPortableOpenShellEnv: mocks.buildOpenShellEnv,
  recoverHermesPortableSandboxLifecycle: mocks.recoverHermes,
  stopHermesPortableSandboxLifecycle: mocks.stopHermes,
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
  recoverPortableAgentSandboxLifecycle,
  requireHermesPortableActiveRegistryAuthority,
  revalidateHermesPortableActiveRegistryAuthority,
  stopPortableAgentSandboxLifecycle,
  validateHermesPortableRegistryAuthority,
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

describe("portable agent lifecycle dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("ignores non-Hermes receipt authority before registry validation (#9203)", () => {
    expect(validateHermesPortableRegistryAuthority("alpha", { kind: "openclaw" }, null)).toBeNull();
  });

  it("accepts a pending Hermes receipt only before registry publication (#9203)", () => {
    const disposition = hermesDisposition("pending");
    expect(validateHermesPortableRegistryAuthority("alpha", disposition, null)).toEqual({
      ...disposition,
      entry: null,
    });
    expect(() =>
      validateHermesPortableRegistryAuthority("alpha", disposition, {
        name: "alpha",
        agent: "hermes",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
      }),
    ).toThrow("pending receipt conflicts with an existing registry entry");
  });

  it("requires an active Hermes receipt to have exact registry authority (#9203)", () => {
    const disposition = hermesDisposition("active");
    const entry = {
      name: "alpha",
      agent: "hermes",
      openshellDriver: "docker",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: disposition.liveIdentityFingerprint,
    };

    expect(validateHermesPortableRegistryAuthority("alpha", disposition, entry)).toEqual({
      ...disposition,
      entry,
    });
    expect(() => validateHermesPortableRegistryAuthority("alpha", disposition, null)).toThrow(
      "active receipt is missing its registry authority",
    );
    expect(() =>
      validateHermesPortableRegistryAuthority("alpha", disposition, {
        ...entry,
        gatewayName: "other-gateway",
      }),
    ).toThrow("receipt and registry authority disagree");
  });

  it("revalidates active Hermes authority against its locked snapshot (#9203)", () => {
    const disposition = hermesDisposition("active");
    const entry = {
      name: "alpha",
      agent: "hermes",
      openshellDriver: "docker",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: disposition.liveIdentityFingerprint,
    };
    const initial = requireHermesPortableActiveRegistryAuthority("alpha", disposition, entry);

    expect(
      revalidateHermesPortableActiveRegistryAuthority("alpha", initial, disposition, entry),
    ).toEqual(initial);
    expect(() =>
      revalidateHermesPortableActiveRegistryAuthority(
        "alpha",
        initial,
        { ...disposition, lifecycleGeneration: "generation-2" },
        { ...entry, lifecycleGeneration: "generation-2" },
      ),
    ).toThrow("authority changed");
  });

  it("binds schema-5 command children to the receipt runtime namespace (#9203)", () => {
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
