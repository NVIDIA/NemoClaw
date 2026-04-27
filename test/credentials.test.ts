// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CredentialsModule = typeof import("../dist/lib/credentials.js");

function isCredentialsModule(value: object | null): value is CredentialsModule {
  return (
    value !== null &&
    typeof Reflect.get(value, "loadCredentials") === "function" &&
    typeof Reflect.get(value, "getCredential") === "function" &&
    typeof Reflect.get(value, "saveCredential") === "function" &&
    typeof Reflect.get(value, "migrateLegacyCredentialsFile") === "function"
  );
}

const TRACKED_ENV_KEYS = [
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
  "GITHUB_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "ALLOWED_CHAT_IDS",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "TEST_API_KEY",
  "OTHER_KEY",
  "EMPTY_VALUE",
  "ZETA",
  "ALPHA",
];

function clearTrackedEnv() {
  for (const key of TRACKED_ENV_KEYS) {
    delete process.env[key];
  }
}

async function importCredentialsModule(home: string): Promise<CredentialsModule> {
  vi.resetModules();
  vi.doUnmock("fs");
  vi.doUnmock("child_process");
  vi.doUnmock("readline");
  vi.stubEnv("HOME", home);
  const module = await import("../dist/lib/credentials.js");
  const loaded = "default" in module ? module.default : module;
  const moduleObject = typeof loaded === "object" && loaded !== null ? loaded : null;
  if (!isCredentialsModule(moduleObject)) {
    throw new Error("Expected credentials module exports to be available");
  }
  return moduleObject;
}

beforeEach(() => {
  // The user's shell may export NVIDIA_API_KEY etc.; the credentials module
  // now reads exclusively from process.env, so any inherited value would
  // contaminate every test. Start each case from a clean process env.
  clearTrackedEnv();
});

afterEach(() => {
  clearTrackedEnv();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("host-side credential staging", () => {
  it("stages values in process.env and never writes to disk", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);

    expect(credentials.loadCredentials()).toEqual({});

    credentials.saveCredential("NVIDIA_API_KEY", "  nvapi-saved-key \r\n");

    // No plaintext credentials.json — the gateway is the system of record.
    const legacyFile = path.join(home, ".nemoclaw", "credentials.json");
    expect(fs.existsSync(legacyFile)).toBe(false);

    expect(process.env.NVIDIA_API_KEY).toBe("nvapi-saved-key");
    expect(credentials.getCredential("NVIDIA_API_KEY")).toBe("nvapi-saved-key");
    expect(credentials.loadCredentials()).toEqual({ NVIDIA_API_KEY: "nvapi-saved-key" });
    expect(credentials.listCredentialKeys()).toEqual(["NVIDIA_API_KEY"]);
  });

  it("getCredential reads only from process.env", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));

    // A pre-existing legacy file must NOT bleed into getCredential — the
    // module no longer reads cleartext from disk.
    fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".nemoclaw", "credentials.json"),
      JSON.stringify({ NVIDIA_API_KEY: "nvapi-from-disk" }),
      { mode: 0o600 },
    );

    const credentials = await importCredentialsModule(home);
    expect(credentials.getCredential("NVIDIA_API_KEY")).toBe(null);

    vi.stubEnv("NVIDIA_API_KEY", "  nvapi-from-env \n");
    expect(credentials.getCredential("NVIDIA_API_KEY")).toBe("nvapi-from-env");
  });

  it("returns null for missing or blank credential values", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);

    credentials.saveCredential("EMPTY_VALUE", " \r\n ");
    expect(credentials.getCredential("EMPTY_VALUE")).toBe(null);
    expect(credentials.getCredential("NVIDIA_API_KEY")).toBe(null);
  });

  it("deleteCredential clears the staged value without touching disk", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);

    credentials.saveCredential("NVIDIA_API_KEY", "nvapi-bad-key");
    credentials.saveCredential("OPENAI_API_KEY", "sk-other");

    expect(credentials.listCredentialKeys()).toEqual(["NVIDIA_API_KEY", "OPENAI_API_KEY"]);
    expect(fs.existsSync(path.join(home, ".nemoclaw", "credentials.json"))).toBe(false);

    expect(credentials.deleteCredential("NVIDIA_API_KEY")).toBe(true);
    expect(credentials.getCredential("NVIDIA_API_KEY")).toBe(null);
    expect(credentials.listCredentialKeys()).toEqual(["OPENAI_API_KEY"]);
    expect(credentials.getCredential("OPENAI_API_KEY")).toBe("sk-other");

    // Idempotent.
    expect(credentials.deleteCredential("NVIDIA_API_KEY")).toBe(false);
  });

  it("deleteCredential returns false when nothing is staged", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);
    expect(credentials.deleteCredential("ANYTHING")).toBe(false);
  });

  it("listCredentialKeys reports staged known keys, sorted, without exposing values", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);
    expect(credentials.listCredentialKeys()).toEqual([]);

    credentials.saveCredential("ANTHROPIC_API_KEY", "z");
    credentials.saveCredential("OPENAI_API_KEY", "a");
    expect(credentials.listCredentialKeys()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });
});

describe("legacy credentials.json migration", () => {
  it("hydrates env from a pre-fix plaintext file and securely removes it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        NVIDIA_API_KEY: "nvapi-legacy",
        TELEGRAM_BOT_TOKEN: "tg-legacy",
        IGNORED_NON_STRING: 42 as unknown as string,
      }),
      { mode: 0o600 },
    );

    const credentials = await importCredentialsModule(home);
    const migrated = credentials.migrateLegacyCredentialsFile();

    expect(migrated).toEqual(["NVIDIA_API_KEY", "TELEGRAM_BOT_TOKEN"]);
    expect(process.env.NVIDIA_API_KEY).toBe("nvapi-legacy");
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("tg-legacy");

    // File is gone.
    expect(fs.existsSync(legacyFile)).toBe(false);
  });

  it("returns [] when no legacy file is present", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);
    expect(credentials.migrateLegacyCredentialsFile()).toEqual([]);
  });

  it("does not override env values that the user explicitly set", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credsDir, "credentials.json"),
      JSON.stringify({ NVIDIA_API_KEY: "nvapi-from-disk" }),
      { mode: 0o600 },
    );

    vi.stubEnv("NVIDIA_API_KEY", "nvapi-from-env");
    const credentials = await importCredentialsModule(home);
    credentials.migrateLegacyCredentialsFile();

    expect(process.env.NVIDIA_API_KEY).toBe("nvapi-from-env");
    expect(fs.existsSync(path.join(credsDir, "credentials.json"))).toBe(false);
  });

  it("deletes a corrupt legacy file without staging anything", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(legacyFile, "{not-json", { mode: 0o600 });

    const credentials = await importCredentialsModule(home);
    expect(credentials.migrateLegacyCredentialsFile()).toEqual([]);
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(process.env.NVIDIA_API_KEY).toBeUndefined();
  });
});

describe("prompt machinery (unchanged)", () => {
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
      path.join(import.meta.dirname, "..", "src", "lib", "credentials.ts"),
      "utf-8",
    );

    expect(source).toMatch(/return new Promise\(\(resolve, reject\) => \{/);
    expect(source).toContain("promptSecret(question)");
    expect(source).toContain('process.kill(process.pid, "SIGINT")');
    expect(source).toMatch(/reject\((err|error)\);/);
  });

  it("re-raises SIGINT from standard readline prompts instead of treating it like an empty answer", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "credentials.ts"),
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
      path.join(import.meta.dirname, "..", "src", "lib", "credentials.ts"),
      "utf-8",
    );
    expect(source).toMatch(/while \(true\) \{/);
    expect(source).toMatch(/Invalid NVIDIA API key\. Must start with nvapi-/);
    expect(source).toMatch(/continue;/);
  });

  it("masks secret input with asterisks while preserving the underlying value", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "credentials.ts"),
      "utf-8",
    );

    expect(source).toContain('output.write("*")');
    expect(source).toContain('output.write("\\b \\b")');
  });
});
