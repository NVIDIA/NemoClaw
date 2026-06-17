// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(async () => undefined),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  runOpenshell: vi.fn(),
}));

import { runOpenshell } from "../../adapters/openshell/runtime";
import { ensureLiveSandboxOrExit } from "./gateway-state";
import { uploadToSandbox } from "./upload";

const runMock = runOpenshell as unknown as ReturnType<typeof vi.fn>;
const ensureMock = ensureLiveSandboxOrExit as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  runMock.mockReset();
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
    expect(ensureMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(runMock).toHaveBeenCalledWith(
      ["sandbox", "upload", "alpha", expectedHostPath, "/sandbox/.openclaw/workspace/SOUL.md"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(result).toEqual({
      hostPath: expectedHostPath,
      sandboxDest: "/sandbox/.openclaw/workspace/SOUL.md",
    });
  });

  it("defaults the sandbox destination to /sandbox/ when omitted", async () => {
    await uploadToSandbox({ sandboxName: "alpha", hostPath: "./x" });
    const args = runMock.mock.calls[0]?.[0];
    expect(args?.at(-1)).toBe("/sandbox/");
  });

  it("forwards an absolute host path unchanged", async () => {
    await uploadToSandbox({
      sandboxName: "alpha",
      hostPath: "/etc/hosts",
      sandboxDest: "/sandbox/etc/",
    });
    const args = runMock.mock.calls[0]?.[0];
    expect(args?.[3]).toBe("/etc/hosts");
  });

  it("preserves a trailing separator on a relative host directory source", async () => {
    await uploadToSandbox({
      sandboxName: "alpha",
      hostPath: "./src/",
      sandboxDest: "/sandbox/work/",
    });
    const args = runMock.mock.calls[0]?.[0];
    const hostPath = args?.[3] as string;
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
