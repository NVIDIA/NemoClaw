// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { startTestProgress } from "../fixtures/progress.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import {
  nativeLocalUlaOnlyResolution,
  isWslDockerIpv6TestHost,
  nativeLocalIpv6ResolutionCommand,
  nativeLocalIpv6DeniedCommand,
} from "../fixtures/native-local-ipv6-evidence.ts";

describe("native local IPv6 resolution evidence", () => {
  it.each([
    ['["fdc4:f303:9324::254"]', true],
    ['["fc00::1", "fdff::ffff"]', true],
    ['["fdc4:f303:9324::254", "192.168.65.254"]', false],
    ['["2001:4860:4860::8888"]', false],
    ['["fe80::1"]', false],
    ['["::1"]', false],
    ['["192.168.65.254"]', false],
    ["[]", false],
    ["[null]", false],
    ['{"address":"fdc4:f303:9324::254"}', false],
  ])("classifies resolver evidence %s as IPv6-only ULA=%s", (output, expected) => {
    expect(nativeLocalUlaOnlyResolution(output)).toBe(expected);
  });
  it.each([
    ["6.6.87.2-microsoft-standard-WSL2", "docker", true],
    ["6.6.87.2-microsoft-standard-WSL2", "podman", false],
    ["6.8.0-generic", "docker", false],
    ["Darwin Kernel Version 25", "docker", false],
  ])("selects the WSL Docker scenario for %s with %s=%s", (release, runtime, expected) => {
    expect(isWslDockerIpv6TestHost(release, runtime)).toBe(expected);
  });
  it("queries both address families and keeps policy response evidence separate from transport errors", () => {
    const resolution = nativeLocalIpv6ResolutionCommand();
    expect(resolution.slice(0, 2)).toEqual(["python3", "-c"]);
    expect(resolution[2]).toContain(
      "socket.getaddrinfo('host.openshell.internal',8081,type=socket.SOCK_STREAM)",
    );
    const command = nativeLocalIpv6DeniedCommand("::1", '{"model":"fixture"}');
    expect(command).toEqual([
      "curl",
      "-sS",
      "--max-time",
      "15",
      "--noproxy",
      "",
      "--write-out",
      "\n%{http_code}",
      "--header",
      "Content-Type: application/json",
      "--data",
      '{"model":"fixture"}',
      "http://[::1]:8081/v1/chat/completions",
    ]);
    expect(() => nativeLocalIpv6DeniedCommand("host.openshell.internal", "{}")).toThrow(
      "IPv6 literal",
    );
  });
  it("serves authenticated chat on the IPv6 listener used by the live fixture", async () => {
    const apiKey = "dummy";
    const progress = startTestProgress(
      "IPv6 host fixture",
      ["serve fixture", "verify authentication"],
      { logLine: () => undefined },
    );
    progress.phase("serve fixture");
    const server = await startFakeOpenAiCompatibleServer({
      progress,
      host: "::",
      apiKey,
      model: "ipv6-test",
      requireAuth: true,
    });
    try {
      progress.phase("verify authentication");
      const endpoint = new URL(server.baseUrl);
      endpoint.hostname = "[::1]";
      const body = JSON.stringify({
        model: "ipv6-test",
        messages: [{ role: "user", content: "PONG" }],
      });
      const unauthenticated = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      await unauthenticated.text();
      expect(unauthenticated.status).toBe(401);
      const response = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
      });
      await response.text();
      expect(response.status).toBe(200);
      expect(
        server
          .requests()
          .some((request) => request.path === "/v1/chat/completions" && request.auth === "ok"),
      ).toBe(true);
    } finally {
      await server.close();
      progress.stop();
    }
  });
  it("rejects malformed resolver output", () => {
    expect(() => nativeLocalUlaOnlyResolution("not JSON")).toThrow();
  });
});
