// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  it("forwards verbatim args to `openshell sandbox upload` after a live-sandbox check", async () => {
    const result = await uploadToSandbox({
      sandboxName: "alpha",
      hostPath: "./SOUL.md",
      sandboxDest: "/sandbox/.openclaw/workspace/SOUL.md",
    });

    expect(ensureMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(runMock).toHaveBeenCalledWith(
      ["sandbox", "upload", "alpha", "./SOUL.md", "/sandbox/.openclaw/workspace/SOUL.md"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(result).toEqual({
      hostPath: "./SOUL.md",
      sandboxDest: "/sandbox/.openclaw/workspace/SOUL.md",
    });
  });

  it("defaults the sandbox destination to /sandbox/ when omitted", async () => {
    await uploadToSandbox({ sandboxName: "alpha", hostPath: "./x" });
    const args = runMock.mock.calls[0]?.[0];
    expect(args?.at(-1)).toBe("/sandbox/");
  });

  it("throws (does not exit) when no host path is given", async () => {
    await expect(uploadToSandbox({ sandboxName: "alpha", hostPath: "" })).rejects.toThrow(
      /No host path provided/,
    );
    expect(ensureMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });
});
