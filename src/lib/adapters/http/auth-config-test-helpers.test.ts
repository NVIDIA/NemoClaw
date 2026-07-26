// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  captureAuthConfigPath,
  expectTrustedConfig,
  readAuthConfigContents,
} from "./auth-config-test-helpers";

describe("captureAuthConfigPath", () => {
  it("returns the path following --config", () => {
    expect(captureAuthConfigPath(["-sS", "--config", "/tmp/auth.conf", "https://x"])).toBe(
      "/tmp/auth.conf",
    );
  });

  it("throws when --config is absent", () => {
    expect(() => captureAuthConfigPath(["-sS", "https://x"])).toThrow();
  });

  it("throws when --config is the last argument with no path value", () => {
    expect(() => captureAuthConfigPath(["-sS", "--config"])).toThrow();
  });

  it("throws when the config path is not a string", () => {
    expect(() =>
      captureAuthConfigPath(["--config", 42 as unknown as string, "https://x"]),
    ).toThrow();
  });
});

describe("readAuthConfigContents", () => {
  it("reads the config body and asserts the 0600 file mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-helper-test-"));
    const configPath = path.join(dir, "auth.conf");
    fs.writeFileSync(configPath, 'header = "Authorization: Bearer sk-test"\n', { mode: 0o600 });
    const argv = ["-sS", "--config", configPath, "https://example.test"];
    expect(readAuthConfigContents(argv)).toContain("Authorization: Bearer sk-test");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws ENOENT when the config file is missing", () => {
    const missing = path.join(os.tmpdir(), "nemoclaw-auth-helper-absent.conf");
    expect(() => readAuthConfigContents(["--config", missing, "https://x"])).toThrow(/ENOENT/);
  });
});

describe("expectTrustedConfig", () => {
  it("passes when trustedConfigFiles contains the config path", () => {
    const argv = ["--config", "/tmp/trusted.conf", "https://x"];
    expect(() =>
      expectTrustedConfig(argv, { trustedConfigFiles: ["/tmp/trusted.conf"] }),
    ).not.toThrow();
  });

  it("throws when trustedConfigFiles omits the config path", () => {
    const argv = ["--config", "/tmp/trusted.conf", "https://x"];
    expect(() => expectTrustedConfig(argv, { trustedConfigFiles: [] })).toThrow();
  });

  it("throws when the options bag is undefined", () => {
    const argv = ["--config", "/tmp/trusted.conf", "https://x"];
    expect(() => expectTrustedConfig(argv, undefined)).toThrow();
  });
});
