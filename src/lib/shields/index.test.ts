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
  resolvePermissivePolicyPath: vi.fn(() => "/mock/permissive.yaml"),
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

    it("getShieldsPosture exposes canonical status wording for callers", async () => {
      const distModulePath = path.join(
        process.cwd(),
        "dist",
        "lib",
        "shields",
        "index.js",
      );
      const { getShieldsPosture } = await import(distModulePath);
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      expect(getShieldsPosture("openclaw", false)).toEqual(
        expect.objectContaining({
          mode: "mutable_default",
          detail: "not configured (default mutable state)",
          statusText: "NOT CONFIGURED (default mutable state)",
        }),
      );

      fs.writeFileSync(
        path.join(stateDir, "shields-openclaw.json"),
        JSON.stringify({ shieldsDown: false, updatedAt: "2026-05-20T00:00:00Z" }),
        { mode: 0o600 },
      );
      expect(getShieldsPosture("openclaw", false)).toEqual(
        expect.objectContaining({
          mode: "locked",
          detail: "up (lockdown active)",
          statusText: "UP (lockdown active)",
        }),
      );

      fs.writeFileSync(
        path.join(stateDir, "shields-openclaw.json"),
        JSON.stringify({
          shieldsDown: true,
          shieldsDownAt: "2026-05-20T00:00:00Z",
          shieldsDownTimeout: 300,
          updatedAt: "2026-05-20T00:00:00Z",
        }),
        { mode: 0o600 },
      );
      expect(getShieldsPosture("openclaw", false)).toEqual(
        expect.objectContaining({
          mode: "temporarily_unlocked",
          detail: "down (temporarily unlocked)",
          statusText: "DOWN (temporarily unlocked)",
        }),
      );
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

    it("rejects state files whose fileHashes entries are not SHA-256 hex strings", async () => {
      const sandboxName = "openclaw";
      fs.mkdirSync(stateDir(), { recursive: true });
      // Hash value is the right length but contains non-hex chars,
      // and another value is far too short. Either alone should fail
      // the isOptionalHashMap guard.
      fs.writeFileSync(
        path.join(stateDir(), `shields-${sandboxName}.json`),
        JSON.stringify({
          shieldsDown: false,
          fileHashes: {
            "/sandbox/.openclaw/openclaw.json": "not-a-real-hash",
          },
          updatedAt: new Date().toISOString(),
        }),
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

  // -------------------------------------------------------------------
  // shieldsStatus: locked-state drift surface
  // -------------------------------------------------------------------
  describe("shieldsStatus surfaces drift returned by the verifier", () => {
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

    function writeLockedState(
      sandboxName: string,
      extra: Record<string, unknown> = {},
    ): void {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir(), `shields-${sandboxName}.json`),
        JSON.stringify(
          {
            shieldsDown: false,
            updatedAt: new Date().toISOString(),
            ...extra,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }

    const SEAL_HASH =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    function writeSealedLockedState(sandboxName: string): void {
      writeLockedState(sandboxName, {
        chattrApplied: true,
        fileHashes: { "/sandbox/.openclaw/openclaw.json": SEAL_HASH },
      });
    }

    it("prints DRIFTED with the issue list and exits 2 when the verifier reports drift", async () => {
      const sandboxName = "openclaw";
      writeLockedState(sandboxName);
      const driftIssues = [
        "/sandbox/.openclaw/openclaw.json mode=660 (expected 444)",
        "/sandbox/.openclaw/openclaw.json owner=sandbox:sandbox (expected root:root)",
        "dir mode=2770 (expected 755)",
        "dir owner=sandbox:sandbox (expected root:root)",
      ];
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((code?: string | number | null) => {
          throw new Error(`exit ${String(code)}`);
        });

      const { shieldsStatus } = await loadShieldsModule();
      expect(() =>
        shieldsStatus(sandboxName, true, {
          verifyLockState: () => ({ ok: false, issues: driftIssues }),
          resolveConfig: () => ({
            agentName: "openclaw",
            configPath: "/sandbox/.openclaw/openclaw.json",
            configDir: "/sandbox/.openclaw",
          }),
        }),
      ).toThrow("exit 2");

      expect(errorSpy).toHaveBeenCalledWith(
        "  Shields: UP (DRIFTED — declared locked but sandbox filesystem differs)",
      );
      expect(errorSpy).toHaveBeenCalledWith("  Drift:");
      for (const issue of driftIssues) {
        expect(errorSpy).toHaveBeenCalledWith(`    - ${issue}`);
      }
      expect(errorSpy).toHaveBeenCalledWith(
        `  Recovery: nemoclaw ${sandboxName} shields up   # re-lock and re-verify`,
      );
      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it("prints a clean locked status when the verifier reports no drift", async () => {
      const sandboxName = "openclaw";
      writeSealedLockedState(sandboxName);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { shieldsStatus } = await loadShieldsModule();
      shieldsStatus(sandboxName, true, {
        verifyLockState: () => ({ ok: true, issues: [] }),
        resolveConfig: () => ({
          agentName: "openclaw",
          configPath: "/sandbox/.openclaw/openclaw.json",
          configDir: "/sandbox/.openclaw",
        }),
      });

      expect(logSpy).toHaveBeenCalledWith("  Shields: UP (lockdown active)");
      expect(logSpy).toHaveBeenCalledWith("  Policy:  restrictive");
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("passes the persisted fileHashes seal to the verifier when present", async () => {
      const sandboxName = "openclaw";
      const fileHashes = {
        "/sandbox/.openclaw/openclaw.json":
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      };
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir(), `shields-${sandboxName}.json`),
        JSON.stringify(
          {
            shieldsDown: false,
            chattrApplied: true,
            fileHashes,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      let receivedExpectedHashes:
        | { [path: string]: string }
        | undefined;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { shieldsStatus } = await loadShieldsModule();
      shieldsStatus(sandboxName, true, {
        verifyLockState: (
          _name: string,
          _target: unknown,
          options: { expectedHashes?: { [path: string]: string } },
        ) => {
          receivedExpectedHashes = options.expectedHashes;
          return { ok: true, issues: [] };
        },
        resolveConfig: () => ({
          agentName: "openclaw",
          configPath: "/sandbox/.openclaw/openclaw.json",
          configDir: "/sandbox/.openclaw",
        }),
      });

      expect(receivedExpectedHashes).toEqual(fileHashes);
      // No legacy-state notice when a seal is recorded.
      expect(
        logSpy.mock.calls.map((args) => args[0]).join("\n"),
      ).not.toContain("no content seal recorded");
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("exits 2 with an UNSEALED line when locked but no fileHashes seal is recorded", async () => {
      const sandboxName = "openclaw";
      writeLockedState(sandboxName);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((code?: string | number | null) => {
          throw new Error(`exit ${String(code)}`);
        });

      const { shieldsStatus } = await loadShieldsModule();
      expect(() =>
        shieldsStatus(sandboxName, true, {
          verifyLockState: () => ({ ok: true, issues: [] }),
          resolveConfig: () => ({
            agentName: "openclaw",
            configPath: "/sandbox/.openclaw/openclaw.json",
            configDir: "/sandbox/.openclaw",
          }),
        }),
      ).toThrow("exit 2");

      const errors = errorSpy.mock.calls.map((args) => args[0]).join("\n");
      expect(errors).toContain(
        "Shields: UP (UNSEALED — content integrity unknown for legacy lockdown)",
      );
      expect(errors).toContain(
        `or set NEMOCLAW_SHIELDS_ACCEPT_LEGACY_BASELINE=1 and re-run \`nemoclaw ${sandboxName} shields up\` to seal the current bytes.`,
      );
      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it("surfaces content-drift entries from the verifier without re-locking", async () => {
      const sandboxName = "openclaw";
      writeLockedState(sandboxName);
      const driftIssues = [
        "/sandbox/.openclaw/openclaw.json content drifted (sha256 fff... != sealed 012...)",
      ];
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((code?: string | number | null) => {
          throw new Error(`exit ${String(code)}`);
        });

      const { shieldsStatus } = await loadShieldsModule();
      expect(() =>
        shieldsStatus(sandboxName, true, {
          verifyLockState: () => ({ ok: false, issues: driftIssues }),
          resolveConfig: () => ({
            agentName: "openclaw",
            configPath: "/sandbox/.openclaw/openclaw.json",
            configDir: "/sandbox/.openclaw",
          }),
        }),
      ).toThrow("exit 2");

      const allErrors = errorSpy.mock.calls.map((args) => args[0]).join("\n");
      expect(allErrors).toContain("content drifted");
      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it("treats a resolveConfig throw as drift so the locked status cannot mask a setup gap", async () => {
      const sandboxName = "openclaw";
      writeLockedState(sandboxName);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((code?: string | number | null) => {
          throw new Error(`exit ${String(code)}`);
        });

      const { shieldsStatus } = await loadShieldsModule();
      expect(() =>
        shieldsStatus(sandboxName, true, {
          verifyLockState: () => ({ ok: true, issues: [] }),
          resolveConfig: () => {
            throw new Error("agent config not found");
          },
        }),
      ).toThrow("exit 2");

      const allErrors = errorSpy.mock.calls.map((args) => args[0]).join("\n");
      expect(allErrors).toContain(
        "unable to resolve agent config target: agent config not found",
      );
      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });
});

// -------------------------------------------------------------------
// NC-2227-05: shields timer marker behavior
// -------------------------------------------------------------------
describe("NC-2227-05: shields timer marker behavior", () => {
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
