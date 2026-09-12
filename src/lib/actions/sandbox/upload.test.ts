// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(async () => undefined),
  getKnownSandboxTargetGatewayName: () => null,
}));

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));
vi.mock("../../adapters/openshell/sandbox-transfer-cli", () => ({
  createCliOpenShellSandboxTransferExecutor: () => ({ run: runMock }),
}));

import { deferSandboxLifecycleExit } from "../../core/process-exit";
import { ensureLiveSandboxOrExit } from "./gateway-state";
import { uploadToSandbox } from "./upload";

const ensureMock = ensureLiveSandboxOrExit as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  runMock.mockReset();
  runMock.mockResolvedValue({
    outcome: { kind: "completed", exitCode: 0 },
    release: vi.fn(),
    wasInterrupted: () => false,
  });
  ensureMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uploadToSandbox", () => {
  it("resolves a relative host path against the caller cwd before forwarding to openshell", async () => {
    const result = await uploadToSandbox({
      sandboxName: "alpha",
      hostPath: "./SOUL.md",
      sandboxDest: "/sandbox/.openclaw/workspace/SOUL.md",
    });

    const expectedHostPath = path.resolve(process.cwd(), "SOUL.md");
    expect(ensureMock).toHaveBeenCalledWith("alpha", {
      allowNonReadyPhase: true,
      exit: deferSandboxLifecycleExit,
    });
    expect(runMock).toHaveBeenCalledWith({
      direction: "upload",
      sandboxName: "alpha",
      target: { kind: "selected" },
      source: expectedHostPath,
      destination: "/sandbox/.openclaw/workspace/SOUL.md",
    });
    expect(result).toEqual({
      hostPath: expectedHostPath,
      sandboxDest: "/sandbox/.openclaw/workspace/SOUL.md",
    });
  });

  it("defaults the sandbox destination to /sandbox/ when omitted", async () => {
    await uploadToSandbox({ sandboxName: "alpha", hostPath: "./x" });
    const args = runMock.mock.calls[0]?.[0];
    expect(args?.destination).toBe("/sandbox/");
  });

  it("forwards an absolute host path unchanged", async () => {
    await uploadToSandbox({
      sandboxName: "alpha",
      hostPath: "/etc/hosts",
      sandboxDest: "/sandbox/etc/",
    });
    const args = runMock.mock.calls[0]?.[0];
    expect(args?.source).toBe("/etc/hosts");
  });

  it("preserves a trailing separator on a relative host directory source", async () => {
    await uploadToSandbox({
      sandboxName: "alpha",
      hostPath: "./src/",
      sandboxDest: "/sandbox/work/",
    });
    const args = runMock.mock.calls[0]?.[0];
    const hostPath = args?.source as string;
    expect(hostPath.endsWith(path.sep) || hostPath.endsWith("/")).toBe(true);
    expect(hostPath.slice(0, -1)).toBe(path.resolve(process.cwd(), "src"));
  });

  it("throws (does not exit) when no host path is given", async () => {
    await expect(uploadToSandbox({ sandboxName: "alpha", hostPath: "" })).rejects.toThrow(
      /No host path provided/,
    );
    expect(ensureMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });
});
