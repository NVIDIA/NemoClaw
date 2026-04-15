// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import credentialsModule from "../bin/lib/credentials.js";

describe("credentials", () => {
  let tmpDir;
  let origHome;
  let creds;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cred-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    creds = credentialsModule;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MY_KEY;
  });

  describe("loadCredentials", () => {
    it("returns empty object when no file exists", () => {
      const result = creds.loadCredentials();
      expect(result).toEqual({});
    });

    it("returns empty object for corrupt file", () => {
      const dir = path.join(tmpDir, ".nemoclaw");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "credentials.json"), "not json");
      const result = creds.loadCredentials();
      expect(result).toEqual({});
    });
  });

  describe("saveCredential + getCredential", () => {
    it("saves and retrieves a credential", () => {
      creds.saveCredential("TEST_KEY", "test-value");
      const result = creds.getCredential("TEST_KEY");
      expect(result).toBe("test-value");
    });

    it("creates directory with restricted permissions", () => {
      creds.saveCredential("KEY", "val");
      const dir = path.join(tmpDir, ".nemoclaw");
      const file = path.join(dir, "credentials.json");
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it("overwrites existing credential", () => {
      creds.saveCredential("KEY", "v1");
      creds.saveCredential("KEY", "v2");
      expect(creds.getCredential("KEY")).toBe("v2");
    });

    it("preserves other credentials when adding new one", () => {
      creds.saveCredential("A", "1");
      creds.saveCredential("B", "2");
      expect(creds.getCredential("A")).toBe("1");
      expect(creds.getCredential("B")).toBe("2");
    });
  });

  describe("getCredential", () => {
    it("prefers environment variable over stored credential", () => {
      creds.saveCredential("MY_KEY", "stored");
      process.env.MY_KEY = "from-env";
      const result = creds.getCredential("MY_KEY");
      expect(result).toBe("from-env");
      delete process.env.MY_KEY;
    });

    it("returns null for missing credential", () => {
      expect(creds.getCredential("NONEXISTENT_KEY_12345")).toBe(null);
    });
  });
});
