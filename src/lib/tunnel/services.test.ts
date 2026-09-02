// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess, { type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
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

// Import source directly so tests cannot pass against a stale build.
import { registerTunnelOrigin } from "./allowed-origins";
import { resolveDefaultSandboxName } from "./service-command";
import {
  getServiceStatuses,
  getTunnelUrl,
  type ProcessControl,
  readCloudflaredState,
  showStatus,
  startAll,
  stopAll,
} from "./services";

// startAll's tunnel-origin registration performs real host→sandbox config
// writes; stub it so these tests exercise only the wiring (tunnel-URL and
// sandbox-name discovery plus the skip/guard branches), never openshell/docker.
vi.mock("./allowed-origins", () => ({ registerTunnelOrigin: vi.fn() }));

const INTEGRATION_ENV_SANDBOX = "nc1077-env-sandbox";
const INTEGRATION_REGISTRY_SANDBOX = "nc1077-registry-sandbox";
const INTEGRATION_ENV_PID_DIR = `/tmp/nemoclaw-services-${INTEGRATION_ENV_SANDBOX}`;
const INTEGRATION_REGISTRY_PID_DIR = `/tmp/nemoclaw-services-${INTEGRATION_REGISTRY_SANDBOX}`;

function resetIntegrationPidDirs(): void {
  for (const dir of [INTEGRATION_ENV_PID_DIR, INTEGRATION_REGISTRY_PID_DIR]) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedAliveCloudflaredPid(pidDir: string): void {
  mkdirSync(pidDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(pidDir, "cloudflared.pid"), String(process.pid), { mode: 0o600 });
}

const ollamaProxySourcePath = resolve(import.meta.dirname, "..", "inference", "ollama", "proxy.ts");

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
    // Write a PID that doesn't correspond to a running process
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    const statuses = getServiceStatuses({ pidDir });
    const cf = statuses.find((s) => s.name === "cloudflared");
    expect(cf?.running).toBe(false);
    // Dead processes should have pid normalized to null
    expect(cf?.pid).toBeNull();
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
});

describe("sandbox name validation", () => {
  it("rejects names with path traversal", () => {
    expect(() => getServiceStatuses({ sandboxName: "../escape" })).toThrow("Invalid sandbox name");
  });

  it("rejects names with slashes", () => {
    expect(() => getServiceStatuses({ sandboxName: "foo/bar" })).toThrow("Invalid sandbox name");
  });

  it("rejects empty names", () => {
    expect(() => getServiceStatuses({ sandboxName: "" })).toThrow("Invalid sandbox name");
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

describe("status host service PID dir matches start/stop env (#1077)", () => {
  const savedSandboxName = process.env.SANDBOX_NAME;
  const savedNemoclawSandbox = process.env.NEMOCLAW_SANDBOX;
  const savedNemoclawSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;

  beforeEach(() => {
    delete process.env.SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    delete process.env.NEMOCLAW_SANDBOX_NAME;
  });

  afterEach(() => {
    if (savedSandboxName !== undefined) process.env.SANDBOX_NAME = savedSandboxName;
    else delete process.env.SANDBOX_NAME;
    if (savedNemoclawSandbox !== undefined) process.env.NEMOCLAW_SANDBOX = savedNemoclawSandbox;
    else delete process.env.NEMOCLAW_SANDBOX;
    if (savedNemoclawSandboxName !== undefined) {
      process.env.NEMOCLAW_SANDBOX_NAME = savedNemoclawSandboxName;
    } else {
      delete process.env.NEMOCLAW_SANDBOX_NAME;
    }
    resetIntegrationPidDirs();
  });

  it("reports running cloudflared when status passes env-resolved sandboxName", () => {
    resetIntegrationPidDirs();
    process.env.SANDBOX_NAME = INTEGRATION_ENV_SANDBOX;
    seedAliveCloudflaredPid(INTEGRATION_ENV_PID_DIR);

    const resolved = resolveDefaultSandboxName(() => ({
      defaultSandbox: INTEGRATION_REGISTRY_SANDBOX,
    }));
    expect(resolved).toBe(INTEGRATION_ENV_SANDBOX);

    const statuses = getServiceStatuses({ sandboxName: resolved });
    const cloudflared = statuses.find((service) => service.name === "cloudflared");
    expect(cloudflared?.running).toBe(true);
    expect(cloudflared?.pid).toBe(process.pid);
  });

  it("reports stopped cloudflared when status passes registry sandbox but env PID dir has the process", () => {
    resetIntegrationPidDirs();
    process.env.SANDBOX_NAME = INTEGRATION_ENV_SANDBOX;
    seedAliveCloudflaredPid(INTEGRATION_ENV_PID_DIR);

    const statuses = getServiceStatuses({ sandboxName: INTEGRATION_REGISTRY_SANDBOX });
    const cloudflared = statuses.find((service) => service.name === "cloudflared");
    expect(cloudflared?.running).toBe(false);
    expect(cloudflared?.pid).toBeNull();
  });

  it("showStatus prints running cloudflared from env-resolved production PID dir", () => {
    resetIntegrationPidDirs();
    process.env.SANDBOX_NAME = INTEGRATION_ENV_SANDBOX;
    seedAliveCloudflaredPid(INTEGRATION_ENV_PID_DIR);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      showStatus({
        sandboxName: resolveDefaultSandboxName(() => ({
          defaultSandbox: INTEGRATION_REGISTRY_SANDBOX,
        })),
      });
      const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      // Wrong PID dir would report "(stopped)" with no PID; env-resolved dir finds our pid file.
      expect(output).not.toContain("cloudflared  (stopped)");
      expect(output).toContain(`cloudflared  (stale PID ${String(process.pid)})`);
    } finally {
      logSpy.mockRestore();
    }
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
    // Write a stale log file but no running process
    writeFileSync(join(pidDir, "cloudflared.log"), "https://abc-def.trycloudflare.com");
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    // Should NOT show the URL since cloudflared is not actually running
    expect(output).not.toContain("Public URL");
    logSpy.mockRestore();
  });

  // #2604: wangericnv and Carlos (issue comments 2026-05-11, 2026-05-14) both
  // asked for a "no cloudflared process; restart with ..." shape — a cause
  // phrase plus a single-command recovery. All three failure modes surface
  // "no cloudflared process" and point at `nemoclaw tunnel start`, which
  // overwrites a stale PID file when isRunning() is false (see startService).
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
    const pid = readCloudflaredState(pidDir);
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

    await startAll({ pidDir, dashboardPort: 12345 });

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

    await startAll({ pidDir, dashboardPort: 12345 });

    const log = readFileSync(join(pidDir, "cloudflared.log"), "utf-8");
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(log).toContain("argv:tunnel run");
    expect(log).toContain("token-env-present");
    expect(log).not.toContain("named-secret");
    expect(output).toContain("https://agent.example.com");
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
    // PID > max(int32) is virtually guaranteed dead on macOS/Linux.
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    const state = readCloudflaredState(pidDir);
    expect(state.kind).toBe("stale-pid-process");
    if (state.kind === "stale-pid-process") expect(state.pid).toBe(999999999);
  });

  it("returns stale-pid-process when the PID points at a different process", () => {
    // Use this test process's own PID — guaranteed alive, but not cloudflared.
    writeFileSync(join(pidDir, "cloudflared.pid"), String(process.pid));
    const state = readCloudflaredState(pidDir);
    expect(state.kind).toBe("stale-pid-process");
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
      // Return an empty model list so the unload's for-loop is a no-op.
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
      signal: (pid, sig) => {
        signals.push({ pid, sig });
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
        cmdlines: ["/usr/bin/node vitest"],
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

  it("does not escalate to SIGKILL when the PID is recycled during the poll", () => {
    const { control, signals } = scriptedControl({
      // Alive pre-SIGTERM; the poll observes exit; a live PID reappears at the
      // pre-SIGKILL re-check.
      alive: [true, false, true],
      // Ours pre-SIGTERM, then recycled to a bystander before escalation.
      cmdlines: ["cloudflared tunnel run", "/usr/bin/node vitest"],
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
      alive: [true, true],
      cmdlines: ["cloudflared tunnel run", "cloudflared tunnel run"],
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

  it("removes stale PID files", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir });
    logSpy.mockRestore();

    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
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
    const state = readCloudflaredState(pidDir);
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

  // Scenario 14
  it("calls registration with the raw discovered URL and the opts sandbox name", async () => {
    writeFakeCloudflared(["echo 'https://good.trycloudflare.com/route'", "sleep 20"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startAll({ pidDir, dashboardPort: 12345, sandboxName: "my-sandbox" });
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

  // Scenario 15
  it("skips registration and warns when no sandbox name is available", async () => {
    writeFakeCloudflared(["echo 'https://good.trycloudflare.com/route'", "sleep 20"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startAll({ pidDir, dashboardPort: 12345 });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();

    expect(registerTunnelOrigin).not.toHaveBeenCalled();
    expect(output).toContain("No sandbox name available — skipping tunnel-origin registration");
  });

  // Scenario 16
  it("does not register when no tunnel URL is produced, but still prints the banner", async () => {
    // A present-but-URL-less cloudflared would force startAll's 15s URL-wait
    // poll and exceed the 5s test budget, so drive the same tunnelUrl==="" branch
    // with cloudflared absent from PATH (the "cloudflared not found" path).
    const emptyBin = join(tmpDir, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    vi.stubEnv("PATH", emptyBin);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startAll({ pidDir, dashboardPort: 12345, sandboxName: "my-sandbox" });
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
      startAll({ pidDir, dashboardPort: 12345, sandboxName: "my-sandbox" }),
    ).resolves.toBeUndefined();
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();

    expect(output).toContain("Public URL");
    expect(output).toContain("https://good.trycloudflare.com/route");
  });
});
