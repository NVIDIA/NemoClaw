// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import * as agentDefinitions from "../../agent/defs";
import { loadAgent } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  prepareInteractiveSession: vi.fn(),
  printInteractiveSessionHints: vi.fn(),
  completeInteractiveSessionSetup: vi.fn(),
  completeReadinessQualifiedInteractiveSessionSetup: vi.fn(),
  execSandbox: vi.fn(),
  runSandboxExecChild: vi.fn(),
  releaseSandboxExecSignals: vi.fn(),
  prepareHermesLightTerminalSkin: vi.fn(),
  inspectLaunchReadiness: vi.fn(),
  publishLaunchReadiness: vi.fn(),
  withLaunchReadinessMutationGate: vi.fn(),
  inspectPortableReceiptDisposition: vi.fn(),
  recoverPortableLifecycle: vi.fn(),
}));

vi.mock("./connect", () => ({
  prepareInteractiveSession: mocks.prepareInteractiveSession,
  printInteractiveSessionHints: mocks.printInteractiveSessionHints,
  completeInteractiveSessionSetup: mocks.completeInteractiveSessionSetup,
  completeReadinessQualifiedInteractiveSessionSetup:
    mocks.completeReadinessQualifiedInteractiveSessionSetup,
}));
vi.mock("./exec", () => ({
  execSandbox: mocks.execSandbox,
  resolveSandboxExecBinary: () => "openshell",
  runSandboxExecChild: mocks.runSandboxExecChild,
  buildOpenshellExecArgs: (
    sandboxName: string,
    command: readonly string[],
    options: { tty?: boolean; stdin?: boolean; timeoutSeconds?: number },
    gatewayName?: string,
  ) => [
    "sandbox",
    "exec",
    "--name",
    sandboxName,
    ...(gatewayName ? ["-g", gatewayName] : []),
    ...(options.tty ? ["--tty"] : []),
    ...(typeof options.timeoutSeconds === "number"
      ? ["--timeout", String(options.timeoutSeconds)]
      : []),
    "--",
    ...command,
  ],
  wrapExecCommandWithRuntimeEnv: (command: readonly string[]) => command,
}));
vi.mock("./connect-hermes-light-skin", () => ({
  prepareHermesLightTerminalSkin: mocks.prepareHermesLightTerminalSkin,
}));
vi.mock("./launch-readiness", () => ({
  inspectLaunchReadiness: mocks.inspectLaunchReadiness,
  publishLaunchReadiness: mocks.publishLaunchReadiness,
  withLaunchReadinessMutationGate: mocks.withLaunchReadinessMutationGate,
  publicationFromDecision: (sandboxName: string, decision: { fence?: { epochId: string } }) => ({
    sandboxName,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    epochId: decision.fence?.epochId ?? null,
  }),
}));
vi.mock("./gateway-state", async () => {
  const lifecycle = await vi.importActual<
    typeof import("../../onboard/experimental/hermes-portable-lifecycle")
  >("../../onboard/experimental/hermes-portable-lifecycle");
  return {
    buildHermesPortableCommandAuthority: () => ({
      env: lifecycle.hermesPortableLifecycleInternals.buildHermesPortableOpenShellEnv(
        {
          ...process.env,
          HOME: "/home/test",
          XDG_CONFIG_HOME: "/home/test/.config",
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
        {
          schemaVersion: 1,
          kind: "podman",
          ownership: "current-user",
          uid: process.getuid!(),
          homeDir: "/home/test",
          configHome: "/home/test/.config",
          runtimeDir: "/run/user/1000",
          socketPath: "/run/user/1000/podman/podman.sock",
        },
      ),
      executablePath: "/usr/bin/openshell",
    }),
    buildHermesPortableCommandEnvironment: () => ({
      HOME: "/home/test",
      XDG_CONFIG_HOME: "/home/test/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
    }),
    inspectPortableAgentReceiptDisposition: mocks.inspectPortableReceiptDisposition,
    recoverPortableDemoSandboxLifecycleForConnect: mocks.recoverPortableLifecycle,
    withSandboxLifecycleLock: async (_sandboxName: string, operation: () => unknown) => operation(),
  };
});

import { launchSandbox } from "./launch";

function sandboxEntry(agentName: string | null): SandboxEntry {
  return {
    name: "alpha",
    agent: agentName,
    gatewayName: "gateway-alpha",
    lifecycleGeneration: "generation-alpha",
    provider: null,
    model: null,
    gpuEnabled: false,
    policies: [],
  } as SandboxEntry;
}

function activeHermesDisposition() {
  return {
    kind: "hermes" as const,
    phase: "active" as const,
    gatewayName: "gateway-alpha",
    lifecycleGeneration: "generation-alpha",
    liveIdentityFingerprint: "f".repeat(64),
  };
}

function prepareSession(
  agentName: string,
  agent: AgentDefinition | null,
  hermesPortable = false,
): void {
  mocks.prepareInteractiveSession.mockImplementation(async () => {
    mocks.calls.push("prepareInteractiveSession");
    return { agent, sb: sandboxEntry(agentName), hermesPortable };
  });
}

function launchedCommand(): readonly string[] {
  return mocks.execSandbox.mock.calls[0]?.[1] as readonly string[];
}

type AsyncTestLock = <T>(name: string, operation: () => Promise<T> | T) => Promise<T>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSerialTestLock(events: string[], label: string): AsyncTestLock {
  let tail = Promise.resolve();
  return async <T>(_name: string, operation: () => Promise<T> | T): Promise<T> => {
    const previous = tail;
    const release = deferred();
    tail = previous.then(() => release.promise);
    await previous;
    events.push(`${label}:acquired`);
    try {
      return await operation();
    } finally {
      events.push(`${label}:released`);
      release.resolve();
    }
  };
}

describe("launchSandbox", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.execSandbox.mockImplementation(async () => {
      mocks.calls.push("execSandbox");
    });
    mocks.runSandboxExecChild.mockImplementation(async () => {
      mocks.calls.push("runSandboxExecChild");
      return { status: 0, releaseSignals: mocks.releaseSandboxExecSignals };
    });
    mocks.prepareHermesLightTerminalSkin.mockImplementation(() => {
      mocks.calls.push("prepareHermesLightTerminalSkin");
    });
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "fallback",
      category: "missing",
      fence: null,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      fenceFailed: true,
      recoveryBlocked: false,
    });
    mocks.publishLaunchReadiness.mockResolvedValue({ kind: "published" });
    mocks.withLaunchReadinessMutationGate.mockImplementation(async (_publication, operation) => ({
      kind: "entered",
      value: await operation(),
    }));
    mocks.inspectPortableReceiptDisposition.mockReturnValue({ kind: "absent" });
    mocks.recoverPortableLifecycle.mockReturnValue({ kind: "already-running" });
    // Production keeps OpenClaw null in getSessionAgent so its recovery path
    // continues to use the legacy defaults. The launch resolver must still
    // load OpenClaw's trusted manifest before choosing the interactive command.
    prepareSession("openclaw", null);
  });

  it("starts the OpenClaw TUI for an OpenClaw sandbox (#6006)", async () => {
    await launchSandbox("alpha");

    expect(launchedCommand()).toEqual(["bash", "-lc", "openclaw tui"]);
  });

  it("uses the OpenClaw manifest command when the session agent is null (#6006)", async () => {
    const openclaw = loadAgent("openclaw");
    vi.spyOn(agentDefinitions, "loadAgent").mockReturnValueOnce({
      ...openclaw,
      runtime: { ...openclaw.runtime!, interactive_command: "openclaw manifest-test-tui" },
    });

    await launchSandbox("alpha");

    expect(launchedCommand()).toEqual(["bash", "-lc", "openclaw manifest-test-tui"]);
  });

  it("starts dcode for a Deep Agents Code sandbox (#6006)", async () => {
    prepareSession("langchain-deepagents-code", loadAgent("langchain-deepagents-code"));

    await launchSandbox("alpha");

    expect(launchedCommand()).toEqual(["bash", "-lc", "dcode"]);
  });

  it("starts hermes for a Hermes sandbox (#6006)", async () => {
    prepareSession("hermes", loadAgent("hermes"));

    await launchSandbox("alpha");

    expect(launchedCommand()).toEqual(["bash", "-lc", "hermes"]);
  });

  it("holds schema-5 authority through the exact interactive child execution (#9203)", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "do-not-forward");
    vi.stubEnv("GITHUB_TOKEN", "do-not-forward");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "do-not-forward");
    const hermes = loadAgent("hermes");
    const entry = sandboxEntry("hermes");
    prepareSession("hermes", hermes, true);
    mocks.inspectPortableReceiptDisposition.mockReturnValue(activeHermesDisposition());
    const events: string[] = [];
    const childStarted = deferred();
    const releaseChild = deferred();
    const withSandboxMutationLock = createSerialTestLock(events, "sandbox");
    mocks.runSandboxExecChild.mockImplementationOnce(async () => {
      events.push("child");
      childStarted.resolve();
      await releaseChild.promise;
      return { status: 0, releaseSignals: mocks.releaseSandboxExecSignals };
    });

    const launch = launchSandbox("alpha", {
      getSandbox: () => entry,
      resolveSandboxGatewayName: () => "gateway-alpha",
      withSandboxMutationLock,
    });
    await childStarted.promise;
    const contender = withSandboxMutationLock("alpha", () => events.push("contender"));
    await Promise.resolve();

    expect(mocks.recoverPortableLifecycle).toHaveBeenCalledTimes(2);
    expect(mocks.recoverPortableLifecycle).toHaveBeenCalledWith("alpha", entry, "gateway-alpha");
    expect(events).toEqual(["sandbox:acquired", "child"]);
    expect(mocks.execSandbox).not.toHaveBeenCalled();
    expect(mocks.prepareHermesLightTerminalSkin).not.toHaveBeenCalled();
    expect(mocks.runSandboxExecChild.mock.calls[0]?.slice(0, 2)).toEqual([
      "/usr/bin/openshell",
      [
        "sandbox",
        "exec",
        "--name",
        "alpha",
        "-g",
        "gateway-alpha",
        "--tty",
        "--timeout",
        "0",
        "--",
        "bash",
        "-lc",
        "hermes",
      ],
    ]);
    expect(mocks.runSandboxExecChild.mock.calls[0]?.[2]).toMatchObject({
      subprocessEnv: expect.not.objectContaining({
        NVIDIA_INFERENCE_API_KEY: expect.anything(),
        GITHUB_TOKEN: expect.anything(),
        AWS_SECRET_ACCESS_KEY: expect.anything(),
      }),
    });

    releaseChild.resolve();
    await launch;
    await contender;
    expect(events).toEqual([
      "sandbox:acquired",
      "child",
      "sandbox:released",
      "sandbox:acquired",
      "contender",
      "sandbox:released",
    ]);
  });

  it("rejects ordinary-to-schema-5 publication inside the launch lifecycle fence (#9203)", async () => {
    const entry = sandboxEntry("hermes");
    prepareSession("hermes", loadAgent("hermes"));
    mocks.inspectPortableReceiptDisposition.mockReturnValue({ kind: "absent" });

    await expect(
      launchSandbox("alpha", {
        getSandbox: () => entry,
        resolveSandboxGatewayName: () => "gateway-alpha",
        withSandboxMutationLock: async (_sandboxName, operation) => {
          mocks.inspectPortableReceiptDisposition.mockReturnValue(activeHermesDisposition());
          return await operation();
        },
      }),
    ).rejects.toThrow("lifecycle authority changed");

    expect(mocks.recoverPortableLifecycle).not.toHaveBeenCalled();
    expect(mocks.execSandbox).not.toHaveBeenCalled();
    expect(mocks.runSandboxExecChild).not.toHaveBeenCalled();
  });

  it("does not run accepted ordinary setup when schema-5 publishes before the launch fence (#9203)", async () => {
    const hermes = loadAgent("hermes");
    const entry = sandboxEntry("hermes");
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "accepted",
      category: "accepted",
      agent: hermes,
      sb: entry,
    });
    mocks.inspectPortableReceiptDisposition.mockReturnValue({ kind: "absent" });

    await expect(
      launchSandbox("alpha", {
        getSandbox: () => entry,
        resolveSandboxGatewayName: () => "gateway-alpha",
        withSandboxMutationLock: async (_sandboxName, operation) => {
          mocks.inspectPortableReceiptDisposition.mockReturnValue(activeHermesDisposition());
          return await operation();
        },
      }),
    ).rejects.toThrow("lifecycle authority changed");

    expect(mocks.printInteractiveSessionHints).not.toHaveBeenCalled();
    expect(mocks.completeReadinessQualifiedInteractiveSessionSetup).not.toHaveBeenCalled();
    expect(mocks.execSandbox).not.toHaveBeenCalled();
    expect(mocks.runSandboxExecChild).not.toHaveBeenCalled();
  });

  it("rejects schema-5 retirement inside the launch lifecycle fence (#9203)", async () => {
    prepareSession("hermes", loadAgent("hermes"), true);
    mocks.inspectPortableReceiptDisposition.mockReturnValue(activeHermesDisposition());

    await expect(
      launchSandbox("alpha", {
        withSandboxMutationLock: async (_sandboxName, operation) => {
          mocks.inspectPortableReceiptDisposition.mockReturnValue({ kind: "absent" });
          return await operation();
        },
      }),
    ).rejects.toThrow("lifecycle authority changed");

    expect(mocks.recoverPortableLifecycle).not.toHaveBeenCalled();
    expect(mocks.execSandbox).not.toHaveBeenCalled();
  });

  it("launches NemoCUA through the ordinary terminal-agent path (#9649)", async () => {
    const nemocua = {
      ...loadAgent("hermes"),
      name: "nemocua",
      runtime: {
        kind: "terminal" as const,
        interactive_command: "/bin/bash",
        headless_command: "python3 /app/run_with_harness.py",
      },
    };
    const cuaEntry = sandboxEntry("nemocua");
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "accepted",
      category: "accepted",
      agent: nemocua,
      sb: cuaEntry,
    });
    await launchSandbox("alpha", {
      getSandbox: () => cuaEntry,
    });

    expect(launchedCommand()).toEqual(["bash", "-lc", "/bin/bash"]);
  });

  it("rejects an untrusted registry agent before starting an in-sandbox command (#6006)", async () => {
    prepareSession("mystery-agent; echo pwned", null);

    await expect(launchSandbox("alpha")).rejects.toThrow(
      'Cannot resolve an interactive command for unsupported agent "mystery-agent; echo pwned".',
    );

    expect(mocks.prepareHermesLightTerminalSkin).not.toHaveBeenCalled();
    expect(mocks.execSandbox).not.toHaveBeenCalled();
  });

  // Regression guard for #6291: execSandbox wraps every command in
  // wrapExecCommandWithRuntimeEnv, which unsets OPENCLAW_GATEWAY_TOKEN after
  // sourcing the runtime env file. Only a login shell re-sources the file
  // through the profile, so a bare argv would start the agent with different
  // auth than `connect` gives it.
  it("runs the agent command through a login shell rather than bare argv (#6006)", async () => {
    await launchSandbox("alpha");

    const command = launchedCommand();
    expect(command).toEqual(["bash", "-lc", "openclaw tui"]);
    expect(command).not.toEqual(["openclaw", "tui"]);
  });

  // `connect` applies the managed light skin before opening its SSH session, so
  // `launch` must too or a Hermes TUI on a light terminal keeps the dark skin.
  it("applies the Hermes light terminal skin before starting the agent (#6006)", async () => {
    const hermes = loadAgent("hermes");
    prepareSession("hermes", hermes);

    await launchSandbox("alpha");

    expect(mocks.prepareHermesLightTerminalSkin).toHaveBeenCalledWith("alpha", hermes, process.env);
    expect(mocks.calls).toEqual([
      "prepareInteractiveSession",
      "prepareHermesLightTerminalSkin",
      "execSandbox",
    ]);
  });

  it("requests an interactive session with no timeout (#6006)", async () => {
    await launchSandbox("alpha");

    expect(mocks.execSandbox.mock.calls[0]?.[2]).toEqual({
      tty: true,
      stdin: true,
      timeoutSeconds: 0,
    });
  });

  it("forwards the sandbox name unmodified (#6006)", async () => {
    await launchSandbox("beta-01");

    expect(mocks.prepareInteractiveSession).toHaveBeenCalledWith("beta-01");
    expect(mocks.execSandbox.mock.calls[0]?.[0]).toBe("beta-01");
  });

  // Without the preflight, the agent starts over exec while gateway process
  // recovery never runs, so the TUI renders but sits disconnected.
  it("runs the interactive preflight before starting the agent (#6006)", async () => {
    await launchSandbox("alpha");

    expect(mocks.calls).toEqual([
      "prepareInteractiveSession",
      "prepareHermesLightTerminalSkin",
      "execSandbox",
    ]);
    expect(mocks.withLaunchReadinessMutationGate).toHaveBeenCalledWith(
      expect.objectContaining({ epochId: null }),
      expect.any(Function),
    );
  });

  it("rejects a sandbox missing from local state before readiness recovery (#8942)", async () => {
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "fallback",
      category: "missing",
      fence: null,
      gatewayName: null,
      gatewayPort: null,
      fenceFailed: true,
      recoveryBlocked: true,
    });

    await expect(launchSandbox("alpha;echo pwned")).rejects.toThrow(
      "Sandbox 'alpha;echo pwned' is not registered in the local NemoClaw state.",
    );

    expect(mocks.withLaunchReadinessMutationGate).not.toHaveBeenCalled();
    expect(mocks.prepareInteractiveSession).not.toHaveBeenCalled();
    expect(mocks.execSandbox).not.toHaveBeenCalled();
  });

  it("skips the complete OpenClaw pairing pass after current lease qualification (#9023)", async () => {
    const openclaw = loadAgent("openclaw");
    const sb = sandboxEntry("openclaw");
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "accepted",
      category: "accepted",
      agent: openclaw,
      sb,
    });

    await launchSandbox("alpha");

    expect(mocks.prepareInteractiveSession).not.toHaveBeenCalled();
    expect(mocks.printInteractiveSessionHints).toHaveBeenCalledWith("alpha");
    expect(mocks.completeReadinessQualifiedInteractiveSessionSetup).toHaveBeenCalledWith(
      "alpha",
      openclaw,
      sb,
    );
    expect(mocks.completeInteractiveSessionSetup).not.toHaveBeenCalled();
    expect(mocks.publishLaunchReadiness).not.toHaveBeenCalled();
    expect(mocks.printInteractiveSessionHints).toHaveBeenCalledBefore(
      mocks.completeReadinessQualifiedInteractiveSessionSetup,
    );
    expect(mocks.completeReadinessQualifiedInteractiveSessionSetup).toHaveBeenCalledBefore(
      mocks.prepareHermesLightTerminalSkin,
    );
    expect(mocks.prepareHermesLightTerminalSkin).toHaveBeenCalledBefore(mocks.execSandbox);
    expect(launchedCommand()).toEqual(["bash", "-lc", "openclaw tui"]);
  });

  it("launches accepted Hermes readiness without entering recovery (#9203)", async () => {
    const hermes = loadAgent("hermes");
    const entry = sandboxEntry("hermes");
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "accepted",
      category: "accepted",
      agent: hermes,
      sb: entry,
    });
    mocks.inspectPortableReceiptDisposition.mockReturnValue(activeHermesDisposition());

    await launchSandbox("alpha", {
      getSandbox: () => entry,
      resolveSandboxGatewayName: () => "gateway-alpha",
      withSandboxMutationLock: async (_name, operation) => await operation(),
    });

    expect(mocks.printInteractiveSessionHints).not.toHaveBeenCalled();
    expect(mocks.prepareInteractiveSession).not.toHaveBeenCalled();
    expect(mocks.completeReadinessQualifiedInteractiveSessionSetup).not.toHaveBeenCalled();
    expect(mocks.completeInteractiveSessionSetup).not.toHaveBeenCalled();
    expect(mocks.prepareHermesLightTerminalSkin).not.toHaveBeenCalled();
    expect(mocks.recoverPortableLifecycle).toHaveBeenCalledTimes(2);
    expect(mocks.runSandboxExecChild).toHaveBeenCalledOnce();
  });

  it("passes the qualified OpenClaw identity for legacy registry state (#9023)", async () => {
    const openclaw = loadAgent("openclaw");
    const sb = sandboxEntry(null);
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "accepted",
      category: "accepted",
      agent: openclaw,
      sb,
    });

    await launchSandbox("alpha");

    expect(mocks.prepareInteractiveSession).not.toHaveBeenCalled();
    expect(mocks.completeReadinessQualifiedInteractiveSessionSetup).toHaveBeenCalledWith(
      "alpha",
      openclaw,
      sb,
    );
    expect(mocks.completeInteractiveSessionSetup).not.toHaveBeenCalled();
    expect(mocks.publishLaunchReadiness).not.toHaveBeenCalled();
    expect(launchedCommand()).toEqual(["bash", "-lc", "openclaw tui"]);
  });

  it("does not mutate after its epoch is replaced by a newer accepted lease (#8942)", async () => {
    const openclaw = loadAgent("openclaw");
    const sb = sandboxEntry("openclaw");
    mocks.inspectLaunchReadiness
      .mockResolvedValueOnce({
        kind: "fallback",
        category: "config",
        fence: { epochId: "a".repeat(64) },
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: false,
        recoveryBlocked: false,
      })
      .mockResolvedValueOnce({
        kind: "accepted",
        category: "accepted",
        agent: openclaw,
        sb,
      });
    mocks.withLaunchReadinessMutationGate.mockResolvedValueOnce({ kind: "changed" });

    await launchSandbox("alpha");

    expect(mocks.prepareInteractiveSession).not.toHaveBeenCalled();
    expect(mocks.publishLaunchReadiness).not.toHaveBeenCalled();
    expect(mocks.inspectLaunchReadiness).toHaveBeenCalledTimes(2);
    expect(mocks.withLaunchReadinessMutationGate).toHaveBeenCalledWith(
      expect.objectContaining({ epochId: "a".repeat(64) }),
      expect.any(Function),
    );
    expect(mocks.completeReadinessQualifiedInteractiveSessionSetup).toHaveBeenCalledWith(
      "alpha",
      openclaw,
      sb,
    );
    expect(mocks.execSandbox).toHaveBeenCalledOnce();
  });

  it("keeps repeated launch and exit cycles on the accepted non-sliding lease (#8942)", async () => {
    const openclaw = loadAgent("openclaw");
    const sb = sandboxEntry("openclaw");
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "accepted",
      category: "accepted",
      agent: openclaw,
      sb,
    });

    await launchSandbox("alpha");
    await launchSandbox("alpha");

    expect(mocks.prepareInteractiveSession).not.toHaveBeenCalled();
    expect(mocks.execSandbox).toHaveBeenCalledTimes(2);
    expect(mocks.publishLaunchReadiness).not.toHaveBeenCalled();
    expect(mocks.completeReadinessQualifiedInteractiveSessionSetup).toHaveBeenCalledTimes(2);
    expect(mocks.completeInteractiveSessionSetup).not.toHaveBeenCalled();
  });

  it("runs the existing complete pairing path once after qualification fallback (#9023)", async () => {
    mocks.prepareInteractiveSession.mockImplementationOnce(async () => {
      mocks.completeInteractiveSessionSetup("alpha", sandboxEntry("openclaw"));
      return { agent: loadAgent("openclaw"), sb: sandboxEntry("openclaw") };
    });

    await launchSandbox("alpha");

    expect(mocks.prepareInteractiveSession).toHaveBeenCalledOnce();
    expect(mocks.completeInteractiveSessionSetup).toHaveBeenCalledOnce();
    expect(mocks.completeReadinessQualifiedInteractiveSessionSetup).not.toHaveBeenCalled();
  });

  it("publishes recaptured final state only after successful complete preflight (#8942)", async () => {
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "fallback",
      category: "expired",
      fence: { epochId: "a".repeat(64) },
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      fenceFailed: false,
      recoveryBlocked: false,
    });

    await launchSandbox("alpha");

    expect(mocks.prepareInteractiveSession).toHaveBeenCalledBefore(mocks.publishLaunchReadiness);
    expect(mocks.publishLaunchReadiness).toHaveBeenCalledBefore(mocks.execSandbox);
  });

  it("stops before readiness publication and agent execution when recovery rejects launch (#9364)", async () => {
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "fallback",
      category: "expired",
      fence: { epochId: "a".repeat(64) },
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      fenceFailed: false,
      recoveryBlocked: false,
    });
    const recoveryFailure = new Error("process.exit(1)");
    mocks.prepareInteractiveSession.mockRejectedValueOnce(recoveryFailure);

    await expect(launchSandbox("alpha")).rejects.toBe(recoveryFailure);

    expect(mocks.prepareInteractiveSession).toHaveBeenCalledOnce();
    expect(mocks.publishLaunchReadiness).not.toHaveBeenCalled();
    expect(mocks.prepareHermesLightTerminalSkin).not.toHaveBeenCalled();
    expect(mocks.execSandbox).not.toHaveBeenCalled();
  });

  it("keeps ordinary launch available when evidence observation, hashing, or storage fails (#8942)", async () => {
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "fallback",
      category: "unsafe",
      fence: { epochId: "a".repeat(64) },
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      fenceFailed: false,
      recoveryBlocked: false,
    });
    mocks.publishLaunchReadiness.mockResolvedValue({ kind: "evidence-failed" });

    await expect(launchSandbox("alpha")).resolves.toBeUndefined();

    expect(mocks.prepareInteractiveSession).toHaveBeenCalled();
    expect(mocks.execSandbox).toHaveBeenCalled();
  });

  it("runs the complete preflight and interactive command when macOS evidence is unavailable (#8942)", async () => {
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "fallback",
      category: "unsafe",
      fence: null,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      fenceFailed: true,
      recoveryBlocked: false,
      authorityUnsupported: true,
    });

    await expect(launchSandbox("alpha")).resolves.toBeUndefined();

    expect(mocks.prepareInteractiveSession).toHaveBeenCalledOnce();
    expect(mocks.publishLaunchReadiness).not.toHaveBeenCalled();
    expect(mocks.withLaunchReadinessMutationGate).toHaveBeenCalledWith(
      expect.objectContaining({ epochId: null }),
      expect.any(Function),
    );
    expect(mocks.execSandbox).toHaveBeenCalledOnce();
  });

  it("stops before the complete preflight when a prior launch-readiness epoch may remain acceptable (#8942)", async () => {
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "fallback",
      category: "unsafe",
      fence: null,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      fenceFailed: true,
      recoveryBlocked: true,
    });

    await expect(launchSandbox("alpha")).rejects.toThrow(
      "Launch readiness evidence could not be safely invalidated",
    );

    expect(mocks.prepareInteractiveSession).not.toHaveBeenCalled();
    expect(mocks.publishLaunchReadiness).not.toHaveBeenCalled();
    expect(mocks.execSandbox).not.toHaveBeenCalled();
  });

  it("stops before the complete preflight when the fenced epoch cannot be revalidated (#8942)", async () => {
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "fallback",
      category: "config",
      fence: { epochId: "a".repeat(64) },
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      fenceFailed: false,
      recoveryBlocked: false,
    });
    mocks.withLaunchReadinessMutationGate.mockResolvedValue({ kind: "unsafe" });

    await expect(launchSandbox("alpha")).rejects.toThrow(
      "Launch readiness evidence could not be safely invalidated",
    );

    expect(mocks.prepareInteractiveSession).not.toHaveBeenCalled();
    expect(mocks.publishLaunchReadiness).not.toHaveBeenCalled();
    expect(mocks.execSandbox).not.toHaveBeenCalled();
  });

  it("does not launch after final semantic validation reports unhealthy state (#8942)", async () => {
    mocks.inspectLaunchReadiness.mockResolvedValue({
      kind: "fallback",
      category: "health",
      fence: { epochId: "a".repeat(64) },
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      fenceFailed: false,
      recoveryBlocked: false,
    });
    mocks.publishLaunchReadiness.mockResolvedValue({
      kind: "validation-failed",
      category: "health",
    });

    await expect(launchSandbox("alpha")).rejects.toThrow(
      "Launch readiness final validation failed due to health",
    );

    expect(mocks.prepareInteractiveSession).toHaveBeenCalled();
    expect(mocks.execSandbox).not.toHaveBeenCalled();
  });

  it("does not print connect's in-sandbox command hint (#6006)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await launchSandbox("alpha");

      const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(output).not.toContain("Inside the sandbox, run");
    } finally {
      logSpy.mockRestore();
    }
  });
});
