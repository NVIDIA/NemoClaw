// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addSandboxHostAlias,
  addSandboxHostAliasWithDeps,
  HostAliasesCommandError,
  listSandboxHostAliasesWithDeps,
  removeSandboxHostAliasWithDeps,
  type SandboxHostAliasesDeps,
} from "../../src/lib/actions/sandbox/host-aliases";
import * as registry from "../../src/lib/state/registry";

type HostAlias = { ip: string; hostnames: string[] };
type KubectlRunner = (args: string[]) => string;

const tempDirs = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function sandboxResource(resourceVersion: string, hostAliases: HostAlias[]): string {
  return JSON.stringify({
    metadata: { resourceVersion },
    spec: { podTemplate: { spec: { hostAliases } } },
  });
}

function actionDeps(runKubectlInClusterRaw: KubectlRunner): SandboxHostAliasesDeps {
  return {
    getSandbox: () => ({}),
    probeLegacyGatewayContainer: () => ({ state: "present" }),
    runKubectlInClusterRaw,
  };
}

function patchFromCall(args: string[]): Array<{ op: string; path: string; value: unknown }> {
  const patchIndex = args.indexOf("-p");
  expect(patchIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(args[patchIndex + 1] ?? "[]") as Array<{
    op: string;
    path: string;
    value: unknown;
  }>;
}

describe("sandbox host alias actions", () => {
  it("adds host aliases with a sandbox json patch", () => {
    const runKubectl = vi
      .fn<KubectlRunner>()
      .mockReturnValueOnce(sandboxResource("123", [{ ip: "10.0.0.5", hostnames: ["old.local"] }]))
      .mockReturnValueOnce("");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    addSandboxHostAliasWithDeps(
      "alpha",
      { hostname: "searxng.local", ip: "192.168.1.105" },
      actionDeps(runKubectl),
    );

    expect(runKubectl).toHaveBeenNthCalledWith(1, ["get", "sandbox", "alpha", "-o", "json"]);
    expect(runKubectl.mock.calls[1]?.[0]?.slice(0, 5)).toEqual([
      "patch",
      "sandbox",
      "alpha",
      "--type=json",
      "-p",
    ]);
    expect(patchFromCall(runKubectl.mock.calls[1]?.[0] ?? [])).toEqual([
      { op: "test", path: "/metadata/resourceVersion", value: "123" },
      {
        op: "replace",
        path: "/spec/podTemplate/spec/hostAliases",
        value: [
          { ip: "10.0.0.5", hostnames: ["old.local"] },
          { ip: "192.168.1.105", hostnames: ["searxng.local"] },
        ],
      },
    ]);
    expect(log).toHaveBeenCalledWith("  Added host alias searxng.local -> 192.168.1.105");
  });

  it("lists host aliases from the sandbox resource", () => {
    const runKubectl = vi
      .fn<KubectlRunner>()
      .mockReturnValueOnce(
        sandboxResource("123", [
          { ip: "192.168.1.105", hostnames: ["searxng.local", "search.lan"] },
        ]),
      );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    listSandboxHostAliasesWithDeps("alpha", actionDeps(runKubectl));

    expect(runKubectl).toHaveBeenCalledOnce();
    expect(log).toHaveBeenNthCalledWith(1, "  Host aliases for 'alpha':");
    expect(log).toHaveBeenNthCalledWith(2, "    192.168.1.105  searxng.local, search.lan");
  });

  it("removes host aliases with a sandbox json patch", () => {
    const runKubectl = vi
      .fn<KubectlRunner>()
      .mockReturnValueOnce(
        sandboxResource("123", [
          { ip: "10.0.0.5", hostnames: ["searxng.local", "old.local"] },
          { ip: "192.168.1.10", hostnames: ["keep.local"] },
        ]),
      )
      .mockReturnValueOnce("");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    removeSandboxHostAliasWithDeps("alpha", { hostname: "searxng.local" }, actionDeps(runKubectl));

    expect(patchFromCall(runKubectl.mock.calls[1]?.[0] ?? [])).toEqual([
      { op: "test", path: "/metadata/resourceVersion", value: "123" },
      {
        op: "replace",
        path: "/spec/podTemplate/spec/hostAliases",
        value: [
          { ip: "10.0.0.5", hostnames: ["old.local"] },
          { ip: "192.168.1.10", hostnames: ["keep.local"] },
        ],
      },
    ]);
    expect(log).toHaveBeenCalledWith("  Removed host alias searxng.local");
  });

  it("rejects duplicate host aliases case-insensitively", () => {
    const runKubectl = vi
      .fn<KubectlRunner>()
      .mockReturnValueOnce(
        sandboxResource("123", [{ ip: "10.0.0.5", hostnames: ["SearXNG.local"] }]),
      );

    expect(() =>
      addSandboxHostAliasWithDeps(
        "alpha",
        { hostname: "searxng.local", ip: "192.168.1.105" },
        actionDeps(runKubectl),
      ),
    ).toThrow("Host alias 'searxng.local' already exists");
    expect(runKubectl).toHaveBeenCalledOnce();
  });

  it("previews host alias changes with dry-run without patching", () => {
    const initial = sandboxResource("123", [
      { ip: "10.0.0.5", hostnames: ["searxng.local", "old.local"] },
    ]);
    const addKubectl = vi.fn<KubectlRunner>().mockReturnValueOnce(initial);
    const removeKubectl = vi.fn<KubectlRunner>().mockReturnValueOnce(initial);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    addSandboxHostAliasWithDeps(
      "alpha",
      { hostname: "dry.local", ip: "192.168.1.105", dryRun: true },
      actionDeps(addKubectl),
    );
    removeSandboxHostAliasWithDeps(
      "alpha",
      { hostname: "searxng.local", dryRun: true },
      actionDeps(removeKubectl),
    );

    const addPatch = JSON.parse(String(log.mock.calls[0]?.[0])) as Array<Record<string, unknown>>;
    const removePatch = JSON.parse(String(log.mock.calls[1]?.[0])) as Array<
      Record<string, unknown>
    >;
    expect(addPatch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/metadata/resourceVersion", value: "123" }),
        expect.objectContaining({
          path: "/spec/podTemplate/spec/hostAliases",
          value: expect.arrayContaining([{ ip: "192.168.1.105", hostnames: ["dry.local"] }]),
        }),
      ]),
    );
    expect(JSON.stringify(removePatch)).toContain("old.local");
    expect(JSON.stringify(removePatch)).not.toContain("searxng.local");
    expect(addKubectl).toHaveBeenCalledOnce();
    expect(removeKubectl).toHaveBeenCalledOnce();
  });

  it("retries host alias patches when the resource version changes", () => {
    const conflict = Object.assign(new Error("patch conflict"), {
      status: 1,
      stderr: "Operation cannot be fulfilled: the object has been modified",
    });
    const runKubectl = vi
      .fn<KubectlRunner>()
      .mockReturnValueOnce(sandboxResource("123", [{ ip: "10.0.0.5", hostnames: ["old.local"] }]))
      .mockImplementationOnce(() => {
        throw conflict;
      })
      .mockReturnValueOnce(sandboxResource("124", [{ ip: "10.0.0.5", hostnames: ["old.local"] }]))
      .mockReturnValueOnce("");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    addSandboxHostAliasWithDeps(
      "alpha",
      { hostname: "retry.local", ip: "192.168.1.105" },
      actionDeps(runKubectl),
    );

    expect(runKubectl).toHaveBeenCalledTimes(4);
    expect(runKubectl.mock.calls.map(([args]) => args[0])).toEqual([
      "get",
      "patch",
      "get",
      "patch",
    ]);
    expect(patchFromCall(runKubectl.mock.calls[3]?.[0] ?? [])[0]).toEqual({
      op: "test",
      path: "/metadata/resourceVersion",
      value: "124",
    });
  });

  it("stops before kubectl when the legacy gateway probe is unknown", () => {
    const runKubectl = vi.fn<KubectlRunner>();
    const deps: SandboxHostAliasesDeps = {
      getSandbox: () => ({}),
      probeLegacyGatewayContainer: () => ({
        state: "unknown",
        reason: "docker ps timed out",
      }),
      runKubectlInClusterRaw: runKubectl,
    };

    expect(() => listSandboxHostAliasesWithDeps("alpha", deps)).toThrow(
      new HostAliasesCommandError([
        "  Could not verify the legacy OpenShell gateway container 'openshell-cluster-nemoclaw'.",
        "  Docker probe failed: docker ps timed out",
        "  Check whether the Docker daemon is reachable with `docker info`.",
      ]),
    );
    expect(runKubectl).not.toHaveBeenCalled();
  });
});

describe("production host alias process adapters", () => {
  it("probes Docker and patches through the legacy gateway container", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-alias-process-"));
    tempDirs.add(tempDir);
    const binDir = path.join(tempDir, "bin");
    const dockerLog = path.join(tempDir, "docker.jsonl");
    const dockerPath = path.join(binDir, "docker");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      dockerPath,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        `fs.appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify(args) + "\\n");`,
        'if (args[0] === "ps") { process.stdout.write("openshell-cluster-nemoclaw\\n"); process.exit(0); }',
        'if (args.includes("get")) { process.stdout.write(JSON.stringify({ metadata: { resourceVersion: "123" }, spec: { podTemplate: { spec: { hostAliases: [{ ip: "10.0.0.5", hostnames: ["old.local"] }] } } } })); }',
      ].join("\n"),
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha" } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    addSandboxHostAlias("alpha", {
      hostname: "searxng.local",
      ip: "192.168.1.105",
    });

    const calls = fs
      .readFileSync(dockerLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls[0]).toEqual(["ps", "--format", "{{.Names}}"]);
    expect(calls[1]).toEqual([
      "exec",
      "openshell-cluster-nemoclaw",
      "kubectl",
      "-n",
      "openshell",
      "get",
      "sandbox",
      "alpha",
      "-o",
      "json",
    ]);
    expect(calls[2]?.slice(0, 10)).toEqual([
      "exec",
      "openshell-cluster-nemoclaw",
      "kubectl",
      "-n",
      "openshell",
      "patch",
      "sandbox",
      "alpha",
      "--type=json",
      "-p",
    ]);
    expect(patchFromCall(calls[2]?.slice(5) ?? [])[0]).toEqual({
      op: "test",
      path: "/metadata/resourceVersion",
      value: "123",
    });
    expect(log).toHaveBeenCalledWith("  Added host alias searxng.local -> 192.168.1.105");
  });
});
