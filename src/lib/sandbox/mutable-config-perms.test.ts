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
import os, pwd, types, runpy
sandbox_uid, sandbox_gid = os.geteuid(), os.getegid()
pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=sandbox_uid, pw_gid=sandbox_gid)
startup_fixture = {"requires_completion": lambda: True, "wait_for_completion": lambda: "fixture", "read_completion": lambda: "fixture"}
def topology_fixture():
    return None
def load_runtime_helper(path):
    if path.endswith("hermes-startup-completion.py"):
        if startup_fixture is None:
            raise FileNotFoundError(2, "missing helper", path)
        return startup_fixture
    assert path == "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"
    return {"inspect_private_mutable_topology": lambda: topology_fixture()}
runpy.run_path = load_runtime_helper
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
        "30",
        "--",
        ...mutableHermesConfigProbeCommand(hermesTarget),
      ],
      expect.objectContaining({ timeout: 35_000, maxBuffer: 64 * 1024 }),
    );
    expect(mutableHermesConfigProbeCommand(hermesTarget)[0]).toBe("/opt/hermes/.venv/bin/python3");
  });

  it.each([
    { status: 1, output: "" },
    { status: null, output: "", signal: "SIGTERM" },
    { status: 0, output: "", error: new Error("transport failed") },
  ])("rejects an incomplete native permission probe: %j", (result) => {
    captureSanitizedResolvedOpenshell.mockReturnValue(result);
    expect(inspectMutableHermesConfigPerms("hermes-demo", getSandbox).verified).toBe(false);
    expect(captureSanitizedResolvedOpenshell).toHaveBeenCalledOnce();
  });

  it("retains bounded probe failure details with credentials redacted and controls escaped", () => {
    captureSanitizedResolvedOpenshell.mockReturnValue({
      status: 1,
      output: "unused stdout",
      stdout: "OPENAI_API_KEY=stdout-secret",
      stderr:
        "x".repeat(5000) +
        "\nPermissionError: config.yaml remains read-only\n" +
        "MSTEAMS_APP_PASSWORD=diagnostic-test-secret\n" +
        "https://diagnostic-user:diagnostic-password@example.test/?token=diagnostic-token\n" +
        "\u001b[2J\u009b\u202euntrusted output",
    });

    const verification = inspectMutableHermesConfigPerms("hermes-demo", getSandbox);
    const message = verification.errors[0]!;

    expect(verification.verified).toBe(false);
    expect(message).toContain("PermissionError: config.yaml remains read-only");
    expect(message).toContain("<REDACTED>");
    expect(message).not.toMatch(/diagnostic-(?:test-secret|user|password|token)|stdout-secret/);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(message).toContain("\\u{001b}[2J");
    expect(message.length).toBeLessThanOrEqual(4096 + "Hermes config probe failed ()".length);
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
    fs.chownSync(root, process.getuid!(), process.getgid!());
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
    ["created", false, "shared-state.db-shm=created"],
    ["removed", false, "shared-state.db-wal=removed"],
    ["replaced", false, "shared-state.db=replaced"],
    ["metadata", false, "shared-state.db=metadata-changed"],
    ["symlink", false, "gateway_state.json=replaced"],
    ["unavailable", false, "gateway_state.json=unavailable"],
    ["unlisted", false, "known entries in inspected directory: none observed"],
    ["stable", true, ""],
  ] as const)(
    "reports fixed runtime entry metadata for %s without reading contents or retrying",
    (scenario, expected, diagnostic) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-entry-metadata-"));
      fs.chownSync(root, process.getuid!(), process.getgid!());
      const configDir = path.join(root, ".hermes");
      fs.mkdirSync(configDir, { mode: 0o700 });
      fs.writeFileSync(path.join(configDir, "config.yaml"), "config-fixture", { mode: 0o640 });
      fs.writeFileSync(path.join(configDir, "shared-state.db"), "private-state-canary");
      fs.writeFileSync(path.join(configDir, "shared-state.db-wal"), "private-state-canary");
      const outside = path.join(root, "private-target-canary");
      fs.writeFileSync(outside, "private-target-content");
      fs.symlinkSync(outside, path.join(configDir, "gateway_state.json"));
      const command = mutableHermesConfigProbeCommand({
        ...hermesTarget,
        configDir,
        configPath: path.join(configDir, "config.yaml"),
        sensitiveFiles: [],
      });
      const codeIndex = command.indexOf("-c") + 1;
      const prelude = `
${localSandboxIdentity}
import pathlib
scenario = ${JSON.stringify(scenario)}
calls = 0
original_stat = os.stat
known = ("gateway_state.json", "shared-state.db", "shared-state.db-wal", "shared-state.db-shm")
def observed_stat(name, *args, **kwargs):
    if name in known:
        assert kwargs.get("follow_symlinks") is False
        assert isinstance(kwargs.get("dir_fd"), int)
        if scenario == "unavailable" and name == "gateway_state.json" and calls == 2:
            raise PermissionError("private-error-canary")
    return original_stat(name, *args, **kwargs)
os.stat = observed_stat
def replace_entry():
    temporary = pathlib.Path(config_dir) / ".private-entry-canary"
    temporary.write_text("private-state-canary")
    os.replace(temporary, pathlib.Path(config_dir) / ("gateway_state.json" if scenario == "symlink" else "shared-state.db"))
def transient_entry():
    temporary = pathlib.Path(config_dir) / ".private-entry-canary"
    temporary.write_text("private-state-canary")
    temporary.unlink()
def topology_fixture():
    global calls
    calls += 1
    assert calls <= 2
    if calls == 2:
        mutations = {
            "created": lambda: (pathlib.Path(config_dir) / "shared-state.db-shm").write_text("private-state-canary"),
            "removed": lambda: (pathlib.Path(config_dir) / "shared-state.db-wal").unlink(),
            "replaced": replace_entry,
            "metadata": lambda: os.chmod(pathlib.Path(config_dir) / "shared-state.db", 0o600),
            "symlink": replace_entry,
            "unavailable": lambda: None,
            "unlisted": transient_entry,
            "stable": lambda: None,
        }
        mutations[scenario]()
        if scenario != "stable":
            info = original_stat(config_dir)
            os.utime(config_dir, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000))
    return None
probe = ${JSON.stringify(command[codeIndex])}
try:
    exec(probe)
finally:
    assert calls == 2
`;
      try {
        const result = spawnSync(
          "python3",
          ["-I", "-c", prelude, ...command.slice(codeIndex + 1)],
          {
            encoding: "utf8",
            timeout: 15_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status === 0, result.stderr).toBe(expected);
        expect(result.stderr).toContain(diagnostic);
        expect(result.stderr === "").toBe(expected);
        expect(result.stderr.includes("Hermes config root changed during inspection")).toBe(
          !expected,
        );
        expect(result.stderr).not.toMatch(
          /private-(?:state|target|entry|error)-(?:canary|content)/u,
        );
        expect(result.stderr).not.toContain(root);
        expect(result.stdout).toBe("");
        expect(fs.readFileSync(outside, "utf8")).toBe("private-target-content");
        expect(fs.readFileSync(path.join(configDir, "config.yaml"), "utf8")).toBe("config-fixture");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [0o3770, "unavailable", true, ""],
    [0o700, "verified", true, ""],
    [0o700, "guard-import", true, ""],
    [0o700, "guard-timeout", false, "Private Hermes config requires an attested same-UID runtime"],
    [0o700, "retained-image", true, ""],
    [0o3770, "root-separated", true, ""],
    [0o700, "unavailable", false, "Private Hermes config requires an attested same-UID runtime"],
    [0o700, "changed", false, "Private Hermes config requires an attested same-UID runtime"],
    [
      0o700,
      "directory-race",
      false,
      "Hermes config root changed during inspection: st_mode, st_ctime_ns; directory mtime unchanged",
    ],
    [
      0o700,
      "directory-timestamp",
      false,
      "Hermes config root changed during inspection: st_ctime_ns; directory mtime unchanged",
    ],
    [
      0o700,
      "directory-entry",
      false,
      "Hermes config root changed during inspection: st_ctime_ns; directory mtime changed",
    ],
    [0o3770, "access-denied", false, "Hermes config root is not writable by the sandbox identity"],
    [0o3770, "append-only-root", false, "Hermes config has immutable or append-only inode flags"],
    [0o3770, "immutable-artifact", false, "Hermes config has immutable or append-only inode flags"],
    [0o750, "verified", false, "Hermes config root does not have an allowed mutable mode"],
    [0o3770, "root", false, "Hermes config probe requires the non-root sandbox identity"],
    [0o3770, "wrong-user", false, "Hermes config probe requires the non-root sandbox identity"],
    [0o3770, "wrong-group", false, "Hermes config probe requires the non-root sandbox identity"],
    [
      0o3770,
      "startup-generation",
      false,
      "Hermes startup generation changed during config inspection",
    ],
  ] as const)(
    "checks mode %s with %s topology without changing state",
    (mode, topology, expected, diagnostic) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-private-hermes-probe-"));
      fs.chownSync(root, process.getuid!(), process.getgid!());
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
import fcntl, os, stat, struct, signal, sys, types
topology = ${JSON.stringify(topology)}
original_load_runtime_helper = runpy.run_path
def load_before_snapshot(path):
    if topology == "guard-import" and path.endswith("hermes-runtime-config-guard.py"):
        directory = sys.argv[1]
        before = os.stat(directory)
        transient = os.path.join(directory, ".runtime-import-fixture")
        with open(transient, "x", encoding="utf-8") as output:
            output.write("fixture")
        os.unlink(transient)
        os.utime(directory, ns=(before.st_atime_ns, before.st_mtime_ns + 1000000))
    return original_load_runtime_helper(path)
runpy.run_path = load_before_snapshot
if topology == "startup-generation":
    startup_fixture = {"requires_completion": lambda: True, "wait_for_completion": lambda: "old", "read_completion": lambda: "new"}
elif topology == "retained-image":
    startup_fixture = None
elif topology == "root-separated":
    startup_fixture = {"requires_completion": lambda: False}
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
def topology_fixture():
    global calls
    calls += 1
    if topology == "directory-race" and calls == 2:
        os.chmod(config_dir, 0o750)
    if topology == "directory-timestamp" and calls == 2:
        info = os.stat(config_dir)
        os.utime(config_dir, ns=(info.st_atime_ns, info.st_mtime_ns))
    if topology == "directory-entry" and calls == 2:
        info = os.stat(config_dir)
        transient = os.path.join(config_dir, ".private-entry-canary")
        with open(transient, "x", encoding="utf-8") as output:
            output.write("private-state-canary")
        os.unlink(transient)
        os.utime(config_dir, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000))
    if topology == "guard-timeout":
        try:
            signal.raise_signal(signal.SIGALRM)
        except Exception:
            pass
    success = topology != "unavailable" and not (topology == "changed" and calls == 2)
    if not success:
        raise RuntimeError("topology unavailable")
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
        expect(result.stderr).toContain(diagnostic);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain(configDir);
        expect(result.stderr).not.toContain("private-entry-canary");
        expect(result.stderr).not.toContain("private-state-canary");
        expect(fs.readdirSync(configDir).sort()).toEqual([...names].sort());
        expect(fs.statSync(configDir).mtimeMs === before).toBe(
          !["directory-entry", "guard-import"].includes(topology),
        );
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
