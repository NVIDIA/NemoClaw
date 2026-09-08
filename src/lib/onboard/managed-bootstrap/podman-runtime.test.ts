// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { PodmanBoundContainerEngine } from "../../adapters/podman";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";

const coordinator = vi.hoisted(() => ({
  activate: vi.fn<typeof import("./adapter").activateManagedBootstrapSequence>(),
  finalize: vi.fn<typeof import("./adapter").finalizeManagedBootstrapSequence>(),
  prepare: vi.fn<typeof import("./adapter").prepareManagedBootstrapSequence>(),
}));

vi.mock("./adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adapter")>()),
  activateManagedBootstrapSequence: coordinator.activate,
  finalizeManagedBootstrapSequence: coordinator.finalize,
  prepareManagedBootstrapSequence: coordinator.prepare,
}));

import type {
  ManagedBootstrapActivatedTransaction,
  ManagedBootstrapAdapter,
  ManagedBootstrapPreparedTransaction,
} from "./adapter";
import {
  createFilePodmanBootstrapJournalStore,
  PODMAN_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  type PodmanBootstrapJournal,
} from "./podman-bootstrap-journal";
import {
  buildPodmanStandaloneGatewayEnvironmentAuthority,
  createPodmanManagedBootstrapAdapter,
  createPodmanManagedBootstrapSurface,
  finishCommittedPodmanBootstrap,
  observePodmanBootstrapReplacementReady,
  preparePodmanManagedWorkspaceAuthority,
  resolvePodmanManagedGatewayAuthority,
  renderPodmanReplacementEnvironment,
  renderPodmanReplacementHealthArgs,
  renderPodmanReplacementMountArgs,
  renderPodmanReplacementRuntimeArgs,
  renderPodmanReplacementSecretArgs,
} from "./podman-runtime";
import { prepareManagedBootstrapStateRoots } from "./state-root-authority";
import type { PodmanGatewayWatcherLease } from "./podman-watcher-lease";
import { PODMAN_WATCHER_LEASE_SCHEMA_VERSION } from "./podman-watcher-lease";

const IDENTITY = "1".repeat(64);
const MANIFEST_DIGEST = `sha256:${"2".repeat(64)}` as const;
const ORIGINAL_RUNTIME_ID = "2".repeat(64);
const REPLACEMENT_RUNTIME_ID = "3".repeat(64);
const SUPERVISOR_IMAGE = "ghcr.io/nvidia/openshell/supervisor:0.0.106";
const LEASE_ID = "123e4567-e89b-42d3-a456-426614174000";
const ENGINE_AUTHORITY_ID = `podman-sha256:${"4".repeat(64)}`;
const STORAGE_GRAPH_ROOT = "/run/user/1000/containers/storage";

function committedJournal(): PodmanBootstrapJournal {
  return {
    schemaVersion: PODMAN_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
    phase: "preparing-replacement",
    bootstrapIdentity: IDENTITY,
    engineAuthorityId: ENGINE_AUTHORITY_ID,
    watcherLeaseId: LEASE_ID,
    sandboxName: "alpha",
    sandboxId: "sandbox-alpha",
    originalRuntimeId: ORIGINAL_RUNTIME_ID,
    originalContainerName: "openshell-default--alpha-sandbox-alpha",
    originalImageContentId: `sha256:${"5".repeat(64)}`,
    originalSpecFingerprint: "6".repeat(64),
    replacementStateVolumeName: "openshell-alpha-bootstrap-state",
    replacementStateVolumeMountpoint: null,
    replacementRuntimeId: null,
    replacementStagingName: "openshell-alpha-bootstrap",
    replacementImageContentId: `sha256:${"7".repeat(64)}`,
    replacementSpecFingerprint: "8".repeat(64),
  };
}

function runtimeInspect(runtimeId: string, name: string, image: string) {
  return {
    Id: runtimeId,
    Name: name,
    Image: image,
    Config: {
      Labels: {
        "openshell.managed": "true",
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-id": "sandbox-alpha",
        "openshell.ai/sandbox-name": "alpha",
        "openshell.ai/sandbox-namespace": "",
        "openshell.ai/sandbox-workspace": "default",
      },
    },
  };
}

function engine(): PodmanBoundContainerEngine {
  return {
    operation: "managed-bootstrap",
    engineId: "podman",
    displayName: "Podman",
    authorityId: "test:podman-authority",
    endpointAuthorityId: "test:podman-endpoint",
    capture: vi.fn(),
    captureHost: vi.fn(),
    assertAuthority: vi.fn(),
  };
}

function adapter() {
  const recoverUnfinishedTransactions = vi.fn(async () => ({ receipts: [], failures: [] }));
  return {
    value: { recoverUnfinishedTransactions } as unknown as ManagedBootstrapAdapter,
    recoverUnfinishedTransactions,
  };
}

function lifecycleInput(adapterOverride: ManagedBootstrapAdapter) {
  const request = createManagedStartupRootApplyRequest({
    agent: "hermes",
    encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile("hermes", false, false)),
  });
  return {
    providerId: "podman",
    environment: {},
    dockerClientEnv: {},
    stateRoot: "/unused/provider-state",
    bootstrapIdentity: IDENTITY,
    request,
    image: {
      repository: "registry.example/nemoclaw/hermes",
      manifestDigest: MANIFEST_DIGEST,
    },
    agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    workspaceRoot: { uid: 1000, gid: 1000, mode: 0o755 as const },
    managedStateRoots: [],
    intendedWorkloadArgv: ["/usr/local/bin/nemoclaw-start"],
    expectedSupervisorArgv: ["/opt/openshell/bin/supervisor"],
    launchArgv: ["openshell", "sandbox", "create", "--name", "alpha"],
    heldWorkloadArgv: ["/usr/local/bin/nemoclaw-managed-startup-hold"],
    authorityStore: { recordPreparedAuthority: vi.fn() },
    adapterOverride,
    route: "none" as const,
    persistStartupCommand: false,
    sandboxName: "alpha",
    sandboxGpuConfig: {
      mode: "0" as const,
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      sandboxGpuDevice: null,
      errors: [],
    },
    requiredLimits: [],
    timeoutSecs: 30,
    network: {
      inferenceProvider: "openai",
      gatewayUsesContainerBridge: false,
      gatewayPort: 8080,
      reverifyBridgeReachability: () => undefined,
    },
    dependencies: {},
  };
}

function installCoordinatorMocks() {
  const prepared = Object.freeze({}) as ManagedBootstrapPreparedTransaction;
  const activated = Object.freeze({}) as ManagedBootstrapActivatedTransaction;
  coordinator.prepare.mockImplementation(async (_adapter, input) => {
    await input.create.launch({
      heldWorkloadArgv: ["/usr/local/bin/nemoclaw-managed-startup-hold"],
      bootstrapIdentity: IDENTITY,
    });
    return prepared;
  });
  coordinator.activate.mockResolvedValue(activated);
  coordinator.finalize.mockResolvedValue({} as never);
  return { activated, prepared };
}

describe("Podman managed-bootstrap runtime surface", () => {
  it.each([
    [8080, "nemoclaw", "openshell-docker-gateway"],
    [18080, "nemoclaw-18080", "openshell-docker-gateway-18080"],
  ])("binds gateway port %i to its runtime authority", (gatewayPort, gatewayName, stateDirName) => {
    expect(resolvePodmanManagedGatewayAuthority({ HOME: "/home/test" }, gatewayPort)).toEqual({
      gatewayName,
      stateDir: `/home/test/.local/state/nemoclaw/${stateDirName}`,
    });
  });

  it("preserves an explicit native gateway state-directory authority", () => {
    expect(
      resolvePodmanManagedGatewayAuthority(
        {
          HOME: "/home/test",
          NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: " /run/user/1000/nemoclaw-gateway ",
        },
        18080,
      ),
    ).toEqual({
      gatewayName: "nemoclaw-18080",
      stateDir: "/run/user/1000/nemoclaw-gateway",
    });
  });

  it("emits exact replacement health until OpenShell observes the sandbox as Ready", () => {
    let time = 0;
    const capture = vi.fn(() => ({
      status: 0,
      stdout: "healthy",
      stderr: "",
      error: undefined,
    }));
    const phases = ["Error", "Ready"];
    const runCaptureOpenshell = vi.fn(() =>
      JSON.stringify({
        id: "sandbox-alpha",
        name: "alpha",
        phase: phases.shift() ?? "Ready",
      }),
    );

    observePodmanBootstrapReplacementReady({
      engine: { ...engine(), capture },
      runtimeId: REPLACEMENT_RUNTIME_ID,
      sandboxName: "alpha",
      sandboxId: "sandbox-alpha",
      gatewayName: "nemoclaw",
      runCaptureOpenshell,
      sleep: (seconds) => {
        time += seconds * 1000;
      },
      now: () => time,
    });

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenNthCalledWith(
      1,
      ["healthcheck", "run", REPLACEMENT_RUNTIME_ID],
      15_000,
    );
    expect(runCaptureOpenshell).toHaveBeenCalledTimes(2);
    expect(runCaptureOpenshell).toHaveBeenLastCalledWith(
      ["sandbox", "get", "-g", "nemoclaw", "alpha", "--output", "json"],
      { ignoreError: true, timeout: 5_000 },
    );
  });

  it("reproduces the OpenShell Podman health contract on the replacement", () => {
    expect(
      renderPodmanReplacementHealthArgs({
        Config: {
          Healthcheck: {
            Test: ["CMD-SHELL", "test -S /var/run/openshell.sock"],
            Interval: 30_000_000_000,
            Timeout: 2_000_000_000,
            Retries: 10,
            StartPeriod: 5_000_000_000,
          },
        },
      }),
    ).toEqual([
      "--health-cmd",
      "test -S /var/run/openshell.sock",
      "--health-interval",
      "30000000000ns",
      "--health-timeout",
      "2000000000ns",
      "--health-retries",
      "10",
      "--health-start-period",
      "5000000000ns",
    ]);
  });

  it("preserves NemoClaw workspace ownership across the managed replacement", () => {
    expect(
      renderPodmanReplacementEnvironment(
        {
          Config: {
            User: "0:0",
            WorkingDir: "/sandbox",
            Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
            Cmd: ["--workdir", "/sandbox"],
            Labels: { "openshell.managed": "true" },
            Env: [
              "OPENSHELL_OCI_IMAGE_USER=1000:1000",
              "OPENSHELL_SANDBOX_UID=",
              "OPENSHELL_SANDBOX_GID=",
              "OPENSHELL_SANDBOX_COMMAND=stale",
              "PATH=/usr/bin",
            ],
          },
        },
        {
          plan: { profile: { agent: "hermes", fingerprint: "a".repeat(64) } },
          bootstrapIdentity: IDENTITY,
          intendedWorkloadArgv: ["/usr/local/bin/nemoclaw-start"],
        } as never,
      ),
    ).toEqual([
      "OPENSHELL_SANDBOX_UID=",
      "OPENSHELL_SANDBOX_GID=",
      "PATH=/usr/bin",
      "OPENSHELL_SANDBOX_COMMAND=/usr/local/bin/nemoclaw-start",
      "NEMOCLAW_MANAGED_BOOTSTRAP_DROP_CAPABILITIES=0x32",
    ]);
  });

  it("reproduces the OpenShell supervisor image mount on the bootstrap replacement", () => {
    expect(
      renderPodmanReplacementMountArgs(
        {
          Id: ORIGINAL_RUNTIME_ID,
          Mounts: [
            {
              Type: "image",
              Source: SUPERVISOR_IMAGE,
              Destination: "/opt/openshell/bin",
              RW: false,
            },
          ],
        },
        STORAGE_GRAPH_ROOT,
      ),
    ).toEqual([
      "--mount",
      `type=image,source=${SUPERVISOR_IMAGE},destination=/opt/openshell/bin,rw=false`,
    ]);
  });

  it("collapses Podman's materialized supervisor bind into its image-mount identity", () => {
    const image = SUPERVISOR_IMAGE;
    expect(
      renderPodmanReplacementMountArgs(
        {
          Id: ORIGINAL_RUNTIME_ID,
          Mounts: [
            {
              Type: "image",
              Source: image,
              Destination: "/opt/openshell/bin",
              RW: false,
            },
            {
              Type: "bind",
              Source:
                `${STORAGE_GRAPH_ROOT}/overlay-containers/${ORIGINAL_RUNTIME_ID}` +
                "/userdata/overlay/example/merge",
              Destination: "/opt/openshell/bin",
              RW: true,
            },
          ],
        },
        STORAGE_GRAPH_ROOT,
      ),
    ).toEqual(["--mount", `type=image,source=${image},destination=/opt/openshell/bin,rw=false`]);
  });

  it("rejects unrelated Podman mounts with the same destination", () => {
    expect(() =>
      renderPodmanReplacementMountArgs(
        {
          Id: ORIGINAL_RUNTIME_ID,
          Mounts: [
            {
              Type: "bind",
              Source: "/srv/first",
              Destination: "/sandbox/state",
              RW: true,
            },
            {
              Type: "bind",
              Source: "/srv/second",
              Destination: "/sandbox/state",
              RW: true,
            },
          ],
        },
        STORAGE_GRAPH_ROOT,
      ),
    ).toThrow("mount destination resolves to ambiguous runtime mounts");
  });

  it("rejects an image mount paired with another container's storage bind", () => {
    expect(() =>
      renderPodmanReplacementMountArgs(
        {
          Id: ORIGINAL_RUNTIME_ID,
          Mounts: [
            {
              Type: "image",
              Source: SUPERVISOR_IMAGE,
              Destination: "/opt/openshell/bin",
              RW: false,
            },
            {
              Type: "bind",
              Source:
                `${STORAGE_GRAPH_ROOT}/overlay-containers/${"f".repeat(64)}` +
                "/userdata/overlay/example/merge",
              Destination: "/opt/openshell/bin",
              RW: true,
            },
          ],
        },
        STORAGE_GRAPH_ROOT,
      ),
    ).toThrow("mount destination resolves to ambiguous runtime mounts");
  });

  it("restores the exact OpenShell named-volume workspace authority before replacement start", () => {
    const mountpoint =
      "/home/test/.local/share/containers/storage/volumes/openshell-sandbox-sandbox-alpha-workspace/_data";
    const prepareManagedWorkspaceRoot = vi.fn(() => ({
      path: mountpoint,
      device: "8",
      inode: "9001",
      uid: 0,
      gid: 999,
      mode: 0o1775 as const,
    }));
    const capture = vi.fn(() => ({
      status: 0,
      stdout: `openshell-sandbox-sandbox-alpha-workspace\n${mountpoint}\n`,
      stderr: "",
      error: undefined,
    }));

    preparePodmanManagedWorkspaceAuthority({
      engine: { ...engine(), capture, prepareManagedWorkspaceRoot },
      inspect: {
        Mounts: [
          {
            Type: "volume",
            Name: "openshell-sandbox-sandbox-alpha-workspace",
            Driver: "local",
            Source: mountpoint,
            Destination: "/sandbox",
            RW: true,
          },
        ],
      },
      sandboxId: "sandbox-alpha",
      workspaceRoot: { uid: 0, gid: 999, mode: 0o1775 },
    });

    expect(capture).toHaveBeenCalledExactlyOnceWith(
      [
        "volume",
        "inspect",
        "--format",
        "{{.Name}}\n{{.Mountpoint}}",
        "openshell-sandbox-sandbox-alpha-workspace",
      ],
      15_000,
    );
    expect(prepareManagedWorkspaceRoot).toHaveBeenCalledExactlyOnceWith({
      path: mountpoint,
      uid: 0,
      gid: 999,
      mode: 0o1775,
    });
  });

  it("prepares a synthetic declared state root without provider-specific agent logic", () => {
    const mountpoint =
      "/home/test/.local/share/containers/storage/volumes/synthetic-state-alpha/_data";
    const prepareManagedVolumeRoot = vi.fn(() => ({
      path: mountpoint,
      device: "8",
      inode: "9002",
      uid: 1000,
      gid: 1000,
      mode: 0o3770 as const,
    }));
    const labels = {
      "io.nvidia.nemoclaw.synthetic-state.managed": "true",
      "io.nvidia.nemoclaw.synthetic-state.sandbox": "alpha",
    };
    const captureVolume = vi.fn(
      () => `synthetic-state-alpha\n${mountpoint}\n${JSON.stringify(labels)}\n`,
    );

    prepareManagedBootstrapStateRoots({
      inspect: {
        Mounts: [
          {
            Type: "volume",
            Name: "synthetic-state-alpha",
            Driver: "local",
            Source: mountpoint,
            Destination: "/sandbox/.synthetic",
            RW: true,
          },
        ],
      },
      roots: [
        {
          mountTarget: "/sandbox/.synthetic",
          resourceIdentity: "synthetic-state-alpha",
          ownershipLabels: labels,
          uid: 1000,
          gid: 1000,
          mode: 0o3770,
          readWrite: true,
        },
      ],
      captureVolume,
      prepareRoot: prepareManagedVolumeRoot,
    });

    expect(captureVolume).toHaveBeenCalledExactlyOnceWith([
      "inspect",
      "--format",
      "{{.Name}}\n{{.Mountpoint}}\n{{json .Labels}}",
      "synthetic-state-alpha",
    ]);
    expect(prepareManagedVolumeRoot).toHaveBeenCalledExactlyOnceWith({
      path: mountpoint,
      uid: 1000,
      gid: 1000,
      mode: 0o3770,
    });
  });

  it("reproduces the exact OpenShell Podman token secret on the replacement", () => {
    const secretId = "secret-identity";
    const capture = vi.fn(() => ({
      status: 0,
      stdout: `${secretId}\n`,
      stderr: "",
      error: undefined,
    }));

    expect(
      renderPodmanReplacementSecretArgs(
        { ...engine(), capture },
        {
          Config: {
            Cmd: ["--workdir", "/sandbox"],
            Env: ["OPENSHELL_SANDBOX_TOKEN_FILE=/run/secrets/openshell-token"],
            Secrets: [
              {
                Name: "openshell-token-sandbox-alpha",
                ID: secretId,
                UID: 0,
                GID: 0,
                Mode: 0o400,
              },
            ],
          },
        },
        "sandbox-alpha",
      ),
    ).toEqual([
      "--secret",
      "openshell-token-sandbox-alpha,target=/run/secrets/openshell-token,uid=0,gid=0,mode=0400",
    ]);
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      ["secret", "inspect", "--format", "{{.ID}}", "openshell-token-sandbox-alpha"],
      15_000,
    );
  });

  it("reproduces OpenShell's provider-owned Podman launch authority", () => {
    expect(
      renderPodmanReplacementRuntimeArgs({
        Config: {
          User: "0:0",
          Hostname: "sandbox-alpha",
          WorkingDir: "/",
          StopTimeout: 10,
        },
        HostConfig: {
          CapAdd: ["CAP_SYS_ADMIN", "NET_ADMIN"],
          CapDrop: [
            "KILL",
            "CHOWN",
            "DAC_OVERRIDE",
            "FOWNER",
            "FSETID",
            "SETGID",
            "SETUID",
            "NET_RAW",
          ],
          SecurityOpt: ["no-new-privileges", "seccomp=unconfined"],
          ExtraHosts: ["host.openshell.internal:10.89.0.1"],
          GroupAdd: ["44"],
          Tmpfs: { "/run/netns": "rw,nosuid,nodev" },
          PortBindings: {
            "22/tcp": [{ HostIp: "127.0.0.1", HostPort: "32122" }],
          },
          Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 2048 }],
          Memory: 2_147_483_648,
          PidsLimit: 2048,
          OomScoreAdj: 500,
        },
      }),
    ).toEqual([
      "--user",
      "0:0",
      "--hostname",
      "sandbox-alpha",
      "--workdir",
      "/",
      "--stop-timeout",
      "10",
      "--cap-add",
      "SYS_ADMIN",
      "--cap-add",
      "NET_ADMIN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FSETID",
      "--cap-add",
      "KILL",
      "--cap-drop",
      "CHOWN",
      "--cap-drop",
      "FOWNER",
      "--cap-drop",
      "SETGID",
      "--cap-drop",
      "SETUID",
      "--cap-drop",
      "NET_RAW",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      "seccomp=unconfined",
      "--add-host",
      "host.openshell.internal:10.89.0.1",
      "--group-add",
      "44",
      "--tmpfs",
      "/run/netns:rw,nosuid,nodev",
      "--publish",
      "127.0.0.1:32122:22/tcp",
      "--ulimit",
      "nofile=1024:2048",
      "--memory",
      "2147483648",
      "--pids-limit",
      "2048",
      "--oom-score-adj",
      "500",
    ]);
  });

  it("persists only non-secret native gateway launch environment", () => {
    const first = buildPodmanStandaloneGatewayEnvironmentAuthority({
      PATH: "/usr/bin",
      OPENSHELL_DRIVERS: "podman",
      OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      NVIDIA_API_KEY: "first-secret",
      GH_TOKEN: "first-token",
      NEMOCLAW_BOOTSTRAP_PAYLOAD: "first-bootstrap-payload",
    });
    const changedSecrets = buildPodmanStandaloneGatewayEnvironmentAuthority({
      PATH: "/usr/bin",
      OPENSHELL_DRIVERS: "podman",
      OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
      DOCKER_HOST: "tcp://unrelated-docker:2375",
      NVIDIA_API_KEY: "changed-secret",
      GH_TOKEN: "changed-token",
      NEMOCLAW_BOOTSTRAP_PAYLOAD: "changed-bootstrap-payload",
    });

    expect(changedSecrets).toEqual(first);
    expect(first.map((entry) => entry.key)).toEqual([
      "OPENSHELL_DRIVERS",
      "OPENSHELL_PODMAN_SOCKET",
      "PATH",
    ]);
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(JSON.stringify(first)).not.toContain("token");
    expect(JSON.stringify(first)).not.toContain("DOCKER_HOST");
    expect(JSON.stringify(first)).not.toContain("NEMOCLAW_BOOTSTRAP_PAYLOAD");
    expect(JSON.stringify(first)).not.toContain(
      createHash("sha256").update("first-bootstrap-payload", "utf8").digest("hex"),
    );
  });

  it.each([
    ["after original removal", "openshell-alpha-bootstrap", true],
    ["after replacement rename", "openshell-default--alpha-sandbox-alpha", false],
  ])("finishes an authorized commit crash %s", (_label, replacementName, expectsRename) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-runtime-commit-"));
    try {
      const store = createFilePodmanBootstrapJournalStore(root);
      const initial = committedJournal();
      store.create(initial);
      store.recordStateVolume(IDENTITY, "/var/lib/containers/storage/volumes/alpha/_data");
      store.recordReplacement(IDENTITY, REPLACEMENT_RUNTIME_ID);
      store.recordOriginalStopped(IDENTITY);
      const authorized = store.authorizeCommit(IDENTITY, ["original-stopped"]);
      const runtimes = new Map([
        [
          REPLACEMENT_RUNTIME_ID,
          runtimeInspect(REPLACEMENT_RUNTIME_ID, replacementName, `sha256:${"7".repeat(64)}`),
        ],
      ]);
      const capture = vi.fn((args: readonly string[]) => {
        const [kind, command, runtimeId, renameTarget] = args;
        const exactRuntimeId = typeof runtimeId === "string" ? runtimeId : "";
        const unsupported = () => ({
          status: 2,
          stdout: "",
          stderr: "unsupported",
          error: undefined,
        });
        const handlers: Record<string, () => ReturnType<typeof unsupported>> = {
          exists: () => ({
            status: runtimes.has(exactRuntimeId) ? 0 : 1,
            stdout: "",
            stderr: "",
            error: undefined,
          }),
          inspect: () => {
            const inspected = runtimes.get(exactRuntimeId);
            return {
              status: inspected ? 0 : 1,
              stdout: inspected ? JSON.stringify([inspected]) : "",
              stderr: "",
              error: undefined,
            };
          },
          rm: () => {
            runtimes.delete(exactRuntimeId);
            return { status: 0, stdout: "", stderr: "", error: undefined };
          },
          rename: () => {
            const inspected = runtimes.get(exactRuntimeId);
            const target = typeof renameTarget === "string" ? renameTarget : "";
            inspected && (inspected.Name = target);
            return {
              status: inspected && target ? 0 : 1,
              stdout: "",
              stderr: "",
              error: undefined,
            };
          },
        };
        return kind === "container" && exactRuntimeId
          ? (handlers[command ?? ""] ?? unsupported)()
          : unsupported();
      });
      const commitEngine = {
        ...engine(),
        authorityId: ENGINE_AUTHORITY_ID,
        capture,
      } as PodmanBoundContainerEngine;
      const lease = {
        record: {
          schemaVersion: PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          launchIdentity: "launch",
          ownerIdentity: "owner",
          ownerKind: "standalone",
          pid: 4100,
          processStartIdentity: "start",
          holder: { pid: 9100, processStartIdentity: "holder" },
          leaseId: LEASE_ID,
          phase: "stopped",
        },
        assertStillHeld: vi.fn(),
        assertStillStopped: vi.fn(),
        resumeForObservationAndProve: vi.fn(),
        requiesceAndProve: vi.fn(),
        resumeAndProve: vi.fn(),
      } satisfies PodmanGatewayWatcherLease;

      expect(
        finishCommittedPodmanBootstrap({
          engine: commitEngine,
          journalStore: store,
          journal: authorized,
          watcherLease: lease,
        }).phase,
      ).toBe("committed");
      expect(store.load(IDENTITY)).toBeNull();
      expect(runtimes.get(REPLACEMENT_RUNTIME_ID)?.Name).toBe(
        "openshell-default--alpha-sandbox-alpha",
      );
      expect(capture.mock.calls.some(([args]) => Array.isArray(args) && args[1] === "rename")).toBe(
        expectsRename,
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("recovers a terminal cleanup crash that left only the watcher lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-runtime-recovery-"));
    const recoverUnfinishedLease = vi.fn();
    try {
      const adapter = createPodmanManagedBootstrapAdapter({
        engine: engine(),
        stateRoot: root,
        environment: {},
        gatewayPort: 8080,
        workspaceRoot: { uid: 998, gid: 999, mode: 0o755 },
        watcherController: {
          recoverUnfinishedLease,
          reclaimStoppedLease: vi.fn(),
          quiesceAndProve: vi.fn(),
        },
      });

      await expect(adapter.recoverUnfinishedTransactions()).resolves.toEqual({
        receipts: [],
        failures: [],
      });
      expect(recoverUnfinishedLease).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("selects the Podman provider and keeps compatibility routing disabled", () => {
    const operationEngine = engine();
    const surface = createPodmanManagedBootstrapSurface(operationEngine);
    const routing = surface.createOnboardRouting({
      sandboxName: "alpha",
      openshellArgv: (args) => args,
      nativeFallbackEnabled: true,
    });

    expect(surface.providerId).toBe("podman");
    expect(surface.supported).toBe(true);
    expect(routing.nativeFallbackHasCleanBaseline).toBe(false);
    expect(routing.inspectNativeRuntime()).toBeNull();
    expect(routing.isNativeCreateRoutingFailure("failure", true)).toBe(false);
    expect(() =>
      routing.prepareCompatibilityLaunch({
        createArgs: [],
        currentRegistryImageRef: null,
        managedImageReference:
          "nvcr.io/nvidia/nemoclaw/hermes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        prebuildImageId: null,
        allowUnbuiltSource: false,
        compatibilityPolicyPath: "/unused/policy.yaml",
        startupCommand: [],
        runtimeSnapshot: null,
      }),
    ).toThrow("does not use Docker compatibility fallback");
    expect(operationEngine.capture).not.toHaveBeenCalled();
  });

  it("wires recovery and commit through the selected provider without eager engine dispatch", async () => {
    vi.clearAllMocks();
    installCoordinatorMocks();
    const operationEngine = engine();
    const injected = adapter();
    const lifecycle = createPodmanManagedBootstrapSurface(operationEngine).createLifecycle(
      lifecycleInput(injected.value),
    );

    await expect(lifecycle.recoverUnfinished()).resolves.toEqual({ receipts: [], failures: [] });
    await expect(
      lifecycle.runCreate(async ({ bootstrapIdentity }) => ({
        value: "created",
        receipt: {
          sandbox: { sandboxName: "alpha", sandboxId: "sandbox-alpha", driverId: "podman" },
          ready: true,
          readyAt: "2026-08-22T00:00:00.000Z",
        },
        bootstrapIdentity,
      })),
    ).resolves.toBe("created");
    await lifecycle.patch.commitAfterReady();

    expect(injected.recoverUnfinishedTransactions).toHaveBeenCalledOnce();
    expect(coordinator.prepare).toHaveBeenCalledOnce();
    expect(coordinator.activate).toHaveBeenCalledOnce();
    expect(coordinator.finalize).toHaveBeenCalledExactlyOnceWith(
      injected.value,
      expect.objectContaining({ outcome: "commit" }),
    );
    expect(operationEngine.capture).not.toHaveBeenCalled();
  });

  it("uses Podman's all-GPU CDI authority when no exact device was selected", async () => {
    vi.clearAllMocks();
    installCoordinatorMocks();
    const injected = adapter();
    const input = lifecycleInput(injected.value);
    const lifecycle = createPodmanManagedBootstrapSurface(engine()).createLifecycle({
      ...input,
      sandboxGpuConfig: {
        ...input.sandboxGpuConfig,
        mode: "1",
        hostGpuDetected: true,
        hostGpuPlatform: "linux",
        sandboxGpuEnabled: true,
      },
    });

    await lifecycle.runCreate(async () => ({
      value: "created",
      receipt: {
        sandbox: { sandboxName: "alpha", sandboxId: "sandbox-alpha", driverId: "podman" },
        ready: true,
        readyAt: "2026-08-22T00:00:00.000Z",
      },
    }));

    expect(coordinator.prepare).toHaveBeenCalledWith(
      injected.value,
      expect.objectContaining({
        replacementOptions: { values: expect.objectContaining({ gpuModeArgs: ["--gpus", "all"] }) },
      }),
    );
  });

  it("wires rollback through the same provider-owned terminal transaction", async () => {
    vi.clearAllMocks();
    installCoordinatorMocks();
    const operationEngine = engine();
    const injected = adapter();
    const lifecycle = createPodmanManagedBootstrapSurface(operationEngine).createLifecycle(
      lifecycleInput(injected.value),
    );

    await lifecycle.runCreate(async () => ({
      value: "created",
      receipt: {
        sandbox: { sandboxName: "alpha", sandboxId: "sandbox-alpha", driverId: "podman" },
        ready: true,
        readyAt: "2026-08-22T00:00:00.000Z",
      },
    }));
    await lifecycle.patch.rollbackManagedStartupAfterCreateFailure();

    expect(coordinator.finalize).toHaveBeenCalledExactlyOnceWith(
      injected.value,
      expect.objectContaining({ outcome: "rollback" }),
    );
    expect(operationEngine.capture).not.toHaveBeenCalled();
  });

  it("rejects lifecycle construction for another provider identity", () => {
    const injected = adapter();
    expect(() =>
      createPodmanManagedBootstrapSurface(engine()).createLifecycle({
        ...lifecycleInput(injected.value),
        providerId: "docker",
      }),
    ).toThrow("another provider identity");
  });
});
