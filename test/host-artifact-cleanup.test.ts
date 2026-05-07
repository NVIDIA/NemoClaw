// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KNOWN_CREDENTIAL_ENV_KEYS } from "../dist/lib/credentials.js";
import { cleanupStaleHostFiles } from "../dist/lib/host-artifact-cleanup.js";

const TRACKED_ENV_KEYS = [...KNOWN_CREDENTIAL_ENV_KEYS];

function clearTrackedEnv() {
  for (const key of TRACKED_ENV_KEYS) {
    delete process.env[key];
  }
}

function captureConsole<T>(fn: () => T): { result: T; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = fn();
    return { result, stdout, stderr };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

beforeEach(() => {
  clearTrackedEnv();
});

afterEach(() => {
  clearTrackedEnv();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("cleanupStaleHostFiles (post-upgrade sweep, #3105)", () => {
  it("removes an empty legacy credentials.json and logs the removal", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(legacyFile, "{}", { mode: 0o600 });
    vi.stubEnv("HOME", home);

    const { stdout, stderr } = captureConsole(() => cleanupStaleHostFiles());

    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(stdout.join("\n")).toMatch(/Removed stale .*credentials\.json/);
    expect(stderr).toEqual([]);
  });

  it("keeps a credentials.json carrying real credentials and logs nothing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    const payload = JSON.stringify({ NVIDIA_API_KEY: "nvapi-real" });
    fs.writeFileSync(legacyFile, payload, { mode: 0o600 });
    vi.stubEnv("HOME", home);

    const { stdout, stderr } = captureConsole(() => cleanupStaleHostFiles());

    expect(fs.existsSync(legacyFile)).toBe(true);
    expect(fs.readFileSync(legacyFile, "utf-8")).toBe(payload);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("is a no-op (and emits no log) when no stale file exists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-"));
    vi.stubEnv("HOME", home);

    const { stdout, stderr } = captureConsole(() => cleanupStaleHostFiles());

    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });
});
