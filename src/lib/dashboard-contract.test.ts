// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { buildChain, buildControlUiUrls } from "../../dist/lib/dashboard-contract.js";

describe("buildChain", () => {
  it("returns default loopback chain with no arguments", () => {
    const c = buildChain();
    expect(c).toMatchObject({
      accessUrl: "http://127.0.0.1:18789", forwardTarget: "18789",
      healthEndpoint: "/health", port: 18789, bindAddress: "127.0.0.1",
    });
    expect(c.corsOrigins).toEqual(["http://127.0.0.1:18789"]);
  });

  it("preserves custom port from loopback URL", () => {
    const c = buildChain({ chatUiUrl: "http://127.0.0.1:19000" });
    expect(c.port).toBe(19000);
    expect(c.forwardTarget).toBe("19000");
  });

  it("binds to 0.0.0.0 for non-loopback URL and includes both CORS origins", () => {
    const c = buildChain({ chatUiUrl: "https://my-brev-host.example.com:18789" });
    expect(c.forwardTarget).toBe("0.0.0.0:18789");
    expect(c.bindAddress).toBe("0.0.0.0");
    expect(c.corsOrigins[0]).toBe("http://127.0.0.1:18789");
    expect(c.corsOrigins).toContain("https://my-brev-host.example.com:18789");
  });

  it("uses WSL host address and binds to 0.0.0.0", () => {
    const c = buildChain({ isWsl: true, wslHostAddress: "172.24.240.1" });
    expect(c.forwardTarget).toBe("0.0.0.0:18789");
    expect(c.accessUrl).toBe("http://172.24.240.1:18789");
    expect(c.corsOrigins).toContain("http://172.24.240.1:18789");
  });

  it("respects explicit port override", () => {
    expect(buildChain({ port: 19000 }).port).toBe(19000);
  });

  it("treats empty/invalid chatUiUrl as default without throwing", () => {
    expect(buildChain({ chatUiUrl: "" }).port).toBe(18789);
    expect(buildChain({ chatUiUrl: "not-a-url" }).port).toBe(18789);
  });

  it("returns port-only forward for IPv6 and localhost", () => {
    expect(buildChain({ chatUiUrl: "http://[::1]:18789" }).forwardTarget).toBe("18789");
    expect(buildChain({ chatUiUrl: "http://localhost:18789" }).forwardTarget).toBe("18789");
  });

  it("canonicalizes schemeless non-loopback URLs", () => {
    const c = buildChain({ chatUiUrl: "remote-host:18789" });
    expect(c.accessUrl).toBe("http://remote-host:18789");
    expect(c.forwardTarget).toBe("0.0.0.0:18789");
  });
});

describe("buildControlUiUrls", () => {
  it("builds URL with encoded token hash", () => {
    expect(buildControlUiUrls("my-token")).toEqual(["http://127.0.0.1:18789/#token=my-token"]);
  });

  it("builds URL without token", () => {
    expect(buildControlUiUrls(null)).toEqual(["http://127.0.0.1:18789/"]);
  });

  it("includes non-loopback chatUiUrl as second entry", () => {
    const urls = buildControlUiUrls("tok", 18789, "https://my-dashboard.example.com");
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("my-dashboard.example.com");
  });

  it("deduplicates and ignores non-http/empty chatUiUrl", () => {
    expect(buildControlUiUrls(null, 18789, "http://127.0.0.1:18789")).toHaveLength(1);
    expect(buildControlUiUrls("tok", 18789, "ftp://x.com")).toHaveLength(1);
    expect(buildControlUiUrls("tok", 18789, "  ")).toHaveLength(1);
  });

  it("uses configured port", () => {
    expect(buildControlUiUrls("t", 19000)).toEqual(["http://127.0.0.1:19000/#token=t"]);
  });

  it("encodes special characters in tokens", () => {
    const urls = buildControlUiUrls("a=b&c");
    expect(urls[0]).toContain("#token=a%3Db%26c");
  });
});
