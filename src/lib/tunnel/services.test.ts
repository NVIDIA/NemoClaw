// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess, { type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import { registerTunnelOrigin } from "./allowed-origins";
import * as gatewayStop from "./gateway-stop";
import { runStopCommand } from "./service-command";
import {
  getServiceStatuses,
  getTunnelUrl,
  migrateLegacyCloudflaredState,
  type CloudflaredState,
  type ProcessControl,
  readCloudflaredState,
  readWindowsProcessCommandLine,
  resolveServicePidDir,
  resolveTunnelPidDir,
  signalCloudflaredForPlatform,
  showStatus,
  startAll,
  stopAll,
} from "./services";

// startAll's tunnel-origin registration performs real host→sandbox config
// writes; stub it so these tests exercise only the wiring (tunnel-URL and
// sandbox-name discovery plus the skip/guard branches), never openshell/docker.
vi.mock("./allowed-origins", () => ({ registerTunnelOrigin: vi.fn() }));

const ollamaProxySourcePath = resolve(import.meta.dirname, "..", "inference", "ollama", "proxy.ts");

function fakeCloudflaredProcessControl(): ProcessControl {
  return {
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    commandLine: (pid) =>
      pid === process.pid ? process.argv.join(" ") : "/usr/local/bin/cloudflared tunnel run",
    signalCloudflared: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return "signaled";
      } catch {
        return "not-running";
      }
    },
  };
}

describe("getTunnelUrl", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-url-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
  });

  it("returns empty string when the cloudflared log does not exist", () => {
    expect(getTunnelUrl(pidDir, 18789)).toBe("");
  });

  it("parses quick tunnel URLs and strips fragments", () => {
    writeFileSync(
      join(pidDir, "cloudflared.log"),
      "https://abc-def.trycloudflare.com/path#secret\n",
    );
    expect(getTunnelUrl(pidDir, 18789)).toBe("https://abc-def.trycloudflare.com/path");
  });

  it("parses the named tunnel hostname matching the dashboard port", () => {
    writeFileSync(
      join(pidDir, "cloudflared.log"),
      '2026-01-01T00:00:00Z INF Updated config="{\\"ingress\\":[{\\"hostname\\":\\"other.example.com\\", \\"service\\":\\"http://localhost:9999\\"}, {\\"hostname\\":\\"agent.example.com\\", \\"service\\":\\"http://localhost:18789\\"}]}" version=1\n',
    );
    expect(getTunnelUrl(pidDir, 18789)).toBe("https://agent.example.com");
  });
});

describe("getServiceStatuses", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
  });

  it("returns stopped status when no PID files exist", () => {
    const statuses = getServiceStatuses({ pidDir });
    expect(statuses).toHaveLength(1);
    statuses.forEach((s) => {
      expect(s.running).toBe(false);
      expect(s.pid).toBeNull();
    });
  });

  it("returns service name cloudflared", () => {
    const statuses = getServiceStatuses({ pidDir });
    const names = statuses.map((s) => s.name);
    expect(names).toContain("cloudflared");
  });

  it("detects a stale PID file as not running with null pid", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    const statuses = getServiceStatuses({ pidDir });
    const cf = statuses.find((s) => s.name === "cloudflared");
    expect(cf?.running).toBe(false);
    expect(cf?.pid).toBeNull();
  });

  it("does not report a live PID owned by another process as cloudflared", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), String(process.pid));
    const statuses = getServiceStatuses({ pidDir });
    const cf = statuses.find((s) => s.name === "cloudflared");
    expect(cf).toEqual({ name: "cloudflared", running: false, pid: null });
  });

  it("ignores invalid PID file contents", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "not-a-number");
    const statuses = getServiceStatuses({ pidDir });
    const cf = statuses.find((s) => s.name === "cloudflared");
    expect(cf?.pid).toBeNull();
    expect(cf?.running).toBe(false);
  });

  it("creates pidDir if it does not exist", () => {
    const nested = join(pidDir, "nested", "deep");
    const statuses = getServiceStatuses({ pidDir: nested });
    expect(existsSync(nested)).toBe(true);
    expect(statuses).toHaveLength(1);
  });

  it("reports an unmanaged cloudflared process instead of stopped (#11628)", () => {
    const statuses = getServiceStatuses({
      pidDir,
      unmanagedCloudflaredPids: () => [4242],
    });

    expect(statuses).toEqual([{ name: "cloudflared", running: true, pid: 4242 }]);
  });
});

describe("sandbox name validation", () => {
  it("rejects names with path traversal", () => {
    expect(() => resolveServicePidDir({ sandboxName: "../escape" })).toThrow(
      "Invalid sandbox name",
    );
  });

  it("rejects names with slashes", () => {
    expect(() => resolveServicePidDir({ sandboxName: "foo/bar" })).toThrow("Invalid sandbox name");
  });

  it("rejects empty names", () => {
    expect(() => resolveServicePidDir({ sandboxName: "" })).toThrow("Invalid sandbox name");
  });

  it("accepts valid alphanumeric names", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-valid-name-test-"));
    try {
      expect(() => getServiceStatuses({ pidDir, sandboxName: "my-sandbox.1" })).not.toThrow();
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }
  });
});

describe("legacy tunnel state migration (#11628)", () => {
  const targetPidDir = resolveTunnelPidDir();
  let legacyRoot: string;

  beforeEach(() => {
    legacyRoot = mkdtempSync(join(tmpdir(), "nemoclaw-legacy-root-"));
    rmSync(targetPidDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(legacyRoot, { recursive: true, force: true });
    rmSync(targetPidDir, { recursive: true, force: true });
  });

  function createLegacyState(name: string, pid: number): string {
    const pidDir = join(legacyRoot, `nemoclaw-services-${name}`);
    mkdirSync(pidDir);
    writeFileSync(join(pidDir, "cloudflared.pid"), String(pid), { mode: 0o600 });
    writeFileSync(join(pidDir, "cloudflared.log"), "https://legacy.trycloudflare.com\n", {
      mode: 0o600,
    });
    return pidDir;
  }

  it("adopts one verified record owned by the selected gateway registry", () => {
    const legacyPidDir = createLegacyState("legacy", 4242);
    const foreignPidDir = createLegacyState("foreign", 4343);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      expect(
        migrateLegacyCloudflaredState(
          {},
          {
            legacyPidDirs: () => [foreignPidDir, legacyPidDir],
            registeredSandboxNames: () => ["legacy"],
            readState: (pidDir) =>
              new Map<string, CloudflaredState>([
                [legacyPidDir, { kind: "running", pid: 4242 }],
                [foreignPidDir, { kind: "running", pid: 4343 }],
              ]).get(pidDir) ?? { kind: "stopped" },
          },
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }

    expect(readFileSync(join(targetPidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
    expect(readFileSync(join(targetPidDir, "cloudflared.log"), "utf-8")).toContain(
      "legacy.trycloudflare.com",
    );
    expect(existsSync(join(legacyPidDir, "cloudflared.pid"))).toBe(false);
    expect(existsSync(join(foreignPidDir, "cloudflared.pid"))).toBe(true);
  });

  it("fails closed when multiple verified legacy records are live", () => {
    const first = createLegacyState("first", 4242);
    const second = createLegacyState("second", 4343);

    expect(() =>
      migrateLegacyCloudflaredState(
        {},
        {
          legacyPidDirs: () => [first, second],
          registeredSandboxNames: () => ["first", "second"],
          readState: (pidDir) => {
            if (pidDir === first) return { kind: "running", pid: 4242 };
            if (pidDir === second) return { kind: "running", pid: 4343 };
            return { kind: "stopped" };
          },
        },
      ),
    ).toThrow("Multiple live cloudflared PID records exist");

    expect(existsSync(join(targetPidDir, "cloudflared.pid"))).toBe(false);
    expect(existsSync(join(first, "cloudflared.pid"))).toBe(true);
    expect(existsSync(join(second, "cloudflared.pid"))).toBe(true);
  });

  it("fails closed when host and legacy records are both live", () => {
    const legacyPidDir = createLegacyState("legacy", 4343);
    mkdirSync(targetPidDir, { recursive: true });
    writeFileSync(join(targetPidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

    expect(() =>
      migrateLegacyCloudflaredState(
        {},
        {
          legacyPidDirs: () => [legacyPidDir],
          registeredSandboxNames: () => ["legacy"],
          readState: (pidDir) =>
            pidDir === targetPidDir
              ? { kind: "running", pid: 4242 }
              : { kind: "running", pid: 4343 },
        },
      ),
    ).toThrow("Multiple live cloudflared PID records exist");

    expect(readFileSync(join(targetPidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
    expect(readFileSync(join(legacyPidDir, "cloudflared.pid"), "utf-8")).toBe("4343");
  });
});

describe("showStatus", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
  });

  it("prints stopped status for all services", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("cloudflared");
    expect(output).toContain("stopped");
    logSpy.mockRestore();
  });

  it("does not show tunnel URL when cloudflared is not running", () => {
    writeFileSync(join(pidDir, "cloudflared.log"), "https://abc-def.trycloudflare.com");
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).not.toContain("Public URL");
    logSpy.mockRestore();
  });

  it("reports an unmanaged process with process-manager recovery (#11628)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    showStatus({ pidDir, unmanagedCloudflaredPids: () => [4242] });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();

    expect(output).toContain("cloudflared  (unmanaged PID 4242)");
    expect(output).toContain("stop it through its process manager");
    expect(output).not.toContain("cloudflared  (stopped)");
  });

  it("does not show a stale tunnel URL when live PID identity is unavailable", () => {
    writeFileSync(join(pidDir, "cloudflared.log"), "https://stale.trycloudflare.com");
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({
      pidDir,
      processControl: {
        isAlive: () => true,
        commandLine: () => null,
        signalCloudflared: () => "signaled",
      },
    });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("PID 4242, identity unavailable");
    expect(output).toContain("restore process inspection access");
    expect(output).not.toContain("Public URL");
    expect(output).not.toContain("https://stale.trycloudflare.com");
    logSpy.mockRestore();
  });

  // #2604: wangericnv and Carlos (issue comments 2026-05-11, 2026-05-14) both
  // asked for a "no cloudflared process; restart with ..." shape — a cause
  // phrase plus a single-command recovery. All three failure modes surface
  // "no cloudflared process" and point at `nemoclaw tunnel start`, which
  // overwrites a stale PID file when the identity-aware state is not running.
  it("prints `tunnel start` remediation when the PID file is missing (stopped)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("(stopped)");
    expect(output).toContain("no cloudflared process");
    expect(output).toContain("nemoclaw tunnel start");
    logSpy.mockRestore();
  });

  it("prints `tunnel start` remediation when the PID file holds garbage (stale-pid-file)", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "not-a-number");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("(stale PID file)");
    expect(output).toContain("no cloudflared process");
    expect(output).toContain("nemoclaw tunnel start");
    logSpy.mockRestore();
  });

  it("prints `tunnel start` remediation when the PID points at a dead process (stale-pid-process)", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("(stale PID 999999999)");
    expect(output).toContain("no cloudflared process");
    expect(output).toContain("PID 999999999 is dead or not cloudflared");
    expect(output).toContain("nemoclaw tunnel start");
    logSpy.mockRestore();
  });
});

describe("startAll", () => {
  let tmpDir: string;
  let pidDir: string;
  let originalPath: string | undefined;
  let originalCloudflareTunnelToken: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-start-test-"));
    pidDir = join(tmpDir, "pids");
    originalPath = process.env.PATH;
    originalCloudflareTunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalCloudflareTunnelToken === undefined) {
      delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
    } else {
      process.env.CLOUDFLARE_TUNNEL_TOKEN = originalCloudflareTunnelToken;
    }
    const pid = readCloudflaredState(pidDir, fakeCloudflaredProcessControl());
    if (pid.kind === "running") {
      try {
        process.kill(pid.pid, "SIGTERM");
      } catch {
        // Process may have already exited.
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes a private PID file and surfaces only real trycloudflare hosts", async () => {
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCloudflared = join(binDir, "cloudflared");
    writeFileSync(
      fakeCloudflared,
      [
        "#!/usr/bin/env sh",
        "echo 'https://attacker.trycloudflare.com.evil.test'",
        "echo 'https://good.trycloudflare.com/route#secret-fragment'",
        "sleep 20",
      ].join("\n"),
    );
    chmodSync(fakeCloudflared, 0o700);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startAll({
      pidDir,
      dashboardPort: 12345,
      processControl: fakeCloudflaredProcessControl(),
    });

    const pidFile = join(pidDir, "cloudflared.pid");
    expect(readFileSync(pidFile, "utf-8")).toMatch(/^\d+$/);
    expect(statSync(pidFile).mode & 0o777).toBe(0o600);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("https://good.trycloudflare.com/route");
    expect(output).not.toContain("evil.test");
    expect(output).not.toContain("secret-fragment");
  });

  it("starts a named tunnel from CLOUDFLARE_TUNNEL_TOKEN without putting the token in argv", async () => {
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCloudflared = join(binDir, "cloudflared");
    writeFileSync(
      fakeCloudflared,
      [
        "#!/usr/bin/env sh",
        "printf 'argv:%s\\n' \"$*\"",
        "if [ \"${TUNNEL_TOKEN:-}\" = 'named-secret' ]; then echo token-env-present; fi",
        'echo \'config="{\\"ingress\\":[{\\"hostname\\":\\"agent.example.com\\", \\"service\\":\\"http://localhost:12345\\"}]}"\'',
        "sleep 20",
      ].join("\n"),
    );
    chmodSync(fakeCloudflared, 0o700);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.CLOUDFLARE_TUNNEL_TOKEN = "named-secret";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startAll({
      pidDir,
      dashboardPort: 12345,
      processControl: fakeCloudflaredProcessControl(),
    });

    const log = readFileSync(join(pidDir, "cloudflared.log"), "utf-8");
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(log).toContain("argv:tunnel run");
    expect(log).toContain("token-env-present");
    expect(log).not.toContain("named-secret");
    expect(output).toContain("https://agent.example.com");
  });

  it("refuses to shadow an unmanaged cloudflared process (#11628)", async () => {
    await expect(
      startAll({
        pidDir,
        unmanagedCloudflaredPids: () => [4242],
      }),
    ).rejects.toThrow(/already running outside NemoClaw ownership.*PID 4242/);
    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
  });

  it("replaces a stale PID owned by another live process instead of reusing its URL", async () => {
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCloudflared = join(binDir, "cloudflared");
    writeFileSync(
      fakeCloudflared,
      ["#!/usr/bin/env sh", "echo 'https://fresh.trycloudflare.com'", "sleep 20"].join("\n"),
    );
    chmodSync(fakeCloudflared, 0o700);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, "cloudflared.pid"), String(process.pid), { mode: 0o600 });
    writeFileSync(join(pidDir, "cloudflared.log"), "https://stale.trycloudflare.com\n", {
      mode: 0o600,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startAll({
      pidDir,
      dashboardPort: 12345,
      processControl: fakeCloudflaredProcessControl(),
    });

    const replacementPid = Number(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8"));
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(replacementPid).not.toBe(process.pid);
    expect(output).toContain("https://fresh.trycloudflare.com");
    expect(output).not.toContain("https://stale.trycloudflare.com");
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("refuses to replace a live PID when its process identity cannot be read", async () => {
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCloudflared = join(binDir, "cloudflared");
    writeFileSync(
      fakeCloudflared,
      ["#!/usr/bin/env sh", "echo 'https://fresh.trycloudflare.com'", "sleep 20"].join("\n"),
    );
    chmodSync(fakeCloudflared, 0o700);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });
    writeFileSync(join(pidDir, "cloudflared.log"), "https://stale.trycloudflare.com\n", {
      mode: 0o600,
    });
    const signals: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const processControl: ProcessControl = {
      isAlive: () => true,
      commandLine: (pid) => (pid === 4242 ? null : "/usr/local/bin/cloudflared tunnel run"),
      signalCloudflared: (pid, sig) => {
        signals.push({ pid, sig });
        return "signaled";
      },
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(startAll({ pidDir, dashboardPort: 12345, processControl })).rejects.toThrow(
      "cloudflared process identity is unavailable for PID 4242",
    );

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
    expect(output).toContain("process identity is unavailable for PID 4242");
    expect(output).not.toContain("https://fresh.trycloudflare.com");
    expect(output).not.toContain("https://stale.trycloudflare.com");
    expect(signals).toEqual([]);
  });

  it("rejects a mismatched running quick tunnel when cloudflared is unavailable", async () => {
    const emptyBin = join(tmpDir, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    vi.stubEnv("PATH", emptyBin);
    mkdirSync(pidDir, { recursive: true });
    const pidFile = join(pidDir, "cloudflared.pid");
    const portFile = join(pidDir, "cloudflared.dashboard-port");
    writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
    writeFileSync(portFile, "12345", { mode: 0o600 });
    writeFileSync(join(pidDir, "cloudflared.log"), "https://old.trycloudflare.com\n", {
      mode: 0o600,
    });
    const processControl: ProcessControl = {
      isAlive: (pid) => pid === process.pid,
      commandLine: () => "/usr/local/bin/cloudflared tunnel --url http://localhost:12345",
      signalCloudflared: () => "signaled",
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(startAll({ pidDir, dashboardPort: 54321, processControl })).rejects.toThrow(
      "existing quick tunnel targets a different dashboard port and cloudflared is unavailable to replace it",
    );

    const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(readFileSync(pidFile, "utf-8")).toBe(String(process.pid));
    expect(readFileSync(portFile, "utf-8")).toBe("12345");
    expect(output).not.toContain("https://old.trycloudflare.com");
    expect(output).not.toContain("Public URL");
    logSpy.mockRestore();
  });
});

// #2604: readCloudflaredState is the shared source of truth used by both
// showStatus and the doctor's cloudflared check. Tests below exercise each
// branch of the discriminated union.
describe("readCloudflaredState", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-state-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
  });

  it("returns stopped when no PID file exists", () => {
    expect(readCloudflaredState(pidDir)).toEqual({ kind: "stopped" });
  });

  it("returns stopped when the PID file is empty", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "");
    expect(readCloudflaredState(pidDir)).toEqual({ kind: "stopped" });
  });

  it("returns stale-pid-file when contents are not parseable as a positive integer", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "not-a-number");
    expect(readCloudflaredState(pidDir)).toEqual({ kind: "stale-pid-file" });
  });

  it("returns stale-pid-process when the PID is dead (kernel ESRCH)", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    const state = readCloudflaredState(pidDir);
    expect(state.kind).toBe("stale-pid-process");
    if (state.kind === "stale-pid-process") expect(state.pid).toBe(999999999);
  });

  it("returns stale-pid-process when the PID points at a different process", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242");
    const state = readCloudflaredState(pidDir, {
      isAlive: () => true,
      commandLine: () => "/usr/bin/node\0vitest.mjs",
      signalCloudflared: () => "signaled",
    });
    expect(state).toEqual({ kind: "stale-pid-process", pid: 4242 });
  });

  it("does not accept cloudflared appearing only as an unrelated process argument", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242");
    const state = readCloudflaredState(pidDir, {
      isAlive: () => true,
      commandLine: () => "/usr/bin/node\0worker.js\0cloudflared",
      signalCloudflared: () => "signaled",
    });

    expect(state).toEqual({ kind: "stale-pid-process", pid: 4242 });
  });

  it("keeps a shell-wrapped cloudflared PID unverified", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242");
    const state = readCloudflaredState(pidDir, {
      isAlive: () => true,
      commandLine: () => "/bin/sh\0/tmp/cloudflared\0tunnel\0run",
      signalCloudflared: () => "signaled",
    });

    expect(state).toEqual({ kind: "unverified-pid-process", pid: 4242, reason: "wrapper" });
  });

  it("returns unverified-pid-process when a live PID cannot be inspected", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242");
    const state = readCloudflaredState(pidDir, {
      isAlive: () => true,
      commandLine: () => null,
      signalCloudflared: () => "signaled",
    });
    expect(state).toEqual({
      kind: "unverified-pid-process",
      pid: 4242,
      reason: "inspection-unavailable",
    });
  });

  it("recognizes cloudflared through the Windows CIM identity probe", () => {
    const capture = vi.fn((_command: string, _args: readonly string[]) =>
      [
        "cloudflared.exe",
        String.raw`C:\\Program Files\\cloudflared\\cloudflared.exe`,
        String.raw`"C:\\Program Files\\cloudflared\\cloudflared.exe" tunnel run`,
      ].join("\n"),
    );
    const commandLine = readWindowsProcessCommandLine(4242, capture);

    writeFileSync(join(pidDir, "cloudflared.pid"), "4242");
    const state = readCloudflaredState(pidDir, {
      isAlive: () => true,
      commandLine: () => commandLine,
      signalCloudflared: () => "signaled",
    });

    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(capture.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
    );
    expect(capture.mock.calls[0]?.[1].at(-1)).toContain("ProcessId = 4242");
    expect(state).toEqual({ kind: "running", pid: 4242 });
  });

  it("fails closed when the Windows CIM identity probe fails", () => {
    expect(
      readWindowsProcessCommandLine(4242, () => {
        throw new Error("access denied");
      }),
    ).toBeNull();
  });
});

describe("stopAll", () => {
  let pidDir: string;
  let spawnSyncCalls: Array<{ command: string; args: readonly string[] }>;
  let originalSpawnSync: typeof childProcess.spawnSync;

  beforeAll(() => {
    originalSpawnSync = childProcess.spawnSync;
    // @ts-expect-error — partial mock signature is intentional.
    childProcess.spawnSync = (command: string, args: readonly string[]) => {
      spawnSyncCalls.push({ command, args });
      const reply: SpawnSyncReturns<string> = {
        pid: 0,
        output: ["", "", ""],
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
      };
      if (command === "curl" && args.some((a) => a.endsWith("/api/ps"))) {
        reply.stdout = JSON.stringify({ models: [] });
        reply.output = ["", reply.stdout, ""];
      }
      return reply;
    };
    // The Ollama proxy source module destructures `spawnSync` at
    // require time. Load it once with the stable suite-level mock instead of
    // re-evaluating the large module under coverage for every stopAll test.
    delete require.cache[require.resolve(ollamaProxySourcePath)];
    require(ollamaProxySourcePath);
  });

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-test-"));
    spawnSyncCalls = [];
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
  });

  afterAll(() => {
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[require.resolve(ollamaProxySourcePath)];
  });

  // A scripted ProcessControl models PID identity/liveness/signalling without
  // touching the host, so the recycled-PID paths are deterministic and portable
  // (no real process, no /proc, no signals). `alive`/`cmdlines` are consumed in
  // call order, repeating the last entry.
  function scriptedControl(script: { alive: boolean[]; cmdlines: Array<string | null> }): {
    control: ProcessControl;
    signals: Array<{ pid: number; sig: string }>;
  } {
    const signals: Array<{ pid: number; sig: string }> = [];
    let aliveIdx = 0;
    let cmdIdx = 0;
    const control: ProcessControl = {
      isAlive: () => script.alive[Math.min(aliveIdx++, script.alive.length - 1)],
      commandLine: () => script.cmdlines[Math.min(cmdIdx++, script.cmdlines.length - 1)],
      signalCloudflared: (pid, sig) => {
        const commandLine = script.cmdlines[Math.min(cmdIdx++, script.cmdlines.length - 1)];
        const recordSignal = (): "signaled" => {
          signals.push({ pid, sig });
          return "signaled";
        };
        return commandLine === null
          ? "unavailable"
          : commandLine.split(/\s+/).some((token) => token.endsWith("cloudflared"))
            ? recordSignal()
            : "not-cloudflared";
      },
    };
    return { control, signals };
  }

  // The first stopAll call instruments the lazily loaded Ollama proxy dependency
  // graph. Loaded coverage shards can exceed the unit-test default here.
  it(
    "does not signal a live PID recycled to a non-cloudflared process",
    testTimeoutOptions(15_000),
    () => {
      const { control, signals } = scriptedControl({
        alive: [true],
        cmdlines: ["/usr/bin/node worker.js cloudflared"],
      });
      writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        stopAll({ pidDir, processControl: control });
      } finally {
        logSpy.mockRestore();
      }

      expect(signals).toEqual([]);
      expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
    },
  );

  it.each([false, true])(
    "fails the stop command when cloudflared remains unverified (gateway release: %s)",
    (releaseGatewayPort) => {
      vi.spyOn(gatewayStop, "releaseGatewayPortForStop").mockReturnValue("not-scoped");
      const { control, signals } = scriptedControl({ alive: [true], cmdlines: [null] });
      writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(() =>
          runStopCommand({
            listSandboxes: () => ({}),
            releaseGatewayPort,
            stopAll: (options) =>
              stopAll({
                ...options,
                sandboxName: "",
                pidDir,
                processControl: control,
                cleanupOllamaModels: false,
              }),
          }),
        ).toThrow("Cloudflared cleanup is incomplete");
      } finally {
        logSpy.mockRestore();
      }
      expect(signals).toEqual([]);
      expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
    },
  );

  it("does not signal a live PID when process identity cannot be read", () => {
    const { control, signals } = scriptedControl({
      alive: [true],
      cmdlines: [null],
    });
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      expect(() => stopAll({ pidDir, processControl: control })).toThrow(
        "Cloudflared cleanup is incomplete",
      );
    } finally {
      output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      logSpy.mockRestore();
    }

    expect(signals).toEqual([]);
    expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
    expect(output).toContain("cloudflared PID 4242 was not stopped");
    expect(output).toContain("Host service cleanup remains incomplete");
  });

  it("does not signal or discard a shell-wrapped cloudflared PID", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const processControl: ProcessControl = {
      isAlive: () => true,
      commandLine: () => "/bin/sh /tmp/cloudflared tunnel run",
      signalCloudflared: (pid, sig) => {
        signals.push({ pid, sig });
        return "signaled";
      },
    };
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      expect(() => stopAll({ pidDir, processControl })).toThrow(
        "Cloudflared cleanup is incomplete",
      );
    } finally {
      output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      logSpy.mockRestore();
    }

    expect(signals).toEqual([]);
    expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
    expect(output).toContain("Independently verify PID 4242 is cloudflared");
  });

  it("preserves the PID when identity-bound signaling is unavailable", () => {
    const processControl: ProcessControl = {
      isAlive: () => true,
      commandLine: () => "/usr/local/bin/cloudflared tunnel run",
      signalCloudflared: () => "unavailable",
    };
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      expect(() => stopAll({ pidDir, processControl })).toThrow(
        "Cloudflared cleanup is incomplete",
      );
    } finally {
      output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      logSpy.mockRestore();
    }

    expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
    expect(output).toContain("Independently verify PID 4242 is cloudflared");
    expect(output).toContain("keep the PID record until it exits");
  });

  it("does not send SIGTERM when the PID is recycled after initial validation", () => {
    const { control, signals } = scriptedControl({
      alive: [true],
      cmdlines: ["cloudflared tunnel run", "/usr/bin/node vitest"],
    });
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      stopAll({ pidDir, processControl: control });
    } finally {
      logSpy.mockRestore();
    }

    expect(signals).toEqual([]);
    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
  });

  it("signals an identity-confirmed cloudflared process with a macOS audit token", () => {
    const signal = vi.fn(() => "signaled" as const);

    expect(signalCloudflaredForPlatform(4242, "SIGTERM", "darwin", signal)).toBe("signaled");
    expect(signal).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("does not raw-signal a process on Windows", () => {
    expect(signalCloudflaredForPlatform(4242, "SIGTERM", "win32")).toBe("unavailable");
  });

  it("uses the identity-bound macOS signal result without an unbound precheck", () => {
    const signal = vi.fn(() => "not-cloudflared" as const);

    expect(signalCloudflaredForPlatform(4242, "SIGTERM", "darwin", signal)).toBe("not-cloudflared");
    expect(signal).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it.skipIf(process.platform !== "linux")(
    "signals a verified cloudflared process through a Linux pidfd",
    () => {
      const executable = join(pidDir, "cloudflared");
      copyFileSync("/bin/sleep", executable);
      chmodSync(executable, 0o700);
      const subprocess = childProcess.spawn(executable, ["20"], { stdio: "ignore" });
      const pid =
        subprocess.pid ??
        (() => {
          throw new Error("cloudflared test process has no PID");
        })();
      writeFileSync(join(pidDir, "cloudflared.pid"), String(pid), { mode: 0o600 });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const unmanagedCloudflaredPids = (): number[] => [];
      try {
        stopAll({ pidDir, unloadOllamaModels: () => undefined, unmanagedCloudflaredPids });
        const deadline = Date.now() + 1000;
        let processStopped = false;
        while (!processStopped && Date.now() < deadline) {
          try {
            const status = readFileSync(`/proc/${String(pid)}/status`, "utf-8");
            processStopped = /^State:\s+(?:Z|X)/m.test(status);
          } catch {
            // A missing /proc entry also proves that the process exited.
            processStopped = true;
          }
        }
        expect(processStopped).toBe(true);
      } finally {
        logSpy.mockRestore();
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The identity-bound stop path already reaped the process.
        }
      }

      expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "preserves a live cloudflared PID after its executable is removed by an upgrade",
    async () => {
      const executable = join(pidDir, "cloudflared");
      copyFileSync("/bin/sleep", executable);
      chmodSync(executable, 0o700);
      const subprocess = childProcess.spawn(executable, ["20"], { stdio: "ignore" });
      await new Promise<void>((resolveSpawn, reject) => {
        subprocess.once("spawn", resolveSpawn);
        subprocess.once("error", reject);
      });
      const pid =
        subprocess.pid ??
        (() => {
          throw new Error("cloudflared test process has no PID");
        })();
      const pidFile = join(pidDir, "cloudflared.pid");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        writeFileSync(pidFile, String(pid), { mode: 0o600 });
        rmSync(executable);
        expect(() => stopAll({ pidDir, unloadOllamaModels: () => undefined })).toThrow(
          "Cloudflared cleanup is incomplete",
        );
        expect(readFileSync(pidFile, "utf-8")).toBe(String(pid));
        expect(() => process.kill(pid, 0)).not.toThrow();
      } finally {
        logSpy.mockRestore();
        subprocess.kill("SIGKILL");
        await new Promise<void>((resolveExit) => subprocess.once("exit", () => resolveExit()));
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "signals a verified cloudflared process through a macOS audit token",
    () => {
      const executable = join(pidDir, "cloudflared");
      copyFileSync("/bin/sleep", executable);
      chmodSync(executable, 0o700);
      const subprocess = childProcess.spawn(executable, ["20"], { stdio: "ignore" });
      const pid =
        subprocess.pid ??
        (() => {
          throw new Error("cloudflared test process has no PID");
        })();
      writeFileSync(join(pidDir, "cloudflared.pid"), String(pid), { mode: 0o600 });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        stopAll({ pidDir, unloadOllamaModels: () => undefined });
        const processStopped = (): boolean => {
          try {
            const state = childProcess
              .execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf-8" })
              .trim();
            return state === "" || state.startsWith("Z");
          } catch {
            return true;
          }
        };
        const deadline = Date.now() + 1000;
        while (!processStopped() && Date.now() < deadline) {
          // The helper signal is synchronous; this loop only gives the child time to exit.
        }
        expect(processStopped()).toBe(true);
      } finally {
        logSpy.mockRestore();
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The identity-bound stop path already reaped the process.
        }
      }

      expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "does not signal a different macOS process after the initial identity check",
    () => {
      const subprocess = childProcess.spawn("/bin/sleep", ["20"], { stdio: "ignore" });
      const pid =
        subprocess.pid ??
        (() => {
          throw new Error("unrelated test process has no PID");
        })();

      try {
        expect(signalCloudflaredForPlatform(pid, "SIGTERM", "darwin")).toBe("not-cloudflared");
        expect(() => process.kill(pid, 0)).not.toThrow();
      } finally {
        process.kill(pid, "SIGKILL");
      }
    },
  );

  it("preserves the PID when identity becomes unreadable before SIGKILL", () => {
    const { control, signals } = scriptedControl({
      alive: [true, true],
      cmdlines: ["cloudflared tunnel run", "cloudflared tunnel run", null],
    });
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(3000);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      expect(() => stopAll({ pidDir, processControl: control })).toThrow(
        "Cloudflared cleanup is incomplete",
      );
    } finally {
      output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(signals).toEqual([{ pid: 4242, sig: "SIGTERM" }]);
    expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
    expect(output).toContain(
      "was not force-stopped because identity-bound signaling is unavailable",
    );
    expect(output).toContain("Host service cleanup remains incomplete");
  });

  it("does not escalate to SIGKILL when the PID is recycled during the poll", () => {
    const { control, signals } = scriptedControl({
      // Alive pre-SIGTERM; the poll observes exit; a live PID reappears at the
      // pre-SIGKILL re-check.
      alive: [true, false, true],
      // Ours pre-SIGTERM, then recycled to a bystander before escalation.
      cmdlines: ["cloudflared tunnel run", "cloudflared tunnel run", "/usr/bin/node vitest"],
    });
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      stopAll({ pidDir, processControl: control });
    } finally {
      logSpy.mockRestore();
    }

    expect(signals.map((entry) => entry.sig)).toEqual(["SIGTERM"]);
    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
  });

  it("escalates to SIGKILL when cloudflared remains live after the grace period (#7644)", () => {
    const { control, signals } = scriptedControl({
      alive: [true, true, false],
      cmdlines: ["cloudflared tunnel run", "cloudflared tunnel run", "cloudflared tunnel run"],
    });
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(3000);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      stopAll({ pidDir, processControl: control });
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(signals).toEqual([
      { pid: 4242, sig: "SIGTERM" },
      { pid: 4242, sig: "SIGKILL" },
    ]);
    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
  });

  it("retains the PID when cloudflared remains live after SIGKILL", () => {
    const { control, signals } = scriptedControl({
      alive: [true],
      cmdlines: ["cloudflared tunnel run"],
    });
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(3000)
      .mockReturnValueOnce(3000)
      .mockReturnValue(4000);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      expect(() => stopAll({ pidDir, processControl: control })).toThrow(
        "Cloudflared cleanup is incomplete",
      );
    } finally {
      output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(signals).toEqual([
      { pid: 4242, sig: "SIGTERM" },
      { pid: 4242, sig: "SIGKILL" },
    ]);
    expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
    expect(readCloudflaredState(pidDir, control)).toEqual({ kind: "running", pid: 4242 });
    expect(output).toContain("remained live after the force-stop signal");
    expect(output).toContain("Host service cleanup remains incomplete");
  });

  it("removes stale PID files", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir });
    logSpy.mockRestore();

    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
  });

  it("preserves the host tunnel when sandbox cleanup opts out (#11628)", () => {
    const { control, signals } = scriptedControl({
      alive: [true],
      cmdlines: ["cloudflared tunnel run"],
    });
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      stopAll({
        pidDir,
        processControl: control,
        cleanupOllamaModels: false,
        stopCloudflared: false,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(signals).toEqual([]);
    expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
  });

  it("does not claim an unmanaged cloudflared process stopped (#11628)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      expect(() =>
        stopAll({
          pidDir,
          cleanupOllamaModels: false,
          unmanagedCloudflaredPids: () => [4242],
        }),
      ).toThrow(/remains running outside NemoClaw ownership.*PID 4242/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("is idempotent — calling twice does not throw", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir });
    stopAll({ pidDir });
    logSpy.mockRestore();
  });

  it("logs stop messages", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir, unloadOllamaModels: () => undefined });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("All services stopped");
    logSpy.mockRestore();
  });

  it("runs injected Ollama cleanup before reporting services stopped", () => {
    const cleanup = vi.fn();
    const clearPendingOllamaModelCleanup = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({
      pidDir,
      sandboxName: "test-box",
      unloadOllamaModels: cleanup,
      clearPendingOllamaModelCleanup,
    });
    const stoppedCallIndex = logSpy.mock.calls.findIndex(([message]) =>
      String(message).includes("All services stopped"),
    );
    const stoppedCallOrder = logSpy.mock.invocationCallOrder[stoppedCallIndex];
    logSpy.mockRestore();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(clearPendingOllamaModelCleanup).toHaveBeenCalledWith("test-box");
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(stoppedCallOrder ?? 0);
  });

  it("skips Ollama cleanup when the scoped caller proves no model ownership", () => {
    const cleanup = vi.fn();
    const clearPendingOllamaModelCleanup = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    stopAll({
      pidDir,
      sandboxName: "test-box",
      cleanupOllamaModels: false,
      unloadOllamaModels: cleanup,
      clearPendingOllamaModelCleanup,
    });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();

    expect(cleanup).not.toHaveBeenCalled();
    expect(clearPendingOllamaModelCleanup).not.toHaveBeenCalled();
    expect(output).toContain("All services stopped");
  });

  it("reports Ollama cleanup failure and retains its recovery route", () => {
    const failure = {
      ok: false as const,
      outcome: "discovery-failed" as const,
      endpoint: "http://host.docker.internal:11434",
      selectedModels: [],
      discoveries: [],
      requests: [],
      message: "could not connect",
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    stopAll({ pidDir, unloadOllamaModels: () => failure });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();

    expect(output).toContain("Ollama model cleanup failed at http://host.docker.internal:11434");
    expect(output).toContain("saved local route was retained");
    expect(output).toContain("restore access to http://host.docker.internal:11434");
    expect(output).toContain("Host services stopped; Ollama model cleanup remains incomplete");
    expect(output).not.toContain("All services stopped");
  });

  it("propagates an unexpected Ollama cleanup failure after stopping services (#10553)", () => {
    const clearPendingOllamaModelCleanup = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() =>
      stopAll({
        pidDir,
        sandboxName: "test-box",
        unloadOllamaModels: () => {
          throw new Error("transport failed\nwith unbounded detail");
        },
        clearPendingOllamaModelCleanup,
      }),
    ).toThrow("Ollama model cleanup failed unexpectedly: transport failed with unbounded detail");
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();

    expect(output).toContain("restore access to the saved local Ollama endpoint");
    expect(output).toContain("Host services stopped; Ollama model cleanup remains incomplete");
    expect(output).not.toContain("All services stopped");
    expect(clearPendingOllamaModelCleanup).not.toHaveBeenCalled();
  });
});

// #6212: after cloudflared yields a public URL, startAll must register that
// origin in the sandbox gateway's allowedOrigins. These tests cover the wiring
// in startAll (URL + sandbox-name discovery, skip/guard branches). The
// registration module itself is mocked (see vi.mock at the top of this file),
// so no host→sandbox config write or gateway reload runs here.
describe("startAll tunnel-origin registration (#6212)", () => {
  let tmpDir: string;
  let pidDir: string;

  function writeFakeCloudflared(lines: string[]): void {
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCloudflared = join(binDir, "cloudflared");
    writeFileSync(fakeCloudflared, ["#!/usr/bin/env sh", ...lines].join("\n"));
    chmodSync(fakeCloudflared, 0o700);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-register-test-"));
    pidDir = join(tmpDir, "pids");
    vi.stubEnv("CLOUDFLARE_TUNNEL_TOKEN", undefined);
    vi.stubEnv("NEMOCLAW_SANDBOX_NAME", undefined);
    vi.stubEnv("NEMOCLAW_SANDBOX", undefined);
    vi.stubEnv("SANDBOX_NAME", undefined);
    vi.mocked(registerTunnelOrigin).mockReset();
  });

  afterEach(() => {
    const state = readCloudflaredState(pidDir, fakeCloudflaredProcessControl());
    const runningPid = state.kind === "running" ? state.pid : Number.NaN;
    try {
      process.kill(runningPid, "SIGTERM");
    } catch {
      // Not running (NaN pid throws) or already exited.
    }
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("calls registration with the raw discovered URL and the opts sandbox name", async () => {
    writeFakeCloudflared(["echo 'https://good.trycloudflare.com/route'", "sleep 20"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startAll({
      pidDir,
      dashboardPort: 12345,
      sandboxName: "my-sandbox",
      processControl: fakeCloudflaredProcessControl(),
    });
    logSpy.mockRestore();

    expect(registerTunnelOrigin).toHaveBeenCalledTimes(1);
    // The raw URL (path intact) is passed through; origin conversion happens
    // inside registerTunnelOrigin, not here.
    expect(registerTunnelOrigin).toHaveBeenCalledWith(
      "my-sandbox",
      "https://good.trycloudflare.com/route",
      expect.objectContaining({ info: expect.any(Function), warn: expect.any(Function) }),
    );
  });

  it("skips registration and warns when no sandbox name is available", async () => {
    writeFakeCloudflared(["echo 'https://good.trycloudflare.com/route'", "sleep 20"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startAll({
      pidDir,
      dashboardPort: 12345,
      processControl: fakeCloudflaredProcessControl(),
    });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();

    expect(registerTunnelOrigin).not.toHaveBeenCalled();
    expect(output).toContain("No sandbox name available — skipping tunnel-origin registration");
  });

  it("does not register when no tunnel URL is produced, but still prints the banner", async () => {
    // A present-but-URL-less cloudflared would force startAll's 15s URL-wait
    // poll and exceed the 5s test budget, so drive the same tunnelUrl==="" branch
    // with cloudflared absent from PATH (the "cloudflared not found" path).
    const emptyBin = join(tmpDir, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    vi.stubEnv("PATH", emptyBin);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startAll({
      pidDir,
      dashboardPort: 12345,
      sandboxName: "my-sandbox",
      unmanagedCloudflaredPids: () => [],
    });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();

    expect(registerTunnelOrigin).not.toHaveBeenCalled();
    expect(output).toContain("Services");
    expect(output).not.toContain("Public URL");
  });

  // Scenario 17 — guard-rail for Decision 6: startAll must stay resilient even
  // if registration escapes its own try/catch.
  it("still resolves and prints the Public URL banner when registration throws", async () => {
    writeFakeCloudflared(["echo 'https://good.trycloudflare.com/route'", "sleep 20"]);
    vi.mocked(registerTunnelOrigin).mockImplementation(() => {
      throw new Error("registration blew up");
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      startAll({
        pidDir,
        dashboardPort: 12345,
        sandboxName: "my-sandbox",
        processControl: fakeCloudflaredProcessControl(),
      }),
    ).resolves.toBeUndefined();
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();

    expect(output).toContain("Public URL");
    expect(output).toContain("https://good.trycloudflare.com/route");
  });
});
