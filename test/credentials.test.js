// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

async function importCredentialsModule(home) {
  vi.resetModules();
  vi.doUnmock("fs");
  vi.doUnmock("child_process");
  vi.doUnmock("readline");
  vi.stubEnv("HOME", home);
  const module = await import("../bin/lib/credentials.js");
  return module.default ?? module;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("credential prompts", () => {
  it("loads, normalizes, and saves credentials from disk", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);

    expect(credentials.loadCredentials()).toEqual({});

    credentials.saveCredential("TEST_API_KEY", "  nvapi-saved-key \r\n");

    expect(credentials.CREDS_DIR).toBe(path.join(home, ".nemoclaw"));
    expect(credentials.CREDS_FILE).toBe(path.join(home, ".nemoclaw", "credentials.json"));
    expect(credentials.loadCredentials()).toEqual({ TEST_API_KEY: "nvapi-saved-key" });
    expect(credentials.getCredential("TEST_API_KEY")).toBe("nvapi-saved-key");

    const saved = JSON.parse(
      fs.readFileSync(path.join(home, ".nemoclaw", "credentials.json"), "utf-8"),
    );
    expect(saved).toEqual({ TEST_API_KEY: "nvapi-saved-key" });
  });

  it("prefers environment credentials and ignores malformed credential files", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
    fs.writeFileSync(path.join(home, ".nemoclaw", "credentials.json"), "{not-json");

    const credentials = await importCredentialsModule(home);
    expect(credentials.loadCredentials()).toEqual({});

    vi.stubEnv("TEST_API_KEY", "  nvapi-from-env \n");
    expect(credentials.getCredential("TEST_API_KEY")).toBe("nvapi-from-env");
  });

  it("returns null for missing or blank credential values", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);

    credentials.saveCredential("EMPTY_VALUE", " \r\n ");
    expect(credentials.getCredential("MISSING_VALUE")).toBe(null);
    expect(credentials.getCredential("EMPTY_VALUE")).toBe(null);
  });

  it("exits cleanly when answers are staged through a pipe", () => {
    const script = `
      set -euo pipefail
      pipe="$(mktemp -u)"
      mkfifo "$pipe"
      trap 'rm -f "$pipe"' EXIT
      {
        printf 'sandbox-name\\n'
        sleep 1
        printf 'n\\n'
      } > "$pipe" &
      ${JSON.stringify(process.execPath)} -e 'const { prompt } = require(${JSON.stringify(path.join(import.meta.dirname, "..", "bin", "lib", "credentials"))}); (async()=>{ await prompt("first: "); await prompt("second: "); })().catch(err=>{ console.error(err); process.exit(1); });' < "$pipe"
    `;

    const result = spawnSync("bash", ["-lc", script], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status).toBe(0);
  });

  it("settles the outer prompt promise on secret prompt errors", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "credentials.js"),
      "utf-8",
    );

    expect(source).toMatch(/return new Promise\(\(resolve, reject\) => \{/);
    expect(source).toMatch(/reject\(err\);\s*process\.kill\(process\.pid, "SIGINT"\);/);
    expect(source).toMatch(/reject\(err\);\s*\}\);/);
  });

  it("re-raises SIGINT from standard readline prompts instead of treating it like an empty answer", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "credentials.js"),
      "utf-8",
    );

    expect(source).toContain('rl.on("SIGINT"');
    expect(source).toContain('new Error("Prompt interrupted")');
    expect(source).toContain('process.kill(process.pid, "SIGINT")');
  });

  it("normalizes credential values and keeps prompting on invalid NVIDIA API key prefixes", async () => {
    const credentials = await importCredentialsModule("/tmp");
    expect(credentials.normalizeCredentialValue("  nvapi-good-key\r\n")).toBe("nvapi-good-key");

    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "credentials.js"),
      "utf-8",
    );
    expect(source).toMatch(/while \(true\) \{/);
    expect(source).toMatch(/Invalid key\. Must start with nvapi-/);
    expect(source).toMatch(/continue;/);
  });

  it("masks secret input with asterisks while preserving the underlying value", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "credentials.js"),
      "utf-8",
    );

    expect(source).toContain('output.write("*")');
    expect(source).toContain('output.write("\\b \\b")');
  });
});
