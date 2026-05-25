// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decideInstallOllamaLinuxMode,
  installOllamaOnLinux,
  resolveOllamaTarballArch,
  type InstallOllamaLinuxOptions,
} from "../../../dist/lib/onboard/install-ollama-linux";

function makeOpts(overrides: Partial<InstallOllamaLinuxOptions>): InstallOllamaLinuxOptions {
  return {
    isNonInteractive: () => false,
    getEuid: () => 1000,
    isTty: () => true,
    homedir: () => "/home/test",
    arch: () => "arm64",
    canSudoNonInteractive: () => false,
    runCaptureImpl: vi.fn().mockReturnValue(""),
    runCaptureExImpl: vi.fn().mockReturnValue({ stdout: "", exitCode: 0, timedOut: false }),
    runShellImpl: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null }),
    waitForHttpImpl: vi.fn().mockReturnValue(true),
    sleepSecondsImpl: vi.fn(),
    findReachableOllamaHostImpl: vi.fn().mockReturnValue(null),
    ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("ready"),
    fileExistsImpl: vi.fn().mockReturnValue(false),
    readFileImpl: vi.fn().mockReturnValue(""),
    log: vi.fn(),
    errorLog: vi.fn(),
    ...overrides,
  };
}

describe("resolveOllamaTarballArch", () => {
  it("maps node arch labels to Ollama tarball architecture", () => {
    expect(resolveOllamaTarballArch("x64")).toBe("amd64");
    expect(resolveOllamaTarballArch("arm64")).toBe("arm64");
  });

  it("returns null for architectures Ollama does not publish prebuilt tarballs for", () => {
    expect(resolveOllamaTarballArch("arm" as NodeJS.Architecture)).toBeNull();
    expect(resolveOllamaTarballArch("ia32" as NodeJS.Architecture)).toBeNull();
    expect(resolveOllamaTarballArch("ppc64" as NodeJS.Architecture)).toBeNull();
  });
});

describe("decideInstallOllamaLinuxMode", () => {
  const originalEnv = process.env.NEMOCLAW_OLLAMA_INSTALL_MODE;

  beforeEach(() => {
    delete process.env.NEMOCLAW_OLLAMA_INSTALL_MODE;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NEMOCLAW_OLLAMA_INSTALL_MODE;
    else process.env.NEMOCLAW_OLLAMA_INSTALL_MODE = originalEnv;
  });

  it("honours an explicit user-mode env var even with passwordless sudo available", () => {
    process.env.NEMOCLAW_OLLAMA_INSTALL_MODE = "user";
    const opts = makeOpts({ canSudoNonInteractive: () => true });
    expect(decideInstallOllamaLinuxMode(opts)).toBe("user-local");
  });

  it("honours an explicit system-mode env var even in headless non-interactive runs", () => {
    process.env.NEMOCLAW_OLLAMA_INSTALL_MODE = "system";
    const opts = makeOpts({ isNonInteractive: () => true, isTty: () => false });
    expect(decideInstallOllamaLinuxMode(opts)).toBe("system");
  });

  it("rejects unknown NEMOCLAW_OLLAMA_INSTALL_MODE values", () => {
    process.env.NEMOCLAW_OLLAMA_INSTALL_MODE = "garbage";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorLog = vi.fn();
    try {
      expect(() => decideInstallOllamaLinuxMode(makeOpts({ errorLog }))).toThrow(
        /process\.exit\(1\)/,
      );
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Unsupported"));
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("returns system when running as root", () => {
    const opts = makeOpts({ getEuid: () => 0, isNonInteractive: () => true, isTty: () => false });
    expect(decideInstallOllamaLinuxMode(opts)).toBe("system");
  });

  it("returns system when passwordless sudo is available", () => {
    const opts = makeOpts({
      canSudoNonInteractive: () => true,
      isNonInteractive: () => true,
      isTty: () => false,
    });
    expect(decideInstallOllamaLinuxMode(opts)).toBe("system");
  });

  it("returns user-local when non-interactive without passwordless sudo (issue #4114 repro)", () => {
    const opts = makeOpts({
      canSudoNonInteractive: () => false,
      isNonInteractive: () => true,
      isTty: () => true,
    });
    expect(decideInstallOllamaLinuxMode(opts)).toBe("user-local");
  });

  it("returns user-local when stdin is not a TTY even if the flag is unset", () => {
    const opts = makeOpts({
      canSudoNonInteractive: () => false,
      isNonInteractive: () => false,
      isTty: () => false,
    });
    expect(decideInstallOllamaLinuxMode(opts)).toBe("user-local");
  });

  it("returns system in interactive shells without passwordless sudo (lets sudo prompt)", () => {
    const opts = makeOpts({
      canSudoNonInteractive: () => false,
      isNonInteractive: () => false,
      isTty: () => true,
    });
    expect(decideInstallOllamaLinuxMode(opts)).toBe("system");
  });
});

describe("installOllamaOnLinux (user-local)", () => {
  function findRunShellCall(
    runShellImpl: ReturnType<typeof vi.fn>,
    fragment: string,
  ): string | undefined {
    for (const call of runShellImpl.mock.calls) {
      const [cmd] = call as [string, unknown];
      if (typeof cmd === "string" && cmd.includes(fragment)) return cmd;
    }
    return undefined;
  }

  it("downloads the arm64 tar.zst tarball into ~/.local without sudo when zstd is present", () => {
    const runCaptureImpl = vi.fn().mockReturnValue("/usr/bin/zstd");
    const runShellImpl = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const runCaptureExImpl = vi.fn().mockReturnValue({ stdout: "", exitCode: 0, timedOut: false });
    const opts = makeOpts({
      modeOverride: "user-local",
      arch: () => "arm64",
      runCaptureImpl,
      runCaptureExImpl,
      runShellImpl,
    });
    const result = installOllamaOnLinux(opts);
    expect(result).toEqual({ ok: true, mode: "user-local", binPath: "/home/test/.local/bin/ollama" });
    const mkdirCall = findRunShellCall(runShellImpl, "mkdir -p");
    expect(mkdirCall).toContain("/home/test/.local/bin");
    expect(mkdirCall).toContain("/home/test/.local/lib/ollama");
    const downloadCall = findRunShellCall(
      runShellImpl,
      "ollama-linux-arm64.tar.zst",
    );
    expect(downloadCall).toBeDefined();
    expect(downloadCall).toContain("zstd -d");
    expect(downloadCall).toContain("tar -xf - -C '/home/test/.local'");
    expect(downloadCall).not.toContain("sudo");
    const startCall = findRunShellCall(runShellImpl, "nohup '/home/test/.local/bin/ollama'");
    expect(startCall).toBeDefined();
    expect(startCall).toContain(`OLLAMA_HOST=127.0.0.1:`);
    expect(startCall).toContain(" serve ");
  });

  it("uses the amd64 tarball on x64 hosts", () => {
    const runShellImpl = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const opts = makeOpts({
      modeOverride: "user-local",
      arch: () => "x64",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runCaptureExImpl: vi.fn().mockReturnValue({ stdout: "", exitCode: 0, timedOut: false }),
      runShellImpl,
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(true);
    const downloadCall = findRunShellCall(runShellImpl, "ollama-linux-amd64.tar.zst");
    expect(downloadCall).toBeDefined();
  });

  it("shell-quotes user-local paths derived from HOME", () => {
    const runShellImpl = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const opts = makeOpts({
      modeOverride: "user-local",
      homedir: () => "/tmp/name'with-quote",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runCaptureExImpl: vi.fn().mockReturnValue({ stdout: "", exitCode: 0, timedOut: false }),
      runShellImpl,
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(true);
    const commandOutput = runShellImpl.mock.calls
      .map(([cmd]) => (typeof cmd === "string" ? cmd : ""))
      .join("\n");
    expect(commandOutput).toContain("'\\''");
    expect(commandOutput).not.toContain("'/tmp/name'with-quote");
  });

  it("falls back to the .tgz tarball when the .tar.zst HEAD probe fails", () => {
    const runShellImpl = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const runCaptureExImpl = vi.fn().mockReturnValue({
      stdout: "",
      exitCode: 22,
      timedOut: false,
    });
    const opts = makeOpts({
      modeOverride: "user-local",
      arch: () => "arm64",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runCaptureExImpl,
      runShellImpl,
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(true);
    const tgzCall = findRunShellCall(runShellImpl, "ollama-linux-arm64.tgz");
    expect(tgzCall).toBeDefined();
    expect(tgzCall).toContain("tar -xzf - -C '/home/test/.local'");
    expect(tgzCall).not.toContain("sudo");
  });

  it("exits with a per-distro hint when the .tar.zst asset exists but zstd is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorLog = vi.fn();
    try {
      const opts = makeOpts({
        modeOverride: "user-local",
        runCaptureImpl: vi.fn().mockImplementation((cmd: readonly string[]) => {
          if (cmd.includes("zstd")) return "";
          return "";
        }),
        runCaptureExImpl: vi.fn().mockReturnValue({ stdout: "", exitCode: 0, timedOut: false }),
        errorLog,
      });
      expect(() => installOllamaOnLinux(opts)).toThrow(/process\.exit\(1\)/);
      const errorOutput = errorLog.mock.calls.flat().join("\n");
      expect(errorOutput).toContain("sudo apt-get install zstd");
      expect(errorOutput).toContain("sudo dnf install zstd");
      expect(errorOutput).toContain("sudo pacman -S zstd");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("refuses to proceed on unsupported architectures and returns ok:false", () => {
    const errorLog = vi.fn();
    const opts = makeOpts({
      modeOverride: "user-local",
      arch: () => "arm" as NodeJS.Architecture,
      errorLog,
    });
    const result = installOllamaOnLinux(opts);
    expect(result).toEqual({ ok: false, mode: "user-local", binPath: "" });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("arm"));
  });

  it("pulls the matching JetPack add-on tarball when /etc/nv_tegra_release advertises R36", () => {
    const runShellImpl = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const opts = makeOpts({
      modeOverride: "user-local",
      arch: () => "arm64",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runCaptureExImpl: vi.fn().mockReturnValue({ stdout: "", exitCode: 0, timedOut: false }),
      runShellImpl,
      fileExistsImpl: (p: string) => p === "/etc/nv_tegra_release",
      readFileImpl: () => "# R36 (release), REVISION: 0.0",
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(true);
    const jetpackCall = findRunShellCall(runShellImpl, "ollama-linux-arm64-jetpack6.tar.zst");
    expect(jetpackCall).toBeDefined();
  });

  it("reports a failed daemon start as ok:false instead of crashing", () => {
    const opts = makeOpts({
      modeOverride: "user-local",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      waitForHttpImpl: vi.fn().mockReturnValue(false),
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(false);
    expect(result.binPath).toBe("/home/test/.local/bin/ollama");
  });

  it("warns when ~/.local/bin is missing from PATH", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/local/bin:/usr/bin";
    const log = vi.fn();
    try {
      const opts = makeOpts({
        modeOverride: "user-local",
        runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
        log,
      });
      installOllamaOnLinux(opts);
      const logOutput = log.mock.calls.flat().join("\n");
      expect(logOutput).toContain("/home/test/.local/bin");
      expect(logOutput).toContain("PATH");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});

describe("installOllamaOnLinux (system)", () => {
  function findRunShellCall(
    runShellImpl: ReturnType<typeof vi.fn>,
    fragment: string,
  ): string | undefined {
    for (const call of runShellImpl.mock.calls) {
      const [cmd] = call as [string, unknown];
      if (typeof cmd === "string" && cmd.includes(fragment)) return cmd;
    }
    return undefined;
  }

  it("runs the official install.sh and applies the systemd loopback override", () => {
    const runShellImpl = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const ensureOverride = vi.fn().mockReturnValue("ready");
    const opts = makeOpts({
      modeOverride: "system",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runShellImpl,
      ensureManagedOllamaLoopbackSystemdOverrideImpl: ensureOverride,
    });
    const result = installOllamaOnLinux(opts);
    expect(result).toEqual({ ok: true, mode: "system", binPath: "/usr/local/bin/ollama" });
    const installCall = findRunShellCall(runShellImpl, "ollama.com/install.sh");
    expect(installCall).toBeDefined();
    expect(installCall).toContain("curl -fsSL");
    expect(ensureOverride).toHaveBeenCalled();
  });

  it("returns ok:false when the systemd override fails to recover", () => {
    const errorLog = vi.fn();
    const opts = makeOpts({
      modeOverride: "system",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("failed"),
      errorLog,
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(false);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("systemd restart"));
  });

  it("falls back to a manual loopback launch when systemd is not applicable and no daemon is reachable", () => {
    const runShellImpl = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const opts = makeOpts({
      modeOverride: "system",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runShellImpl,
      ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("not-applicable"),
      findReachableOllamaHostImpl: vi.fn().mockReturnValue(null),
      waitForHttpImpl: vi.fn().mockReturnValue(true),
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(true);
    const manualStart = findRunShellCall(runShellImpl, "ollama serve");
    expect(manualStart).toBeDefined();
    expect(manualStart).toContain("OLLAMA_HOST=127.0.0.1:");
  });

  it("skips the manual launch when systemd is not applicable but Ollama is already reachable", () => {
    const runShellImpl = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const waitForHttpImpl = vi.fn().mockReturnValue(true);
    const opts = makeOpts({
      modeOverride: "system",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runShellImpl,
      ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("not-applicable"),
      findReachableOllamaHostImpl: vi.fn().mockReturnValue("127.0.0.1"),
      waitForHttpImpl,
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(true);
    expect(waitForHttpImpl).not.toHaveBeenCalled();
  });
});
