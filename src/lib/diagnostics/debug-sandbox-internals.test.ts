// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execSandbox, getSandbox, listSandboxes } = vi.hoisted(() => ({
  execSandbox: vi.fn(),
  getSandbox: vi.fn(),
  listSandboxes: vi.fn(),
}));

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock("../adapters/openshell/sandbox-control-routing", () => ({
  execSandboxReadOnlyWithGrpcFallback: execSandbox,
}));
vi.mock("../state/registry", () => ({ getSandbox, listSandboxes }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync,
}));

import { collectSandboxInternals } from "./debug";

describe("collectSandboxInternals", () => {
  let collectDir: string;

  beforeEach(() => {
    collectDir = mkdtempSync(join(tmpdir(), "nemoclaw-debug-sandbox-"));
    execFileSync.mockReturnValue(Buffer.alloc(0));
    getSandbox.mockReturnValue({ gatewayPort: 19080 });
    execSandbox.mockResolvedValue({ status: 0, stdout: "ok", stderr: "" });
  });

  afterEach(() => {
    rmSync(collectDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("collects the quick command set through the sandbox's named gateway", async () => {
    await collectSandboxInternals(collectDir, "alpha", true);

    expect(execSandbox.mock.calls).toEqual([
      ["nemoclaw-19080", { sandboxName: "alpha", command: ["ps", "-ef"], timeoutMs: 30_000 }],
      ["nemoclaw-19080", { sandboxName: "alpha", command: ["free", "-m"], timeoutMs: 30_000 }],
    ]);
    expect(readFileSync(join(collectDir, "sandbox-ps.txt"), "utf8")).toBe("ok\n");
  });

  it("adds top and gateway-log collection outside quick mode and redacts output", async () => {
    execSandbox.mockResolvedValue({
      status: 0,
      stdout: "API_KEY=secret-value",
      stderr: "",
    });

    await collectSandboxInternals(collectDir, "alpha", false);

    expect(execSandbox.mock.calls.map((call) => call[1].command)).toEqual([
      ["ps", "-ef"],
      ["free", "-m"],
      ["top", "-b", "-n", "1"],
      ["tail", "-200", "/tmp/gateway.log"],
    ]);
    expect(readFileSync(join(collectDir, "sandbox-gateway-log.txt"), "utf8")).toBe(
      "API_KEY=<REDACTED>\n",
    );
  });

  it("keeps missing CLI and unregistered targets nonfatal", async () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error("not found");
    });
    await expect(collectSandboxInternals(collectDir, "alpha", true)).resolves.toBeUndefined();
    expect(execSandbox).not.toHaveBeenCalled();

    execFileSync.mockReturnValue(Buffer.alloc(0));
    getSandbox.mockReturnValue(undefined);
    await expect(collectSandboxInternals(collectDir, "alpha", true)).resolves.toBeUndefined();
    expect(execSandbox).not.toHaveBeenCalled();
  });

  it("redacts credential-shaped invalid gateway bindings from terminal warnings", async () => {
    const secret = ["sk-proj", "debugregistrycredential"].join("-");
    getSandbox.mockReturnValue({ gatewayName: secret });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await collectSandboxInternals(collectDir, "alpha", true);

      const terminalOutput = consoleLog.mock.calls.flat().join("\n");
      expect(terminalOutput).not.toContain(secret);
      expect(terminalOutput).toContain("<REDACTED>");
      expect(execSandbox).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
    }
  });

  it("records one routing failure and continues collecting", async () => {
    execSandbox
      .mockRejectedValueOnce(new Error("API_KEY=secret-value"))
      .mockResolvedValue({ status: 0, stdout: "free-ok", stderr: "" });

    await collectSandboxInternals(collectDir, "alpha", true);

    expect(execSandbox).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(collectDir, "sandbox-ps.txt"), "utf8")).toBe(
      "  (sandbox command failed: API_KEY=<REDACTED>)\n",
    );
    expect(readFileSync(join(collectDir, "sandbox-free.txt"), "utf8")).toBe("free-ok\n");
  });

  it("records resolved transport errors with partial output and continues collecting", async () => {
    execSandbox
      .mockResolvedValueOnce({
        status: null,
        stdout: "partial output",
        stderr: "partial warning",
        error: new Error("API_KEY=secret-value"),
      })
      .mockResolvedValue({ status: 0, stdout: "free-ok", stderr: "" });

    await collectSandboxInternals(collectDir, "alpha", true);

    expect(execSandbox).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(collectDir, "sandbox-ps.txt"), "utf8")).toBe(
      [
        "partial output",
        "partial warning",
        "  (sandbox command failed; detail follows)",
        "API_KEY=<REDACTED>",
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(collectDir, "sandbox-free.txt"), "utf8")).toBe("free-ok\n");
  });

  it("redacts credentials split across stdout and stderr as one stream", async () => {
    execSandbox.mockResolvedValue({
      status: 0,
      stdout: "Authorization: Bearer",
      stderr: " secret-value",
    });

    await collectSandboxInternals(collectDir, "alpha", true);

    expect(readFileSync(join(collectDir, "sandbox-ps.txt"), "utf8")).toBe(
      "Authorization: <REDACTED>",
    );
  });
});
