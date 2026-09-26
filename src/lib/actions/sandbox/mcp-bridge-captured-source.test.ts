// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectCapturedOpenClawMcpSources } from "./mcp-bridge-source";

describe("captured OpenClaw MCP configuration", () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-captured-"quoted"-'));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function source() {
    return {
      sandboxName: "alpha",
      directory,
      cleanupDirectory: directory,
      assertCurrent: vi.fn(),
      dispose: vi.fn(),
    };
  }

  it("reads native JSON5 and legacy JSON using the host dependency, not captured code (#11764)", () => {
    fs.writeFileSync(
      path.join(directory, "openclaw.json"),
      `{
      // Native configuration may contain comments and trailing commas.
      mcp: { servers: { github: {
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer openshell:resolve:env:v42_GITHUB_TOKEN' },
      } } },
    }`,
    );
    fs.mkdirSync(path.join(directory, "workspace", "config"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "workspace", "config", "mcporter.json"),
      JSON.stringify({
        mcpServers: { old: { baseUrl: "https://legacy.example.test/mcp/" } },
      }),
    );
    fs.mkdirSync(path.join(directory, "node_modules", "json5"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "node_modules", "json5", "index.js"),
      'throw new Error("captured code must not execute");',
    );
    const captured = source();

    const result = inspectCapturedOpenClawMcpSources(captured);

    expect(result.native.github).toMatchObject({
      agent: "openclaw",
      source: "native",
      url: "https://api.githubcopilot.com/mcp/",
      env: ["GITHUB_TOKEN"],
    });
    expect(result.legacy.old).toMatchObject({
      agent: "openclaw",
      source: "legacy",
      url: "https://legacy.example.test/mcp/",
      env: [],
    });
    expect(captured.assertCurrent).toHaveBeenCalledTimes(2);
    expect(captured.dispose).not.toHaveBeenCalled();
  });

  it("returns no registrations when captured configuration is absent", () => {
    expect(inspectCapturedOpenClawMcpSources(source())).toEqual({ native: {}, legacy: {} });
  });

  it.each([
    ["symlink", fs.symlinkSync],
    ["hardlink", fs.linkSync],
  ] as const)("rejects %s configuration without exposing its contents", (_kind, link) => {
    const config = path.join(directory, "openclaw.json");
    const target = path.join(directory, "target.json");
    const contents = JSON.stringify({ secret: "private-mcp-source-marker" });
    fs.writeFileSync(target, contents);
    link(target, config);
    const captured = source();
    expect(() => inspectCapturedOpenClawMcpSources(captured)).toThrowError(
      /^Could not inspect the captured OpenClaw MCP configuration\.$/u,
    );
    expect(captured.assertCurrent).toHaveBeenCalledOnce();
    expect(fs.readFileSync(config, "utf8")).toBe(contents);
  });

  it.each([
    [
      "oversized",
      JSON.stringify({ secret: "private-mcp-source-marker", padding: " ".repeat(262_145) }),
    ],
    ["invalid JSON5", "{ private-mcp-source-marker"],
  ])("rejects %s configuration without exposing its contents", (_kind, contents) => {
    const config = path.join(directory, "openclaw.json");
    fs.writeFileSync(config, contents);
    const captured = source();
    expect(() => inspectCapturedOpenClawMcpSources(captured)).toThrowError(
      /^Could not inspect the captured OpenClaw MCP configuration\.$/u,
    );
    expect(captured.assertCurrent).toHaveBeenCalledOnce();
    expect(fs.readFileSync(config, "utf8")).toBe(contents);
  });

  it("rejects a captured source whose identity changed during inspection", () => {
    fs.writeFileSync(path.join(directory, "openclaw.json"), "{}");
    const captured = source();
    captured.assertCurrent
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("captured source changed");
      });
    expect(() => inspectCapturedOpenClawMcpSources(captured)).toThrow("captured source changed");
  });
});
