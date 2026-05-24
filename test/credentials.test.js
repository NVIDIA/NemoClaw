// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import credentialsModule from "../bin/lib/credentials.js";

const credentials = credentialsModule;
const TRACKED_ENV_KEYS = [...credentials.KNOWN_CREDENTIAL_ENV_KEYS, "TEST_KEY"];

function clearTrackedEnv() {
  for (const key of TRACKED_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("credentials shim", () => {
  let tmpDir;
  let origHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cred-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    clearTrackedEnv();
  });

  afterEach(() => {
    clearTrackedEnv();
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exposes HOME-relative legacy paths without creating files", () => {
    const dir = path.join(tmpDir, ".nemoclaw");
    const file = path.join(dir, "credentials.json");

    expect(Reflect.get(credentials, "CREDS_DIR")).toBe(dir);
    expect(Reflect.get(credentials, "CREDS_FILE")).toBe(file);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("stages and lists allowlisted credentials from process.env only", () => {
    credentials.saveCredential("NVIDIA_API_KEY", "  nvapi-js-shim \r\n");
    credentials.saveCredential("TEST_KEY", "fixture-only");

    expect(credentials.getCredential("NVIDIA_API_KEY")).toBe("nvapi-js-shim");
    expect(credentials.getCredential("TEST_KEY")).toBe("fixture-only");
    expect(credentials.loadCredentials()).toEqual({ NVIDIA_API_KEY: "nvapi-js-shim" });
    expect(credentials.listCredentialKeys()).toEqual(["NVIDIA_API_KEY"]);
  });

  it("clears blank values instead of persisting them", () => {
    credentials.saveCredential("OPENAI_API_KEY", "sk-js-shim");
    expect(credentials.getCredential("OPENAI_API_KEY")).toBe("sk-js-shim");

    credentials.saveCredential("OPENAI_API_KEY", " \r\n ");
    expect(credentials.getCredential("OPENAI_API_KEY")).toBe(null);
    expect(credentials.loadCredentials()).toEqual({});
  });

  it("does not read from or write to the legacy credentials file", () => {
    const dir = path.join(tmpDir, ".nemoclaw");
    const file = path.join(dir, "credentials.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ NVIDIA_API_KEY: "nvapi-from-disk" }), { mode: 0o600 });

    expect(credentials.getCredential("NVIDIA_API_KEY")).toBe(null);
    expect(credentials.loadCredentials()).toEqual({});

    credentials.saveCredential("NVIDIA_API_KEY", "nvapi-from-env");
    expect(fs.readFileSync(file, "utf8")).toBe(
      JSON.stringify({ NVIDIA_API_KEY: "nvapi-from-disk" }),
    );
    expect(credentials.getCredential("NVIDIA_API_KEY")).toBe("nvapi-from-env");
  });
});
