// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  createMxcWindowsOpenShellFileDigestObserver,
  type MxcWindowsFileObserverCommand,
  type MxcWindowsFileObserverCommandRunner,
} from "./mxc-windows-file-observer";

const DIGEST = "a".repeat(64);

function runtime(
  runCommand: (command: MxcWindowsFileObserverCommand) => Promise<string>,
  environment: NodeJS.ProcessEnv = {
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    PROVIDER_SECRET: "must-not-enter-observer",
  },
) {
  return {
    platform: "win32" as const,
    environment,
    runCommand,
  };
}

describe("inactive native Windows OpenShell file observation", () => {
  it("passes an encoded path to one absolute system PowerShell process (#8178)", async () => {
    const runCommand = vi.fn<MxcWindowsFileObserverCommandRunner>(async () => DIGEST);
    const observeDigest = createMxcWindowsOpenShellFileDigestObserver(runtime(runCommand));

    await expect(observeDigest("C:\\OpenShell\\openshell.exe")).resolves.toBe(DIGEST);

    expect(runCommand).toHaveBeenCalledOnce();
    const command = runCommand.mock.calls[0]![0];
    expect(command.executablePath).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(command.arguments).toContain("-EncodedCommand");
    expect(command.arguments).not.toContain("C:\\OpenShell\\openshell.exe");
    expect(command.timeoutMs).toBe(30_000);
    expect(command.environment).toEqual({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      NEMOCLAW_MXC_OBSERVER_PATH_B64: Buffer.from("C:\\OpenShell\\openshell.exe", "utf8").toString(
        "base64",
      ),
    });
  });

  it("keeps installation paths and command failures out of diagnostics (#8178)", async () => {
    const sensitivePath = "C:\\OpenShell\\provider-secret.exe";
    const observeDigest = createMxcWindowsOpenShellFileDigestObserver(
      runtime(async () => {
        throw new Error(`failed for ${sensitivePath}`);
      }),
    );

    const failure = observeDigest(sensitivePath);
    await expect(failure).rejects.toThrow(/stable-file boundary failed \(observer-unavailable\)/u);
    await expect(failure).rejects.not.toThrow(sensitivePath);
  });

  it.each([
    ["non-Windows host", { platform: "linux" as const, filePath: "C:\\OpenShell\\a.exe" }],
    ["relative file path", { platform: "win32" as const, filePath: "OpenShell\\a.exe" }],
    ["network file path", { platform: "win32" as const, filePath: "\\\\host\\a.exe" }],
  ])("rejects a %s before invoking PowerShell (#8178)", async (_name, input) => {
    const runCommand = vi.fn<MxcWindowsFileObserverCommandRunner>(async () => DIGEST);
    const observeDigest = createMxcWindowsOpenShellFileDigestObserver({
      ...runtime(runCommand),
      platform: input.platform,
    });

    await expect(observeDigest(input.filePath)).rejects.toThrow(/stable-file boundary/u);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects malformed PowerShell output (#8178)", async () => {
    const observeDigest = createMxcWindowsOpenShellFileDigestObserver(
      runtime(async () => `${DIGEST}\nextra output`),
    );

    await expect(observeDigest("C:\\OpenShell\\a.exe")).rejects.toThrow(
      /stable-file boundary failed \(invalid-output\)/u,
    );
  });

  it.each(["observer-unavailable", "observation-rejected"] as const)(
    "preserves the redacted %s category from PowerShell (#8178)",
    async (category) => {
      const observeDigest = createMxcWindowsOpenShellFileDigestObserver(
        runtime(async () => `NEMOCLAW_MXC_OBSERVER_ERROR:${category}`),
      );

      await expect(observeDigest("C:\\OpenShell\\a.exe")).rejects.toThrow(
        new RegExp(`stable-file boundary failed \\(${category}\\)`, "u"),
      );
    },
  );

  it("does not use a caller-supplied Windows system root (#8178)", async () => {
    const runCommand = vi.fn<MxcWindowsFileObserverCommandRunner>(async () => DIGEST);
    const observeDigest = createMxcWindowsOpenShellFileDigestObserver(
      runtime(runCommand, { SystemRoot: "C:\\caller-controlled" }),
    );

    await expect(observeDigest("C:\\OpenShell\\a.exe")).resolves.toBe(DIGEST);
    expect(runCommand.mock.calls[0]![0].executablePath).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});
