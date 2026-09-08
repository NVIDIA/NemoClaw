// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  OPENCLAW_PAIRING_TIMELINE_LOCAL_PATH,
  buildOpenClawPairingTimelineCommand,
  captureOpenClawPairingTimeline,
  parseOpenClawPairingTimeline,
} from "../fixtures/openclaw-pairing-timeline.ts";

const DEVICE_ID = "device-id-secret-correlation-value";
const OTHER_DEVICE_ID = "other-device-id-secret-value";
const PUBLIC_KEY = "public-key-secret-material-value";
const OTHER_PUBLIC_KEY = "other-public-key-secret-value";
const PEM_BODY = "pem-body-secret-value";
const TOKEN = "operator-token-secret-value";
const OTHER_TOKEN = "control-ui-token-secret-value";
const REQUEST_ID = "request-id-secret-value";
const LOG_PASSWORD = "log-password-secret-value";
const LOG_TOKEN = "log-token-secret-value";
const SECRETS = [
  DEVICE_ID,
  OTHER_DEVICE_ID,
  PUBLIC_KEY,
  OTHER_PUBLIC_KEY,
  PEM_BODY,
  TOKEN,
  OTHER_TOKEN,
  REQUEST_ID,
  LOG_PASSWORD,
  LOG_TOKEN,
];
const BOOT_TIME_MS = 1_700_000_000_000;

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Build a /proc/<pid>/stat line whose field 22 (start time in clock ticks) is `startTicks`. */
function procStat(pid: number, comm: string, startTicks: number): string {
  return `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${startTicks} 1000 10\n`;
}

function localDevice() {
  return {
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
    clientId: "cli",
    clientMode: "cli",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.pairing"],
    approvedScopes: ["operator.pairing"],
    tokens: {
      operator: { role: "operator", token: TOKEN, scopes: ["operator.pairing"], revokedAtMs: null },
    },
  };
}

function fixtureInputs(root: string) {
  return {
    stateDir: join(root, "state"),
    statusPath: join(root, "status.json"),
    autoPairLogPath: join(root, "auto-pair.log"),
    procRoot: join(root, "proc"),
  };
}

function writeStateTree(root: string) {
  const inputs = fixtureInputs(root);
  writeJson(join(inputs.stateDir, "identity", "device.json"), {
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${PEM_BODY}\n-----END PUBLIC KEY-----\n`,
  });
  writeJson(join(inputs.stateDir, "devices", "paired.json"), {
    [DEVICE_ID]: localDevice(),
    [OTHER_DEVICE_ID]: {
      deviceId: OTHER_DEVICE_ID,
      publicKey: OTHER_PUBLIC_KEY,
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      role: "operator",
      scopes: ["operator.read", "custom.scope"],
      tokens: { operator: { token: OTHER_TOKEN } },
    },
  });
  writeJson(join(inputs.stateDir, "devices", "pending.json"), {
    [REQUEST_ID]: {
      requestId: REQUEST_ID,
      deviceId: DEVICE_ID,
      publicKey: PUBLIC_KEY,
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      scopes: ["operator.write", "operator.pairing"],
      isRepair: false,
    },
    "other-request": {
      requestId: "other-request",
      deviceId: OTHER_DEVICE_ID,
      scopes: ["operator.write"],
    },
  });
  writeJson(inputs.statusPath, { schemaVersion: 1, state: "request-observed" });
  writeText(
    inputs.autoPairLogPath,
    "[auto-pair] watcher started\n" +
      `[auto-pair] stage=listing failed reason=invalid-response password=${LOG_PASSWORD}\n` +
      `[auto-pair] stage=validation accepted request=${REQUEST_ID} reason=allowlisted-initial-cli\n` +
      `[auto-pair] approved initial CLI pairing request=${REQUEST_ID}\n` +
      `[auto-pair] stage=listing failed reason=invalid-response token=${LOG_TOKEN}\n` +
      "[auto-pair] loopback CLI pairing bootstrap completed\n" +
      `unknown raw line secret=${LOG_TOKEN}\n` +
      `[auto-pair] stage=approval failed reason=timeout token=${LOG_TOKEN}\n`,
  );
  writeText(
    join(inputs.procRoot, "stat"),
    `cpu  10 0 5 100 0 0 0 0 0 0\nbtime ${BOOT_TIME_MS / 1000}\nprocesses 3\n`,
  );
  writeText(join(inputs.procRoot, "1", "stat"), procStat(1, "init", 250));
  writeText(join(inputs.procRoot, "42", "stat"), procStat(42, "node", 1250));
  writeText(
    join(inputs.procRoot, "42", "cmdline"),
    "node\0/usr/local/lib/node_modules/openclaw/openclaw.mjs\0gateway\0run\0--port\0" + "18789\0",
  );
  writeText(join(inputs.procRoot, "50", "stat"), procStat(50, "python3", 700));
  writeText(join(inputs.procRoot, "50", "cmdline"), "python3\0-\0");
  mkdirSync(join(inputs.procRoot, "50", "fd"), { recursive: true });
  symlinkSync("/tmp/other.log", join(inputs.procRoot, "50", "fd", "1"));
  writeText(join(inputs.procRoot, "77", "stat"), procStat(77, "python3", 3250));
  writeText(join(inputs.procRoot, "77", "cmdline"), "python3\0-u\0-\0");
  mkdirSync(join(inputs.procRoot, "77", "fd"), { recursive: true });
  symlinkSync(inputs.autoPairLogPath, join(inputs.procRoot, "77", "fd", "1"));
  mkdirSync(join(inputs.procRoot, "self"), { recursive: true });
  return inputs;
}

function runCollector(waitSeconds: number, inputs: ReturnType<typeof fixtureInputs>) {
  const [command, ...args] = buildOpenClawPairingTimelineCommand(
    waitSeconds,
    inputs,
    OPENCLAW_PAIRING_TIMELINE_LOCAL_PATH,
  );
  return spawnSync(command, args, { encoding: "utf8" });
}

describe("OpenClaw pairing timeline evidence", () => {
  it("uploads the collector and runs it with fixed sandbox inputs and the requested wait (#11085)", async () => {
    const upload = vi.fn(async () => ({ exitCode: 0 }));
    const exec = vi.fn(async () => ({ stdout: '{"schemaVersion":1}\n' }));
    const record = await captureOpenClawPairingTimeline({ exec, upload } as never, {
      artifactName: "phase-2-pairing-timeline",
      env: { PATH: "/usr/bin" },
      redactionValues: ["secret-api-key"],
      sandboxName: "e2e-repair",
      waitSeconds: 240,
    });
    expect(upload).toHaveBeenCalledExactlyOnceWith(
      "e2e-repair",
      expect.stringMatching(/\/test\/e2e\/lib\/openclaw-pairing-timeline\.py$/),
      "/tmp",
      expect.objectContaining({
        artifactName: "phase-2-pairing-timeline-upload",
        redactionValues: ["secret-api-key"],
      }),
    );
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "e2e-repair",
      [
        "python3",
        "/tmp/openclaw-pairing-timeline.py",
        "/sandbox/.openclaw",
        "/tmp/nemoclaw-auto-pair-status.json",
        "/tmp/auto-pair.log",
        "/proc",
        "240",
      ],
      expect.objectContaining({
        artifactName: "phase-2-pairing-timeline",
        captureLimitBytes: 262_144,
        redactionValues: ["secret-api-key"],
        timeoutMs: 270_000,
      }),
    );
    expect(record).toEqual({ schemaVersion: 1 });
  });

  it("emits only allowlisted pairing state, log events, and process times from a secret-bearing tree (#11085)", () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-pairing-timeline-"));
    try {
      const inputs = writeStateTree(root);
      const result = runCollector(0, inputs);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 1,
        collectedAtMs: expect.any(Number),
        observedAtMs: expect.any(Number),
        appearance: {
          pollIntervalMs: 2000,
          waitBudgetMs: 0,
          waitedMs: expect.any(Number),
          present: true,
        },
        identity: {
          readable: true,
          deviceIdSha256: createHash("sha256").update(DEVICE_ID).digest("hex"),
          mtimeMs: expect.any(Number),
        },
        paired: {
          readable: true,
          mtimeMs: expect.any(Number),
          deviceCount: 2,
          local: {
            present: true,
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            scopes: ["operator.pairing"],
            otherScopeCount: 0,
            approved: { scopes: ["operator.pairing"], otherScopeCount: 0 },
            token: {
              present: true,
              revoked: false,
              scopes: ["operator.pairing"],
              otherScopeCount: 0,
            },
          },
          otherDevices: [
            {
              clientId: "openclaw-control-ui",
              clientMode: "webchat",
              role: "operator",
              scopes: ["operator.read"],
              otherScopeCount: 1,
            },
          ],
        },
        pending: {
          readable: true,
          mtimeMs: expect.any(Number),
          count: 2,
          local: [
            {
              clientId: "cli",
              clientMode: "cli",
              role: "operator",
              scopes: ["operator.pairing", "operator.write"],
              otherScopeCount: 0,
              isRepair: false,
            },
          ],
        },
        status: { readable: true, state: "request-observed", mtimeMs: expect.any(Number) },
        autoPairLog: {
          readable: true,
          lineCount: 8,
          events: [
            { index: 1, stage: "listing", outcome: "failed", reason: "invalid-response" },
            {
              index: 2,
              stage: "validation",
              outcome: "accepted",
              reason: "allowlisted-initial-cli",
            },
            { index: 4, stage: "listing", outcome: "failed", reason: "invalid-response" },
            { index: 7, stage: "approval", outcome: "failed", reason: "timeout" },
          ],
          markers: { watcherStarted: 0, initialApproved: 3, bootstrapCompleted: 5 },
        },
        processes: {
          containerStartedAtMs: BOOT_TIME_MS + 2_500,
          gateway: { running: true, startedAtMs: BOOT_TIME_MS + 12_500 },
          autoPairWatcher: {
            running: true,
            startedAtMs: BOOT_TIME_MS + 32_500,
            stdoutIsAutoPairLog: true,
          },
        },
      });
      expect(SECRETS.some((secret) => result.stdout.includes(secret))).toBe(false);
      expect(result.stdout).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks missing state, log, and process inputs unreadable without emitting their paths (#11085)", () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-pairing-timeline-"));
    try {
      const inputs = fixtureInputs(root);
      mkdirSync(inputs.procRoot, { recursive: true });
      const result = runCollector(0, inputs);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 1,
        collectedAtMs: expect.any(Number),
        observedAtMs: expect.any(Number),
        appearance: {
          pollIntervalMs: 2000,
          waitBudgetMs: 0,
          waitedMs: expect.any(Number),
          present: false,
        },
        identity: { readable: false, deviceIdSha256: null, mtimeMs: null },
        paired: {
          readable: false,
          mtimeMs: null,
          deviceCount: 0,
          local: { present: false },
          otherDevices: [],
        },
        pending: { readable: false, mtimeMs: null, count: 0, local: [] },
        status: { readable: false, state: null, mtimeMs: null },
        autoPairLog: {
          readable: false,
          lineCount: 0,
          events: [],
          markers: { watcherStarted: null, initialApproved: null, bootstrapCompleted: null },
        },
        processes: {
          containerStartedAtMs: null,
          gateway: { running: false, startedAtMs: null },
          autoPairWatcher: { running: false, startedAtMs: null, stdoutIsAutoPairLog: null },
        },
      });
      expect(result.stdout).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the wait until the local CLI device appears in the paired records (#11085)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-pairing-timeline-"));
    try {
      const inputs = fixtureInputs(root);
      const pairedPath = join(inputs.stateDir, "devices", "paired.json");
      writeJson(join(inputs.stateDir, "identity", "device.json"), {
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
      });
      writeJson(pairedPath, {});
      mkdirSync(inputs.procRoot, { recursive: true });
      const [command, ...args] = buildOpenClawPairingTimelineCommand(
        8,
        inputs,
        OPENCLAW_PAIRING_TIMELINE_LOCAL_PATH,
      );
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      setTimeout(() => writeJson(pairedPath, { [DEVICE_ID]: localDevice() }), 700);
      const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
      const record = parseOpenClawPairingTimeline(stdout);
      const appearance = record?.appearance as { waitedMs: number };
      expect(exitCode).toBe(0);
      expect(record?.appearance).toEqual({
        pollIntervalMs: 2000,
        waitBudgetMs: 8000,
        waitedMs: expect.any(Number),
        present: true,
      });
      expect(appearance.waitedMs).toBeGreaterThanOrEqual(700);
      expect(appearance.waitedMs).toBeLessThan(8000);
      expect(stdout).not.toContain(TOKEN);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a fixed unavailable record and still exits 0 on missing or out-of-range inputs (#11085)", () => {
    const missing = spawnSync("python3", [OPENCLAW_PAIRING_TIMELINE_LOCAL_PATH], {
      encoding: "utf8",
    });
    const [command, ...args] = buildOpenClawPairingTimelineCommand(
      601,
      fixtureInputs("/nonexistent"),
      OPENCLAW_PAIRING_TIMELINE_LOCAL_PATH,
    );
    const outOfRange = spawnSync(command, args, { encoding: "utf8" });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe('{"schemaVersion":1,"status":"unavailable"}\n');
    expect(missing.stderr).toBe("");
    expect(outOfRange.status).toBe(0);
    expect(outOfRange.stdout).toBe('{"schemaVersion":1,"status":"unavailable"}\n');
  });

  it("returns null instead of raising when the upload or exec fails or the record is malformed (#11085)", async () => {
    const options = {
      artifactName: "phase-2-pairing-timeline",
      env: {},
      redactionValues: [],
      sandboxName: "e2e-repair",
      waitSeconds: 0,
    };
    const upload = vi.fn(async () => ({ exitCode: 0 }));
    const failingUpload = vi.fn(async () => {
      throw new Error("upload refused");
    });
    const failingExec = vi.fn(async () => {
      throw new Error("sandbox not found");
    });
    const malformedExec = vi.fn(async () => ({ stdout: "not json\n" }));
    const arrayExec = vi.fn(async () => ({ stdout: "[1]\n" }));
    await expect(
      captureOpenClawPairingTimeline(
        { exec: malformedExec, upload: failingUpload } as never,
        options,
      ),
    ).resolves.toBeNull();
    await expect(
      captureOpenClawPairingTimeline({ exec: failingExec, upload } as never, options),
    ).resolves.toBeNull();
    await expect(
      captureOpenClawPairingTimeline({ exec: malformedExec, upload } as never, options),
    ).resolves.toBeNull();
    await expect(
      captureOpenClawPairingTimeline({ exec: arrayExec, upload } as never, options),
    ).resolves.toBeNull();
    expect(malformedExec).toHaveBeenCalledOnce();
    expect(parseOpenClawPairingTimeline('progress line\n{"a":1}\n')).toEqual({ a: 1 });
  });
});
