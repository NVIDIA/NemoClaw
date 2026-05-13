// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withLocalNoProxy } from "../../dist/lib/subprocess-env";

describe("withLocalNoProxy", () => {
  it("does nothing when no proxy vars are present", () => {
    const env: Record<string, string> = { PATH: "/usr/bin" };
    withLocalNoProxy(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("adds local host-bound names to NO_PROXY and no_proxy when HTTP_PROXY is set and NO_PROXY is absent", () => {
    const env: Record<string, string> = { HTTP_PROXY: "http://proxy:8888" };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,host.docker.internal");
    expect(env.no_proxy).toBe("localhost,127.0.0.1,host.docker.internal");
  });

  it("adds local host-bound names when HTTPS_PROXY is set", () => {
    const env: Record<string, string> = { HTTPS_PROXY: "http://proxy:8888" };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,host.docker.internal");
    expect(env.no_proxy).toBe("localhost,127.0.0.1,host.docker.internal");
  });

  it("adds local host-bound names when lowercase http_proxy is set", () => {
    const env: Record<string, string> = { http_proxy: "http://proxy:8888" };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,host.docker.internal");
    expect(env.no_proxy).toBe("localhost,127.0.0.1,host.docker.internal");
  });

  it("appends only the missing local entries when NO_PROXY already has localhost", () => {
    const env: Record<string, string> = {
      HTTP_PROXY: "http://proxy:8888",
      NO_PROXY: "example.com,localhost",
      no_proxy: "example.com,localhost",
    };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe("example.com,localhost,127.0.0.1,host.docker.internal");
    expect(env.no_proxy).toBe("example.com,localhost,127.0.0.1,host.docker.internal");
  });

  it("does not duplicate entries when all local hosts are already present", () => {
    const env: Record<string, string> = {
      HTTP_PROXY: "http://proxy:8888",
      NO_PROXY: "localhost,127.0.0.1,host.docker.internal,corp.internal",
      no_proxy: "localhost,127.0.0.1,host.docker.internal,corp.internal",
    };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,host.docker.internal,corp.internal");
    expect(env.no_proxy).toBe("localhost,127.0.0.1,host.docker.internal,corp.internal");
  });

  it("preserves existing NO_PROXY entries and adds local hosts", () => {
    const env: Record<string, string> = {
      HTTP_PROXY: "http://proxy:8888",
      NO_PROXY: "corp.internal,.nvidia.com",
      no_proxy: "corp.internal,.nvidia.com",
    };
    withLocalNoProxy(env);
    expect(env.NO_PROXY).toBe("corp.internal,.nvidia.com,localhost,127.0.0.1,host.docker.internal");
    expect(env.no_proxy).toBe("corp.internal,.nvidia.com,localhost,127.0.0.1,host.docker.internal");
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
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,host.docker.internal");
    expect(env.no_proxy).toBe("localhost,127.0.0.1,host.docker.internal");
  });

  it("augments an existing NO_PROXY to add local hosts", async () => {
    process.env.HTTP_PROXY = "http://proxy.example.com:8888";
    process.env.NO_PROXY = "corp.internal";
    process.env.no_proxy = "corp.internal";

    const { buildSubprocessEnv } = await import("../../dist/lib/subprocess-env");
    const env = buildSubprocessEnv();
    expect(env.NO_PROXY).toBe("corp.internal,localhost,127.0.0.1,host.docker.internal");
    expect(env.no_proxy).toBe("corp.internal,localhost,127.0.0.1,host.docker.internal");
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
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,host.docker.internal");
  });
});
