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
    typeof Reflect.get(value, "stageLegacyCredentialsToEnv") === "function" &&
    typeof Reflect.get(value, "removeLegacyCredentialsFile") === "function"
  );
}

// Pull the credential-env-key allowlist from the production module so
// future additions only need to be made in one place. Plus a few
// fixture-only names this suite mutates directly.
import { KNOWN_CREDENTIAL_ENV_KEYS } from "../dist/lib/credentials.js";
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
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ NVIDIA_API_KEY: `nvapi-${filler}` }),
      { mode: 0o600 },
    );

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
    fs.writeFileSync(
      realFile,
      JSON.stringify({ NVIDIA_API_KEY: "nvapi-attacker-controlled" }),
    );
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
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ NVIDIA_API_KEY: "nvapi-survives-crash" }),
      { mode: 0o600 },
    );

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

  it("releases stdin after a prompt resolves so the event loop drains on a TTY", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "credentials.ts"),
      "utf-8",
    );

    // The previous TTY-only guard kept the event loop pinned on interactive
    // runs — the wizard would not exit after its last prompt.
    expect(source).not.toMatch(/cleanup\s*\(\s*\)\s*\{\s*rl\.close\(\);\s*if\s*\(\s*!process\.stdin\.isTTY\s*\)/);
    expect(source).toMatch(
      /function cleanup\(\)\s*\{\s*rl\.close\(\);[\s\S]*?process\.stdin\.pause\(\)[\s\S]*?process\.stdin\.unref\(\)/,
    );
  });

  it("re-refs stdin before each prompt so a follow-up prompt is not stranded by a sticky unref()", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "credentials.ts"),
      "utf-8",
    );

    // unref() is sticky — readline.createInterface() will not re-ref by
    // itself, so a sequential prompt after the first cleanup would see a
    // detached stdin handle and the process could exit before the user
    // can answer. The matching ref() at the top of `prompt()` undoes that.
    expect(source).toMatch(
      /process\.stdin\.ref\(\)[\s\S]*?readline\.createInterface\(\{\s*input:\s*process\.stdin/,
    );
  });

  it("re-refs stdin even on the secret-prompt branch so a follow-up secret read is not stranded", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "credentials.ts"),
      "utf-8",
    );

    // The ref() must come before the silent/secret branch so that a
    // sequence of `prompt()` -> `prompt({ secret: true })` after a normal
    // prompt's sticky unref() still has a ref'd handle for promptSecret().
    const refIdx = source.search(/process\.stdin\.ref\(\);/);
    const silentIdx = source.search(/const silent = opts\.secret === true/);
    expect(refIdx).toBeGreaterThan(0);
    expect(silentIdx).toBeGreaterThan(0);
    expect(refIdx).toBeLessThan(silentIdx);
  });

  it("releases stdin in promptSecret() cleanup so a wizard ending on a secret prompt exits naturally", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "credentials.ts"),
      "utf-8",
    );

    // The secret reader uses raw mode + a `data` listener instead of
    // readline. Its cleanup must still pause+unref or the wizard hangs the
    // same way the readline path did.
    expect(source).toMatch(
      /promptSecret[\s\S]*?function cleanup\(\)\s*\{[\s\S]*?input\.pause\(\)[\s\S]*?input\.unref\(\)/,
    );
  });

  it("re-refs stdin at the top of promptSecret() so a direct caller is self-contained", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "credentials.ts"),
      "utf-8",
    );

    // promptSecret() is exported and used directly elsewhere. Because its
    // own cleanup unref()s stdin, two sequential direct calls (or any call
    // after a prior unref) would strand the second read without an entry
    // ref(). Assert ref() is the first effectful call inside the body.
    expect(source).toMatch(
      /export function promptSecret[\s\S]*?const input = process\.stdin;[\s\S]{0,400}?input\.ref\(\);[\s\S]*?function cleanup/,
    );
  });

});
