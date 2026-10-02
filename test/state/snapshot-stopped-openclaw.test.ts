// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-snapshot-test-"));
process.env.HOME = home;
const state = await import("../../src/lib/state/sandbox");
const registry = await import("../../src/lib/state/registry");

afterAll(() => {
  originalHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", originalHome);
  fs.rmSync(home, { recursive: true, force: true });
});

function source(name: string) {
  registry.registerSandbox({ name, agent: "openclaw" });
  const directory = fs.mkdtempSync(path.join(home, "captured-"));
  fs.mkdirSync(path.join(directory, "workspace"));
  fs.writeFileSync(path.join(directory, "workspace", "keep.txt"), "operator data");
  fs.mkdirSync(path.join(directory, "workspace-second"));
  fs.writeFileSync(path.join(directory, "workspace-second", "keep.txt"), "second agent data");
  fs.writeFileSync(
    path.join(directory, "openclaw.json"),
    JSON.stringify({
      gateway: { auth: { token: "stopped-snapshot-secret-canary" } },
      mcp: {
        servers: {
          github: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
          },
        },
      },
    }),
  );
  fs.writeFileSync(path.join(directory, "unrelated-private-file"), "not declared state");
  return { sandboxName: name, agentName: "openclaw" as const, directory, assertCurrent: vi.fn() };
}

it("publishes sanitized declared state from a stopped source without a sandbox connection", () => {
  const captured = source("stopped-good");
  const result = state.backupSandboxState("stopped-good", { capturedAgentState: captured });
  expect(result.success, result.error).toBe(true);
  expect(result.manifest?.backupComplete).toBe(true);
  const destination = result.manifest!.backupPath;
  expect(fs.readFileSync(path.join(destination, "workspace", "keep.txt"), "utf8")).toBe(
    "operator data",
  );
  expect(fs.readFileSync(path.join(destination, "workspace-second", "keep.txt"), "utf8")).toBe(
    "second agent data",
  );
  expect(result.manifest!.stateDirs).toContain("workspace-second");
  const config = fs.readFileSync(path.join(destination, "openclaw.json"), "utf8");
  expect(config).not.toContain("stopped-snapshot-secret-canary");
  expect(config).toContain("openshell:resolve:env:GITHUB_TOKEN");
  expect(fs.existsSync(path.join(destination, "unrelated-private-file"))).toBe(false);
  expect(fs.readFileSync(path.join(captured.directory, "openclaw.json"), "utf8")).toContain(
    "stopped-snapshot-secret-canary",
  );
});

it("removes an unpublished stopped-state copy after the work deadline expires", () => {
  const captured = source("stopped-expired-copy");
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  captured.assertCurrent
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => now.mockReturnValue(2_000));

  const result = state.backupSandboxState("stopped-expired-copy", {
    capturedAgentState: captured,
    deadlineMs: 1_500,
  });

  now.mockRestore();
  expect(result.success).toBe(false);
  expect(result.error).not.toContain("requires cleanup");
  expect(state.listBackups("stopped-expired-copy")).toEqual([]);
  expect(
    fs
      .readdirSync(home, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.includes("rebuild-backups/stopped-expired-copy/")),
  ).toEqual([]);
  expect(fs.readFileSync(path.join(captured.directory, "workspace", "keep.txt"), "utf8")).toBe(
    "operator data",
  );
});

it("preserves stopped Deep Agents state and nested skills while excluding private MCP input and credentials (#11165)", () => {
  const name = "stopped-dcode";
  registry.registerSandbox({ name, agent: "langchain-deepagents-code" });
  const directory = fs.mkdtempSync(path.join(home, "captured-dcode-"));
  fs.mkdirSync(path.join(directory, ".state"));
  fs.mkdirSync(path.join(directory, "agent", "skills"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".state", "conversation.txt"), "retained conversation");
  fs.writeFileSync(path.join(directory, "agent", "skills", "retained.md"), "retained skill");
  fs.writeFileSync(path.join(directory, "config.toml"), "[ui]\nshow_scrollbar = true\n");
  fs.writeFileSync(path.join(directory, ".mcp.json"), '{"mcpServers":{}}');
  fs.writeFileSync(path.join(directory, ".env"), "DO-NOT-PUBLISH-CREDENTIAL");
  const result = state.backupSandboxState(name, {
    capturedAgentState: {
      sandboxName: name,
      agentName: "langchain-deepagents-code",
      directory,
      assertCurrent: vi.fn(),
    },
  });
  expect(result.success, result.error).toBe(true);
  expect(result.manifest?.backupComplete).toBe(true);
  const destination = result.manifest!.backupPath;
  expect(fs.readFileSync(path.join(destination, ".state", "conversation.txt"), "utf8")).toBe(
    "retained conversation",
  );
  expect(fs.readFileSync(path.join(destination, "agent", "skills", "retained.md"), "utf8")).toBe(
    "retained skill",
  );
  expect(fs.readFileSync(path.join(destination, "config.toml"), "utf8")).toContain(
    "show_scrollbar = true",
  );
  expect(fs.existsSync(path.join(destination, ".mcp.json"))).toBe(false);
  expect(fs.existsSync(path.join(destination, ".env"))).toBe(false);
  expect(fs.existsSync(path.join(directory, ".mcp.json"))).toBe(true);
});

it.each([
  {
    name: "stopped-dcode-parent-link",
    prepare: (captured: ReturnType<typeof source>) => {
      registry.updateSandbox(captured.sandboxName, { agent: "langchain-deepagents-code" });
      Object.assign(captured, { agentName: "langchain-deepagents-code" });
      fs.mkdirSync(path.join(captured.directory, "workspace", "skills"));
      fs.writeFileSync(
        path.join(captured.directory, "workspace", "skills", "private.md"),
        "undeclared state",
      );
      fs.symlinkSync("workspace", path.join(captured.directory, "agent"));
    },
  },
  {
    name: "stopped-wrong-agent",
    prepare: (captured: ReturnType<typeof source>) =>
      Object.assign(captured, { agentName: "langchain-deepagents-code" }),
  },
  {
    name: "stopped-link",
    prepare: (captured: ReturnType<typeof source>) =>
      fs.symlinkSync("/etc/passwd", path.join(captured.directory, "workspace", "outside")),
  },
  {
    name: "stopped-changed",
    prepare: (captured: ReturnType<typeof source>) =>
      captured.assertCurrent
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new Error("changed");
        }),
  },
])("preserves the source and publishes no snapshot for $name", ({ name, prepare }) => {
  const captured = source(name);
  prepare(captured);
  const result = state.backupSandboxState(name, { capturedAgentState: captured });
  expect(result.success).toBe(false);
  expect(result.manifest).toBeUndefined();
  expect(state.listBackups(name)).toEqual([]);
  expect(fs.readFileSync(path.join(captured.directory, "workspace", "keep.txt"), "utf8")).toBe(
    "operator data",
  );
});
