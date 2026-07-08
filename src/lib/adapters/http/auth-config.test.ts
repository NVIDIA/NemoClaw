// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createBearerAuthConfig,
  createCurlAuthConfig,
  createOpenAiLikeAuthConfig,
  createQueryParamAuthConfig,
  createXApiKeyAuthConfig,
} from "./auth-config";

describe("curl auth config helper", () => {
  it("returns an empty config when no entries are provided", () => {
    const config = createCurlAuthConfig([]);
    expect(config.args).toEqual([]);
    expect(config.trustedConfigFiles).toEqual([]);
    expect(() => config.cleanup()).not.toThrow();
  });

  it("writes a 0600 curl config tmpfile with a header entry and removes it on cleanup", () => {
    const config = createBearerAuthConfig("nvapi-test-1234");
    const configPath = config.args[1];
    try {
      expect(config.args[0]).toBe("--config");
      expect(typeof configPath).toBe("string");
      // Single readFileSync — readFileSync throws ENOENT synchronously if
      // the file is missing, which is what we want anyway, and avoids the
      // "check then use" race CodeQL flagged in PR #5975 review.
      const contents = fs.readFileSync(configPath, "utf8");
      const stat = fs.statSync(configPath);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(contents).toContain('header = "Authorization: Bearer nvapi-test-1234"');
      expect(config.trustedConfigFiles).toContain(configPath);
    } finally {
      config.cleanup();
    }
    expect(() => fs.statSync(configPath)).toThrow(/ENOENT/);
  });

  it("writes a url-query entry instead of a header for query-param auth", () => {
    const config = createQueryParamAuthConfig("key", "AIzaFakeKey123");
    try {
      const contents = fs.readFileSync(config.args[1], "utf8");
      expect(contents).toContain('url-query = "key=AIzaFakeKey123"');
    } finally {
      config.cleanup();
    }
  });

  it("escapes embedded quotes, backslashes, and newlines in entry values", () => {
    const config = createCurlAuthConfig([
      { kind: "header", value: 'Authorization: Bearer evil"\\\nvalue' },
    ]);
    try {
      const contents = fs.readFileSync(config.args[1], "utf8");
      expect(contents).toContain('header = "Authorization: Bearer evil\\"\\\\ value"');
      expect(contents).not.toContain("\nvalue");
    } finally {
      config.cleanup();
    }
  });

  it("emits an x-api-key header entry for Anthropic-style auth", () => {
    const config = createXApiKeyAuthConfig("sk-ant-secret");
    try {
      const contents = fs.readFileSync(config.args[1], "utf8");
      expect(contents).toContain('header = "x-api-key: sk-ant-secret"');
    } finally {
      config.cleanup();
    }
  });

  it("routes the OpenAI-like helper through Bearer auth by default and emits no url-query entry", () => {
    const config = createOpenAiLikeAuthConfig("sk-test");
    try {
      const contents = fs.readFileSync(config.args[1], "utf8");
      expect(contents).toContain('header = "Authorization: Bearer sk-test"');
      expect(contents).not.toContain("url-query =");
    } finally {
      config.cleanup();
    }
  });

  it("routes the OpenAI-like helper through query-param auth when requested and emits no Authorization header", () => {
    const config = createOpenAiLikeAuthConfig("AIzaFakeKey123", "query-param");
    try {
      const contents = fs.readFileSync(config.args[1], "utf8");
      expect(contents).toContain('url-query = "key=AIzaFakeKey123"');
      expect(contents).not.toContain('header = "Authorization');
    } finally {
      config.cleanup();
    }
  });

  it("honours a caller-supplied tmpfile prefix so health probes are identifiable in /proc", () => {
    const config = createBearerAuthConfig("nvapi-test", { prefix: "nemoclaw-kimi-health-curl" });
    try {
      expect(config.args[1]).toContain("nemoclaw-kimi-health-curl-");
    } finally {
      config.cleanup();
    }
  });

  it("rejects an invalid prefix value to keep tmpfile paths predictable", () => {
    expect(() => createBearerAuthConfig("nvapi-test", { prefix: "../escape" })).toThrow(
      /invalid curl auth config prefix/,
    );
    expect(() => createBearerAuthConfig("nvapi-test", { prefix: "" })).toThrow(
      /invalid curl auth config prefix/,
    );
  });

  it("rethrows when the tmpdir cannot be created and leaves no config behind", () => {
    const spy = vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
      throw new Error("mkdtemp failed");
    });
    try {
      expect(() => createBearerAuthConfig("nvapi-test")).toThrow(/mkdtemp failed/);
    } finally {
      spy.mockRestore();
    }
  });

  it("removes the tmpdir and rethrows when chmod fails", () => {
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("chmod failed");
    });
    try {
      expect(() => createBearerAuthConfig("nvapi-test")).toThrow(/chmod failed/);
      const created = mkdtempSpy.mock.results[0]?.value as string;
      expect(created).toBeTruthy();
      expect(() => fs.statSync(created)).toThrow(/ENOENT/);
    } finally {
      chmodSpy.mockRestore();
      mkdtempSpy.mockRestore();
    }
  });

  it("removes the tmpdir and rethrows when writing the config file fails", () => {
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("write failed");
    });
    try {
      expect(() => createBearerAuthConfig("nvapi-test")).toThrow(/write failed/);
      const created = mkdtempSpy.mock.results[0]?.value as string;
      expect(created).toBeTruthy();
      expect(() => fs.statSync(created)).toThrow(/ENOENT/);
    } finally {
      writeSpy.mockRestore();
      mkdtempSpy.mockRestore();
    }
  });
});
