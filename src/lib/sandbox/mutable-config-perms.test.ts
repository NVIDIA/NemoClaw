// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  captureSanitizedResolvedOpenshell,
  getSandbox,
  resolveAgentConfig,
  withMcpLifecycleLockSync,
} = vi.hoisted(() => ({
  captureSanitizedResolvedOpenshell: vi.fn(),
  getSandbox: vi.fn(),
  resolveAgentConfig: vi.fn(),
  withMcpLifecycleLockSync: vi.fn((_name, action) => action()),
}));

vi.mock("../adapters/openshell/sanitized-capture", () => ({
  captureSanitizedResolvedOpenshell,
}));
vi.mock("./agent-config", () => ({ resolveAgentConfig }));
vi.mock("../state/mcp-lifecycle-lock-acquisition", () => ({ withMcpLifecycleLockSync }));

import type { AgentConfigTarget } from "./agent-config";
import {
  inspectMutableHermesConfigPerms,
  mutableHermesConfigProbeCommand,
  verifyMutableHermesConfigForTarget,
} from "./mutable-config-perms";

// The host has no sandbox account; retain real file ownership and execution identity.
const localSandboxIdentity = `
import os, pwd, types
sandbox_uid, sandbox_gid = os.geteuid(), os.getegid()
pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=sandbox_uid, pw_gid=sandbox_gid)
`;

const hermesTarget: AgentConfigTarget = {
  agentName: "hermes",
  configDir: "/sandbox/.hermes",
  configFile: "config.yaml",
  configPath: "/sandbox/.hermes/config.yaml",
  format: "yaml",
  sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
};
describe("mutable Hermes config permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentConfig.mockReturnValue(hermesTarget);
    getSandbox.mockReturnValue({ name: "hermes-demo", agent: "hermes", gatewayPort: 40808 });
    captureSanitizedResolvedOpenshell.mockReturnValue({ status: 0, output: "" });
  });

  it("inspects the registered gateway as its native user while holding the lifecycle lock", () => {
    withMcpLifecycleLockSync.mockImplementationOnce((_name, action) => {
      expect(captureSanitizedResolvedOpenshell).not.toHaveBeenCalled();
      const result = action();
      expect(captureSanitizedResolvedOpenshell).toHaveBeenCalledOnce();
      return result;
    });
    expect(inspectMutableHermesConfigPerms("hermes-demo", getSandbox)).toEqual({
      verified: true,
      errors: [],
    });
    expect(withMcpLifecycleLockSync).toHaveBeenCalledWith("hermes-demo", expect.any(Function));
    expect(captureSanitizedResolvedOpenshell).toHaveBeenCalledWith(
      [
        "sandbox",
        "exec",
        "--name",
        "hermes-demo",
        "-g",
        "nemoclaw-40808",
        "--no-tty",
        "--no-login-shell",
        "--timeout",
        "15",
        "--",
        ...mutableHermesConfigProbeCommand(hermesTarget),
      ],
      expect.objectContaining({ timeout: 20_000, maxBuffer: 64 * 1024 }),
    );
    expect(mutableHermesConfigProbeCommand(hermesTarget)[0]).toBe("/usr/bin/python3");
  });

  it.each([
    { status: 1, output: "" },
    { status: null, output: "", signal: "SIGTERM" },
    { status: 0, output: "", error: new Error("transport failed") },
  ])("rejects an incomplete native permission probe: %j", (result) => {
    captureSanitizedResolvedOpenshell.mockReturnValue(result);
    expect(inspectMutableHermesConfigPerms("hermes-demo", getSandbox).verified).toBe(false);
  });

  it.each([null, { gatewayName: "unregistered-gateway" }])(
    "rejects missing or invalid registry authority: %j",
    (entry) => {
      getSandbox.mockReturnValue(entry);
      expect(inspectMutableHermesConfigPerms("hermes-demo", getSandbox).verified).toBe(false);
      expect(captureSanitizedResolvedOpenshell).not.toHaveBeenCalled();
    },
  );

  it("claims mutable Hermes posture only after the exact probe succeeds", () => {
    const execute = vi.fn();

    expect(verifyMutableHermesConfigForTarget(hermesTarget, execute)).toEqual({
      verified: true,
      errors: [],
    });
    expect(execute).toHaveBeenCalledOnce();

    expect(
      verifyMutableHermesConfigForTarget(hermesTarget, () => {
        throw new Error("config.yaml remains read-only");
      }),
    ).toEqual({ verified: false, errors: ["config.yaml remains read-only"] });
  });

  it("executes the Hermes probe and rejects read-only or linked config artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mutable-probe-"));
    const configDir = path.join(root, ".hermes");
    const configPath = path.join(configDir, "config.yaml");
    const hashPath = path.join(configDir, ".config-hash");
    const envPath = path.join(configDir, ".env");
    fs.mkdirSync(configDir, { mode: 0o700 });
    fs.chmodSync(configDir, 0o3770);
    fs.writeFileSync(configPath, "fixture\n", { mode: 0o640 });
    fs.writeFileSync(hashPath, "fixture\n", { mode: 0o640 });
    fs.writeFileSync(envPath, "fixture\n", { mode: 0o640 });
    fs.chmodSync(configPath, 0o640);
    fs.chmodSync(hashPath, 0o640);
    fs.chmodSync(envPath, 0o640);

    const fixtureTarget: AgentConfigTarget = {
      ...hermesTarget,
      configDir,
      configPath,
      sensitiveFiles: [hashPath, envPath],
    };
    const runProbe = () =>
      verifyMutableHermesConfigForTarget(fixtureTarget, (command) => {
        const codeIndex = command.indexOf("-c") + 1;
        const result = spawnSync(
          "python3",
          ["-I", "-c", localSandboxIdentity + command[codeIndex], ...command.slice(codeIndex + 1)],
          {
            encoding: "utf8",
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      });

    try {
      const valid = runProbe();
      expect(valid).toEqual({ verified: true, errors: [] });
      expect(
        fs.readdirSync(configDir).some((entry) => entry.startsWith(".nemoclaw-mutable-posture-")),
      ).toBe(false);

      fs.chmodSync(configPath, 0o440);
      const readOnly = runProbe();
      expect(readOnly.verified).toBe(false);
      expect(readOnly.errors.join("\n")).toContain("mode 0640");
      expect(
        fs.readdirSync(configDir).some((entry) => entry.startsWith(".nemoclaw-mutable-posture-")),
      ).toBe(false);

      fs.chmodSync(configPath, 0o640);
      fs.rmSync(envPath);
      fs.symlinkSync(configPath, envPath);
      const linked = runProbe();
      expect(linked.verified).toBe(false);
      expect(linked.errors.join("\n")).toMatch(/(?:ELOOP|Too many levels of symbolic links)/u);
      expect(
        fs.readdirSync(configDir).some((entry) => entry.startsWith(".nemoclaw-mutable-posture-")),
      ).toBe(false);

      fs.rmSync(envPath);
      fs.linkSync(configPath, envPath);
      expect(runProbe().errors.join("\n")).toContain("singly linked regular file");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [0o3770, "unavailable", true],
    [0o700, "verified", true],
    [0o700, "unavailable", false],
    [0o700, "changed", false],
    [0o700, "directory-race", false],
    [0o3770, "access-denied", false],
    [0o3770, "append-only-root", false],
    [0o3770, "immutable-artifact", false],
    [0o750, "verified", false],
    [0o3770, "root", false],
    [0o3770, "wrong-user", false],
    [0o3770, "wrong-group", false],
  ] as const)(
    "checks mode %s with %s topology without changing state",
    (mode, topology, expected) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-private-hermes-probe-"));
      const configDir = path.join(root, ".hermes");
      fs.mkdirSync(configDir, { mode });
      fs.chmodSync(configDir, mode);
      const names = ["config.yaml", ".env", ".config-hash"];
      fs.writeFileSync(path.join(configDir, "config.yaml"), "fixture\n", { mode: 0o640 });
      fs.writeFileSync(path.join(configDir, ".env"), "fixture\n", { mode: 0o640 });
      fs.writeFileSync(path.join(configDir, ".config-hash"), "fixture\n", { mode: 0o640 });
      fs.chmodSync(path.join(configDir, "config.yaml"), 0o640);
      fs.chmodSync(path.join(configDir, ".env"), 0o640);
      fs.chmodSync(path.join(configDir, ".config-hash"), 0o640);
      const command = mutableHermesConfigProbeCommand({
        ...hermesTarget,
        configDir,
        configPath: path.join(configDir, names[0]!),
        sensitiveFiles: names.slice(1).map((name) => path.join(configDir, name)),
      });
      const codeIndex = command.indexOf("-c") + 1;
      // The image-owned topology response is external input to the host probe.
      // Guard tests exercise its real procfs proof separately.
      // Supply blocking inode flags as external metadata; keep file I/O real.
      const prelude = `
${localSandboxIdentity}
import fcntl, os, stat, struct, subprocess, types
topology = ${JSON.stringify(topology)}
original_fstat = os.fstat
original_ioctl = fcntl.ioctl
def blocking_flags(fd, append_flag, immutable_flag):
    mode = original_fstat(fd).st_mode
    return (append_flag if topology == "append-only-root" and stat.S_ISDIR(mode) else
            immutable_flag if topology == "immutable-artifact" and stat.S_ISREG(mode) else 0)
def inode_flags(fd, request, buffer):
    if topology in ("append-only-root", "immutable-artifact"):
        return struct.pack("I", blocking_flags(fd, 0x20, 0x10))
    return original_ioctl(fd, request, buffer)
def native_flags(fd):
    value = original_fstat(fd)
    if not hasattr(value, "st_flags"):
        return value
    fields = {name: getattr(value, name) for name in dir(value) if name.startswith("st_")}
    fields["st_flags"] |= blocking_flags(fd, stat.UF_APPEND, stat.UF_IMMUTABLE)
    return types.SimpleNamespace(**fields)
fcntl.ioctl = inode_flags
os.fstat = native_flags
if topology == "root":
    os.geteuid = lambda: 0
elif topology == "wrong-user":
    os.geteuid = lambda: sandbox_uid + 1
elif topology == "wrong-group":
    os.getegid = lambda: sandbox_gid + 1
calls = 0
def topology_response(args, **kwargs):
    global calls
    calls += 1
    assert args[3] == "inspect-private-mutable-topology"
    if topology == "directory-race" and calls == 2:
        os.chmod(config_dir, 0o750)
    success = topology != "unavailable" and not (topology == "changed" and calls == 2)
    return types.SimpleNamespace(returncode=0 if success else 1, stdout=b"same-uid-nonroot\\n")
subprocess.run = topology_response
if topology == "access-denied":
    os.access = lambda *args, **kwargs: False
os.mkdir = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("probe must not create state"))
`;
      const before = fs.statSync(configDir).mtimeMs;
      try {
        const result = spawnSync(
          "python3",
          ["-I", "-c", prelude + command[codeIndex], ...command.slice(codeIndex + 1)],
          {
            encoding: "utf8",
            timeout: 15_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status === 0, result.stderr).toBe(expected);
        expect(fs.readdirSync(configDir).sort()).toEqual([...names].sort());
        expect(fs.statSync(configDir).mtimeMs).toBe(before);
        expect(names.map((name) => fs.readFileSync(path.join(configDir, name), "utf8"))).toEqual([
          "fixture\n",
          "fixture\n",
          "fixture\n",
        ]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not apply the Hermes proof to another agent", () => {
    const execute = vi.fn();

    expect(
      verifyMutableHermesConfigForTarget({ ...hermesTarget, agentName: "openclaw" }, execute),
    ).toEqual({
      verified: false,
      errors: ["agent openclaw does not use the mutable Hermes config contract"],
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
