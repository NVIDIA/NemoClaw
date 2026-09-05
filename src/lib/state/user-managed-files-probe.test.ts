// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import child_process from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SandboxStateModule = typeof import("./sandbox");
type RegistryModule = typeof import("./registry");
type DefsModule = typeof import("../agent/defs");
type ProbeModule = typeof import("./user-managed-files-probe");
type OpenShellClientModule = typeof import("../adapters/openshell/client");
type OpenShellResolveModule = typeof import("../adapters/openshell/resolve");

const requireDist = createRequire(import.meta.url);
const sandboxStatePath = "./sandbox.js";
const registryPath = "./registry.js";
const defsPath = "../agent/defs.js";
const probePath = "./user-managed-files-probe.js";
const openshellClientPath = "../adapters/openshell/client.js";
const openshellResolvePath = "../adapters/openshell/resolve.js";

function loadProbe(): ProbeModule {
  delete require.cache[requireDist.resolve(probePath)];
  return requireDist(probePath);
}

function loadSandboxState(): SandboxStateModule {
  return requireDist(sandboxStatePath);
}

function loadRegistry(): RegistryModule {
  return requireDist(registryPath);
}

function loadDefs(): DefsModule {
  return requireDist(defsPath);
}

function loadOpenShellClient(): OpenShellClientModule {
  return requireDist(openshellClientPath);
}

function loadOpenShellResolve(): OpenShellResolveModule {
  return requireDist(openshellResolvePath);
}

function makeFakeAgent(declared: string[]): ReturnType<DefsModule["loadAgent"]> {
  return {
    name: "fake-agent",
    displayName: "Fake Agent",
    description: null,
    binaryPath: null,
    versionCommand: "fake --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
    runtime: { kind: "terminal" },
    healthProbe: null,
    forwardPort: 0,
    dashboard: { kind: "headless" },
    dashboardUi: null,
    configPaths: {
      dir: "/sandbox/.fake",
      configFile: "config.toml",
      envFile: null,
      format: "toml",
    },
    inferenceProviderOptions: [],
    stateDirs: [],
    stateFiles: [],
    userManagedFiles: declared,
    messagingPlatforms: [],
    agentDir: "/tmp/fake-agent",
    manifestPath: "/tmp/fake-agent/manifest.yaml",
  } as unknown as ReturnType<DefsModule["loadAgent"]>;
}

describe("probeUserManagedFiles", () => {
  let recordedArgs: string[][];
  let recordedOptions: Array<Record<string, unknown>>;
  let spawnSpy: ReturnType<typeof vi.spyOn>;
  let tempSshFiles: Set<string>;
  let originalMkdtempSync: typeof fs.mkdtempSync;

  beforeEach(() => {
    recordedArgs = [];
    recordedOptions = [];
    tempSshFiles = new Set<string>();
    const sandboxState = loadSandboxState();
    const registry = loadRegistry();
    const defs = loadDefs();

    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "fake-agent",
    } as unknown as ReturnType<RegistryModule["getSandbox"]>);
    vi.spyOn(defs, "loadAgent").mockImplementation(() => makeFakeAgent([".env", ".mcp.json"]));
    vi.spyOn(sandboxState, "getSshConfig").mockReturnValue(
      "Host openshell-alpha\n  HostName 127.0.0.1\n",
    );

    originalMkdtempSync = fs.mkdtempSync;
    vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string): string => {
      const dir = originalMkdtempSync.call(fs, prefix) as string;
      tempSshFiles.add(dir);
      return dir;
    }) as unknown as typeof fs.mkdtempSync);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of tempSshFiles) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  function stubSpawnSync(stdout: string, status: number, stderr = ""): void {
    spawnSpy = vi.spyOn(child_process, "spawnSync").mockImplementation(((
      command: string,
      args?: readonly string[],
      options?: Record<string, unknown>,
    ) => {
      const argList = Array.isArray(args) ? [...args] : [];
      const sshCall = command === "ssh" && argList.length > 0;
      sshCall && recordedArgs.push(argList);
      sshCall && recordedOptions.push(options ?? {});
      return {
        status,
        signal: null,
        output: [],
        pid: 0,
        stdout,
        stderr,
      } as ReturnType<typeof child_process.spawnSync>;
    }) as typeof child_process.spawnSync);
  }

  it("probes declared user-managed files at the sandbox root, not the agent config dir", () => {
    stubSpawnSync(".env\n.mcp.json\n", 0);
    const { probeUserManagedFiles, USER_MANAGED_FILES_BASE } = loadProbe();

    const result = probeUserManagedFiles("alpha");

    expect(USER_MANAGED_FILES_BASE).toBe("/sandbox");
    expect(result.declared).toEqual([".env", ".mcp.json"]);
    expect(result.existing).toEqual([".env", ".mcp.json"]);
    expect(spawnSpy).toHaveBeenCalledOnce();
    const lastArgs = recordedArgs[0] ?? [];
    const probeCmd = lastArgs[lastArgs.length - 1] ?? "";
    expect(probeCmd).toContain("if [ -f '/sandbox/.env' ]");
    expect(probeCmd).toContain("if [ -f '/sandbox/.mcp.json' ]");
    expect(probeCmd).not.toContain("/sandbox/.fake/");
  });

  it("pins SSH config and ProxyCommand environment to the frozen target (#10514)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    const runtimeSelection = {
      gatewayName: "recorded-gateway",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };
    const sandboxState = loadSandboxState();
    const getSshConfig = vi.mocked(sandboxState.getSshConfig);
    stubSpawnSync(".env\n", 0);
    const { probeUserManagedFiles } = loadProbe();

    probeUserManagedFiles("alpha", runtimeSelection);

    expect(getSshConfig).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        gatewayName: "recorded-gateway",
        replaceEnv: true,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "recorded-gateway",
          OPENSHELL_WORKSPACE: "default",
          OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        }),
      }),
    );
    const env = recordedOptions[0]?.env as Record<string, string>;
    expect(env).toMatchObject({
      OPENSHELL_GATEWAY: "recorded-gateway",
      OPENSHELL_WORKSPACE: "default",
      OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
    });
    expect(env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
  });

  it("supports nested declared files relative to the sandbox root", () => {
    const defs = loadDefs();
    vi.spyOn(defs, "loadAgent").mockImplementation(() => makeFakeAgent([".hermes/.env"]));
    stubSpawnSync(".hermes/.env\n", 0);
    const { probeUserManagedFiles } = loadProbe();

    const result = probeUserManagedFiles("alpha");

    expect(result.declared).toEqual([".hermes/.env"]);
    expect(result.existing).toEqual([".hermes/.env"]);
    const lastArgs = recordedArgs[0] ?? [];
    const probeCmd = lastArgs[lastArgs.length - 1] ?? "";
    expect(probeCmd).toContain("if [ -f '/sandbox/.hermes/.env' ]");
  });

  it("returns empty existing when ssh exits 0 with no stdout (no declared files present)", () => {
    stubSpawnSync("", 0);
    const { probeUserManagedFiles } = loadProbe();

    const result = probeUserManagedFiles("alpha");
    expect(result.declared).toEqual([".env", ".mcp.json"]);
    expect(result.existing).toEqual([]);
  });

  it("throws when ssh exits non-zero with no stdout", () => {
    stubSpawnSync("", 255, "connection refused");
    const { probeUserManagedFiles } = loadProbe();

    expect(() => probeUserManagedFiles("alpha")).toThrow(/user-managed file probe failed/);
  });

  it("throws when sandbox has no SSH config and the agent declares user-managed files", () => {
    stubSpawnSync("", 0);
    const sandboxState = loadSandboxState();
    vi.spyOn(sandboxState, "getSshConfig").mockReturnValue(null);
    const { probeUserManagedFiles } = loadProbe();

    expect(() => probeUserManagedFiles("alpha")).toThrow(
      /user-managed file probe failed: no SSH config/,
    );
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("returns empty existing when sandbox has no SSH config but agent declares no user-managed files", () => {
    stubSpawnSync("", 0);
    const defs = loadDefs();
    vi.spyOn(defs, "loadAgent").mockImplementation(() => makeFakeAgent([]));
    const sandboxState = loadSandboxState();
    vi.spyOn(sandboxState, "getSshConfig").mockReturnValue(null);
    const { probeUserManagedFiles } = loadProbe();

    const result = probeUserManagedFiles("alpha");
    expect(result.declared).toEqual([]);
    expect(result.existing).toEqual([]);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("creates its temp SSH config inside the OS tmpdir", () => {
    stubSpawnSync("", 0);
    const { probeUserManagedFiles } = loadProbe();

    probeUserManagedFiles("alpha");
    expect(tempSshFiles.size).toBeGreaterThan(0);
    const tmpdir = path.resolve(os.tmpdir());
    expect([...tempSshFiles].every((dir) => {
        const resolved = path.resolve(dir);
        return resolved.startsWith(tmpdir + path.sep) || resolved === tmpdir;
      })).toBe(true);
  });

  it("shell-quotes unusual but permitted filenames safely", () => {
    const defs = loadDefs();
    vi.spyOn(defs, "loadAgent").mockImplementation(() => makeFakeAgent(["user's.env", ".env"]));
    stubSpawnSync("", 0);
    const { probeUserManagedFiles } = loadProbe();

    probeUserManagedFiles("alpha");
    const lastArgs = recordedArgs[0] ?? [];
    const probeCmd = lastArgs[lastArgs.length - 1] ?? "";
    expect(probeCmd).toContain("'/sandbox/user'\\''s.env'");
    expect(probeCmd).toContain("'/sandbox/.env'");
  });

  it("cleans up the temp SSH config on success", () => {
    stubSpawnSync(".env\n", 0);
    const { probeUserManagedFiles } = loadProbe();

    probeUserManagedFiles("alpha");
    expect([...tempSshFiles].every((dir) => !fs.existsSync(dir))).toBe(true);
  });

  it("cleans up the temp SSH config on SSH failure", () => {
    stubSpawnSync("", 255, "boom");
    const { probeUserManagedFiles } = loadProbe();

    expect(() => probeUserManagedFiles("alpha")).toThrow();
    expect([...tempSshFiles].every((dir) => !fs.existsSync(dir))).toBe(true);
  });

  it("returns empty declared when the agent has no user_managed_files", () => {
    const defs = loadDefs();
    vi.spyOn(defs, "loadAgent").mockImplementation(() => makeFakeAgent([]));
    stubSpawnSync("", 0);
    const { probeUserManagedFiles } = loadProbe();

    const result = probeUserManagedFiles("alpha");
    expect(result.declared).toEqual([]);
    expect(result.existing).toEqual([]);
  });
});

describe("getSshConfig frozen target", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses replacement environment, workspace, TLS, and gateway for SSH config (#10514)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.spyOn(loadOpenShellResolve(), "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
    const capture = vi
      .spyOn(loadOpenShellClient(), "captureSandboxSshConfigCommand")
      .mockReturnValue({ status: 0, output: "Host openshell-alpha.default\n" });

    const runtimeOptions = {
      gatewayName: "recorded-gateway",
      replaceEnv: true,
      env: {
        OPENSHELL_GATEWAY: "recorded-gateway",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      },
    };
    expect(loadSandboxState().getSshConfig("alpha", runtimeOptions)).toContain(
      "openshell-alpha.default",
    );

    expect(capture).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      "alpha",
      expect.objectContaining({
        gatewayName: "recorded-gateway",
        replaceEnv: true,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "recorded-gateway",
          OPENSHELL_WORKSPACE: "default",
          OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        }),
      }),
    );
    const env = capture.mock.calls[0]?.[2]?.env as Record<string, string>;
    expect(env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
  });
});
