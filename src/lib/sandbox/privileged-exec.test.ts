// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPersistedLifecycleStoreOrThrow } from "../../../test/helpers/privileged-exec-test-helpers";

// The shared source hook preserves the writable CommonJS cache used by these mocks.
const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as any;
const helperPath = require.resolve("./privileged-exec");
const dockerRunPath = require.resolve("../adapters/docker/run");
const portableLifecyclePath = require.resolve("../onboard/experimental/portable-demo-lifecycle");
const registryPath = require.resolve("../state/registry");
const lifecycleGenerationPath = require.resolve("../state/registry/lifecycle-generation");
const persistedLifecyclePath =
  require.resolve("../onboard/runtime-provider/persisted-engine-lifecycle");
const statePathsPath = require.resolve("../state/paths");
const transitionLockPath = require.resolve("../shields/transition-lock");
const {
  buildStoppedDockerSandboxChannelCleanupScript,
  containerNameMatchesSandbox,
  selectDirectSandboxContainer,
} = require(helperPath);
const PINNED_CLEANUP_IMAGE =
  "node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c";
const EXPECTED_WECHAT_STATE_PATHS = [
  "/sandbox/.openclaw/wechat",
  "/sandbox/.openclaw/openclaw-weixin",
] as const;

function restoreRequireCacheEntry(modulePath: string, priorEntry: unknown): void {
  if (priorEntry) requireCache[modulePath] = priorEntry;
  else delete requireCache[modulePath];
}

function withPrivilegedExecMocks<T>(
  deps: {
    dockerCapture: (args: readonly string[], options?: { timeout?: number }) => string;
    dockerRun?: (
      args: readonly string[],
      options?: { timeout?: number },
    ) => { status: number; stdout: string; stderr: string; error: null };
    getSandbox: (name: string) => {
      name?: string;
      lifecycleGeneration?: string;
      openshellDriver?: string | null;
    } | null;
    listSandboxes: () => {
      sandboxes?: Array<{ name?: string | null }>;
      defaultSandbox?: string | null;
    };
    compareAndSetLegacySandboxLifecycleGeneration?: (
      expected: { name?: string },
      generation: string,
    ) => boolean;
    resolvePortableDemoPrivilegedExecTarget?: (
      sandboxName: string,
      deps?: {
        backfillRegistryGeneration?: (generation: string) => boolean;
        registryGeneration?: string;
      },
    ) => { assertRuntimeAuthority: () => void; containerId: string; dockerHost: string } | null;
    stateMutationGate?: {
      readonly active: boolean;
      readonly stateDir: string;
      readonly storeError?: Error;
    };
    withShieldsTransitionLock?: <T>(sandboxName: string, operation: string, fn: () => T) => T;
  },
  run: (helper: typeof import("./privileged-exec")) => T,
): T {
  const priorHelper = require.cache[helperPath];
  const priorDockerRun = require.cache[dockerRunPath];
  const priorPortableLifecycle = require.cache[portableLifecyclePath];
  const priorRegistry = require.cache[registryPath];
  const priorLifecycleGeneration = require.cache[lifecycleGenerationPath];
  const priorPersistedLifecycle = require.cache[persistedLifecyclePath];
  const priorStatePaths = require.cache[statePathsPath];
  const priorTransitionLock = require.cache[transitionLockPath];

  delete require.cache[helperPath];
  requireCache[dockerRunPath] = {
    id: dockerRunPath,
    filename: dockerRunPath,
    loaded: true,
    exports: {
      dockerCapture: deps.dockerCapture,
      dockerRun:
        deps.dockerRun ?? (() => ({ status: 0, stdout: "", stderr: "", error: null }) as const),
    },
  } as any;
  requireCache[portableLifecyclePath] = {
    id: portableLifecyclePath,
    filename: portableLifecyclePath,
    loaded: true,
    exports: {
      resolvePortableDemoPrivilegedExecTarget:
        deps.resolvePortableDemoPrivilegedExecTarget ?? (() => null),
    },
  } as any;
  requireCache[registryPath] = {
    id: registryPath,
    filename: registryPath,
    loaded: true,
    exports: {
      getSandbox: deps.getSandbox,
      listSandboxes: deps.listSandboxes,
    },
  } as any;
  requireCache[lifecycleGenerationPath] = {
    id: lifecycleGenerationPath,
    filename: lifecycleGenerationPath,
    loaded: true,
    exports: {
      compareAndSetLegacySandboxLifecycleGeneration:
        deps.compareAndSetLegacySandboxLifecycleGeneration ?? (() => false),
    },
  } as any;
  requireCache[persistedLifecyclePath] = {
    id: persistedLifecyclePath,
    filename: persistedLifecyclePath,
    loaded: true,
    exports: {
      PERSISTED_ENGINE_LIFECYCLE_DIRECTORY: "runtime-provider-lifecycle",
      createFilePersistedEngineLifecycleStore: () =>
        createPersistedLifecycleStoreOrThrow(deps.stateMutationGate),
      hasActivePersistedEngineStateMutationTarget: () => deps.stateMutationGate?.active ?? false,
    },
  } as any;
  requireCache[statePathsPath] = {
    id: statePathsPath,
    filename: statePathsPath,
    loaded: true,
    exports: {
      resolveNemoclawStateDir: () => deps.stateMutationGate?.stateDir ?? "/nonexistent",
    },
  } as any;
  requireCache[transitionLockPath] = {
    id: transitionLockPath,
    filename: transitionLockPath,
    loaded: true,
    exports: {
      resolveShieldsStateDir: () => deps.stateMutationGate?.stateDir ?? "/nonexistent",
      withShieldsTransitionLock:
        deps.withShieldsTransitionLock ??
        (<T>(_sandboxName: string, _operation: string, fn: () => T): T => fn()),
    },
  } as any;

  try {
    return run(require(helperPath));
  } finally {
    restoreRequireCacheEntry(helperPath, priorHelper);
    restoreRequireCacheEntry(dockerRunPath, priorDockerRun);
    restoreRequireCacheEntry(portableLifecyclePath, priorPortableLifecycle);
    restoreRequireCacheEntry(registryPath, priorRegistry);
    restoreRequireCacheEntry(lifecycleGenerationPath, priorLifecycleGeneration);
    restoreRequireCacheEntry(persistedLifecyclePath, priorPersistedLifecycle);
    restoreRequireCacheEntry(statePathsPath, priorStatePaths);
    restoreRequireCacheEntry(transitionLockPath, priorTransitionLock);
  }
}

describe("privileged sandbox exec routing", () => {
  it("matches only the requested OpenShell sandbox container name pattern", () => {
    expect(containerNameMatchesSandbox("openshell-demo", "demo")).toBe(true);
    expect(containerNameMatchesSandbox("openshell-demo-abc123", "demo")).toBe(true);
    expect(containerNameMatchesSandbox("openshell-default--demo-abc123", "demo")).toBe(true);
    expect(containerNameMatchesSandbox("openshell-demolition", "demo")).toBe(false);
    expect(containerNameMatchesSandbox("openshell-review--demo-abc123", "demo")).toBe(false);
    expect(containerNameMatchesSandbox("openshell-default--demo--abc123", "demo")).toBe(false);
    expect(containerNameMatchesSandbox("openshell-gateway-nemoclaw", "demo")).toBe(false);
  });

  it("selects the immutable id of one labeled direct sandbox container", () => {
    expect(selectDirectSandboxContainer("demo", "abc123\topenshell-demo-2026\n", ["demo"])).toBe(
      "abc123",
    );
  });

  it("selects the immutable id of one v0.0.99 default-workspace container", () => {
    expect(
      selectDirectSandboxContainer("demo", "abc123\topenshell-default--demo-2026\n", ["demo"]),
    ).toBe("abc123");
  });

  it("clears stopped OpenClaw WeChat state through an isolated immutable-image helper", () => {
    const containerId = "a".repeat(64);
    const helperId = "b".repeat(64);
    const mounts = JSON.stringify([
      {
        Type: "volume",
        Name: "nemoclaw-alpha-state",
        Destination: "/sandbox",
        RW: true,
      },
      {
        Type: "bind",
        Source: "/home/operator/project",
        Destination: "/sandbox/project",
        RW: false,
      },
    ]);
    const results = [
      {
        status: 0,
        stdout: `${containerId}\tfalse\t${mounts}\n`,
        stderr: "",
        error: null,
      },
      {
        status: 0,
        stdout: `sha256:${"c".repeat(64)}\n`,
        stderr: "",
        error: null,
      },
      {
        status: 1,
        stdout: "",
        stderr: "Error: No such object: cleanup-helper",
        error: null,
      },
      {
        status: 0,
        stdout: `${helperId}\n`,
        stderr: "",
        error: null,
      },
      { status: 0, stdout: "", stderr: "", error: null },
      { status: 0, stdout: helperId, stderr: "", error: null },
      {
        status: 1,
        stdout: "",
        stderr: `Error: No such container: ${helperId}`,
        error: null,
      },
      {
        status: 0,
        stdout: `${containerId}\tfalse\t${mounts}\n`,
        stderr: "",
        error: null,
      },
    ];
    const runDocker = vi.fn(
      (_args: readonly string[]) => results.shift() as (typeof results)[number],
    );

    withPrivilegedExecMocks(
      {
        dockerCapture: () => `${containerId}\topenshell-alpha\n`,
        dockerRun: runDocker,
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
      },
      ({ clearStoppedDockerSandboxChannelState }) => {
        expect(clearStoppedDockerSandboxChannelState("alpha", EXPECTED_WECHAT_STATE_PATHS)).toEqual(
          { cleared: true },
        );
      },
    );

    const helperArgv = runDocker.mock.calls[3]?.[0];
    expect(runDocker).toHaveBeenCalledTimes(8);
    expect(helperArgv).toEqual(
      expect.arrayContaining([
        "create",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "DAC_OVERRIDE",
        "--mount",
        "type=volume,src=nemoclaw-alpha-state,dst=/sandbox,volume-nocopy",
        PINNED_CLEANUP_IMAGE,
      ]),
    );
    expect(helperArgv).not.toContain("--volumes-from");
    expect(helperArgv?.join("\0")).not.toContain("/home/operator/project");
    expect(helperArgv?.join("\0")).not.toContain("/sandbox/project");
    expect(helperArgv).not.toContain("/bin/sh");
    expect(helperArgv?.join("\0")).not.toContain("rm -rf");
    expect(helperArgv?.at(-1)).toBe(JSON.stringify(EXPECTED_WECHAT_STATE_PATHS));
    expect(runDocker.mock.calls[4]?.[0]).toEqual(["start", "--attach", helperId]);
    expect(runDocker.mock.calls[5]?.[0]).toEqual(["rm", "-f", helperId]);
  });

  it("deletes only the exact stopped-channel directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-cleanup-"));
    const configDir = path.join(root, ".openclaw");
    const wechatDir = path.join(configDir, "wechat");
    const otherDir = path.join(configDir, "preserve");
    fs.mkdirSync(wechatDir, { recursive: true });
    fs.mkdirSync(otherDir);
    fs.writeFileSync(path.join(wechatDir, "account.json"), "credential residue\n");
    fs.writeFileSync(path.join(otherDir, "sentinel"), "preserve\n");

    try {
      const result = spawnSync(
        process.execPath,
        ["-e", buildStoppedDockerSandboxChannelCleanupScript(root), JSON.stringify([wechatDir])],
        { encoding: "utf8", timeout: 5000 },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(wechatDir)).toBe(false);
      expect(fs.readFileSync(path.join(otherDir, "sentinel"), "utf8")).toBe("preserve\n");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a symlinked parent without touching its external target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-cleanup-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-cleanup-outside-"));
    const outsideWechat = path.join(outside, "wechat");
    fs.mkdirSync(outsideWechat);
    fs.writeFileSync(path.join(outsideWechat, "sentinel"), "preserve\n");
    fs.symlinkSync(outside, path.join(root, ".openclaw"));

    try {
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          buildStoppedDockerSandboxChannelCleanupScript(root),
          JSON.stringify([path.join(root, ".openclaw", "wechat")]),
        ],
        { encoding: "utf8", timeout: 5000 },
      );

      expect(result.status).toBe(43);
      expect(fs.readFileSync(path.join(outsideWechat, "sentinel"), "utf8")).toBe("preserve\n");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
      fs.rmSync(outside, { force: true, recursive: true });
    }
  });

  it("refuses an unsafe stopped-cleanup path before Docker discovery", () => {
    const captureDocker = vi.fn(() => "");
    withPrivilegedExecMocks(
      {
        dockerCapture: captureDocker,
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
      },
      ({ clearStoppedDockerSandboxChannelState }) => {
        expect(
          clearStoppedDockerSandboxChannelState("alpha", ["/sandbox/.openclaw/../project"]),
        ).toEqual({ cleared: false, failure: "state-paths-invalid" });
      },
    );
    expect(captureDocker).not.toHaveBeenCalled();
  });

  it("refuses stopped cleanup for a non-Docker sandbox before Docker discovery", () => {
    const captureDocker = vi.fn(() => "");
    const runDocker = vi.fn((_args: readonly string[]) => {
      return { status: 0, stdout: "", stderr: "", error: null } as const;
    });

    withPrivilegedExecMocks(
      {
        dockerCapture: captureDocker,
        dockerRun: runDocker,
        getSandbox: () => ({ name: "alpha", openshellDriver: "vm" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
      },
      ({ clearStoppedDockerSandboxChannelState }) => {
        expect(clearStoppedDockerSandboxChannelState("alpha", EXPECTED_WECHAT_STATE_PATHS)).toEqual(
          {
            cleared: false,
            failure: "driver-not-docker",
          },
        );
      },
    );

    expect(captureDocker).not.toHaveBeenCalled();
    expect(runDocker).not.toHaveBeenCalled();
  });

  it("refuses cleanup when the stopped container has no writable sandbox mount", () => {
    const containerId = "a".repeat(64);
    const runDocker = vi.fn((_args: readonly string[]) => {
      return {
        status: 0,
        stdout: `${containerId}\tfalse\t[]\n`,
        stderr: "",
        error: null,
      } as const;
    });

    withPrivilegedExecMocks(
      {
        dockerCapture: () => `${containerId}\topenshell-alpha\n`,
        dockerRun: runDocker,
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
      },
      ({ clearStoppedDockerSandboxChannelState }) => {
        expect(clearStoppedDockerSandboxChannelState("alpha", EXPECTED_WECHAT_STATE_PATHS)).toEqual(
          {
            cleared: false,
            failure: "sandbox-volume-unavailable",
          },
        );
      },
    );

    expect(runDocker).toHaveBeenCalledOnce();
  });

  it("classifies an unavailable Docker daemon without exposing its error", () => {
    withPrivilegedExecMocks(
      {
        dockerCapture: () => {
          throw new Error("daemon detail must stay private");
        },
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
      },
      ({ clearStoppedDockerSandboxChannelState }) => {
        expect(clearStoppedDockerSandboxChannelState("alpha", EXPECTED_WECHAT_STATE_PATHS)).toEqual(
          {
            cleared: false,
            failure: "docker-discovery-failed",
          },
        );
      },
    );
  });

  it("classifies a missing eligible stopped container", () => {
    withPrivilegedExecMocks(
      {
        dockerCapture: () => "",
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
      },
      ({ clearStoppedDockerSandboxChannelState }) => {
        expect(clearStoppedDockerSandboxChannelState("alpha", EXPECTED_WECHAT_STATE_PATHS)).toEqual(
          {
            cleared: false,
            failure: "no-eligible-stopped-container",
          },
        );
      },
    );
  });

  it("classifies invalid stopped-container ownership metadata", () => {
    withPrivilegedExecMocks(
      {
        dockerCapture: () => `gateway-id\topenshell-gateway-nemoclaw\n`,
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
      },
      ({ clearStoppedDockerSandboxChannelState }) => {
        expect(clearStoppedDockerSandboxChannelState("alpha", EXPECTED_WECHAT_STATE_PATHS)).toEqual(
          {
            cleared: false,
            failure: "container-ownership-invalid",
          },
        );
      },
    );
  });

  it("classifies an unavailable pinned cleanup image", () => {
    const containerId = "a".repeat(64);
    const mounts = JSON.stringify([
      { Type: "volume", Name: "nemoclaw-alpha-state", Destination: "/sandbox", RW: true },
    ]);
    const results = [
      {
        status: 0,
        stdout: `${containerId}\tfalse\t${mounts}\n`,
        stderr: "",
        error: null,
      },
      { status: 1, stdout: "", stderr: "helper detail must stay private", error: null },
    ];
    withPrivilegedExecMocks(
      {
        dockerCapture: () => `${containerId}\topenshell-alpha\n`,
        dockerRun: () => results.shift() as (typeof results)[number],
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
      },
      ({ clearStoppedDockerSandboxChannelState }) => {
        expect(clearStoppedDockerSandboxChannelState("alpha", EXPECTED_WECHAT_STATE_PATHS)).toEqual(
          {
            cleared: false,
            failure: "cleanup-helper-image-unavailable",
          },
        );
      },
    );
  });

  it("reconciles a helper container after an ambiguous create failure", () => {
    const containerId = "a".repeat(64);
    const helperId = "d".repeat(64);
    const sandboxVolume = "nemoclaw-alpha-state";
    const ownerIdentity = createHash("sha256").update("alpha").digest("hex");
    const volumeIdentity = createHash("sha256").update(sandboxVolume).digest("hex");
    const helperName = `nemoclaw-channel-cleanup-${ownerIdentity.slice(0, 24)}`;
    const mounts = JSON.stringify([
      { Type: "volume", Name: sandboxVolume, Destination: "/sandbox", RW: true },
    ]);
    let helperInspections = 0;
    const runDocker = vi.fn((args: readonly string[]) => {
      switch (args[0]) {
        case "image":
          return {
            status: 0,
            stdout: `sha256:${"c".repeat(64)}\n`,
            stderr: "",
            error: null,
          } as const;
        case "create":
          return {
            status: 1,
            stdout: "",
            stderr: "daemon response was interrupted",
            error: null,
          } as const;
        case "rm":
          return { status: 0, stdout: helperId, stderr: "", error: null } as const;
        case "inspect": {
          switch (args.at(-1)) {
            case containerId:
              return {
                status: 0,
                stdout: `${containerId}\tfalse\t${mounts}\n`,
                stderr: "",
                error: null,
              } as const;
            case helperName:
              helperInspections += 1;
              return helperInspections === 1
                ? ({
                    status: 1,
                    stdout: "",
                    stderr: `Error: No such object: ${helperName}`,
                    error: null,
                  } as const)
                : ({
                    status: 0,
                    stdout: `${helperId}\t${PINNED_CLEANUP_IMAGE}\t1\t${ownerIdentity}\t${volumeIdentity}\n`,
                    stderr: "",
                    error: null,
                  } as const);
            default:
              return {
                status: 1,
                stdout: "",
                stderr: `Error: No such container: ${helperId}`,
                error: null,
              } as const;
          }
        }
        default:
          throw new Error(`unexpected Docker argv: ${args.join(" ")}`);
      }
    });

    withPrivilegedExecMocks(
      {
        dockerCapture: () => `${containerId}\topenshell-alpha\n`,
        dockerRun: runDocker,
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
      },
      ({ clearStoppedDockerSandboxChannelState }) => {
        expect(clearStoppedDockerSandboxChannelState("alpha", EXPECTED_WECHAT_STATE_PATHS)).toEqual(
          { cleared: false, failure: "cleanup-helper-failed" },
        );
      },
    );

    expect(runDocker).toHaveBeenCalledWith(
      ["rm", "-f", helperId],
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(helperInspections).toBe(2);
  });

  it.each([
    [43, "cleanup-state-tree-unsafe"],
    [45, "cleanup-deletion-unconfirmed"],
    [125, "cleanup-helper-failed"],
  ] as const)(
    "removes and confirms the named helper before classifying start exit %i as %s",
    (startStatus, expectedFailure) => {
      const containerId = "a".repeat(64);
      const helperId = "e".repeat(64);
      const mounts = JSON.stringify([
        { Type: "volume", Name: "nemoclaw-alpha-state", Destination: "/sandbox", RW: true },
      ]);
      const results = [
        {
          status: 0,
          stdout: `${containerId}\tfalse\t${mounts}\n`,
          stderr: "",
          error: null,
        },
        {
          status: 0,
          stdout: `sha256:${"c".repeat(64)}\n`,
          stderr: "",
          error: null,
        },
        {
          status: 1,
          stdout: "",
          stderr: "Error: No such object: cleanup-helper",
          error: null,
        },
        { status: 0, stdout: `${helperId}\n`, stderr: "", error: null },
        { status: startStatus, stdout: "", stderr: "private helper detail", error: null },
        { status: 0, stdout: helperId, stderr: "", error: null },
        {
          status: 1,
          stdout: "",
          stderr: `Error: No such container: ${helperId}`,
          error: null,
        },
      ];
      const runDocker = vi.fn(
        (_args: readonly string[]) => results.shift() as (typeof results)[number],
      );

      withPrivilegedExecMocks(
        {
          dockerCapture: () => `${containerId}\topenshell-alpha\n`,
          dockerRun: runDocker,
          getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
          listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        },
        ({ clearStoppedDockerSandboxChannelState }) => {
          expect(
            clearStoppedDockerSandboxChannelState("alpha", EXPECTED_WECHAT_STATE_PATHS),
          ).toEqual({ cleared: false, failure: expectedFailure });
        },
      );

      expect(runDocker.mock.calls[4]?.[0]).toEqual(["start", "--attach", helperId]);
      expect(runDocker.mock.calls[5]?.[0]).toEqual(["rm", "-f", helperId]);
      expect(runDocker).toHaveBeenCalledTimes(7);
    },
  );

  it("rejects ambiguous labeled running containers", () => {
    expect(() =>
      selectDirectSandboxContainer(
        "demo",
        "abc123\topenshell-demo-one\ndef456\topenshell-demo-two\n",
        ["demo"],
      ),
    ).toThrow(/Multiple running OpenShell containers.*refusing ambiguous/);
  });

  it("rejects malformed Docker metadata", () => {
    expect(() => selectDirectSandboxContainer("demo", "openshell-demo\n", ["demo"])).toThrow(
      /malformed OpenShell sandbox container metadata/,
    );
  });

  it("rejects an authoritative label and container-name mismatch", () => {
    expect(() =>
      selectDirectSandboxContainer("alpha", "gateway-id\topenshell-gateway-nemoclaw\n", ["alpha"]),
    ).toThrow(/labels and names disagree.*refusing lifecycle execution/);
  });

  it("uses the longest registered sandbox-name match to reject prefix collisions", () => {
    expect(() =>
      selectDirectSandboxContainer("alpha", "child-id\topenshell-alpha-child\n", [
        "alpha",
        "alpha-child",
      ]),
    ).toThrow(/labels and names disagree.*refusing lifecycle execution/);
  });

  it("rejects a workspace-qualified prefix collision owned by a longer sandbox name", () => {
    expect(() =>
      selectDirectSandboxContainer(
        "alpha",
        "child-id\topenshell-default--alpha-child-runtime-id\n",
        ["alpha", "alpha-child"],
      ),
    ).toThrow(/labels and names disagree.*refusing lifecycle execution/);
  });

  it("builds privileged docker exec argv through the registered direct sandbox container", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "vm" }),
        listSandboxes: () => ({
          sandboxes: [{ name: "alpha" }, { name: "alpha-child" }],
          defaultSandbox: "alpha",
        }),
        dockerCapture: () => "immutable-alpha-id\topenshell-default--alpha-abc123\n",
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(privilegedSandboxExecArgv("alpha", ["id"], true)).toEqual([
          "exec",
          "-i",
          "--user",
          "root",
          "immutable-alpha-id",
          "id",
        ]);
      },
    );
  });

  it("rejects every ordinary direct exec while a provider target claim is active", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-direct-exec-gate-"));
    fs.mkdirSync(path.join(stateDir, "runtime-provider-lifecycle"));
    let dockerPsCalls = 0;
    try {
      withPrivilegedExecMocks(
        {
          getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
          listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
          dockerCapture: () => {
            dockerPsCalls += 1;
            return "immutable-alpha-id\topenshell-alpha\n";
          },
          stateMutationGate: { active: true, stateDir },
        },
        ({ privilegedSandboxExecArgv }) => {
          expect(() => privilegedSandboxExecArgv("alpha", ["sh", "-c", "write"])).toThrow(
            /state mutation owns direct-container execution.*provider fence is released/i,
          );
        },
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    expect(dockerPsCalls).toBe(0);
  });

  it("fails closed when a present lifecycle ledger cannot be validated", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-direct-exec-invalid-gate-"));
    fs.symlinkSync(
      path.join(stateDir, "missing-ledger-target"),
      path.join(stateDir, "runtime-provider-lifecycle"),
    );
    let dockerPsCalls = 0;
    try {
      withPrivilegedExecMocks(
        {
          getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
          listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
          dockerCapture: () => {
            dockerPsCalls += 1;
            return "immutable-alpha-id\topenshell-alpha\n";
          },
          stateMutationGate: {
            active: false,
            stateDir,
            storeError: new Error("lifecycle ledger is present but invalid"),
          },
        },
        ({ privilegedSandboxExecArgv }) => {
          expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow(
            /lifecycle ledger is present but invalid/u,
          );
        },
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    expect(dockerPsCalls).toBe(0);
  });

  it("holds the shared exclusion across target check and the complete exec callback", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-direct-exec-lease-"));
    fs.mkdirSync(path.join(stateDir, "runtime-provider-lifecycle"));
    const events: string[] = [];
    let lockHeld = false;
    try {
      withPrivilegedExecMocks(
        {
          getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
          listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
          dockerCapture: () => "immutable-alpha-id\topenshell-alpha\n",
          stateMutationGate: { active: false, stateDir },
          withShieldsTransitionLock: (sandboxName, operation, fn) => {
            events.push(`lock:${sandboxName}:${operation}`);
            lockHeld = true;
            try {
              return fn();
            } finally {
              events.push("unlock");
              lockHeld = false;
            }
          },
        },
        ({ withPrivilegedSandboxExecutionLease }) => {
          const result = withPrivilegedSandboxExecutionLease("alpha", "test subprocess", () => {
            expect(lockHeld).toBe(true);
            events.push("spawn-and-wait");
            return "complete";
          });
          expect(result).toBe("complete");
        },
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    expect(events).toEqual([
      "lock:alpha:privileged direct-container execution: test subprocess",
      "spawn-and-wait",
      "unlock",
    ]);
  });

  it("uses numeric container UID 0 on the receipt-owned portable target (#9054)", () => {
    let dockerPsCalls = 0;
    const assertRuntimeAuthority = vi.fn();
    let backfillRegistryGeneration: ((generation: string) => boolean) | undefined;
    const compareAndSetLegacySandboxLifecycleGeneration = vi.fn(() => true);
    const resolvePortableDemoPrivilegedExecTarget = vi.fn(
      (
        _sandboxName: string,
        deps?: { backfillRegistryGeneration?: (generation: string) => boolean },
      ) => {
        backfillRegistryGeneration = deps?.backfillRegistryGeneration;
        return {
          assertRuntimeAuthority,
          containerId: "a".repeat(64),
          dockerHost: "unix:///run/user/1001/podman/podman.sock",
        };
      },
    );
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({
          name: "alpha",
          lifecycleGeneration: "current-generation",
          openshellDriver: "docker",
        }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: () => {
          dockerPsCalls += 1;
          return "";
        },
        compareAndSetLegacySandboxLifecycleGeneration,
        resolvePortableDemoPrivilegedExecTarget,
      },
      ({ privilegedSandboxExecArgv }) => {
        const argv = privilegedSandboxExecArgv("alpha", ["id"], false, true);
        expect(argv).toEqual([
          "--host",
          "unix:///run/user/1001/podman/podman.sock",
          "exec",
          "--env",
          "BASH_ENV=",
          "--env",
          "ENV=",
          "--env",
          "GCONV_PATH=",
          "--env",
          "GLIBC_TUNABLES=",
          "--env",
          "LD_AUDIT=",
          "--env",
          "LD_LIBRARY_PATH=",
          "--env",
          "LD_PRELOAD=",
          "--env",
          "LOCPATH=",
          "--env",
          "NODE_OPTIONS=",
          "--env",
          "PERL5OPT=",
          "--env",
          "PYTHONHOME=",
          "--env",
          "PYTHONINSPECT=",
          "--env",
          "PYTHONNOUSERSITE=1",
          "--env",
          "PYTHONPATH=",
          "--env",
          "PYTHONSTARTUP=",
          "--env",
          "PYTHONUSERBASE=",
          "--env",
          "RUBYOPT=",
          "--user",
          "0",
          "a".repeat(64),
          "id",
        ]);
        expect(argv).not.toContain("root");
      },
    );
    expect(dockerPsCalls).toBe(0);
    expect(assertRuntimeAuthority).toHaveBeenCalledOnce();
    expect(resolvePortableDemoPrivilegedExecTarget).toHaveBeenCalledWith("alpha", {
      backfillRegistryGeneration: expect.any(Function),
      registryGeneration: "current-generation",
    });
    expect(backfillRegistryGeneration?.("legacy-generation")).toBe(true);
    expect(compareAndSetLegacySandboxLifecycleGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", openshellDriver: "docker" }),
      "legacy-generation",
    );
  });

  it("types a portable-target pinned container identity change", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: vi.fn(),
        resolvePortableDemoPrivilegedExecTarget: () => ({
          assertRuntimeAuthority: vi.fn(),
          containerId: "current-container-id",
          dockerHost: "unix:///run/user/1001/podman/podman.sock",
        }),
      },
      ({ isPinnedSandboxContainerIdentityChangedError, privilegedSandboxExecArgv }) => {
        let refusal: unknown;
        try {
          privilegedSandboxExecArgv("alpha", ["id"], false, true, "previous-container-id");
        } catch (error) {
          refusal = error;
        }
        expect(isPinnedSandboxContainerIdentityChangedError(refusal)).toBe(true);
      },
    );
  });

  it("rejects a non-direct driver before consulting a stale portable receipt (#8584)", () => {
    const resolvePortableDemoPrivilegedExecTarget = vi.fn();

    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "kubernetes" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: vi.fn(),
        resolvePortableDemoPrivilegedExecTarget,
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow(
          "refusing local Docker discovery for a non-direct driver",
        );
      },
    );

    expect(resolvePortableDemoPrivilegedExecTarget).not.toHaveBeenCalled();
  });

  it("keeps ordinary Docker discovery bounded and uses symbolic root (#9054)", () => {
    const discoveryCalls: Array<{
      args: readonly string[];
      timeout: number | undefined;
    }> = [];

    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: (args, options) => {
          discoveryCalls.push({ args, timeout: options?.timeout });
          return "immutable-alpha-id\topenshell-alpha\n";
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(privilegedSandboxExecArgv("alpha", ["id"])).toEqual([
          "exec",
          "--user",
          "root",
          "immutable-alpha-id",
          "id",
        ]);
      },
    );

    expect(discoveryCalls).toEqual([
      {
        args: [
          "ps",
          "--no-trunc",
          "--filter",
          "label=openshell.ai/managed-by=openshell",
          "--filter",
          "label=openshell.ai/sandbox-name=alpha",
          "--format",
          "{{.ID}}\t{{.Names}}",
        ],
        timeout: 5000,
      },
    ]);
  });

  it("clears interpreter and dynamic-loader injection variables for root control", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: () => "immutable-alpha-id\topenshell-alpha\n",
      },
      ({ privilegedSandboxExecArgv }) => {
        const argv = privilegedSandboxExecArgv("alpha", ["/trusted/control"], false, true);
        expect(argv.slice(0, 1)).toEqual(["exec"]);
        expect(argv).toContain("LD_PRELOAD=");
        expect(argv).toContain("LD_LIBRARY_PATH=");
        expect(argv).toContain("LD_AUDIT=");
        expect(argv).toContain("PYTHONPATH=");
        expect(argv).toContain("PYTHONUSERBASE=");
        expect(argv).toContain("PYTHONNOUSERSITE=1");
        expect(argv).toContain("BASH_ENV=");
        expect(argv.slice(-4)).toEqual([
          "--user",
          "root",
          "immutable-alpha-id",
          "/trusted/control",
        ]);
      },
    );
  });

  it("refuses privileged execution when the pinned container identity changed", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: () => "current-container-id\topenshell-alpha\n",
      },
      ({ isPinnedSandboxContainerIdentityChangedError, privilegedSandboxExecArgv }) => {
        let refusal: unknown;
        try {
          privilegedSandboxExecArgv(
            "alpha",
            ["/trusted/control"],
            false,
            true,
            "previous-container-id",
          );
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(Error);
        expect(String(refusal)).toMatch(
          /container identity changed.*refusing privileged execution/i,
        );
        expect(isPinnedSandboxContainerIdentityChangedError(refusal)).toBe(true);
      },
    );
  });

  it("refuses privileged execution when the pinned container identity is empty", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: () => "current-container-id\topenshell-alpha\n",
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() =>
          privilegedSandboxExecArgv("alpha", ["/trusted/control"], false, true, ""),
        ).toThrow(/container identity changed.*refusing privileged execution/i);
      },
    );
  });

  it("fails before docker discovery when the sandbox registry entry is unavailable", () => {
    let dockerPsCalls = 0;
    withPrivilegedExecMocks(
      {
        getSandbox: () => {
          throw new Error("registry corrupt");
        },
        listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
        dockerCapture: () => {
          dockerPsCalls += 1;
          return "child-id\topenshell-alpha-child\n";
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow("registry corrupt");
      },
    );
    expect(dockerPsCalls).toBe(0);
  });

  it("rejects a Kubernetes registry owner before stale local-container discovery", () => {
    let dockerPsCalls = 0;
    const resolvePortableDemoPrivilegedExecTarget = vi.fn(() => ({
      assertRuntimeAuthority: vi.fn(),
      containerId: "a".repeat(64),
      dockerHost: "unix:///run/user/1001/podman/podman.sock",
    }));
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "kubernetes" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        resolvePortableDemoPrivilegedExecTarget,
        dockerCapture: () => {
          dockerPsCalls += 1;
          return "stale-id\topenshell-alpha-stale\n";
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow(
          /driver: kubernetes.*refusing local Docker discovery/i,
        );
      },
    );
    expect(dockerPsCalls).toBe(0);
    expect(resolvePortableDemoPrivilegedExecTarget).not.toHaveBeenCalled();
  });

  it("fails before docker discovery when registry disambiguation is unavailable", () => {
    let dockerPsCalls = 0;
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "vm" }),
        listSandboxes: () => {
          throw new Error("registry list unavailable");
        },
        dockerCapture: () => {
          dockerPsCalls += 1;
          return "child-id\topenshell-alpha-child\n";
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow(
          "registry list unavailable",
        );
      },
    );
    expect(dockerPsCalls).toBe(0);
  });

  it("surfaces docker discovery failures instead of reporting a missing container", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "vm" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: () => {
          throw new Error("docker daemon unavailable");
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow(
          "docker daemon unavailable",
        );
      },
    );
  });

  it("fails clearly when no matching direct sandbox container is running", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "vm" }),
        listSandboxes: () => ({
          sandboxes: [{ name: "alpha" }, { name: "alpha-child" }],
          defaultSandbox: "alpha",
        }),
        dockerCapture: () => "",
      },
      ({ isDirectSandboxFallbackUnavailableError, privilegedSandboxExecArgv }) => {
        let refusal: unknown;
        try {
          privilegedSandboxExecArgv("alpha", ["id"]);
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(Error);
        expect(String(refusal)).toMatch(
          /No running direct OpenShell sandbox container found for 'alpha'/,
        );
        expect(isDirectSandboxFallbackUnavailableError(refusal)).toBe(true);
      },
    );
  });
});
