// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

type CredentialsModule = typeof import("../dist/lib/credentials/store.js");

function isCredentialsModule(value: object | null): value is CredentialsModule {
  return (
    value !== null &&
    typeof Reflect.get(value, "loadCredentials") === "function" &&
    typeof Reflect.get(value, "getCredential") === "function" &&
    typeof Reflect.get(value, "saveCredential") === "function" &&
    typeof Reflect.get(value, "stageLegacyCredentialsToEnv") === "function" &&
    typeof Reflect.get(value, "removeLegacyCredentialsFile") === "function" &&
    typeof Reflect.get(value, "removeLegacyCredentialsFileIfEmpty") === "function"
  );
}

// Pull the credential-env-key allowlist from the production module so
// future additions only need to be made in one place. Plus a few
// fixture-only names this suite mutates directly.
import { KNOWN_CREDENTIAL_ENV_KEYS } from "../dist/lib/credentials/store.js";
const TEST_FIXTURE_ENV_KEYS = ["TEST_API_KEY", "OTHER_KEY", "EMPTY_VALUE", "ZETA", "ALPHA"];
const TRACKED_ENV_KEYS = [...KNOWN_CREDENTIAL_ENV_KEYS, ...TEST_FIXTURE_ENV_KEYS];

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
  const module = await import("../dist/lib/credentials/store.js");
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

describe("messaging legacy bridge credentials", () => {
  it("keeps the legacy ALLOWED_CHAT_IDS entry for the deploy-time bridge", () => {
    // The Telegram bridge runtime injected by deploy.ts still expects the
    // legacy env name. Channel config values are persisted separately from
    // provider credentials, but this credential key stays for deploy.ts.
    expect(KNOWN_CREDENTIAL_ENV_KEYS).toContain("ALLOWED_CHAT_IDS");
  });
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

describe("legacy credentials.json migration (two-phase: stage then remove)", () => {
  it("stages allowlisted keys into env without touching the file", async () => {
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
    const staged = credentials.stageLegacyCredentialsToEnv();

    expect(staged).toEqual(["NVIDIA_API_KEY", "TELEGRAM_BOT_TOKEN"]);
    expect(process.env.NVIDIA_API_KEY).toBe("nvapi-legacy");
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("tg-legacy");

    // The file MUST still exist after staging — it is removed only after a
    // successful gateway write so an interrupted onboard can be retried.
    expect(fs.existsSync(legacyFile)).toBe(true);
  });

  it("ignores keys outside the credential allowlist (PATH, NODE_OPTIONS, etc.)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    // Capture what the runner already exports so the assertions don't
    // assume `undefined` on hosts that legitimately set NODE_OPTIONS or
    // OPENSHELL_GATEWAY (CI runners, dev shells with debug flags, etc.).
    const originalPath = process.env.PATH;
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const originalOpenshellGateway = process.env.OPENSHELL_GATEWAY;
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        PATH: "/attacker/bin:/usr/bin",
        NODE_OPTIONS: "--require=/tmp/evil.js",
        OPENSHELL_GATEWAY: "evil-gw",
        NVIDIA_API_KEY: "nvapi-legitimate",
      }),
      { mode: 0o600 },
    );

    const credentials = await importCredentialsModule(home);
    const staged = credentials.stageLegacyCredentialsToEnv();

    expect(staged).toEqual(["NVIDIA_API_KEY"]);
    expect(process.env.NVIDIA_API_KEY).toBe("nvapi-legitimate");
    expect(process.env.PATH).toBe(originalPath);
    expect(process.env.NODE_OPTIONS).toBe(originalNodeOptions);
    expect(process.env.OPENSHELL_GATEWAY).toBe(originalOpenshellGateway);
  });

  it("returns [] when no legacy file is present", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);
    expect(credentials.stageLegacyCredentialsToEnv()).toEqual([]);
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
    const staged = credentials.stageLegacyCredentialsToEnv();

    expect(process.env.NVIDIA_API_KEY).toBe("nvapi-from-env");
    // The legacy value was skipped, so it must NOT be reported as staged.
    // Onboard uses the staged length to decide whether to delete the file;
    // a false-positive entry here would unlink credentials we never
    // actually migrated.
    expect(staged).toEqual([]);
    expect(fs.existsSync(path.join(credsDir, "credentials.json"))).toBe(true);
  });

  it("staging is a no-op once the file is gone (idempotent across runs)", async () => {
    // Subsequent CLI invocations after the legacy file has been
    // unlinked must short-circuit without rebuilding env from disk.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);
    expect(credentials.stageLegacyCredentialsToEnv()).toEqual([]);
    expect(process.env.NVIDIA_API_KEY).toBeUndefined();
  });

  it("treats a blank/whitespace env entry as unset and stages the legacy value", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credsDir, "credentials.json"),
      JSON.stringify({ NVIDIA_API_KEY: "nvapi-from-disk" }),
      { mode: 0o600 },
    );

    // A whitespace-only env entry — for example a CI step that exports
    // an empty value — must not block staging the legacy file value, or
    // rebuild/onboard preflight will fail with a credential the user
    // demonstrably has on disk.
    vi.stubEnv("NVIDIA_API_KEY", "   ");
    const credentials = await importCredentialsModule(home);
    const staged = credentials.stageLegacyCredentialsToEnv();

    expect(staged).toEqual(["NVIDIA_API_KEY"]);
    expect(process.env.NVIDIA_API_KEY).toBe("nvapi-from-disk");
  });

  it("stages nothing from a corrupt legacy file and leaves it untouched", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(legacyFile, "{not-json", { mode: 0o600 });

    const credentials = await importCredentialsModule(home);
    expect(credentials.stageLegacyCredentialsToEnv()).toEqual([]);
    // Corrupt input must not silently disappear — leave it for inspection.
    expect(fs.existsSync(legacyFile)).toBe(true);
    expect(process.env.NVIDIA_API_KEY).toBeUndefined();
  });

  it("refuses to migrate an oversized legacy file (DoS guard)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    // Two megabytes of valid JSON, well above the 1 MiB sanity cap.
    const filler = "x".repeat(2 * 1024 * 1024);
    fs.writeFileSync(legacyFile, JSON.stringify({ NVIDIA_API_KEY: `nvapi-${filler}` }), {
      mode: 0o600,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const credentials = await importCredentialsModule(home);

    try {
      expect(credentials.stageLegacyCredentialsToEnv()).toEqual([]);
      expect(process.env.NVIDIA_API_KEY).toBeUndefined();
      // File is left in place so the user can inspect or delete it.
      expect(fs.existsSync(legacyFile)).toBe(true);
      // The user gets a diagnostic on stderr explaining the refusal.
      const messages = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(messages).toMatch(/sanity cap/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("refuses to follow a symlink at the legacy path (no value reads past the link)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });

    // A real credentials file at an unrelated path; the attacker plants a
    // symlink at credentials.json that points at it.
    const realFile = path.join(home, "real-creds.json");
    fs.writeFileSync(realFile, JSON.stringify({ NVIDIA_API_KEY: "nvapi-attacker-controlled" }));
    fs.symlinkSync(realFile, legacyFile);

    const credentials = await importCredentialsModule(home);
    expect(credentials.stageLegacyCredentialsToEnv()).toEqual([]);
    expect(process.env.NVIDIA_API_KEY).toBeUndefined();
    // The pointee is intact; we never read or modified it.
    expect(fs.existsSync(realFile)).toBe(true);
  });

  it("survives a crash between stage and remove (interrupted-onboard regression)", async () => {
    // Simulates: process A stages legacy values into env then dies before
    // completeSession + removeLegacyCredentialsFile run. Process B starts
    // fresh (no env) and must successfully re-stage from the still-present
    // file, then cleanly remove it on its own success path.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ NVIDIA_API_KEY: "nvapi-survives-crash" }), {
      mode: 0o600,
    });

    // --- Process A: stage, then "crash" (we just abandon the env). ---
    {
      const credentials = await importCredentialsModule(home);
      const stagedA = credentials.stageLegacyCredentialsToEnv();
      expect(stagedA).toEqual(["NVIDIA_API_KEY"]);
      expect(process.env.NVIDIA_API_KEY).toBe("nvapi-survives-crash");
      // Mid-onboard crash — file MUST still exist.
      expect(fs.existsSync(legacyFile)).toBe(true);
    }

    // Wipe env so nothing carries over from "process A" into "process B".
    delete process.env.NVIDIA_API_KEY;

    // --- Process B: fresh start, re-stage idempotently, then succeed. ---
    {
      const credentials = await importCredentialsModule(home);
      const stagedB = credentials.stageLegacyCredentialsToEnv();
      expect(stagedB).toEqual(["NVIDIA_API_KEY"]);
      expect(process.env.NVIDIA_API_KEY).toBe("nvapi-survives-crash");
      credentials.removeLegacyCredentialsFile();
      expect(fs.existsSync(legacyFile)).toBe(false);
    }
  });

  it("removeLegacyCredentialsFile zero-fills the file before unlinking", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    const cleartext = JSON.stringify({ NVIDIA_API_KEY: "nvapi-secret-payload" });
    fs.writeFileSync(legacyFile, cleartext, { mode: 0o600 });

    // Capture the pre-unlink content via a wrapper that intercepts the unlink
    // call. After secureUnlink finishes the zero-fill but before the unlink
    // runs, the file should be all-zero bytes of the original size.
    // The capture lives on a holder object so TypeScript doesn't narrow the
    // closure-mutated slot to `never`.
    const originalUnlink = fs.unlinkSync;
    const captured: { bytes: Buffer | null } = { bytes: null };
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (typeof p === "string" && p === legacyFile && captured.bytes === null) {
        try {
          captured.bytes = fs.readFileSync(p);
        } catch {
          /* file already gone */
        }
      }
      return originalUnlink(p);
    });

    try {
      const credentials = await importCredentialsModule(home);
      credentials.removeLegacyCredentialsFile();
    } finally {
      spy.mockRestore();
    }

    const bytesAtUnlink = captured.bytes;
    expect(bytesAtUnlink).not.toBeNull();
    if (bytesAtUnlink !== null) {
      expect(bytesAtUnlink.length).toBe(Buffer.byteLength(cleartext));
      expect(bytesAtUnlink.every((b) => b === 0)).toBe(true);
    }
    expect(fs.existsSync(legacyFile)).toBe(false);
  });

  it("removeLegacyCredentialsFile refuses to follow symlinks (deletes the link, not the target)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });

    // The "victim" file is unrelated content the attacker wants overwritten.
    const victimFile = path.join(home, "victim.txt");
    const victimPayload = "important data the attacker should not touch";
    fs.writeFileSync(victimFile, victimPayload);

    // Plant the symlink at the credentials path.
    fs.symlinkSync(victimFile, legacyFile);

    const credentials = await importCredentialsModule(home);
    credentials.removeLegacyCredentialsFile();

    // The symlink itself is gone, but the victim file is intact.
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(fs.existsSync(victimFile)).toBe(true);
    expect(fs.readFileSync(victimFile, "utf-8")).toBe(victimPayload);
  });
});

describe("removeLegacyCredentialsFileIfEmpty (post-upgrade cleanup, #3105)", () => {
  it("removes an empty {} legacy file (regression #3105)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(legacyFile, "{}", { mode: 0o600 });

    const credentials = await importCredentialsModule(home);
    expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(true);
    expect(fs.existsSync(legacyFile)).toBe(false);
  });

  it("removes a file containing only unknown keys", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ FOO: "bar", PATH: "/etc/passwd" }),
      { mode: 0o600 },
    );

    const credentials = await importCredentialsModule(home);
    expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(true);
    expect(fs.existsSync(legacyFile)).toBe(false);
  });

  it("removes a file where every allowlisted value is blank/whitespace", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ NVIDIA_API_KEY: "", OPENAI_API_KEY: "   \r\n\t  " }),
      { mode: 0o600 },
    );

    const credentials = await importCredentialsModule(home);
    expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(true);
    expect(fs.existsSync(legacyFile)).toBe(false);
  });

  it("keeps a file with at least one non-empty allowlisted credential", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    const payload = JSON.stringify({ NVIDIA_API_KEY: "nvapi-real-secret", FOO: "bar" });
    fs.writeFileSync(legacyFile, payload, { mode: 0o600 });

    const credentials = await importCredentialsModule(home);
    expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(false);
    expect(fs.existsSync(legacyFile)).toBe(true);
    expect(fs.readFileSync(legacyFile, "utf-8")).toBe(payload);
  });

  it("returns false when no legacy file exists", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentials = await importCredentialsModule(home);
    expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(false);
  });

  it("refuses to act on a symlinked legacy path (target untouched)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });

    const victimFile = path.join(home, "victim.json");
    fs.writeFileSync(victimFile, "{}", { mode: 0o600 });
    fs.symlinkSync(victimFile, legacyFile);

    const credentials = await importCredentialsModule(home);
    expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(false);
    expect(fs.existsSync(legacyFile)).toBe(true);
    expect(fs.existsSync(victimFile)).toBe(true);
  });

  it("leaves a corrupt legacy file in place for inspection", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(legacyFile, "{not-json", { mode: 0o600 });

    const credentials = await importCredentialsModule(home);
    expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(false);
    expect(fs.existsSync(legacyFile)).toBe(true);
  });

  it("removes a 0-byte legacy file (CodeRabbit nit: whitespace-only doesn't throw)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(legacyFile, "", { mode: 0o600 });

    const credentials = await importCredentialsModule(home);
    expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(true);
    expect(fs.existsSync(legacyFile)).toBe(false);
  });

  it("removes a whitespace-only legacy file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(legacyFile, "   \n\t\r\n  ", { mode: 0o600 });

    const credentials = await importCredentialsModule(home);
    expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(true);
    expect(fs.existsSync(legacyFile)).toBe(false);
  });

  it("returns false when the secure unlink silently fails (CodeRabbit nit)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(legacyFile, "{}", { mode: 0o600 });

    // Simulate a swallowed unlink failure: secureUnlink internally calls
    // fs.unlinkSync with try/catch, so a no-op stub leaves the file intact.
    // The helper must detect this and return false rather than lying.
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => undefined);
    try {
      const credentials = await importCredentialsModule(home);
      expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(false);
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(legacyFile)).toBe(true);
  });

  it("zero-fills an empty file before unlinking (defence in depth)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credsDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(credsDir, "credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    const cleartext = "{}";
    fs.writeFileSync(legacyFile, cleartext, { mode: 0o600 });

    const originalUnlink = fs.unlinkSync;
    const captured: { bytes: Buffer | null } = { bytes: null };
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (typeof p === "string" && p === legacyFile && captured.bytes === null) {
        try {
          captured.bytes = fs.readFileSync(p);
        } catch {
          /* file already gone */
        }
      }
      return originalUnlink(p);
    });

    try {
      const credentials = await importCredentialsModule(home);
      expect(credentials.removeLegacyCredentialsFileIfEmpty()).toBe(true);
    } finally {
      spy.mockRestore();
    }

    const bytesAtUnlink = captured.bytes;
    expect(bytesAtUnlink).not.toBeNull();
    if (bytesAtUnlink !== null) {
      expect(bytesAtUnlink.length).toBe(Buffer.byteLength(cleartext));
      expect(bytesAtUnlink.every((b) => b === 0)).toBe(true);
    }
    expect(fs.existsSync(legacyFile)).toBe(false);
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

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status).toBe(0);
  });

  it("settles the outer prompt promise on secret prompt errors", () => {
    const script = `
const { prompt } = require(${JSON.stringify(path.join(import.meta.dirname, "..", "dist", "lib", "credentials", "store.js"))});
process.stdin.isTTY = true;
process.stderr.isTTY = true;
process.stdin.ref = () => process.stdin;
process.stdin.pause = () => process.stdin;
process.stdin.unref = () => process.stdin;
process.stdin.setRawMode = () => { throw new Error('raw mode unavailable'); };
prompt('secret: ', { secret: true })
  .then(() => { console.error('unexpected resolve'); process.exit(1); })
  .catch((err) => { console.log('REJECTED=' + err.message); });
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REJECTED=raw mode unavailable");
  });

  it("re-raises SIGINT from standard readline prompts instead of treating it like an empty answer", async () => {
    const readline = require("node:readline") as typeof import("node:readline");
    const rl = new EventEmitter() as EventEmitter & {
      close: ReturnType<typeof vi.fn>;
      question: ReturnType<typeof vi.fn>;
    };
    rl.close = vi.fn();
    rl.question = vi.fn();

    const createInterfaceSpy = vi.spyOn(readline, "createInterface").mockReturnValue(rl as any);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    const stdinRef = vi.spyOn(process.stdin, "ref").mockImplementation(() => process.stdin);
    const stdinPause = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    const stdinUnref = vi.spyOn(process.stdin, "unref").mockImplementation(() => process.stdin);

    try {
      const credentials = await import("../dist/lib/credentials/store.js");
      const pending = credentials.prompt("question: ");
      rl.emit("SIGINT");
      await expect(pending).rejects.toMatchObject({
        message: "Prompt interrupted",
        code: "SIGINT",
      });
      expect(rl.close).toHaveBeenCalled();
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    } finally {
      createInterfaceSpy.mockRestore();
      killSpy.mockRestore();
      stdinRef.mockRestore();
      stdinPause.mockRestore();
      stdinUnref.mockRestore();
    }
  });

  it("normalizes credential values and keeps prompting on invalid NVIDIA API key prefixes", async () => {
    const credentials = await importCredentialsModule("/tmp");
    expect(credentials.normalizeCredentialValue("  nvapi-good-key\r\n")).toBe("nvapi-good-key");

    const script = `
const { ensureApiKey } = require(${JSON.stringify(path.join(import.meta.dirname, "..", "dist", "lib", "credentials", "store.js"))});
delete process.env.NVIDIA_API_KEY;
ensureApiKey()
  .then(() => console.log('STAGED=' + process.env.NVIDIA_API_KEY))
  .catch((err) => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
`;
    const scriptFile = path.join(os.tmpdir(), `nemoclaw-ensure-api-key-${process.pid}.js`);
    fs.writeFileSync(scriptFile, script, { mode: 0o700 });
    const bash = `
set -euo pipefail
pipe="$(mktemp -u)"
mkfifo "$pipe"
trap 'rm -f "$pipe"' EXIT
{ printf 'not-a-key\\n'; sleep 0.2; printf 'nvapi-good-key\\n'; } > "$pipe" &
${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFile)} < "$pipe"
`;
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync("bash", ["--noprofile", "--norc", "-c", bash], {
        encoding: "utf-8",
        env: { ...process.env, NVIDIA_API_KEY: "" },
        timeout: 5000,
      });
    } finally {
      try {
        fs.unlinkSync(scriptFile);
      } catch {
        /* ignore */
      }
    }
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Invalid NVIDIA API key. Must start with nvapi-",
    );
    expect(result.stdout).toContain("STAGED=nvapi-good-key");
  });

  it("normal and secret prompts re-ref, cleanup stdin, and preserve masked input", () => {
    const script = `
const { prompt } = require(${JSON.stringify(path.join(import.meta.dirname, "..", "dist", "lib", "credentials", "store.js"))});
const counts = { ref: 0, resume: 0, pause: 0, unref: 0, raw: [] };
process.stdin.ref = () => { counts.ref += 1; return process.stdin; };
process.stdin.resume = () => { counts.resume += 1; return process.stdin; };
process.stdin.pause = () => { counts.pause += 1; return process.stdin; };
process.stdin.unref = () => { counts.unref += 1; return process.stdin; };
process.stdin.setRawMode = (value) => { counts.raw.push(value); return process.stdin; };
process.stdin.isTTY = true;
process.stderr.isTTY = true;
(async () => {
  const normalPrompt = prompt('normal: ');
  setImmediate(() => process.stdin.emit('data', 'alpha\\n'));
  const normal = await normalPrompt;
  const secretPrompt = prompt('secret: ', { secret: true });
  setImmediate(() => process.stdin.emit('data', 'bravo\\n'));
  const secret = await secretPrompt;
  console.log(JSON.stringify({ normal, secret, counts }));
})().catch((err) => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
`;
    const scriptFile = path.join(os.tmpdir(), `nemoclaw-credential-prompt-${process.pid}.js`);
    fs.writeFileSync(scriptFile, script, { mode: 0o700 });
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(process.execPath, [scriptFile], {
        encoding: "utf-8",
        timeout: 5000,
      });
    } finally {
      try {
        fs.unlinkSync(scriptFile);
      } catch {
        /* ignore */
      }
    }

    expect(result.status).toBe(0);
    const parsed = JSON.parse(String(result.stdout).trim());
    expect(parsed.normal).toBe("alpha");
    expect(parsed.secret).toBe("bravo");
    expect(parsed.counts.ref).toBeGreaterThanOrEqual(2);
    expect(parsed.counts.pause).toBeGreaterThanOrEqual(2);
    expect(parsed.counts.unref).toBeGreaterThanOrEqual(2);
    expect(parsed.counts.raw).toContain(true);
    expect(parsed.counts.raw.at(-1)).toBe(false);
    expect(result.stderr).toContain("*****");
    expect(result.stderr).not.toContain("bravo");
  });
});
