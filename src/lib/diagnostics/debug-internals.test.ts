// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxCommandTransportError } from "../adapters/sandbox/command-transport";
import { runDebug } from "./debug";

const mocks = vi.hoisted(() => ({
  runBuffered:
    vi.fn<import("../adapters/openshell/sandbox-command-cli").OpenShellBufferedCommandRunner>(),
  archive: vi.fn(),
  directories: [] as string[],
  archivedFiles: [] as string[],
}));

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => Buffer.from("")),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "fixture diagnostics", stderr: "" })),
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      const directory = fs.mkdtempSync(...args);
      mocks.directories.push(String(directory));
      return directory;
    },
  };
});
vi.mock("../adapters/openshell/sandbox-command-cli", async (original) => {
  const actual = await original<typeof import("../adapters/openshell/sandbox-command-cli")>();
  return {
    ...actual,
    createCliOpenShellSandboxCommandExecutor: () =>
      actual.createCliOpenShellSandboxCommandExecutor({
        resolveBinary: () => "/fixture/openshell",
        runBuffered: mocks.runBuffered,
      }),
  };
});
vi.mock("./tarball", async () => {
  const fs = await import("node:fs");
  return {
    createTarball: (directory: string, output: string) => {
      mocks.archivedFiles.push(...fs.readdirSync(directory));
      mocks.archive(directory, output);
      return true;
    },
  };
});

beforeEach(() => {
  mocks.runBuffered.mockReset().mockResolvedValue({ status: 0, stdout: "", stderr: "" });
  mocks.archive.mockReset();
  mocks.directories.length = 0;
  mocks.archivedFiles.length = 0;
  vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("debug sandbox internals failure boundary", () => {
  it("retains later diagnostics and archive when endpoint authority rejects sandbox internals", async () => {
    vi.stubEnv(
      "OPENSHELL_GATEWAY_ENDPOINT",
      "https://fixture-user:fixture-private@invalid.example",
    );
    await expect(
      runDebug({ sandboxName: "alpha", gatewayName: "owned", output: "debug.tar.gz" }),
    ).resolves.toBeUndefined();
    expect(mocks.runBuffered).not.toHaveBeenCalled();
    expect(mocks.archive).toHaveBeenCalledOnce();
    expect(mocks.archivedFiles).toEqual(expect.arrayContaining(["curl-models.txt", "vmstat.txt"]));
    expect(mocks.archivedFiles).not.toContain("sandbox-ps.txt");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Sandbox internals skipped:"));
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("fixture-private");
    expect(mocks.directories).toHaveLength(1);
    expect(existsSync(mocks.directories[0]!)).toBe(false);
  });

  it.each([
    new SandboxCommandTransportError("cancelled"),
    new Error("unexpected executor failure"),
  ])(
    "preserves non-endpoint exceptions and still removes collected files [case %#]",
    async (failure) => {
      mocks.runBuffered.mockRejectedValue(failure);
      await expect(
        runDebug({ sandboxName: "alpha", gatewayName: "owned", output: "debug.tar.gz" }),
      ).rejects.toBe(failure);
      expect(mocks.runBuffered).toHaveBeenCalledOnce();
      expect(mocks.archive).not.toHaveBeenCalled();
      expect(mocks.directories).toHaveLength(1);
      expect(existsSync(mocks.directories[0]!)).toBe(false);
    },
  );
});
