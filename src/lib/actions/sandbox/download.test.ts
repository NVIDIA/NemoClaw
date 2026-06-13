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
import { downloadFromSandbox } from "./download";
import { ensureLiveSandboxOrExit } from "./gateway-state";

const runMock = runOpenshell as unknown as ReturnType<typeof vi.fn>;
const ensureMock = ensureLiveSandboxOrExit as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  runMock.mockReset();
  ensureMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadFromSandbox", () => {
  it("forwards verbatim args to `openshell sandbox download` after a live-sandbox check", async () => {
    const result = await downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
      hostDest: "./out",
    });

    expect(ensureMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(runMock).toHaveBeenCalledWith(
      ["sandbox", "download", "alpha", "/sandbox/.openclaw/workspace/SOUL.md", "./out"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(result).toEqual({
      sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
      hostDest: "./out",
    });
  });

  it("defaults the host destination to the current directory when omitted", async () => {
    await downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x" });
    const args = runMock.mock.calls[0]?.[0];
    expect(args?.at(-1)).toBe(".");
  });

  it("throws (does not exit) when no sandbox path is given", async () => {
    await expect(downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "" })).rejects.toThrow(
      /No sandbox path provided/,
    );
    expect(ensureMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });
});
