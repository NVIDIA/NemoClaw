// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import * as agentDefinitions from "../../agent/defs";
import { loadAgent } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  prepareInteractiveSession: vi.fn(),
  execSandbox: vi.fn(),
  prepareHermesLightTerminalSkin: vi.fn(),
}));

vi.mock("./connect", () => ({
  prepareInteractiveSession: mocks.prepareInteractiveSession,
}));
vi.mock("./exec", () => ({
  execSandbox: mocks.execSandbox,
}));
vi.mock("./connect-hermes-light-skin", () => ({
  prepareHermesLightTerminalSkin: mocks.prepareHermesLightTerminalSkin,
}));

import { launchSandbox } from "./launch";

function sandboxEntry(agentName: string): SandboxEntry {
  return {
    name: "alpha",
    agent: agentName,
    provider: null,
    model: null,
    gpuEnabled: false,
    policies: [],
  } as SandboxEntry;
}

function prepareSession(agentName: string, agent: AgentDefinition | null): void {
  mocks.prepareInteractiveSession.mockImplementation(async () => {
    mocks.calls.push("prepareInteractiveSession");
    return { agent, sb: sandboxEntry(agentName) };
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.execSandbox.mockImplementation(async () => {
      mocks.calls.push("execSandbox");
    });
    mocks.prepareHermesLightTerminalSkin.mockImplementation(() => {
      mocks.calls.push("prepareHermesLightTerminalSkin");
    });
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

  it("holds CUA mutation authority through the exact interactive child execution (#7755)", async () => {
    const nemocua = {
      ...loadAgent("hermes"),
      name: "nemocua",
      runtime: {
        kind: "terminal" as const,
        interactive_command: "nemocua interactive",
        headless_command: "nemocua headless",
      },
    };
    prepareSession("nemocua", nemocua);
    const events: string[] = [];
    const childStarted = deferred();
    const releaseChild = deferred();
    const withSandboxMutationLock = createSerialTestLock(events, "sandbox");
    const withGatewayRouteMutationLock = createSerialTestLock(events, "gateway");
    const requireCuaReadiness = vi.fn(() => events.push("readiness"));
    mocks.execSandbox.mockImplementationOnce(async () => {
      events.push("child");
      childStarted.resolve();
      await releaseChild.promise;
    });

    const launch = launchSandbox("alpha", {
      getSandbox: () => sandboxEntry("nemocua"),
      requireCuaReadiness,
      resolveSandboxGatewayName: () => "gateway-alpha",
      withGatewayRouteMutationLock,
      withSandboxMutationLock,
    });
    await childStarted.promise;
    const mutation = withSandboxMutationLock("alpha", () =>
      withGatewayRouteMutationLock("gateway-alpha", () => events.push("mutation")),
    );
    await Promise.resolve();

    expect(requireCuaReadiness).toHaveBeenCalledWith(expect.objectContaining({ agent: "nemocua" }));
    expect(launchedCommand()).toEqual(["nemocua", "interactive"]);
    expect(events).toEqual(["sandbox:acquired", "gateway:acquired", "readiness", "child"]);

    releaseChild.resolve();
    await launch;
    await mutation;

    expect(events).toEqual([
      "sandbox:acquired",
      "gateway:acquired",
      "readiness",
      "child",
      "gateway:released",
      "sandbox:released",
      "sandbox:acquired",
      "gateway:acquired",
      "mutation",
      "gateway:released",
      "sandbox:released",
    ]);
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
