// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withLocalNoProxy } from "../../dist/lib/subprocess-env";

const LOCAL_NO_PROXY =
  "localhost,127.0.0.1,host.docker.internal,host.containers.internal,::1,0.0.0.0,inference.local";

describe("withLocalNoProxy", () => {
  it("does nothing when no proxy vars are present", () => {
    const env: Record<string, string> = { PATH: "/usr/bin" };
    withLocalNoProxy(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("adds local host-bound names to NO_PROXY and no_proxy when HTTP_PROXY is set and NO_PROXY is absent", () => {
    const env: Record<string, string> = { HTTP_PROXY: "http://proxy:8888" };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe(LOCAL_NO_PROXY);
    expect(env.no_proxy).toBe(LOCAL_NO_PROXY);
  });

  it("adds local host-bound names when HTTPS_PROXY is set", () => {
    const env: Record<string, string> = { HTTPS_PROXY: "http://proxy:8888" };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe(LOCAL_NO_PROXY);
    expect(env.no_proxy).toBe(LOCAL_NO_PROXY);
  });

  it("adds local host-bound names when lowercase http_proxy is set", () => {
    const env: Record<string, string> = { http_proxy: "http://proxy:8888" };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe(LOCAL_NO_PROXY);
    expect(env.no_proxy).toBe(LOCAL_NO_PROXY);
  });

  it("adds local host-bound names when lowercase https_proxy is set", () => {
    const env: Record<string, string> = { https_proxy: "http://proxy:8888" };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe(LOCAL_NO_PROXY);
    expect(env.no_proxy).toBe(LOCAL_NO_PROXY);
  });

  it("strips empty segments from a NO_PROXY with doubled or trailing commas", () => {
    const env: Record<string, string> = {
      HTTP_PROXY: "http://proxy:8888",
      NO_PROXY: "corp.internal,,other.com,",
      no_proxy: "corp.internal,,other.com,",
    };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).not.toContain(",,");
    expect(env.NO_PROXY).not.toMatch(/^,|,$/);
    expect(env.NO_PROXY).toContain("corp.internal");
    expect(env.NO_PROXY).toContain("other.com");
    expect(env.NO_PROXY).toContain("localhost");
  });

  it("appends only the missing local entries when NO_PROXY already has localhost", () => {
    const env: Record<string, string> = {
      HTTP_PROXY: "http://proxy:8888",
      NO_PROXY: "example.com,localhost",
      no_proxy: "example.com,localhost",
    };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe(
      "example.com,localhost,127.0.0.1,host.docker.internal,host.containers.internal,::1,0.0.0.0,inference.local",
    );
    expect(env.no_proxy).toBe(
      "example.com,localhost,127.0.0.1,host.docker.internal,host.containers.internal,::1,0.0.0.0,inference.local",
    );
  });

  it("does not duplicate entries when all local hosts are already present", () => {
    const env: Record<string, string> = {
      HTTP_PROXY: "http://proxy:8888",
      NO_PROXY: `${LOCAL_NO_PROXY},corp.internal`,
      no_proxy: `${LOCAL_NO_PROXY},corp.internal`,
    };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe(`${LOCAL_NO_PROXY},corp.internal`);
    expect(env.no_proxy).toBe(`${LOCAL_NO_PROXY},corp.internal`);
  });

  it("preserves existing NO_PROXY entries and adds local hosts", () => {
    const env: Record<string, string> = {
      HTTP_PROXY: "http://proxy:8888",
      NO_PROXY: "corp.internal,.nvidia.com",
      no_proxy: "corp.internal,.nvidia.com",
    };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe(`corp.internal,.nvidia.com,${LOCAL_NO_PROXY}`);
    expect(env.no_proxy).toBe(`corp.internal,.nvidia.com,${LOCAL_NO_PROXY}`);
  });

  it("bypasses the host proxy for the managed inference hostname when HTTP_PROXY is set", () => {
    const env: Record<string, string> = { HTTP_PROXY: "http://127.0.0.1:8118" };
    withLocalNoProxy(env);
    expect(env.NO_PROXY?.split(",")).toContain("inference.local");
    expect(env.no_proxy?.split(",")).toContain("inference.local");
  });

  it("bypasses the host proxy for the rootless container host alias when HTTPS_PROXY is set", () => {
    const env: Record<string, string> = { HTTPS_PROXY: "http://127.0.0.1:8118" };
    withLocalNoProxy(env);
    expect(env.NO_PROXY?.split(",")).toContain("host.containers.internal");
    expect(env.no_proxy?.split(",")).toContain("host.containers.internal");
  });

  it("does not inject a broad .local suffix or arbitrary *.local hostnames", () => {
    const env: Record<string, string> = { HTTP_PROXY: "http://127.0.0.1:8118" };
    withLocalNoProxy(env);
    for (const key of ["NO_PROXY", "no_proxy"] as const) {
      const parts = (env[key] ?? "").split(",");
      expect(parts).not.toContain(".local");
      expect(parts).not.toContain("*.local");
      expect(parts).not.toContain("evil.local");
      expect(parts).not.toContain("attacker.local");
      expect(parts.filter((p) => p.endsWith(".local"))).toEqual(["inference.local"]);
    }
  });

  it("preserves a caller-provided .local entry without expanding the bypass", () => {
    const env: Record<string, string> = {
      HTTP_PROXY: "http://127.0.0.1:8118",
      NO_PROXY: "trusted.local",
      no_proxy: "trusted.local",
    };
    withLocalNoProxy(env);
    for (const key of ["NO_PROXY", "no_proxy"] as const) {
      const parts = (env[key] ?? "").split(",");
      expect(parts).toContain("trusted.local");
      expect(parts).toContain("inference.local");
      expect(parts).not.toContain(".local");
      expect(parts).not.toContain("*.local");
    }
  });
});

describe("buildSubprocessEnv NO_PROXY injection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("injects local host-bound names when HTTP_PROXY is set and NO_PROXY is absent", async () => {
    process.env.HTTP_PROXY = "http://proxy.example.com:8888";
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    const { buildSubprocessEnv } = await import("../../dist/lib/subprocess-env");
    const env = buildSubprocessEnv();
    expect(env.NO_PROXY).toBe(LOCAL_NO_PROXY);
    expect(env.no_proxy).toBe(LOCAL_NO_PROXY);
  });

  it("augments an existing NO_PROXY to add local hosts", async () => {
    process.env.HTTP_PROXY = "http://proxy.example.com:8888";
    process.env.NO_PROXY = "corp.internal";
    process.env.no_proxy = "corp.internal";

    const { buildSubprocessEnv } = await import("../../dist/lib/subprocess-env");
    const env = buildSubprocessEnv();
    expect(env.NO_PROXY).toBe(`corp.internal,${LOCAL_NO_PROXY}`);
    expect(env.no_proxy).toBe(`corp.internal,${LOCAL_NO_PROXY}`);
  });

  it("does not add NO_PROXY when no proxy is set", async () => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    const { buildSubprocessEnv } = await import("../../dist/lib/subprocess-env");
    const env = buildSubprocessEnv();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });

  it("extra vars passed to buildSubprocessEnv override env vars before NO_PROXY injection", async () => {
    process.env.HTTP_PROXY = "http://proxy.example.com:8888";
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    const { buildSubprocessEnv } = await import("../../dist/lib/subprocess-env");
    const env = buildSubprocessEnv({ MY_TOKEN: "abc123" });
    expect(env.MY_TOKEN).toBe("abc123");
    expect(env.NO_PROXY).toBe(LOCAL_NO_PROXY);
  });
});
