// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { testTimeoutOptions } from "../../helpers/timeouts";

// Migrated from test/e2e/test-whatsapp-qr-compact-e2e.sh. This hermetic
// reporter-workflow coverage guard for #4522 installs the exact OpenClaw /
// @openclaw/whatsapp versions bundled by Dockerfile.base and measures the real
// upstream terminal QR renderer with and without the NemoClaw compact preload.
// It intentionally does not require a WhatsApp account, phone scan, sandbox,
// Docker, or NVIDIA_API_KEY: the legacy contract is the renderer boundary.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DOCKERFILE_BASE = path.join(REPO_ROOT, "Dockerfile.base");
const PRELOAD = path.join(REPO_ROOT, "nemoclaw-blueprint", "scripts", "whatsapp-qr-compact.js");
const INSTALL_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 30_000;
const COMPACT_MAX_ROWS = Number.parseInt(process.env.WHATSAPP_QR_COMPACT_MAX_ROWS ?? "40", 10);
const OVERSIZE_MIN_ROWS = Number.parseInt(process.env.WHATSAPP_QR_OVERSIZE_MIN_ROWS ?? "50", 10);

const PROBE_SOURCE = `import { renderQrTerminal } from "openclaw/plugin-sdk/media-runtime";
const strip = (s) => s.replace(/\\x1b\\[[0-9;]*m/g, "");
// ref,noiseKey,signedIdentityKey,advSecret — the four comma-joined fields a
// baileys WhatsApp Web QR carries; long and dense like the real payload.
const qr =
  "2@" + "ABcd12".repeat(8) + "," + "a8K3".repeat(11) + "=," +
  "Xy90".repeat(11) + "=," + "Qr5T".repeat(9) + "=";
// Call exactly as the plugin does at session login: renderQrTerminal(qr), with
// no { small }, so this exercises the real default rather than a contrived opt-in.
const out = strip(await renderQrTerminal(qr));
const lines = out.split("\\n");
process.stdout.write(JSON.stringify({
  rows: lines.length,
  cols: Math.max(...lines.map((l) => [...l].length)),
}));
`;

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type Dimensions = {
  rows: number;
  cols: number;
};

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

async function readBundledOpenClawVersion(): Promise<string> {
  const dockerfile = await fs.readFile(DOCKERFILE_BASE, "utf8");
  const match = dockerfile.match(/^ARG OPENCLAW_VERSION=(\S+)\s*$/m);
  if (!match?.[1]) {
    throw new Error("could not parse OPENCLAW_VERSION from Dockerfile.base");
  }
  return match[1];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function fileContains(root: string, needle: string): Promise<boolean> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (await fileContains(target, needle)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    const text = await fs.readFile(target, "utf8");
    if (text.includes(needle)) return true;
  }
  return false;
}

function parseDimensions(stdout: string, label: string): Dimensions {
  const parsed = JSON.parse(stdout.trim()) as Partial<Dimensions>;
  expect(typeof parsed.rows, `${label} rows must be numeric`).toBe("number");
  expect(typeof parsed.cols, `${label} cols must be numeric`).toBe("number");
  return parsed as Dimensions;
}

test(
  "WhatsApp pairing QR renders compact with the NemoClaw preload",
  testTimeoutOptions(INSTALL_TIMEOUT_MS + PROBE_TIMEOUT_MS * 2),
  async () => {
    expect(await pathExists(PRELOAD), `compact-QR preload missing: ${PRELOAD}`).toBe(true);
    const openclawVersion = await readBundledOpenClawVersion();

    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-wa-qr-e2e-"));
    try {
      await fs.writeFile(
        path.join(workdir, "package.json"),
        `${JSON.stringify({ name: "wa-qr-e2e", version: "1.0.0", private: true })}\n`,
      );

      const install = await runCommand(
        "npm",
        [
          "install",
          "--no-audit",
          "--no-fund",
          `openclaw@${openclawVersion}`,
          `@openclaw/whatsapp@${openclawVersion}`,
        ],
        { cwd: workdir, timeoutMs: INSTALL_TIMEOUT_MS },
      );
      expect(install.status, `npm install failed\n${install.stderr}`).toBe(0);

      const whatsappDist = path.join(workdir, "node_modules", "@openclaw", "whatsapp", "dist");
      expect(
        await fileContains(whatsappDist, "renderQrTerminal"),
        "plugin channel-login must render through renderQrTerminal",
      ).toBe(true);

      await fs.writeFile(path.join(workdir, "probe.mjs"), PROBE_SOURCE);

      const baseline = await runCommand("node", ["probe.mjs"], {
        cwd: workdir,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      expect(baseline.status, `baseline probe failed\n${baseline.stderr}`).toBe(0);
      const baselineDimensions = parseDimensions(baseline.stdout, "baseline");
      expect(
        baselineDimensions.rows,
        `baseline QR should reproduce the oversized form (${baselineDimensions.rows} rows)`,
      ).toBeGreaterThanOrEqual(OVERSIZE_MIN_ROWS);

      const patched = await runCommand("node", ["probe.mjs"], {
        cwd: workdir,
        env: { NODE_OPTIONS: `--require ${PRELOAD}` },
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      expect(patched.status, `patched probe failed\n${patched.stderr}`).toBe(0);
      const patchedDimensions = parseDimensions(patched.stdout, "patched");
      expect(
        patchedDimensions.rows,
        `compact QR should fit the scan frame (${patchedDimensions.rows} rows)`,
      ).toBeLessThanOrEqual(COMPACT_MAX_ROWS);
      expect(patchedDimensions.rows).toBeLessThan(baselineDimensions.rows);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  },
);
