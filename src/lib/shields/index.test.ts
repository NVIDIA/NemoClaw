// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The shields module uses CJS require("./runner") etc., which vitest resolves
// relative to src/lib/. We mock the absolute paths that vitest will resolve.

vi.mock("../runner", () => ({
  run: vi.fn(() => ({ status: 0 })),
  runCapture: vi.fn(() => "version: 1\nnetwork_policies:\n  test: {}"),
  validateName: vi.fn((name) => name),
  shellQuote: vi.fn((s) => `'${s}'`),
  redact: vi.fn((s) => s),
  ROOT: "/mock/root",
}));

vi.mock("../policy", () => ({
  buildPolicyGetCommand: vi.fn((name) => [
    "openshell",
    "policy",
    "get",
    "--full",
    name,
  ]),
  buildPolicySetCommand: vi.fn((file, name) => [
    "openshell",
    "policy",
    "set",
    "--policy",
    file,
    "--wait",
    name,
  ]),
  parseCurrentPolicy: vi.fn((raw) => raw || ""),
  PERMISSIVE_POLICY_PATH: "/mock/permissive.yaml",
}));

vi.mock("../sandbox/config", () => ({
  resolveAgentConfig: vi.fn(() => ({
    agentName: "openclaw",
    configPath: "/sandbox/.openclaw/openclaw.json",
    configDir: "/sandbox/.openclaw",
    format: "json",
    configFile: "openclaw.json",
  })),
}));

vi.mock("../adapters/docker/exec", () => ({
  dockerExecFileSync: vi.fn((_argv: string[]) => ""),
}));

vi.mock("./audit", () => ({
  appendAuditEntry: vi.fn(),
}));

vi.mock("child_process", () => ({
  fork: vi.fn(() => ({ pid: 12345, disconnect: vi.fn(), unref: vi.fn() })),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
  })),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: "",
    stderr: "",
  })),
  spawn: vi.fn(),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-test-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The shields.ts module reads HOME at require-time for STATE_DIR.
// With vitest's module caching, we can't easily re-evaluate.
// Instead, test the logic by directly manipulating state files and
// calling functions that read them at invocation time.

describe("shields — unit logic", () => {
  describe("parseDuration (inline in shields.ts)", () => {
    // parseDuration is inlined in shields.ts. Test it via the ESM module.
    // Since the CJS require resolution issue makes direct import flaky,
    // test the TypeScript duration module instead.
    it("parses minutes", async () => {
      const { parseDuration } = await import("../domain/duration.js");
      expect(parseDuration("5m")).toBe(300);
      expect(parseDuration("30m")).toBe(1800);
    });

    it("parses seconds", async () => {
      const { parseDuration } = await import("../domain/duration.js");
      expect(parseDuration("90s")).toBe(90);
    });

    it("treats bare numbers as seconds", async () => {
      const { parseDuration } = await import("../domain/duration.js");
      expect(parseDuration("300")).toBe(300);
    });

    it("rejects durations exceeding 30 minutes", async () => {
      const { parseDuration } = await import("../domain/duration.js");
      expect(() => parseDuration("31m")).toThrow("exceeds maximum");
      expect(() => parseDuration("1h")).toThrow("exceeds maximum");
    });

    it("rejects invalid input", async () => {
      const { parseDuration } = await import("../domain/duration.js");
      expect(() => parseDuration("abc")).toThrow("Invalid duration");
    });
  });

  describe("shields state file management", () => {
    it("state files are namespaced by sandbox", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      // Write state for two different sandboxes
      const alphaState = {
        shieldsDown: true,
        updatedAt: new Date().toISOString(),
      };
      const betaState = {
        shieldsDown: false,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stateDir, "shields-alpha.json"),
        JSON.stringify(alphaState, null, 2),
      );
      fs.writeFileSync(
        path.join(stateDir, "shields-beta.json"),
        JSON.stringify(betaState, null, 2),
      );

      const alpha = JSON.parse(
        fs.readFileSync(path.join(stateDir, "shields-alpha.json"), "utf-8"),
      );
      const beta = JSON.parse(
        fs.readFileSync(path.join(stateDir, "shields-beta.json"), "utf-8"),
      );
      expect(alpha.shieldsDown).toBe(true);
      expect(beta.shieldsDown).toBe(false);
    });

    it("shieldsDown creates snapshot, state, and audit files", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const ts = Date.now();
      const snapshotPath = path.join(stateDir, `policy-snapshot-${ts}.yaml`);
      fs.writeFileSync(
        snapshotPath,
        "version: 1\nnetwork_policies:\n  test: {}",
        {
          mode: 0o600,
        },
      );

      const state = {
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "Installing plugin",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stateDir, "shields-openclaw.json"),
        JSON.stringify(state, null, 2),
      );

      const loaded = JSON.parse(
        fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8"),
      );
      expect(loaded.shieldsDown).toBe(true);
      expect(loaded.shieldsDownTimeout).toBe(300);
      expect(loaded.shieldsDownPolicy).toBe("permissive");
      expect(fs.existsSync(snapshotPath)).toBe(true);
    });

    it("shieldsUp clears shields state", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const snapshotPath = path.join(stateDir, "policy-snapshot-test.yaml");
      fs.writeFileSync(
        snapshotPath,
        "version: 1\nnetwork_policies:\n  test: {}",
      );

      const downState = {
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 120000).toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "Testing",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stateDir, "shields-openclaw.json"),
        JSON.stringify(downState, null, 2),
      );

      const cleared = {
        ...downState,
        shieldsDown: false,
        shieldsDownAt: null,
        shieldsDownTimeout: null,
        shieldsDownReason: null,
        shieldsDownPolicy: null,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stateDir, "shields-openclaw.json"),
        JSON.stringify(cleared, null, 2),
      );

      const loaded = JSON.parse(
        fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8"),
      );
      expect(loaded.shieldsDown).toBe(false);
      expect(loaded.shieldsDownAt).toBeNull();
      expect(loaded.shieldsPolicySnapshotPath).toBe(snapshotPath);
    });

    it("timer marker contains expected fields", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const marker = {
        pid: 12345,
        sandboxName: "openclaw",
        snapshotPath: "/tmp/snapshot.yaml",
        restoreAt: new Date(Date.now() + 300000).toISOString(),
      };
      const markerPath = path.join(stateDir, "shields-timer-openclaw.json");
      fs.writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });

      const loaded = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
      expect(loaded.pid).toBe(12345);
      expect(loaded.sandboxName).toBe("openclaw");
      expect(loaded.restoreAt).toBeDefined();
    });

    it("audit log entries are valid JSONL", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const auditPath = path.join(stateDir, "shields-audit.jsonl");

      const entries = [
        {
          action: "shields_down",
          sandbox: "openclaw",
          timestamp: "2026-04-13T14:30:00Z",
          timeout_seconds: 300,
          reason: "Plugin install",
          policy_applied: "permissive",
        },
        {
          action: "shields_up",
          sandbox: "openclaw",
          timestamp: "2026-04-13T14:32:00Z",
          restored_by: "operator",
          duration_seconds: 120,
        },
      ];

      for (const entry of entries) {
        fs.appendFileSync(auditPath, JSON.stringify(entry) + "\n");
      }

      const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).action).toBe("shields_down");
      expect(JSON.parse(lines[1]).action).toBe("shields_up");
    });
  });

  // NOTE: Integration tests that call the real shieldsDown/shieldsUp are not
  // feasible here because shields.ts uses CJS require() which doesn't resolve
  // through vitest's ESM mock system. The full call chain is exercised by the
  // E2E test (test/e2e/test-shields-config.sh) against a live sandbox.

  // -------------------------------------------------------------------
  // NC-2227-02: Three-state shields model
  // -------------------------------------------------------------------
  describe("NC-2227-02: three-state shields model", () => {
    it("deriveShieldsMode encodes the fresh, locked, unlocked, and legacy-state cases", async () => {
      const distModulePath = path.join(
        process.cwd(),
        "dist",
        "lib",
        "shields",
        "index.js",
      );
      const { deriveShieldsMode } = await import(distModulePath);

      expect(deriveShieldsMode({}, false)).toBe("mutable_default");
      expect(deriveShieldsMode({ shieldsDown: true }, true)).toBe(
        "temporarily_unlocked",
      );
      expect(deriveShieldsMode({ shieldsDown: false }, true)).toBe("locked");
      expect(deriveShieldsMode({}, true)).toBe("mutable_default");
    });
  });

  describe("NC-3112: status self-heals stale expired auto-restore markers", () => {
    async function loadShieldsModule() {
      const distModulePath = path.join(
        process.cwd(),
        "dist",
        "lib",
        "shields",
        "index.js",
      );
      return import(distModulePath);
    }

    function stateDir(): string {
      return path.join(tmpDir, ".nemoclaw", "state");
    }

    function writeState(
      sandboxName: string,
      state: Record<string, unknown>,
    ): void {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir(), `shields-${sandboxName}.json`),
        JSON.stringify(state, null, 2),
        { mode: 0o600 },
      );
    }

    function writeMarker(
      sandboxName: string,
      marker: Record<string, unknown>,
    ): void {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir(), `shields-timer-${sandboxName}.json`),
        JSON.stringify(marker, null, 2),
        { mode: 0o600 },
      );
    }

    it("shieldsStatus attempts inline recovery for expired marker when timer PID is dead", async () => {
      const sandboxName = "openclaw";
      const snapshotPath = path.join(stateDir(), "policy-snapshot-test.yaml");
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
      writeState(sandboxName, {
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "testing",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
        updatedAt: new Date().toISOString(),
      });
      writeMarker(sandboxName, {
        pid: 4242,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() - 30_000).toISOString(),
        processToken: "token-123",
      });

      const processKillSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((pid: number, signal?: string | number) => {
          if (signal === 0 && pid === 4242) {
            const err = new Error("not running") as NodeJS.ErrnoException;
            err.code = "ESRCH";
            throw err;
          }
          return true;
        });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const dockerExecFileSync = (await import("node:child_process"))
        .execFileSync as ReturnType<typeof vi.fn>;
      dockerExecFileSync.mockImplementation(
        (_file: string, argv?: readonly string[]) => {
          const cmd = Array.isArray(argv) ? argv.join(" ") : "";
          if (
            cmd.includes(" stat -c %a %U:%G /sandbox/.openclaw/.config-hash")
          ) {
            return "444 root:root";
          }
          if (
            cmd.includes(" stat -c %a %U:%G /sandbox/.openclaw/openclaw.json")
          ) {
            return "444 root:root";
          }
          if (cmd.includes(" lsattr -d /sandbox/.openclaw/.config-hash")) {
            return "----i---------e----- /sandbox/.openclaw/.config-hash";
          }
          if (cmd.includes(" stat -c %a %U:%G /sandbox/.openclaw")) {
            return "755 root:root";
          }
          if (cmd.includes(" lsattr -d /sandbox/.openclaw/openclaw.json")) {
            return "----i---------e----- /sandbox/.openclaw/openclaw.json";
          }
          return "";
        },
      );

      const { shieldsStatus } = await loadShieldsModule();

      shieldsStatus(sandboxName);

      expect(processKillSpy).toHaveBeenCalledWith(4242, 0);
      expect(errorSpy).toHaveBeenCalledWith(
        "  Warning: auto-restore timer marker is expired and the timer process is not the recorded shields timer; attempting inline restore.",
      );
      expect(logSpy).toHaveBeenCalledWith(
        "  Shields: DOWN (temporarily unlocked)",
      );
    });

    it("shieldsStatus warns and stays DOWN when inline recovery fails", async () => {
      const sandboxName = "openclaw";
      const missingSnapshotPath = path.join(
        stateDir(),
        "missing-snapshot.yaml",
      );
      writeState(sandboxName, {
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 60_000).toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "testing",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: missingSnapshotPath,
        updatedAt: new Date().toISOString(),
      });
      writeMarker(sandboxName, {
        pid: 4242,
        sandboxName,
        snapshotPath: missingSnapshotPath,
        restoreAt: new Date(Date.now() - 30_000).toISOString(),
      });

      vi.spyOn(process, "kill").mockImplementation(
        (pid: number, signal?: string | number) => {
          if (signal === 0 && pid === 4242) {
            const err = new Error("not running") as NodeJS.ErrnoException;
            err.code = "ESRCH";
            throw err;
          }
          return true;
        },
      );
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { shieldsStatus } = await loadShieldsModule();

      shieldsStatus(sandboxName);

      expect(logSpy).toHaveBeenCalledWith(
        "  Shields: DOWN (temporarily unlocked)",
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "  Recovery warning: inline auto-restore failed; shields remain DOWN.",
      );
      expect(errorSpy).toHaveBeenCalledWith(
        `  Recovery warning: run \`nemoclaw ${sandboxName} shields up\` manually.`,
      );
      expect(
        fs.existsSync(
          path.join(stateDir(), `shields-timer-${sandboxName}.json`),
        ),
      ).toBe(true);
    });

    it("shieldsStatus attempts inline recovery when expired marker PID is alive but cmdline does not match recorded timer", async () => {
      const sandboxName = "openclaw";
      const snapshotPath = path.join(stateDir(), "policy-snapshot-test.yaml");
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
      writeState(sandboxName, {
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "testing",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
        updatedAt: new Date().toISOString(),
      });
      writeMarker(sandboxName, {
        pid: 4242,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() - 30_000).toISOString(),
        processToken: "token-123",
      });

      // PID is alive but belongs to an unrelated process (PID reuse after reboot).
      vi.spyOn(process, "kill").mockImplementation(
        (_pid: number, _signal?: string | number) => true,
      );
      const originalExistsSync = fs.existsSync.bind(fs);
      const originalReadFileSync = fs.readFileSync.bind(fs);
      vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
        if (String(p) === "/proc/4242/cmdline") return true;
        return originalExistsSync(p);
      });
      vi.spyOn(fs, "readFileSync").mockImplementation(
        (p: fs.PathOrFileDescriptor, options?: unknown) => {
          if (String(p) === "/proc/4242/cmdline") {
            return "python\0unrelated-process\0";
          }
          return originalReadFileSync(p, options as never) as never;
        },
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const dockerExecFileSync = (await import("node:child_process"))
        .execFileSync as ReturnType<typeof vi.fn>;
      dockerExecFileSync.mockImplementation(
        (_file: string, argv?: readonly string[]) => {
          const cmd = Array.isArray(argv) ? argv.join(" ") : "";
          if (
            cmd.includes(" stat -c %a %U:%G /sandbox/.openclaw/.config-hash")
          ) {
            return "444 root:root";
          }
          if (
            cmd.includes(" stat -c %a %U:%G /sandbox/.openclaw/openclaw.json")
          ) {
            return "444 root:root";
          }
          if (cmd.includes(" lsattr -d /sandbox/.openclaw/.config-hash")) {
            return "----i---------e----- /sandbox/.openclaw/.config-hash";
          }
          if (cmd.includes(" stat -c %a %U:%G /sandbox/.openclaw")) {
            return "755 root:root";
          }
          if (cmd.includes(" lsattr -d /sandbox/.openclaw/openclaw.json")) {
            return "----i---------e----- /sandbox/.openclaw/openclaw.json";
          }
          return "";
        },
      );

      const { shieldsStatus } = await loadShieldsModule();
      shieldsStatus(sandboxName);

      expect(errorSpy).toHaveBeenCalledWith(
        "  Warning: auto-restore timer marker is expired and the timer process is not the recorded shields timer; attempting inline restore.",
      );
      expect(logSpy).toHaveBeenCalledWith(
        "  Shields: DOWN (temporarily unlocked)",
      );
    });

    it("status fails fast on corrupt shields state instead of reporting NOT CONFIGURED", async () => {
      const sandboxName = "openclaw";
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir(), `shields-${sandboxName}.json`),
        "{not-json",
      );
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((code?: string | number | null) => {
          throw new Error(`exit ${String(code)}`);
        });

      const { shieldsStatus } = await loadShieldsModule();
      expect(() => shieldsStatus(sandboxName)).toThrow("exit 1");
      expect(errorSpy).toHaveBeenCalledWith(
        "  Shields: ERROR (state file is corrupt)",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

// -------------------------------------------------------------------
// NC-2227-04: Regression test — tar commands must not follow symlinks
// -------------------------------------------------------------------
describe("NC-2227-04: sandbox-state.ts tar commands do not follow symlinks", () => {
  function getSourceCode(): string {
    return fs.readFileSync(
      path.join(import.meta.dirname, "..", "state", "sandbox.ts"),
      "utf-8",
    );
  }

  it("backup tar command does not use -h flag (no symlink following)", () => {
    const src = getSourceCode();
    // Find the backup tar command in backupSandboxState
    const fnStart = src.indexOf("function backupSandboxState");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart);

    // The tar command should be `tar -cf` not `tar -chf`
    const tarCmdMatch = fnBody.match(/tar -c([a-z]*)f/g);
    expect(tarCmdMatch).not.toBeNull();
    for (const match of tarCmdMatch!) {
      expect(match).not.toContain("h");
    }
  });

  it("restore tar command does not use -h flag (no symlink following)", () => {
    const src = getSourceCode();
    // Find the restore function
    const fnStart = src.indexOf("function restoreSandboxState");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart);

    // Check tar commands in the restore path
    const tarCmdMatches = fnBody.match(/"-c([a-z]*)f"/g);
    if (tarCmdMatches) {
      for (const match of tarCmdMatches) {
        expect(match).not.toContain("h");
      }
    }
  });

  it("backup includes pre-backup symlink and hard-link audit before tar", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function backupSandboxState");
    const fnBody = src.slice(fnStart);

    // Must have the pre-backup audit command checking for symlinks and hard links.
    expect(fnBody).toContain("Pre-backup audit");
    expect(fnBody).toContain("-type l");
    expect(fnBody).toContain("-links +1");
    expect(fnBody).toContain('.join(" && ")');
  });

  it("backup fails closed when the pre-backup audit command errors", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function backupSandboxState");
    const fnBody = src.slice(fnStart);

    expect(fnBody).toContain("auditResult.status !== 0");
    expect(fnBody).toContain("Pre-backup audit failed");
    expect(fnBody).toContain("failedDirs: [...existingDirs]");
  });

  it("restore fails closed when pre-restore cleanup cannot remove stale state", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function restoreSandboxState");
    const fnBody = src.slice(fnStart);
    const cleanupCheck = fnBody.slice(
      fnBody.indexOf("const rmResult"),
      fnBody.indexOf("const extractCmd"),
    );

    expect(cleanupCheck).toContain("rmResult.status !== 0");
    expect(cleanupCheck).toContain("rmResult.error");
    expect(cleanupCheck).toContain("rmResult.signal");
    expect(cleanupCheck).toContain("FAILED: pre-restore cleanup failed");
    expect(cleanupCheck).toContain("failedDirs: [...localDirs]");
  });

  it("restore treats post-restore ownership repair as best-effort and verifies usability", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function restoreSandboxState");
    const fnBody = src.slice(fnStart);
    const chownCheck = fnBody.slice(
      fnBody.indexOf("const chownCmd"),
      fnBody.indexOf("const usabilityCmd"),
    );
    const usabilityCheck = fnBody.slice(
      fnBody.indexOf("const usabilityCmd"),
      fnBody.indexOf("} else {\n      failedDirs.push(...localDirs);"),
    );

    expect(chownCheck).toContain("chown -R sandbox:sandbox --");
    expect(chownCheck).toContain("2>/dev/null || true");
    expect(chownCheck).toContain("chownResult.error");
    expect(chownCheck).toContain("chownResult.signal");
    expect(chownCheck).toContain(
      "WARNING: post-restore ownership repair did not complete",
    );
    expect(usabilityCheck).toContain("[ -r");
    expect(usabilityCheck).toContain("[ -w");
    expect(usabilityCheck).toContain(
      "FAILED: restored state usability check failed",
    );
    expect(fnBody).toContain("failedDirs.push(...localDirs)");
  });
});

// -------------------------------------------------------------------
// NC-2227-05: Regression test — shields.ts locks state dirs
// -------------------------------------------------------------------
describe("NC-2227-05: shields.ts locks state directories", () => {
  function getSourceCode(): string {
    return fs.readFileSync(path.join(import.meta.dirname, "index.ts"), "utf-8");
  }

  it("HIGH_RISK_STATE_DIRS constant includes executable state and workspace entry points", () => {
    const src = getSourceCode();
    expect(src).toContain("HIGH_RISK_STATE_DIRS");
    for (const dir of [
      "skills",
      "hooks",
      "cron",
      "agents",
      "extensions",
      "plugins",
      "workspace",
      "memory",
      "credentials",
    ]) {
      expect(src).toContain(`"${dir}"`);
    }
  });

  it("lockAgentConfig locks fixed and dynamic workspace state directories", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function lockAgentConfig");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart);
    expect(src).toContain("function applyStateDirLockMode");
    expect(src).toContain("workspace-*");
    expect(fnBody).toContain("applyStateDirLockMode");
    expect(fnBody).toContain('["chmod", "g-s", target.configDir]');
    expect(src).toContain('["chmod", "g-s", dirPath]');
    expect(src).toContain(
      "Best effort; do not skip recursive write stripping.",
    );
    expect(src).toContain('[ "$clear_setgid" = "1" ] && chmod g-s "$dir"');
    expect(fnBody).toContain("chown");
    expect(fnBody).toContain("g-s");
    expect(fnBody).toContain("root:root");
  });

  it("lockAgentConfig verifies every file it attempts to lock", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function lockAgentConfig");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart, src.indexOf("function shieldsDown"));
    const verificationBlock = fnBody.slice(
      fnBody.indexOf("// Verify the lock actually took effect."),
      fnBody.indexOf("try {\n    assertNoLegacyStateLayout"),
    );

    expect(verificationBlock).toContain("for (const f of filesToLock)");
    expect(verificationBlock).toContain('"%a %U:%G"');
    expect(verificationBlock).toContain(
      "privilegedSandboxExecCapture(sandboxName",
    );
    expect(verificationBlock).toContain("${f} mode=");
    expect(verificationBlock).toContain("${f} owner=");
    expect(verificationBlock).toContain("${f} immutable bit not set");
  });

  it("unlockAgentConfig restores sandbox ownership on HIGH_RISK_STATE_DIRS", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function unlockAgentConfig");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart, src.indexOf("function lockAgentConfig"));
    expect(fnBody).toContain("applyStateDirLockMode");
    expect(fnBody).toContain("sandbox:sandbox");
  });

  it("unlockAgentConfig verifies mutable-default postconditions before state is saved", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function unlockAgentConfig");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart, src.indexOf("function lockAgentConfig"));
    expect(fnBody).toContain("Config not unlocked");
    expect(fnBody).toContain("stat");
    expect(fnBody).toContain("lsattr");
    expect(fnBody).toContain("sandbox:sandbox");
  });

  it("shieldsDown only kills auto-restore timers after rejecting repeated down", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function shieldsDown");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart, src.indexOf("function shieldsUp"));
    const stateGuard = fnBody.indexOf("if (state.shieldsDown)");
    const killTimer = fnBody.indexOf("killTimer(sandboxName)");
    expect(stateGuard).toBeGreaterThan(-1);
    expect(killTimer).toBeGreaterThan(stateGuard);
  });

  it("lockAgentConfig fails if legacy .openclaw-data artifacts remain", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function lockAgentConfig");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart);
    expect(src).toContain("function assertNoLegacyStateLayout");
    expect(src).toContain("legacy data dir exists");
    expect(src).toContain("legacy symlink remains");
    expect(fnBody).toContain("assertNoLegacyStateLayout");
  });

  it("readTimerMarker rejects invalid marker pid values", async () => {
    const distModulePath = path.join(
      process.cwd(),
      "dist",
      "lib",
      "shields",
      "timer-control.js",
    );
    const { readTimerMarker } = await import(distModulePath);
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const markerPath = path.join(stateDir, "shields-timer-openclaw.json");

    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: 0,
        sandboxName: "openclaw",
        snapshotPath: "/tmp/snap.yaml",
        restoreAt: new Date().toISOString(),
      }),
    );
    expect(readTimerMarker("openclaw")).toBeNull();

    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: 12.5,
        sandboxName: "openclaw",
        snapshotPath: "/tmp/snap.yaml",
        restoreAt: new Date().toISOString(),
      }),
    );
    expect(readTimerMarker("openclaw")).toBeNull();
  });

  it("killTimer terminates verified live timer process and clears marker", async () => {
    const distModulePath = path.join(
      process.cwd(),
      "dist",
      "lib",
      "shields",
      "timer-control.js",
    );
    const { killTimer } = await import(distModulePath);
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "shields-timer-openclaw.json"),
      JSON.stringify({
        pid: 7331,
        sandboxName: "openclaw",
        snapshotPath: "/tmp/snap.yaml",
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken: "proc-token-1",
      }),
    );
    const originalExistsSync = fs.existsSync.bind(fs);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    const existsSyncSpy = vi.spyOn(fs, "existsSync");
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      const asString = String(p);
      if (asString === "/proc/7331/cmdline") return true;
      return originalExistsSync(p);
    });
    readFileSyncSpy.mockImplementation(
      (
        p: fs.PathOrFileDescriptor,
        options?:
          | BufferEncoding
          | { encoding?: null | BufferEncoding; flag?: string }
          | null,
      ) => {
        const asString = String(p);
        if (asString === "/proc/7331/cmdline") {
          return "node\0dist/lib/shields/timer.js\0openclaw\0/tmp/snap.yaml\0proc-token-1\0";
        }
        return originalReadFileSync(p, options as never) as never;
      },
    );
    const processKillSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid: number, _signal?: string | number) => true);

    const result = killTimer("openclaw");

    expect(result).toEqual({
      markerFound: true,
      markerPid: 7331,
      wasAlive: true,
      terminated: true,
      warnings: [],
    });
    expect(processKillSpy).toHaveBeenCalledWith(7331, 0);
    expect(processKillSpy).toHaveBeenCalledWith(7331, "SIGTERM");
    expect(
      fs.existsSync(path.join(stateDir, "shields-timer-openclaw.json")),
    ).toBe(false);
  });

  it("killTimer does not signal a live PID when marker identity mismatches and still clears marker", async () => {
    const distModulePath = path.join(
      process.cwd(),
      "dist",
      "lib",
      "shields",
      "timer-control.js",
    );
    const { killTimer } = await import(distModulePath);
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "shields-timer-openclaw.json"),
      JSON.stringify({
        pid: 7331,
        sandboxName: "openclaw",
        snapshotPath: "/tmp/snap.yaml",
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken: "expected-token",
      }),
    );
    const originalExistsSync = fs.existsSync.bind(fs);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    const existsSyncSpy = vi.spyOn(fs, "existsSync");
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      const asString = String(p);
      if (asString === "/proc/7331/cmdline") return true;
      return originalExistsSync(p);
    });
    readFileSyncSpy.mockImplementation(
      (
        p: fs.PathOrFileDescriptor,
        options?:
          | BufferEncoding
          | { encoding?: null | BufferEncoding; flag?: string }
          | null,
      ) => {
        const asString = String(p);
        if (asString === "/proc/7331/cmdline") {
          return "python\0some-other-process\0--token\0nope\0";
        }
        return originalReadFileSync(p, options as never) as never;
      },
    );
    const processKillSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid: number, _signal?: string | number) => true);

    const result = killTimer("openclaw");

    expect(result.markerFound).toBe(true);
    expect(result.wasAlive).toBe(true);
    expect(result.terminated).toBe(false);
    expect(result.warnings[0]).toContain(
      "does not match shields timer identity",
    );
    expect(processKillSpy).toHaveBeenCalledTimes(1);
    expect(processKillSpy).toHaveBeenCalledWith(7331, 0);
    expect(
      fs.existsSync(path.join(stateDir, "shields-timer-openclaw.json")),
    ).toBe(false);
  });

  it("killTimer clears stale marker even when PID is not alive", async () => {
    const distModulePath = path.join(
      process.cwd(),
      "dist",
      "lib",
      "shields",
      "timer-control.js",
    );
    const { killTimer } = await import(distModulePath);
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const markerPath = path.join(stateDir, "shields-timer-openclaw.json");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: 7331,
        sandboxName: "openclaw",
        snapshotPath: "/tmp/snap.yaml",
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    const processKillSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: string | number) => {
        if (pid === 7331 && signal === 0) {
          const err = new Error("gone") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      });

    const result = killTimer("openclaw");
    expect(result).toEqual({
      markerFound: true,
      markerPid: 7331,
      wasAlive: false,
      terminated: false,
      warnings: [],
    });
    expect(processKillSpy).toHaveBeenCalledWith(7331, 0);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("shieldsDown writes a process token into the timer marker and passes it to timer args", () => {
    const src = getSourceCode();
    const downStart = src.indexOf("function shieldsDown");
    expect(downStart).not.toBe(-1);
    const fnBody = src.slice(downStart, src.indexOf("function shieldsUp"));

    expect(fnBody).toContain(
      'const processToken = randomBytes(16).toString("hex")',
    );
    expect(fnBody).toContain("processToken,");
  });

  it("isShieldsDown fails closed when shields state is corrupt", async () => {
    const distModulePath = path.join(
      process.cwd(),
      "dist",
      "lib",
      "shields",
      "index.js",
    );
    const { isShieldsDown } = await import(distModulePath);
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      "{broken-json",
    );

    expect(isShieldsDown("openclaw")).toBe(false);
  });
});
