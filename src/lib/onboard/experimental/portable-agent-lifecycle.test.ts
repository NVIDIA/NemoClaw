// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  recoverHermes: vi.fn(),
  recoverOpenClaw: vi.fn(),
  stopHermes: vi.fn(),
  stopOpenClaw: vi.fn(),
}));

vi.mock("./hermes-portable-receipt", () => ({
  inspectPortableAgentReceiptAuthority: mocks.inspect,
}));
vi.mock("./hermes-portable-lifecycle", () => ({
  recoverHermesPortableSandboxLifecycle: mocks.recoverHermes,
  stopHermesPortableSandboxLifecycle: mocks.stopHermes,
}));
vi.mock("./portable-demo-lifecycle", () => ({
  recoverPortableDemoSandboxLifecycle: mocks.recoverOpenClaw,
  stopPortableDemoSandboxLifecycle: mocks.stopOpenClaw,
}));

import {
  inspectPortableAgentReceiptDisposition,
  recoverPortableAgentSandboxLifecycle,
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
  return { kind: "hermes", snapshot: { receipt: { phase } } };
}

describe("portable agent lifecycle dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recoverHermes.mockReturnValue({ kind: "already-running" });
    mocks.stopHermes.mockReturnValue({ kind: "stopped" });
  });

  it.each([
    [{ kind: "none" }, { kind: "absent" }],
    [{ kind: "openclaw" }, { kind: "openclaw" }],
    [hermes("pending"), { kind: "hermes", phase: "pending" }],
    [hermes("configuring"), { kind: "hermes", phase: "configuring" }],
    [hermes("active"), { kind: "hermes", phase: "active" }],
  ])("strictly classifies receipt authority %# (#9203)", (authority, expected) => {
    mocks.inspect.mockReturnValue(authority);
    expect(inspectPortableAgentReceiptDisposition("alpha")).toEqual(expected);
  });

  it("routes active Hermes recovery without OpenClaw or Docker fallthrough (#9203)", () => {
    mocks.inspect.mockReturnValue(hermes("active"));

    expect(recoverPortableAgentSandboxLifecycle("alpha", context)).toEqual({
      kind: "already-running",
    });
    expect(mocks.recoverHermes).toHaveBeenCalledOnce();
    expect(mocks.recoverOpenClaw).not.toHaveBeenCalled();
  });

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
