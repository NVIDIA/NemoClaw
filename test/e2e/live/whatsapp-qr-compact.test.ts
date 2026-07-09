// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { testTimeoutOptions } from "../../helpers/timeouts";
import { REPO_ROOT } from "../fixtures/paths.ts";

// reporter-workflow coverage guard for #4522 installs the exact OpenClaw /
// @openclaw/whatsapp versions bundled by Dockerfile.base and measures the real
// upstream terminal QR renderer with and without the NemoClaw compact preload.
// It intentionally does not require a WhatsApp account, phone scan, sandbox,
// Docker, or NVIDIA_INFERENCE_API_KEY: the contract is the renderer boundary.

const DOCKERFILE_BASE = path.join(REPO_ROOT, "Dockerfile.base");
const PRELOAD_SOURCE = path.join(
  REPO_ROOT,
  "src",
  "lib",
  "messaging",
  "channels",
  "whatsapp",
  "runtime",
  "whatsapp-qr-compact.ts",
);
const INSTALL_TIMEOUT_MS = 180_000;
const TSC_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const COMPACT_MAX_ROWS = Number.parseInt(process.env.WHATSAPP_QR_COMPACT_MAX_ROWS ?? "40", 10);
const OVERSIZE_MIN_ROWS = Number.parseInt(process.env.WHATSAPP_QR_OVERSIZE_MIN_ROWS ?? "50", 10);

const PROBE_SOURCE = `import { renderQrTerminal } from "openclaw/plugin-sdk/media-runtime";
const strip = (s) => s.replace(/\\x1b\\[[0-9;]*m/g, "");
const chars = (s) => [...s];
const leadingSpaces = (line) => {
  let count = 0;
  for (const ch of chars(line)) {
    if (ch !== " ") return count;
    count += 1;
  }
  return count;
};
const trailingSpaces = (line) => {
  let count = 0;
  for (const ch of chars(line).reverse()) {
    if (ch !== " ") return count;
    count += 1;
  }
  return count;
};
const profileTerminalQr = (raw) => {
  const out = strip(raw);
  const lines = out.split("\\n");
  const width = Math.max(...lines.map((l) => chars(l).length));
  const padded = lines.map((l) => chars(l).join("").padEnd(width, " "));
  const allWhite = (line) => chars(line).every((ch) => ch === " ");
  const contentLines = padded.filter((line) => !allWhite(line));
  const topRows = padded.findIndex((line) => !allWhite(line));
  let bottomRows = 0;
  for (let i = padded.length - 1; i >= 0; i -= 1) {
    if (!allWhite(padded[i])) break;
    bottomRows += 1;
  }
  const quietEdges = contentLines.length === 0 ? {
    leftModules: null,
    rightModules: null,
    topModules: null,
    bottomModules: null,
  } : {
    leftModules: Math.min(...contentLines.map(leadingSpaces)),
    rightModules: Math.min(...contentLines.map(trailingSpaces)),
    topModules: topRows * 2,
    bottomModules: bottomRows * 2,
  };
  return {
    rows: lines.length,
    cols: width,
    ...quietEdges,
    dataImageFallback: out.includes("data:image/png"),
  };
};
// ref,noiseKey,signedIdentityKey,advSecret — the four comma-joined fields a
// baileys WhatsApp Web QR carries; long and dense like the real payload.
const qr =
  "2@" + "ABcd12".repeat(8) + "," + "a8K3".repeat(11) + "=," +
  "Xy90".repeat(11) + "=," + "Qr5T".repeat(9) + "=";
// Call exactly as the plugin does at session login: renderQrTerminal(qr), with
// no { small }, so this exercises the real default rather than a contrived opt-in.
const loginDefault = profileTerminalQr(await renderQrTerminal(qr));
// Also exercise OpenClaw's explicit compact branch. The QR renderer owns this
// { small: true } path directly, so this is where the four-edge quiet-zone
// source rewrite must prove itself against the reviewed bundle.
const explicitSmall = profileTerminalQr(await renderQrTerminal(qr, { small: true }));
process.stdout.write(JSON.stringify({
  loginDefault,
  explicitSmall,
}));
`;

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type QrProfile = {
  rows: number;
  cols: number;
  leftModules: number | null;
  rightModules: number | null;
  topModules: number | null;
  bottomModules: number | null;
  dataImageFallback: boolean;
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

type QrProbeResult = {
  loginDefault: QrProfile;
  explicitSmall: QrProfile;
};

function expectProfile(value: Partial<QrProfile> | undefined, label: string): QrProfile {
  expect(typeof value?.rows, `${label} rows must be numeric`).toBe("number");
  expect(typeof value?.cols, `${label} cols must be numeric`).toBe("number");
  expect(typeof value?.dataImageFallback, `${label} fallback marker must be boolean`).toBe(
    "boolean",
  );
  return value as QrProfile;
}

function expectCompactProfile(value: Partial<QrProfile> | undefined, label: string): QrProfile {
  expect(typeof value?.leftModules, `${label} left quiet zone must be numeric`).toBe("number");
  expect(typeof value?.rightModules, `${label} right quiet zone must be numeric`).toBe("number");
  expect(typeof value?.topModules, `${label} top quiet zone must be numeric`).toBe("number");
  expect(typeof value?.bottomModules, `${label} bottom quiet zone must be numeric`).toBe("number");
  return expectProfile(value, label);
}

function parseProbeResult(stdout: string, label: string): QrProbeResult {
  const parsed = JSON.parse(stdout.trim()) as Partial<QrProbeResult>;
  return {
    loginDefault: expectProfile(parsed.loginDefault, `${label} loginDefault`),
    explicitSmall: expectCompactProfile(parsed.explicitSmall, `${label} explicitSmall`),
  };
}

function parseCompactProbeResult(stdout: string, label: string): QrProbeResult {
  const parsed = JSON.parse(stdout.trim()) as Partial<QrProbeResult>;
  return {
    loginDefault: expectCompactProfile(parsed.loginDefault, `${label} loginDefault`),
    explicitSmall: expectCompactProfile(parsed.explicitSmall, `${label} explicitSmall`),
  };
}

async function compileProductionPreload(workdir: string): Promise<string> {
  const outDir = path.join(workdir, "compiled-runtime-preloads");
  const compile = await runCommand(
    path.join(REPO_ROOT, "node_modules", ".bin", "tsc"),
    ["-p", path.join(REPO_ROOT, "tsconfig.runtime-preloads.json"), "--outDir", outDir],
    { cwd: REPO_ROOT, timeoutMs: TSC_TIMEOUT_MS },
  );
  expect(compile.status, `runtime preload compile failed\n${compile.stderr}`).toBe(0);
  const preload = path.join(
    outDir,
    "lib",
    "messaging",
    "channels",
    "whatsapp",
    "runtime",
    "whatsapp-qr-compact.js",
  );
  expect(await pathExists(preload), `compiled compact-QR preload missing: ${preload}`).toBe(true);
  return preload;
}

test(
  "WhatsApp pairing QR renders compact with the NemoClaw preload",
  testTimeoutOptions(INSTALL_TIMEOUT_MS + TSC_TIMEOUT_MS + PROBE_TIMEOUT_MS * 2),
  async () => {
    expect(
      await pathExists(PRELOAD_SOURCE),
      `compact-QR preload source missing: ${PRELOAD_SOURCE}`,
    ).toBe(true);
    const openclawVersion = await readBundledOpenClawVersion();

    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-wa-qr-e2e-"));
    try {
      const preload = await compileProductionPreload(workdir);

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
      const baselineProbe = parseProbeResult(baseline.stdout, "baseline");
      expect(
        baselineProbe.loginDefault.rows,
        `baseline QR should reproduce the oversized form (${baselineProbe.loginDefault.rows} rows)`,
      ).toBeGreaterThanOrEqual(OVERSIZE_MIN_ROWS);
      expect(baselineProbe.explicitSmall.leftModules).toBeLessThan(4);
      expect(baselineProbe.explicitSmall.topModules).toBeLessThan(4);

      const patched = await runCommand("node", ["probe.mjs"], {
        cwd: workdir,
        env: { NODE_OPTIONS: `--require ${preload}` },
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      expect(patched.status, `patched probe failed\n${patched.stderr}`).toBe(0);
      const patchedProbe = parseCompactProbeResult(patched.stdout, "patched");
      expect(
        patchedProbe.loginDefault.rows,
        `compact QR should fit the scan frame (${patchedProbe.loginDefault.rows} rows)`,
      ).toBeLessThanOrEqual(COMPACT_MAX_ROWS);
      expect(patchedProbe.loginDefault.rows).toBeLessThan(baselineProbe.loginDefault.rows);
      expect(patchedProbe.loginDefault.leftModules).toBeGreaterThanOrEqual(4);
      expect(patchedProbe.loginDefault.rightModules).toBeGreaterThanOrEqual(4);
      expect(patchedProbe.loginDefault.topModules).toBeGreaterThanOrEqual(4);
      expect(patchedProbe.loginDefault.bottomModules).toBeGreaterThanOrEqual(4);
      expect(patchedProbe.loginDefault.dataImageFallback).toBe(false);
      expect(patchedProbe.explicitSmall.leftModules).toBeGreaterThanOrEqual(4);
      expect(patchedProbe.explicitSmall.rightModules).toBeGreaterThanOrEqual(4);
      expect(patchedProbe.explicitSmall.topModules).toBeGreaterThanOrEqual(4);
      expect(patchedProbe.explicitSmall.bottomModules).toBeGreaterThanOrEqual(4);
      expect(patchedProbe.explicitSmall.dataImageFallback).toBe(false);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  },
);
