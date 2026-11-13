// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InferenceProviderHostState } from "./onboard/provider-host-state";

const INSTALLED_PATH = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";

interface ObservedCommand {
  executable: string;
  cwd: string;
  args: string[];
}

let stateDirectory = "";
let sourceDirectory = "";
let commandLog = "";
let interopMode = "";
let removeFixture = () => {};
let wsl = true;
const readiness = vi.fn(() => ({
  loopbackOnly: true,
  reachable: true,
  hostValidationEnabled: true,
  protected: true,
}));

async function loadRunner(): Promise<typeof import("./runner")> {
  return import("./runner");
}

async function inheritPrivateDirectory(): Promise<void> {
  const { default: childProcess } = await vi.importActual<{
    default: typeof import("node:child_process");
  }>("node:child_process");
  const originalSpawn = childProcess.spawn;
  vi.spyOn(childProcess, "spawn").mockImplementation(
    (...args: Parameters<typeof originalSpawn>) => {
      const [command, commandArgs, options] = args;
      return originalSpawn(command, commandArgs, {
        ...options,
        cwd: options?.cwd ?? sourceDirectory,
      });
    },
  );
}

function setWsl(value: boolean): void {
  wsl = value;
  fs.writeFileSync(interopMode, JSON.stringify({ wsl: value }));
}

function observedCommands(): ObservedCommand[] {
  return fs
    .readFileSync(commandLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ObservedCommand);
}

async function menuFor(state: InferenceProviderHostState) {
  const { buildInferenceProviderMenu } = await import("./onboard/provider-menu");
  const windows = state.windowsHostOllamaDockerRequirement;
  return buildInferenceProviderMenu({
    ...state,
    remoteProviderConfig: {},
    agentProviderOptions: [],
    experimental: false,
    nvidiaPlatform: undefined,
    ollamaPort: 11434,
    windowsHostLabelSuffix: windows.supported ? "" : windows.labelSuffix,
    windowsHostInstallLabel: windows.installLabel,
    windowsHostStartLabel: windows.startLabel,
    ollamaInstallEntry: state.ollamaInstallMenu.entry,
    routedEnabled: false,
  });
}

beforeEach(() => {
  vi.resetModules();
  wsl = true;
  readiness.mockClear();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nc-windows-interop-"));
  removeFixture = () => fs.rmSync(directory, { recursive: true, force: true });
  stateDirectory = path.join(directory, "state");
  sourceDirectory = path.join(stateDirectory, "source");
  const bin = path.join(directory, "bin");
  commandLog = path.join(directory, "commands.jsonl");
  interopMode = path.join(directory, "interop.json");
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  fs.mkdirSync(sourceDirectory);
  fs.chmodSync(sourceDirectory, 0o755);
  fs.mkdirSync(bin);
  fs.writeFileSync(commandLog, "");
  fs.writeFileSync(interopMode, JSON.stringify({ wsl: true }));

  // Replay the reported launch error. This fixture does not run Windows or WSL.
  const executable = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const command = {
  executable: path.basename(process.argv[1]).toLowerCase(),
  cwd: process.cwd(),
  args: process.argv.slice(2),
};
fs.appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(command) + "\\n");
switch (true) {
  case command.args.includes("--report-cwd"):
    process.stdout.write(command.cwd);
    process.exit(0);
}
let ancestor = command.cwd;
const ancestors = [];
while (ancestor !== path.dirname(ancestor)) {
  ancestors.push(ancestor);
  ancestor = path.dirname(ancestor);
}
const mode = JSON.parse(fs.readFileSync(${JSON.stringify(interopMode)}, "utf8"));
const blocked = mode.wsl && ancestors.some((entry) => (fs.statSync(entry).mode & 0o001) === 0);
switch (true) {
  case blocked:
    process.stderr.write("powershell.exe: Invalid argument\\n");
    process.exit(1);
  case command.executable === "taskkill.exe":
    process.exit(0);
}
const script = command.args.at(-1) || "";
const installedPath = ${JSON.stringify(INSTALLED_PATH)};
switch (true) {
  case script.includes("__NEMOCLAW_WINDOWS_INSTALLER_PID__:"):
    process.stdout.write("__NEMOCLAW_WINDOWS_INSTALLER_PID__:42000\\n");
    break;
  case script.includes("ConvertTo-Json -Compress"):
    process.stdout.write(JSON.stringify({ userHost: "127.0.0.1:11434", watcherPath: null, daemonPath: installedPath }));
    break;
  case script.includes("Get-NetTCPConnection"):
    process.stdout.write("127.0.0.1\\n");
    break;
  case script.includes("Get-Command ollama.exe"):
    process.stdout.write(installedPath);
    break;
  case script.includes("SetEnvironmentVariable('OLLAMA_HOST'") && script.includes("GetEnvironmentVariable('OLLAMA_HOST'"):
    process.stdout.write("127.0.0.1:11434");
    break;
  case script.includes("Write-Output 'interop-ready'"):
    process.stdout.write("interop-ready");
    break;
}
`;
  for (const name of [
    "powershell.exe",
    "PowerShell.EXE",
    "taskkill.exe",
    "relative-helper.exe",
    "host-helper",
  ]) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, executable);
    fs.chmodSync(file, 0o755);
  }
  vi.doMock("./core/repository-root", () => ({ REPOSITORY_ROOT: sourceDirectory }));
  vi.doMock("./platform", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./platform")>()),
    detectDockerHost: () => null,
    isWsl: () => wsl,
  }));
  vi.doMock("./adapters/docker/runtime", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./adapters/docker/runtime")>()),
    detectContainerRuntimeFromDockerInfo: () => "docker-desktop",
  }));
  vi.doMock("./inference/local", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./inference/local")>()),
    probeWindowsHostOllamaRouteProtection: readiness,
  }));
  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
      ...actual,
      spawn: ((...args: Parameters<typeof actual.spawn>) => {
        const [command, commandArgs, options] = args;
        return actual.spawn(command, commandArgs, {
          ...options,
          cwd: options?.cwd ?? sourceDirectory,
        });
      }) as typeof actual.spawn,
    };
  });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
});

afterEach(() => {
  vi.doUnmock("./core/repository-root");
  vi.doUnmock("./platform");
  vi.doUnmock("./adapters/docker/runtime");
  vi.doUnmock("./inference/local");
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  removeFixture();
});

// The fixture requires POSIX executables and Unix directory permissions.
describe.skipIf(process.platform === "win32")(
  "Windows interoperability from a private installation",
  () => {
    it("offers restart and reuses installed Windows Ollama without opening its state directory (#13301)", async () => {
      const { detectInferenceProviderHostState } = await import("./onboard/provider-host-state");
      const state = detectInferenceProviderHostState({
        gpu: null,
        experimental: false,
        probeVllm: false,
        log: () => {},
        deps: {
          hostCommandExists: () => false,
          findReachableOllamaHost: () => null,
          getContainerRuntime: () => "docker-desktop",
          detectVllmProfile: () => null,
          probeWindowsHostOllamaRouteProtection: () => ({
            loopbackOnly: true,
            reachable: false,
            hostValidationEnabled: false,
            protected: false,
          }),
        },
      });
      const menu = await menuFor(state);
      expect(menu.options).toContainEqual({
        key: "start-windows-ollama",
        label: "Restart loopback-only Ollama on Windows host",
      });
      expect(menu.options.some(({ key }) => key === "install-windows-ollama")).toBe(false);
      expect(state.winOllamaInstalledPath).toBe(INSTALLED_PATH);

      const windows = await import("./inference/ollama/windows");
      const result = windows.setupWindowsOllamaLoopbackBinding({
        installedPath: state.winOllamaInstalledPath,
        delay: () => {},
      });
      expect(result.ok).toBe(true);
      result.ok && result.commit();
      expect(readiness).toHaveBeenCalled();
      const scripts = observedCommands().map(({ args }) => args.at(-1) ?? "");
      expect(scripts.some((script) => script.includes("ConvertTo-Json -Compress"))).toBe(true);
      expect(
        scripts.some((script) => script.includes("SetEnvironmentVariable('OLLAMA_HOST'")),
      ).toBe(true);
      expect(scripts.some((script) => script.includes("Stop-Process -Force"))).toBe(true);
      expect(
        scripts.some((script) => script.includes(`Start-Process -FilePath '${INSTALLED_PATH}'`)),
      ).toBe(true);
      expect(scripts.some((script) => script.includes("irm https://ollama.com/install.ps1"))).toBe(
        false,
      );
      expect(fs.statSync(stateDirectory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(sourceDirectory).mode & 0o777).toBe(0o755);
    });

    it.each([
      [
        "runCapture",
        (runner: typeof import("./runner")) =>
          runner.runCapture(["powershell.exe", "-Command", "Write-Output 'interop-ready'"], {
            ignoreError: true,
          }),
      ],
      [
        "runCaptureEx",
        (runner: typeof import("./runner")) =>
          runner.runCaptureEx(["powershell.exe", "-Command", "Write-Output 'interop-ready'"])
            .stdout,
      ],
      [
        "run",
        (runner: typeof import("./runner")) =>
          String(
            runner.run(["powershell.exe", "-Command", "Write-Output 'interop-ready'"], {
              ignoreError: true,
              suppressOutput: true,
            }).stdout,
          ).trim(),
      ],
      [
        "runInteractive",
        (runner: typeof import("./runner")) =>
          String(
            runner.runInteractive(["powershell.exe", "-Command", "Write-Output 'interop-ready'"], {
              ignoreError: true,
              suppressOutput: true,
            }).stdout,
          ).trim(),
      ],
      [
        "runFile",
        (runner: typeof import("./runner")) =>
          String(
            runner.runFile("powershell.exe", ["-Command", "Write-Output 'interop-ready'"], {
              ignoreError: true,
              suppressOutput: true,
            }).stdout,
          ).trim(),
      ],
    ] as const)(
      "runs the Windows command through %s without the private directory (#13301)",
      async (_name, invoke) => {
        expect(invoke(await loadRunner())).toBe("interop-ready");
        expect(fs.statSync(stateDirectory).mode & 0o777).toBe(0o700);
      },
    );

    it("launches an absolute PowerShell path with mixed case (#13301)", async () => {
      const executable = path.join(path.dirname(commandLog), "bin", "PowerShell.EXE");
      expect(
        (await loadRunner()).runCapture([executable, "-Command", "Write-Output 'interop-ready'"]),
      ).toBe("interop-ready");
      expect(fs.statSync(stateDirectory).mode & 0o777).toBe(0o700);
    });

    it.each(["host-helper", "relative-helper.exe"])(
      "keeps the repository working directory for %s (#13301)",
      async (executable) => {
        expect((await loadRunner()).runCapture([executable, "--report-cwd"])).toBe(sourceDirectory);
      },
    );

    it("keeps the repository working directory outside WSL (#13301)", async () => {
      setWsl(false);
      expect((await loadRunner()).runCapture(["powershell.exe", "--report-cwd"])).toBe(
        sourceDirectory,
      );
    });

    it("keeps explicit Linux shell commands in the repository (#13301)", async () => {
      const result = (await loadRunner()).runShell("pwd", { suppressOutput: true });
      expect(String(result.stdout).trim()).toBe(sourceDirectory);
    });

    it("launches and cancels the Windows installer from a private inherited directory (#13301)", async () => {
      await inheritPrivateDirectory();
      const windows = await import("./inference/ollama/windows");
      const installer = windows.startWindowsOllamaInstaller();
      await installer.completion;
      await installer.cancelAndWait();
      expect(observedCommands().map(({ executable }) => executable)).toEqual([
        "powershell.exe",
        "taskkill.exe",
      ]);
      expect(observedCommands().at(-1)?.args).toEqual(["/PID", "42000", "/T", "/F"]);
      expect(fs.statSync(stateDirectory).mode & 0o777).toBe(0o700);
    });

    it("preserves the direct Windows launcher's inherited directory outside WSL (#13301)", async () => {
      setWsl(false);
      await inheritPrivateDirectory();
      const windows = await import("./inference/ollama/windows");
      await windows.startWindowsOllamaInstaller().completion;
      expect(observedCommands().map(({ cwd }) => cwd)).toEqual([sourceDirectory]);
    });
  },
);
