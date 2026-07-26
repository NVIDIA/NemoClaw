// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for issue #6852: snapshot restore must never replace the
// sandbox's working gateway auth state (OpenClaw device identity keypair and
// paired-device token store) with backup copies. Backup sanitization scrubs
// key/token fields, so any backed-up copy of identity/ or devices/ is corrupt
// by construction; restoring it breaks gateway auth for every CLI client
// (GatewayCredentialsRequiredError) until the device is re-paired.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// sandbox-state computes its backup root from HOME at module load time.
// vi.stubEnv records and restores the prior value (including unset) on teardown.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-auth-home-"));
vi.stubEnv("HOME", TMP_HOME);

const REPO_ROOT = path.join(import.meta.dirname, "..");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
)) as typeof import("../src/lib/state/sandbox.js");

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

/**
 * Fake `openshell` and `ssh` executables mirroring the backup/restore SSH
 * contract against a local sandbox-root directory. Unlike the config-only
 * harness in openclaw-config-snapshot.test.ts, this one also implements the
 * state-DIRECTORY contract: exist checks, the pre-backup audit, tar
 * download/extract, pre-restore cleanup, and usability probes.
 */
function writeFakeSandboxBins(binDir: string, fakeRoot: string): void {
  writeExecutable(
    path.join(binDir, "openshell"),
    `#!/bin/sh
if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then
  printf '{"name":"%s"}\n' "\${3:-alpha}"
  exit 0
fi
if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ]; then
  printf 'Host openshell-alpha\n  HostName 127.0.0.1\n  User sandbox\n'
  exit 0
fi
exit 0
`,
  );

  writeExecutable(
    path.join(binDir, "ssh"),
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const fakeRoot = ${JSON.stringify(fakeRoot)};
const dir = path.join(fakeRoot, ".openclaw");
const cmd = process.argv[process.argv.length - 1] || "";
function mapPath(p) {
  return p.replace(/^\\/sandbox\\/\\.openclaw/, dir);
}
function readStdin() {
  const chunks = [];
  for (;;) {
    const buf = Buffer.alloc(65536);
    let n = 0;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { break; }
    if (n === 0) break;
    chunks.push(buf.subarray(0, n));
  }
  return Buffer.concat(chunks);
}
// Backup: state-dir existence probe (piped through awk '!seen[$0]++').
if (cmd.includes("!seen[$0]++")) {
  const probes = [...cmd.matchAll(/\\[ -d '([^']+)' \\] && printf '%s\\\\n' '([^']+)'/g)];
  for (const m of probes) {
    if (fs.existsSync(mapPath(m[1]))) process.stdout.write(m[2] + "\\n");
  }
  process.exit(0);
}
// Backup: pre-backup symlink/hardlink audit — fixture has none.
if (cmd.includes("-printf")) { process.exit(0); }
// Backup: tar download of state dirs.
if (cmd.startsWith("tar -cf - -C ")) {
  const names = [...cmd.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const result = spawnSync("tar", ["-cf", "-", "-C", mapPath(names[0]), "--", ...names.slice(1)], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || Buffer.alloc(0));
  process.exit(result.status || 0);
}
// Restore: pre-restore cleanup of target state dirs.
if (cmd.startsWith("rm -rf -- ")) {
  for (const m of cmd.matchAll(/rm -rf -- '([^']+)'/g)) {
    fs.rmSync(mapPath(m[1]), { recursive: true, force: true });
  }
  process.exit(0);
}
// Restore: tar extract of the backup archive into the state dir.
if (cmd.includes("-xf - -C ")) {
  const target = mapPath([...cmd.matchAll(/'([^']+)'/g)].map((m) => m[1])[0]);
  const result = spawnSync("tar", ["--no-same-owner", "-xf", "-", "-C", target], {
    input: readStdin(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.exit(result.status || 0);
}
// Restore: best-effort chown; usability probe over restored dirs.
if (cmd.startsWith("chown ")) { process.exit(0); }
if (cmd.includes("[ -d ")) { process.exit(0); }
// Backup + config merge: read the live openclaw.json.
if (cmd.includes("openclaw.json") && cmd.includes("cat --")) {
  process.stdout.write(fs.readFileSync(path.join(dir, "openclaw.json")));
  process.exit(0);
}
// Restore: staged openclaw.json write-back.
if (cmd.includes(".nemoclaw-restore") && cmd.includes("openclaw.json")) {
  const configPath = path.join(dir, "openclaw.json");
  const restored = readStdin();
  if (cmd.includes("last-good")) {
    fs.writeFileSync(path.join(dir, "openclaw.json.last-good"), restored);
  }
  fs.writeFileSync(configPath, restored);
  if (cmd.includes("sha256sum") && cmd.includes(".config-hash")) {
    const digest = require("crypto").createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
    fs.writeFileSync(path.join(dir, ".config-hash"), digest + "  openclaw.json\\n");
  }
  process.exit(0);
}
process.exit(0);
`,
  );
}

function writeOpenClawRegistry(sandboxName: string): void {
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          policies: [],
          agent: null,
        },
      },
    }),
  );
}

const LIVE_DEVICE_IDENTITY = JSON.stringify({
  deviceId: "live-device",
  publicKey: "live-public-key",
  privateKey: "live-private-key",
});
const LIVE_PAIRED_DEVICE = JSON.stringify({
  deviceId: "live-device",
  token: "live-operator-token",
});

describe("runtime auth state across snapshot backup/restore (#6852)", () => {
  it("never captures or restores device identity and pairing state", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-auth-"));
    try {
      const binDir = path.join(fixture, "bin");
      const fakeRoot = path.join(fixture, "sandbox-root");
      const openclawDir = path.join(fakeRoot, ".openclaw");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "agents", "main"), { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "identity"), { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "devices"), { recursive: true });

      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({ gateway: { auth: { token: "live-gateway-token" } } }, null, 2),
      );
      fs.writeFileSync(path.join(openclawDir, "agents", "main", "state.txt"), "old-agent-state");
      fs.writeFileSync(path.join(openclawDir, "identity", "device.json"), LIVE_DEVICE_IDENTITY);
      fs.writeFileSync(path.join(openclawDir, "devices", "paired.json"), LIVE_PAIRED_DEVICE);

      writeFakeSandboxBins(binDir, fakeRoot);
      writeOpenClawRegistry("alpha");
      vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", path.join(binDir, "openshell"));
      vi.stubEnv("PATH", `${binDir}:${process.env.PATH || ""}`);

      // ── Backup: runtime auth dirs are not captured at all ──────────
      const backup = sandboxState.backupSandboxState("alpha");
      expect(backup.success).toBe(true);
      expect(backup.backedUpDirs).toContain("agents");
      expect(backup.backedUpDirs).not.toContain("identity");
      expect(backup.backedUpDirs).not.toContain("devices");
      expect(backup.manifest?.stateDirs).not.toContain("identity");
      expect(backup.manifest?.stateDirs).not.toContain("devices");
      const backupPath = backup.manifest!.backupPath!;
      expect(fs.existsSync(path.join(backupPath, "agents", "main", "state.txt"))).toBe(true);
      expect(fs.existsSync(path.join(backupPath, "identity"))).toBe(false);
      expect(fs.existsSync(path.join(backupPath, "devices"))).toBe(false);

      // ── Legacy backup: simulate a pre-fix snapshot that captured the
      // runtime auth dirs (credential-sanitized into corrupt placeholders)
      // and listed them in its embedded manifest. ─────────────────────
      fs.mkdirSync(path.join(backupPath, "identity"), { recursive: true });
      fs.mkdirSync(path.join(backupPath, "devices"), { recursive: true });
      fs.writeFileSync(
        path.join(backupPath, "identity", "device.json"),
        JSON.stringify({
          deviceId: "live-device",
          publicKey: "[STRIPPED_BY_MIGRATION]",
          privateKey: "[STRIPPED_BY_MIGRATION]",
        }),
      );
      fs.writeFileSync(
        path.join(backupPath, "devices", "paired.json"),
        JSON.stringify({ deviceId: "live-device", token: "[STRIPPED_BY_MIGRATION]" }),
      );
      const manifestPath = path.join(backupPath, "rebuild-manifest.json");
      const legacyManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      legacyManifest.stateDirs = [...legacyManifest.stateDirs, "identity", "devices"];
      legacyManifest.backedUpDirs = [...legacyManifest.backedUpDirs, "identity", "devices"];
      fs.writeFileSync(manifestPath, JSON.stringify(legacyManifest, null, 2));

      // Mutate live state so a clobbering restore is detectable.
      fs.writeFileSync(path.join(openclawDir, "agents", "main", "state.txt"), "new-agent-state");

      // ── Restore: durable dirs restored, runtime auth dirs untouched ─
      const restore = sandboxState.restoreSandboxState("alpha", backupPath);
      expect(restore.success).toBe(true);
      expect(restore.restoredDirs).toContain("agents");
      expect(restore.restoredDirs).not.toContain("identity");
      expect(restore.restoredDirs).not.toContain("devices");

      // agents/ came back from the backup...
      expect(fs.readFileSync(path.join(openclawDir, "agents", "main", "state.txt"), "utf-8")).toBe(
        "old-agent-state",
      );
      // ...while the live device identity and pairing tokens survived intact.
      expect(fs.readFileSync(path.join(openclawDir, "identity", "device.json"), "utf-8")).toBe(
        LIVE_DEVICE_IDENTITY,
      );
      expect(fs.readFileSync(path.join(openclawDir, "devices", "paired.json"), "utf-8")).toBe(
        LIVE_PAIRED_DEVICE,
      );
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
