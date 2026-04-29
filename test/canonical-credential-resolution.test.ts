// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parametric tests for resolveProviderCredential() — the canonical entry
 * point for provider credential resolution.  Ensures all 6 remote providers
 * resolve credentials identically through the single canonical function.
 *
 * See #2306.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type CredentialsModule = typeof import("../dist/lib/credentials.js");

const tmpFixtures: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const dir of tmpFixtures.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

async function importCredentialsModule(home: string): Promise<CredentialsModule> {
  vi.resetModules();
  vi.doUnmock("fs");
  vi.doUnmock("child_process");
  vi.doUnmock("readline");
  vi.stubEnv("HOME", home);
  const module = await import("../dist/lib/credentials.js");
  const loaded = "default" in module ? module.default : module;
  return loaded as CredentialsModule;
}

function createFixtureHome(credentialEnv: string, credentialValue: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2306-resolve-"));
  tmpFixtures.push(tmpDir);
  const nemoclawDir = path.join(tmpDir, ".nemoclaw");
  fs.mkdirSync(nemoclawDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(nemoclawDir, "credentials.json"),
    JSON.stringify({ [credentialEnv]: credentialValue }),
    { mode: 0o600 },
  );
  return tmpDir;
}

describe("resolveProviderCredential — canonical credential resolution (#2306)", () => {
  it("is exported from credentials module", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2306-export-"));
    tmpFixtures.push(tmpDir);
    const credentials = await importCredentialsModule(tmpDir);
    expect(typeof credentials.resolveProviderCredential).toBe("function");
  });

  // Parametric: all 6 remote providers
  const providers = [
    { name: "NVIDIA Endpoints", credentialEnv: "NVIDIA_API_KEY", value: "nvapi-test-resolve" },
    { name: "OpenAI", credentialEnv: "OPENAI_API_KEY", value: "sk-test-resolve" },
    { name: "Anthropic", credentialEnv: "ANTHROPIC_API_KEY", value: "sk-ant-test-resolve" },
    { name: "Google Gemini", credentialEnv: "GEMINI_API_KEY", value: "gemini-test-resolve" },
    {
      name: "Custom OpenAI-compatible",
      credentialEnv: "COMPATIBLE_API_KEY",
      value: "compat-test-resolve",
    },
    {
      name: "Custom Anthropic-compatible",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      value: "compat-ant-test-resolve",
    },
  ];

  for (const { name, credentialEnv, value } of providers) {
    it(`resolves ${credentialEnv} (${name}) from credentials.json when not in env`, async () => {
      const tmpDir = createFixtureHome(credentialEnv, value);
      // Ensure env does NOT have the key
      vi.stubEnv(credentialEnv, "");
      delete process.env[credentialEnv];

      const credentials = await importCredentialsModule(tmpDir);
      const result = credentials.resolveProviderCredential(credentialEnv);

      expect(result).toBe(value);
      expect(process.env[credentialEnv]).toBe(value);
    });
  }

  it("returns env value when only in process.env", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2306-envonly-"));
    tmpFixtures.push(tmpDir);
    vi.stubEnv("TEST_RESOLVE_KEY", "from-env");

    const credentials = await importCredentialsModule(tmpDir);
    const result = credentials.resolveProviderCredential("TEST_RESOLVE_KEY");

    expect(result).toBe("from-env");
  });

  it("prefers env over credentials.json", async () => {
    const tmpDir = createFixtureHome("TEST_BOTH_KEY", "from-file");
    vi.stubEnv("TEST_BOTH_KEY", "from-env");

    const credentials = await importCredentialsModule(tmpDir);
    const result = credentials.resolveProviderCredential("TEST_BOTH_KEY");

    expect(result).toBe("from-env");
  });

  it("returns null when credential exists nowhere", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2306-missing-"));
    tmpFixtures.push(tmpDir);
    delete process.env["NONEXISTENT_KEY"];

    const credentials = await importCredentialsModule(tmpDir);
    const result = credentials.resolveProviderCredential("NONEXISTENT_KEY");

    expect(result).toBeNull();
    expect(process.env["NONEXISTENT_KEY"]).toBeUndefined();
  });

  it("normalizes whitespace and carriage returns", async () => {
    const tmpDir = createFixtureHome("TEST_WHITESPACE_KEY", "  nvapi-key \r\n");

    const credentials = await importCredentialsModule(tmpDir);
    delete process.env["TEST_WHITESPACE_KEY"];
    const result = credentials.resolveProviderCredential("TEST_WHITESPACE_KEY");

    expect(result).toBe("nvapi-key");
    expect(process.env["TEST_WHITESPACE_KEY"]).toBe("nvapi-key");
  });

  it("does not pollute process.env on null resolve", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2306-nopollute-"));
    tmpFixtures.push(tmpDir);
    delete process.env["ABSENT_KEY"];

    const credentials = await importCredentialsModule(tmpDir);
    credentials.resolveProviderCredential("ABSENT_KEY");

    expect(process.env["ABSENT_KEY"]).toBeUndefined();
  });
});
