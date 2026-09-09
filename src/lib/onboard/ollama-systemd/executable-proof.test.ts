// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseOllamaSystemdExecutionMetadata,
  proveOllamaSystemdServiceExecutable,
  readElfInterpreterPath,
  type OllamaExecutableCaptureResult,
  type OllamaExecutablePathMetadata,
} from "./executable-proof";

const executablePath = "/usr/local/bin/ollama";
const interpreterPath = "/lib64/ld-linux-x86-64.so.2";
const serviceUserAccessScript = [
  '/usr/bin/test -x "$1"',
  "status=$?",
  "/usr/bin/printf 'nemoclaw-service-user-access:%s\\n' \"$status\"",
  'exit "$status"',
].join("\n");
const temporaryDirectories: string[] = [];

function capture(
  exitCode: number | null,
  stdout = "",
  timedOut = false,
): OllamaExecutableCaptureResult {
  return { exitCode, stdout, timedOut };
}

function accessCapture(accessible: boolean): OllamaExecutableCaptureResult {
  const exitCode = accessible ? 0 : 1;
  return capture(exitCode, `nemoclaw-service-user-access:${exitCode}\n`);
}

function isServiceUserAccessCommand(command: readonly string[]): boolean {
  return command.includes("/bin/sh") && command.includes(serviceUserAccessScript);
}

function isServiceUserProofCommand(command: readonly string[]): boolean {
  return command.includes("/usr/bin/systemd-run") && command.at(-1) === "--version";
}

function expectServiceUserProofCommand(command: readonly string[], serviceUser: string): void {
  expect(command.slice(0, 5)).toEqual([
    "/usr/bin/sudo",
    "-n",
    "/usr/bin/env",
    "LC_ALL=C",
    "/usr/bin/systemd-run",
  ]);
  expect(command).toEqual(
    expect.arrayContaining([
    "--wait",
    "--pipe",
    "--collect",
    "--service-type=exec",
    `--uid=${serviceUser}`,
    "--property=KillMode=control-group",
    "--property=RuntimeMaxSec=15s",
    "--property=TimeoutStopSec=250ms",
    "--property=SendSIGKILL=yes",
    ]),
  );
  expect(command.slice(-2)).toEqual([executablePath, "--version"]);
}

type CommandCase = readonly [
  matches: (command: readonly string[]) => boolean,
  result: (command: readonly string[]) => OllamaExecutableCaptureResult,
];

function captureForCommand(
  command: readonly string[],
  cases: readonly CommandCase[],
): OllamaExecutableCaptureResult {
  return cases.find(([matches]) => matches(command))?.[1](command) ?? capture(1);
}

function metadataFor(
  mode: number,
  overrides: Partial<OllamaExecutablePathMetadata> = {},
): OllamaExecutablePathMetadata {
  return {
    dev: 1,
    gid: 0,
    ino: 2,
    isDirectory: false,
    isFile: true,
    isSymbolicLink: false,
    mode,
    uid: 0,
    ...overrides,
  };
}

function rootDirectoryMetadata(): OllamaExecutablePathMetadata {
  return metadataFor(0o755, { ino: 1, isDirectory: true, isFile: false });
}

function proofFixture(
  initialMode = 0o644,
  serviceUser = "ollama",
): {
  currentMode: () => number;
  runCaptureExImpl: ReturnType<typeof vi.fn>;
  setMode: (nextMode: number) => void;
  options: Parameters<typeof proveOllamaSystemdServiceExecutable>[0];
} {
  let mode = initialMode;
  const versionResults = [capture(1), capture(0, "ollama version is 0.11.10")];
  const runCaptureExImpl = vi.fn((command: readonly string[]) =>
    captureForCommand(command, [
      [
        (candidate) => candidate[0] === "/usr/bin/systemctl",
        () =>
          capture(
            0,
            `User=${serviceUser}\nExecStart={ path=${executablePath} ; argv[]=${executablePath} serve ; ignore_errors=no ; }`,
          ),
      ],
      [(candidate) => candidate[0] === "/usr/bin/id", () => capture(0, "997")],
      [
        (candidate) => isServiceUserAccessCommand(candidate) && candidate.at(-1) === executablePath,
        () => accessCapture(false),
      ],
      [(candidate) => isServiceUserAccessCommand(candidate), () => accessCapture(true)],
      [
        (candidate) => candidate.includes("/usr/bin/chmod"),
        (candidate) => {
          mode = Number.parseInt(String(candidate[candidate.indexOf("/usr/bin/chmod") + 1]), 8);
          return capture(0);
        },
      ],
      [
        (candidate) => candidate.includes(executablePath),
        () => versionResults.shift() ?? capture(1),
      ],
    ]),
  );
  const rootAncestors = new Set(["/", "/usr", "/usr/local", "/usr/local/bin"]);
  const inspectPathImpl = (candidate: string): OllamaExecutablePathMetadata | null =>
    candidate === executablePath
      ? metadataFor(mode)
      : rootAncestors.has(candidate)
        ? rootDirectoryMetadata()
        : null;
  return {
    currentMode: () => mode,
    runCaptureExImpl,
    setMode: (nextMode) => {
      mode = nextMode;
    },
    options: {
      sudoPrefix: "sudo -n",
      inspectPathImpl,
      readElfInterpreterImpl: () => interpreterPath,
      runCaptureExImpl,
    },
  };
}

function writeElf64(interpreter: string | null): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-elf-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "ollama");
  const interpreterBytes = interpreter ? Buffer.from(`${interpreter}\0`, "utf8") : Buffer.alloc(0);
  const programHeaderOffset = 64;
  const interpreterOffset = programHeaderOffset + 56;
  const buffer = Buffer.alloc(interpreterOffset + interpreterBytes.length);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  buffer.writeUInt16LE(2, 16);
  buffer.writeUInt16LE(0x3e, 18);
  buffer.writeUInt32LE(1, 20);
  buffer.writeBigUInt64LE(BigInt(programHeaderOffset), 32);
  buffer.writeUInt16LE(64, 52);
  buffer.writeUInt16LE(56, 54);
  buffer.writeUInt16LE(1, 56);
  buffer.writeUInt32LE(interpreter ? 3 : 1, programHeaderOffset);
  buffer.writeBigUInt64LE(BigInt(interpreterOffset), programHeaderOffset + 8);
  buffer.writeBigUInt64LE(BigInt(interpreterBytes.length), programHeaderOffset + 32);
  interpreterBytes.copy(buffer, interpreterOffset);
  fs.writeFileSync(file, buffer);
  return file;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("parseOllamaSystemdExecutionMetadata", () => {
  it("accepts one configured user and one absolute ExecStart executable (#9728)", () => {
    expect(
      parseOllamaSystemdExecutionMetadata(
        `User=ollama\nExecStart={ path=${executablePath} ; argv[]=${executablePath} serve ; }`,
      ),
    ).toEqual({ executablePath, serviceUser: "ollama" });
  });

  it("rejects missing users, relative paths, and multiple ExecStart commands (#9728)", () => {
    expect(
      parseOllamaSystemdExecutionMetadata(
        `User=\nExecStart={ path=${executablePath} ; argv[]=${executablePath} serve ; }`,
      ),
    ).toBeNull();
    expect(
      parseOllamaSystemdExecutionMetadata(
        "User=ollama\nExecStart={ path=ollama ; argv[]=ollama serve ; }",
      ),
    ).toBeNull();
    expect(
      parseOllamaSystemdExecutionMetadata(
        `User=ollama\nExecStart={ path=${executablePath} ; }; { path=/tmp/ollama ; }`,
      ),
    ).toBeNull();
  });
});

describe("readElfInterpreterPath", () => {
  it("reads the exact PT_INTERP path without executing the ELF file (#9728)", () => {
    expect(readElfInterpreterPath(writeElf64(interpreterPath))).toBe(interpreterPath);
  });

  it("rejects an ELF file that has no PT_INTERP entry (#9728)", () => {
    expect(() => readElfInterpreterPath(writeElf64(null))).toThrow(/PT_INTERP/u);
  });

  it("rejects a FIFO without waiting for a writer (#9728)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-fifo-"));
    temporaryDirectories.push(directory);
    const fifoPath = path.join(directory, "ollama");
    const result = spawnSync("mkfifo", [fifoPath], { timeout: 1_000 });

    expect(result.status).toBe(0);
    expect(() => readElfInterpreterPath(fifoPath)).toThrow(/not a regular file/u);
  });
});

describe("proveOllamaSystemdServiceExecutable", () => {
  it("uses sudo's numeric UID form for every service-user command (#9728)", () => {
    const fixture = proofFixture(0o755, "997");

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      classification: "repair-outside-authority",
      ok: false,
    });
    const commands = fixture.runCaptureExImpl.mock.calls.map(([command]) => command as string[]);
    const serviceUserAccessCommands = commands.filter(isServiceUserAccessCommand);
    expect(serviceUserAccessCommands).toHaveLength(2);
    expect(
      serviceUserAccessCommands.every((command) => command[command.indexOf("-u") + 1] === "#997"),
    ).toBe(true);
    const [serviceUserProof] = commands.filter(isServiceUserProofCommand);
    expect(serviceUserProof).toBeDefined();
    expectServiceUserProofCommand(serviceUserProof ?? [], "997");
    expect(commands).toContainEqual(["/usr/bin/id", "-u", "997"]);
  });

  it("repairs and re-verifies the installer-owned executable when sudo returns status 1 and the execute-access check fails (#9728)", () => {
    const fixture = proofFixture();

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      ok: true,
      repaired: true,
    });
    expect(fixture.currentMode()).toBe(0o755);
    const commands = fixture.runCaptureExImpl.mock.calls.map(([command]) => command as string[]);
    const serviceUserProofs = commands.filter(isServiceUserProofCommand);
    expect(serviceUserProofs).toHaveLength(2);
    serviceUserProofs.forEach((command) => expectServiceUserProofCommand(command, "ollama"));
    expect(commands.filter((command) => isServiceUserAccessCommand(command))).toEqual([
      [
        "/usr/bin/sudo",
        "-n",
        "-u",
        "ollama",
        "--",
        "/bin/sh",
        "-c",
        serviceUserAccessScript,
        "nemoclaw-service-user-access-proof",
        executablePath,
      ],
      [
        "/usr/bin/sudo",
        "-n",
        "-u",
        "ollama",
        "--",
        "/bin/sh",
        "-c",
        serviceUserAccessScript,
        "nemoclaw-service-user-access-proof",
        interpreterPath,
      ],
    ]);
    expect(commands.filter((command) => command.includes("/usr/bin/chmod"))).toEqual([
      ["/usr/bin/sudo", "-n", "/usr/bin/chmod", "0755", "--", executablePath],
    ]);
    expect(commands.flat()).not.toContain("serve");
  });

  it("restores the previous mode when the proof still fails after repair (#9728)", () => {
    const fixture = proofFixture();
    fixture.runCaptureExImpl.mockImplementation((command: readonly string[]) =>
      captureForCommand(command, [
        [
          (candidate) => candidate[0] === "/usr/bin/systemctl",
          () =>
            capture(
              0,
              `User=ollama\nExecStart={ path=${executablePath} ; argv[]=${executablePath} serve ; }`,
            ),
        ],
        [
          (candidate) =>
            isServiceUserAccessCommand(candidate) && candidate.at(-1) === executablePath,
          () => accessCapture(false),
        ],
        [(candidate) => candidate[0] === "/usr/bin/id", () => capture(0)],
        [(candidate) => isServiceUserAccessCommand(candidate), () => accessCapture(true)],
        [
          (candidate) => candidate.includes("/usr/bin/chmod"),
          (candidate) => {
            const nextMode = Number.parseInt(
              String(candidate[candidate.indexOf("/usr/bin/chmod") + 1]),
              8,
            );
            fixture.setMode(nextMode);
            return capture(0);
          },
        ],
        [(candidate) => candidate.includes(executablePath), () => capture(1)],
      ]),
    );

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      classification: "execution-after-repair",
      ok: false,
      rolledBack: true,
    });
    const chmodCommands = fixture.runCaptureExImpl.mock.calls
      .map(([command]) => command as string[])
      .filter((command) => command.includes("/usr/bin/chmod"));
    expect(chmodCommands).toEqual([
      ["/usr/bin/sudo", "-n", "/usr/bin/chmod", "0755", "--", executablePath],
      ["/usr/bin/sudo", "-n", "/usr/bin/chmod", "0644", "--", executablePath],
    ]);
    expect(fixture.currentMode()).toBe(0o644);
  });

  it("does not change an executable outside the official installer path (#9728)", () => {
    const fixture = proofFixture();
    fixture.runCaptureExImpl.mockImplementation((command: readonly string[]) =>
      captureForCommand(command, [
        [
          (candidate) => candidate[0] === "/usr/bin/systemctl",
          () =>
            capture(
              0,
              "User=ollama\nExecStart={ path=/opt/operator/ollama ; argv[]=/opt/operator/ollama serve ; }",
            ),
        ],
        [
          (candidate) =>
            isServiceUserAccessCommand(candidate) && candidate.at(-1) === "/opt/operator/ollama",
          () => accessCapture(false),
        ],
        [(candidate) => candidate[0] === "/usr/bin/id", () => capture(0)],
        [(candidate) => isServiceUserAccessCommand(candidate), () => accessCapture(true)],
        [(candidate) => candidate.includes("/opt/operator/ollama"), () => capture(1)],
      ]),
    );

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      classification: "repair-outside-authority",
      ok: false,
    });
    expect(
      fixture.runCaptureExImpl.mock.calls.some(([command]) =>
        (command as readonly string[]).includes("/usr/bin/chmod"),
      ),
    ).toBe(false);
  });

  it("does not change the official path when an ancestor is operator-writable (#9728)", () => {
    const fixture = proofFixture();
    const inspect = fixture.options.inspectPathImpl;
    fixture.options.inspectPathImpl = (candidate: string) =>
      candidate === "/usr/local"
        ? metadataFor(0o777, { isDirectory: true, isFile: false })
        : (inspect?.(candidate) ?? null);

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      classification: "repair-outside-authority",
      ok: false,
    });
    expect(
      fixture.runCaptureExImpl.mock.calls.some(([command]) =>
        (command as readonly string[]).includes("/usr/bin/chmod"),
      ),
    ).toBe(false);
  });

  it("fails closed without chmod when mode 0755 still fails the service-user execute-access check (#9728)", () => {
    const fixture = proofFixture(0o755);

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      classification: "repair-outside-authority",
      message: expect.stringContaining(
        "no executable permission change within its installer authority",
      ),
      ok: false,
    });
    expect(
      fixture.runCaptureExImpl.mock.calls.some(([command]) =>
        (command as readonly string[]).includes("/usr/bin/chmod"),
      ),
    ).toBe(false);
  });

  it("does not add execute bits to a group-writable installer path (#9728)", () => {
    const fixture = proofFixture(0o666);

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      classification: "repair-outside-authority",
      ok: false,
    });
    expect(
      fixture.runCaptureExImpl.mock.calls.some(([command]) =>
        (command as readonly string[]).includes("/usr/bin/chmod"),
      ),
    ).toBe(false);
  });

  it("classifies an inaccessible interpreter after the service-user proof fails (#9728)", () => {
    const fixture = proofFixture(0o755);
    fixture.runCaptureExImpl.mockImplementation((command: readonly string[]) =>
      captureForCommand(command, [
        [
          (candidate) => candidate[0] === "/usr/bin/systemctl",
          () =>
            capture(
              0,
              `User=ollama\nExecStart={ path=${executablePath} ; argv[]=${executablePath} serve ; }`,
            ),
        ],
        [(candidate) => candidate[0] === "/usr/bin/id", () => capture(0)],
        [(candidate) => candidate.at(-1) === "--version", () => capture(1)],
        [
          (candidate) =>
            isServiceUserAccessCommand(candidate) && candidate.at(-1) === executablePath,
          () => accessCapture(false),
        ],
        [(candidate) => isServiceUserAccessCommand(candidate), () => accessCapture(false)],
      ]),
    );

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      classification: "interpreter-inaccessible",
      ok: false,
    });
  });

  it("does not repair when sudo returns status 1 and the service-user access check returns no confirmed result (#9728)", () => {
    const fixture = proofFixture();
    fixture.runCaptureExImpl.mockImplementation((command: readonly string[]) =>
      captureForCommand(command, [
        [
          (candidate) => candidate[0] === "/usr/bin/systemctl",
          () =>
            capture(
              0,
              `User=ollama\nExecStart={ path=${executablePath} ; argv[]=${executablePath} serve ; }`,
            ),
        ],
        [(candidate) => candidate[0] === "/usr/bin/id", () => capture(0)],
        [(candidate) => isServiceUserAccessCommand(candidate), () => capture(1)],
        [(candidate) => candidate.includes(executablePath), () => capture(1)],
      ]),
    );

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      classification: "execution-failed",
      message: expect.stringContaining("returned no confirmed result from that user"),
      ok: false,
    });
    expect(
      fixture.runCaptureExImpl.mock.calls.some(([command]) =>
        (command as readonly string[]).includes("/usr/bin/chmod"),
      ),
    ).toBe(false);
  });

  it.each([
    {
      call: 1,
      classification: "service-metadata-timeout",
      message: "systemctl did not return Ollama service metadata within 5 seconds",
    },
    {
      call: 2,
      classification: "service-user-timeout",
      message:
        "could not verify that systemd User 'ollama' resolves to a host account within 5 seconds",
    },
    {
      call: 3,
      classification: "execution-timeout",
      message:
        "Ollama ExecStart did not complete '--version' as systemd User 'ollama' within 15 seconds",
    },
    {
      call: 4,
      classification: "executable-timeout",
      message: `could not verify that systemd User 'ollama' can execute Ollama ExecStart '${executablePath}' within 5 seconds`,
    },
    {
      call: 5,
      classification: "interpreter-timeout",
      message: `could not verify that systemd User 'ollama' can execute PT_INTERP '${interpreterPath}' within 5 seconds`,
    },
  ])(
    "classifies a timed-out verification as $classification (#9728)",
    ({ call, classification, message }) => {
      const fixture = proofFixture(0o755);
      let currentCall = 0;
      const baseImplementation = fixture.runCaptureExImpl.getMockImplementation() as (
        command: readonly string[],
        options: { timeout: number },
      ) => OllamaExecutableCaptureResult;
      fixture.runCaptureExImpl.mockImplementation((command, options) => {
        currentCall += 1;
        return currentCall === call
          ? capture(null, "", true)
          : baseImplementation(command, options);
      });

      expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
        classification,
        message,
        ok: false,
      });
    },
  );

  it("passes cgroup cleanup limits to systemd-run for the service-user proof (#10663)", () => {
    const fixture = proofFixture(0o755);

    proveOllamaSystemdServiceExecutable(fixture.options);
    const proofCalls = fixture.runCaptureExImpl.mock.calls.filter(([command]) =>
      isServiceUserProofCommand(command as readonly string[]),
    );
    expect(proofCalls).toHaveLength(1);
    const [[command, options]] = proofCalls;
    expectServiceUserProofCommand(command as readonly string[], "ollama");
    expect(options).toEqual({ timeout: 17_000 });
  });

  it("classifies the systemd cgroup runtime limit as an execution timeout (#10663)", () => {
    const fixture = proofFixture(0o755);
    fixture.runCaptureExImpl.mockImplementation((command: readonly string[]) =>
      command.includes("/usr/bin/systemd-run")
        ? {
            exitCode: 1,
            stderr: "Finished with result: timeout\n",
            stdout: "",
            timedOut: false,
          }
        : captureForCommand(command, [
            [
              (candidate) => candidate[0] === "/usr/bin/systemctl",
              () =>
                capture(
                  0,
                  `User=ollama\nExecStart={ path=${executablePath} ; argv[]=${executablePath} serve ; }`,
                ),
            ],
            [(candidate) => candidate[0] === "/usr/bin/id", () => capture(0)],
          ]),
    );

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      classification: "execution-timeout",
      ok: false,
    });
  });

  it("redacts and bounds systemd-run diagnostics for an execution failure (#10663)", () => {
    const fixture = proofFixture(0o755);
    const credential = `sk-${"x".repeat(48)}`;
    fixture.runCaptureExImpl.mockImplementation((command: readonly string[]) =>
      isServiceUserProofCommand(command)
        ? {
            exitCode: 1,
            stderr: `Failed to start transient service unit: OPENAI_API_KEY=${credential} ${"detail ".repeat(80)}`,
            stdout: "",
            timedOut: false,
          }
        : captureForCommand(command, [
            [
              (candidate) => candidate[0] === "/usr/bin/systemctl",
              () =>
                capture(
                  0,
                  `User=ollama\nExecStart={ path=${executablePath} ; argv[]=${executablePath} serve ; }`,
                ),
            ],
            [(candidate) => candidate[0] === "/usr/bin/id", () => capture(0)],
            [(candidate) => isServiceUserAccessCommand(candidate), () => accessCapture(true)],
          ]),
    );

    const result = proveOllamaSystemdServiceExecutable(fixture.options);

    expect(result).toMatchObject({ classification: "execution-failed", ok: false });
    expect(result.ok ? "" : result.message).toContain(
      "systemd-run detail: Failed to start transient service unit",
    );
    expect(result.ok ? "" : result.message).not.toContain(credential);
    expect(result.ok ? "" : result.message).not.toContain("detail ".repeat(40));
  });

  it("accepts an initial service-user proof without changing permissions (#9728)", () => {
    const fixture = proofFixture(0o755);
    fixture.runCaptureExImpl.mockImplementation((command: readonly string[]) =>
      captureForCommand(command, [
        [
          (candidate) => candidate[0] === "/usr/bin/systemctl",
          () =>
            capture(
              0,
              `User=ollama\nExecStart={ path=${executablePath} ; argv[]=${executablePath} serve ; }`,
            ),
        ],
        [(candidate) => candidate[0] === "/usr/bin/id", () => capture(0)],
        [
          (candidate) => candidate.includes(executablePath),
          () => capture(0, "ollama version is 0.11.10"),
        ],
      ]),
    );

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      ok: true,
      repaired: false,
    });
    expect(
      fixture.runCaptureExImpl.mock.calls.some(([command]) =>
        (command as readonly string[]).includes("/usr/bin/chmod"),
      ),
    ).toBe(false);
  });

  it("rejects a missing configured service user before any execution command (#9728)", () => {
    const fixture = proofFixture();
    fixture.runCaptureExImpl.mockReturnValueOnce(
      capture(0, `User=\nExecStart={ path=${executablePath} ; argv[]=${executablePath} serve ; }`),
    );

    expect(proveOllamaSystemdServiceExecutable(fixture.options)).toMatchObject({
      classification: "service-metadata-invalid",
      ok: false,
    });
    expect(fixture.runCaptureExImpl).toHaveBeenCalledTimes(1);
  });
});
