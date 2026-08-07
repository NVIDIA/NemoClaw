// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { SystemReadinessReport } from "../../readiness/types.js";
import {
  confirmManagedClusterManagedServingCapability,
  createManagedClusterDiscoveryDeps,
  type ManagedClusterConnectivityRequest,
  type ManagedClusterDetectedManagedServingCapability,
  type ManagedClusterDiscoveryDeps,
  type ManagedClusterHostObservation,
  type ManagedClusterReadOnlyHostTransport,
  type ManagedClusterSpawnSync,
  NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV,
  NEMOCLAW_SERVING_PRESET_ENV,
  parseManagedClusterHostObservation,
  probeManagedClusterManagedServingCapability,
} from "./managed-cluster-discovery.js";
import {
  FIXTURE_MANAGED_CLUSTER_PRESET_ID,
  STOPPED_FOREIGN_CONTAINER_FIXTURES,
} from "./managed-cluster-fixture.test-support.js";
import { MANAGED_CLUSTER_MANAGED_LABEL } from "./managed-cluster-materialize.js";
import {
  type ManagedVllmSshBinding,
  managedVllmKnownHostsDigest,
  type QualifiedManagedVllmSshIdentity,
} from "./managed-cluster-ssh-binding.js";

const NOW = new Date("2026-08-02T20:00:00.000Z");
const SOURCE_REVISION = "1d6948d89b46eab739728215f9a19ef40b8f6121";
const REQUIRED_CAPABILITIES = [
  "host.platform.supported",
  "host.platform.dgx_spark",
  "host.docker.available",
  "host.docker.daemon_reachable",
  "host.docker.runtime_supported",
  "host.docker.storage_compatible",
  "host.gpu.nvidia_available",
  "host.gpu.container_toolkit_available",
  "host.gpu.cdi_healthy",
] as const;

function expectDetectedCluster(
  detected: ReturnType<typeof probeManagedClusterManagedServingCapability>,
): ManagedClusterDetectedManagedServingCapability {
  expect(detected.kind).toBe("ready");
  return detected as ManagedClusterDetectedManagedServingCapability;
}

function readiness(overrides: Partial<SystemReadinessReport> = {}): SystemReadinessReport {
  return {
    schemaVersion: "1.1.0",
    status: "supported",
    exitCode: 0,
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: SOURCE_REVISION,
      observedAt: NOW.toISOString(),
    },
    observations: [],
    capabilities: REQUIRED_CAPABILITIES.map((id) => ({
      id,
      state: "present" as const,
    })),
    qualifications: [
      {
        id: "host.platform.dgx_spark",
        status: "qualified",
        capabilityIds: ["host.platform.dgx_spark"],
      },
    ],
    findings: [],
    evidence: [],
    ...overrides,
  } as SystemReadinessReport;
}

function capacity(
  requestedPath: string,
  uid: number,
  gid: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    requestedPath,
    probePath: requestedPath,
    filesystemId: requestedPath.includes("docker") ? "docker-fs" : "home-fs",
    availableBytes: 400_000_000_000,
    availableInodes: 1_000_000,
    ownerUid: uid,
    ownerGid: gid,
    isDirectory: true,
    writableByUser: true,
    ...overrides,
  };
}

function host(
  role: "local" | "peer",
  overrides: Partial<ManagedClusterHostObservation> = {},
): ManagedClusterHostObservation {
  const local = role === "local";
  const uid = 1000;
  const gid = 1000;
  const home = "/home/nvidia";
  const rail = (index: 0 | 1) => {
    const third = 100 + index;
    const address = `192.168.${String(third)}.${local ? "1" : "2"}`;
    return {
      physicalPortId: local ? "cx7-local" : "cx7-peer",
      netdev: `enp${String(index + 1)}s0f0np0`,
      hcaDevice: `rocep${String(index + 1)}s0f0`,
      hcaPort: 1,
      macAddress: local
        ? `02:00:00:00:00:0${String(index + 1)}`
        : `02:00:00:00:01:0${String(index + 1)}`,
      pciAddress: `0000:0${String(index + 1)}:00.0`,
      pciName: "NVIDIA Mellanox ConnectX-7",
      state: "4: ACTIVE",
      operState: "up",
      carrier: true,
      linkLayer: "Ethernet",
      speedMbps: 200_000,
      mtu: 9000,
      ipv4Addresses: [{ address, prefixLength: 30 }],
      roceV2Ipv4Gids: [
        {
          index: 3 + index,
          value: `::ffff:192.168.${String(third)}.${local ? "1" : "2"}`,
          ipv4Address: address,
        },
      ],
    };
  };
  const cacheRoot = `${home}/.cache/huggingface`;
  return {
    schemaVersion: 1,
    hostname: local ? "spark-head" : "spark-worker",
    nodeId: local ? "11111111111111111111111111111111" : "22222222222222222222222222222222",
    productName: "NVIDIA DGX Spark",
    architecture: "aarch64",
    home,
    username: "nvidia",
    uid,
    gid,
    gpus: [
      {
        index: 0,
        name: "NVIDIA GB10",
        uuid: local
          ? "GPU-11111111-1111-1111-1111-111111111111"
          : "GPU-22222222-2222-2222-2222-222222222222",
      },
    ],
    rails: [rail(0), rail(1)],
    earlyoom: { installed: false, active: "inactive", enabled: "disabled" },
    runtimeInspectionComplete: true,
    runtimeSnapshot: { containers: [], listeningPorts: [] },
    storage: {
      huggingFace: {
        ...capacity(cacheRoot, uid, gid),
        cacheRoot,
      },
      docker: {
        ...capacity("/var/lib/docker", 0, 0),
        dockerRootDir: "/var/lib/docker",
      },
    },
    ...overrides,
  };
}

const transport = (name: string): ManagedClusterReadOnlyHostTransport => ({
  execute: () => ({ status: 0, stdout: name, stderr: "" }),
  readFile: () => name,
  readdir: () => [],
});

function identity(target: string): QualifiedManagedVllmSshIdentity {
  const knownHostsLines = [`${target} ssh-ed25519 AAAA`];
  return {
    requestedTarget: target,
    sshTarget: target,
    resolvedHost: target,
    sshUser: "nvidia",
    port: 22,
    lookupHost: target,
    hostKeyDigest: managedVllmKnownHostsDigest(`${knownHostsLines.join("\n")}\n`),
    knownHostsLines,
  };
}

function binding(peerIdentity: QualifiedManagedVllmSshIdentity): ManagedVllmSshBinding {
  return {
    schemaVersion: 2,
    peerTarget: peerIdentity.sshTarget,
    resolvedHost: peerIdentity.resolvedHost,
    sshUser: peerIdentity.sshUser,
    port: peerIdentity.port,
    lookupHost: peerIdentity.lookupHost,
    hostKeyDigest: peerIdentity.hostKeyDigest,
    bindingFile: "/state/binding.json",
    dockerCliFile: "/usr/bin/docker",
    dockerShimFile: "/state/docker",
    dockerShimSha256: "a".repeat(64),
    knownHostsFile: "/state/known_hosts",
    knownHostsSha256: "b".repeat(64),
    sshWrapperDirectory: "/state/bin",
    sshWrapperFile: "/state/bin/ssh",
    sshWrapperSha256: "c".repeat(64),
  };
}

function fixture(overrides: Partial<ManagedClusterDiscoveryDeps> = {}) {
  const events: string[] = [];
  const localTransport = transport("local");
  const peerTransports = new Map([
    ["192.168.100.2", transport("peer-100")],
    ["192.168.101.2", transport("peer-101")],
  ]);
  let bindingWrites = 0;
  const deps: ManagedClusterDiscoveryDeps = {
    now: () => NOW,
    currentUid: () => 1000,
    getBuildIdentity: () => ({
      nemoclawVersion: "0.1.0",
      sourceRevision: SOURCE_REVISION,
    }),
    localTransport: () => localTransport,
    probeHost: (candidate) => (candidate === localTransport ? host("local") : host("peer")),
    inspectPretrustedTarget: (target) => identity(target),
    openPinnedPeerTransport: (peerIdentity) => {
      events.push(`open:${peerIdentity.requestedTarget}`);
      return {
        transport: peerTransports.get(peerIdentity.requestedTarget) ?? transport("explicit-peer"),
        close: () => events.push(`close:${peerIdentity.requestedTarget}`),
      };
    },
    createReadiness: (observedHost) => {
      events.push(`readiness:${observedHost.hostname}`);
      return readiness();
    },
    probeConnectivity: (_candidate, requests) => {
      events.push(`connectivity:${requests[0]?.sourceAddress ?? "missing"}`);
      return null;
    },
    claimBinding: () => true,
    writeBinding: (_statePath, peerIdentity) => {
      bindingWrites += 1;
      events.push("write-binding");
      return binding(peerIdentity);
    },
    clearBinding: () => events.push("clear-binding"),
    encodeBinding: () => "binding-token",
    resolveBindingStatePath: () => "/state/managed-cluster.json",
    ...overrides,
  };
  return { deps, events, bindingWrites: () => bindingWrites, localTransport };
}

describe("managed DGX Spark cluster discovery", () => {
  it("accepts the bounded production observation and rejects malformed cache metadata", () => {
    const observed = host("local");
    expect(parseManagedClusterHostObservation(observed)).toBe(observed);
    expect(() =>
      parseManagedClusterHostObservation({
        ...observed,
        storage: {
          ...observed.storage,
          huggingFace: { ...observed.storage.huggingFace, isDirectory: "yes" },
        },
      }),
    ).toThrow("DGX Spark host observation is invalid");
  });

  it("does nothing when another serving preset is selected", () => {
    const { deps, events, bindingWrites } = fixture({
      localTransport: () => {
        throw new Error("must not probe");
      },
    });

    expect(
      probeManagedClusterManagedServingCapability({
        env: { [NEMOCLAW_SERVING_PRESET_ENV]: "another-preset" },
        deps,
      }),
    ).toEqual({
      kind: "not-selected",
      code: "no-match",
      reason: "Another managed inference preset is selected.",
    });
    expect(events).toEqual([]);
    expect(bindingWrites()).toBe(0);
  });

  it("rejects an explicit managed cluster peer combined with another serving preset", () => {
    const { deps, events, bindingWrites } = fixture({
      localTransport: () => {
        throw new Error("must not probe");
      },
    });

    expect(
      probeManagedClusterManagedServingCapability({
        env: {
          [NEMOCLAW_SERVING_PRESET_ENV]: "another-preset",
          [NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV]: "spark-worker.local",
        },
        deps,
      }),
    ).toMatchObject({ kind: "unavailable", code: "incompatible-selection" });
    expect(events).toEqual([]);
    expect(bindingWrites()).toBe(0);
  });

  it("fails closed when an explicit preset catalog cannot be loaded", () => {
    const { deps, events, bindingWrites } = fixture({
      localTransport: () => {
        throw new Error("must not probe");
      },
    });

    expect(
      probeManagedClusterManagedServingCapability({
        env: { [NEMOCLAW_SERVING_PRESET_ENV]: FIXTURE_MANAGED_CLUSTER_PRESET_ID },
        deps,
        loadCatalog: () => {
          throw new Error("catalog unavailable");
        },
      }),
    ).toMatchObject({ kind: "unavailable", code: "incompatible-selection" });
    expect(events).toEqual([]);
    expect(bindingWrites()).toBe(0);
  });

  it("persists bindings only after the detected cluster is confirmed and revalidated", () => {
    const { deps, events, bindingWrites } = fixture();

    const detected = expectDetectedCluster(
      probeManagedClusterManagedServingCapability({ env: {}, deps }),
    );

    expect(detected).toMatchObject({
      kind: "ready",
      selectionIntent: "automatic",
      sshClaims: [{ statePath: "/state/managed-cluster.json" }],
      local: { hostname: "spark-head", uid: 1000 },
      peers: [{ hostname: "spark-worker", uid: 1000 }],
      topology: { status: "qualified" },
    });
    expect(bindingWrites()).toBe(0);
    expect(events).not.toContain("write-binding");
    const confirmed = confirmManagedClusterManagedServingCapability(detected, {
      env: {},
      deps,
    });

    expect(confirmed).toMatchObject({
      kind: "ready",
      sshBindings: [{ handle: "binding-token" }],
      topology: {
        output: { peers: [{ sshBindingHandle: "binding-token" }] },
      },
    });
    expect(bindingWrites()).toBe(1);
    expect(events.filter((event) => event.startsWith("open:"))).toEqual([
      "open:192.168.100.2",
      "open:192.168.101.2",
      "open:192.168.100.2",
      "open:192.168.101.2",
    ]);
    expect(events.indexOf("write-binding")).toBeGreaterThan(
      events.lastIndexOf("readiness:spark-worker"),
    );
    expect(events.filter((event) => event.startsWith("close:"))).toHaveLength(4);
  });

  it("returns an ordinary automatic no-match when both rails are not pretrusted", () => {
    const { deps, bindingWrites } = fixture({
      inspectPretrustedTarget: () => null,
    });

    expect(probeManagedClusterManagedServingCapability({ env: {}, deps })).toMatchObject({
      kind: "not-selected",
      code: "no-match",
    });
    expect(bindingWrites()).toBe(0);
  });

  it("makes the same peer failure hard when the exact preset was requested", () => {
    const { deps } = fixture({ inspectPretrustedTarget: () => null });

    expect(
      probeManagedClusterManagedServingCapability({
        env: { [NEMOCLAW_SERVING_PRESET_ENV]: FIXTURE_MANAGED_CLUSTER_PRESET_ID },
        deps,
      }),
    ).toMatchObject({ kind: "unavailable", code: "peer-trust-unavailable" });
  });

  it("makes an explicit peer failure hard", () => {
    const { deps } = fixture({ inspectPretrustedTarget: () => null });

    expect(
      probeManagedClusterManagedServingCapability({
        env: { [NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV]: "spark-worker.local" },
        deps,
      }),
    ).toMatchObject({ kind: "unavailable", code: "peer-trust-unavailable" });
  });

  it("does not merge rail addresses that have different host-key identities", () => {
    const { deps, bindingWrites } = fixture({
      inspectPretrustedTarget: (target) => {
        const observed = identity(target);
        return target.endsWith("101.2") ? { ...observed, hostKeyDigest: "f".repeat(64) } : observed;
      },
    });

    expect(probeManagedClusterManagedServingCapability({ env: {}, deps })).toMatchObject({
      kind: "not-selected",
      code: "no-match",
    });
    expect(bindingWrites()).toBe(0);
  });

  it.each(
    STOPPED_FOREIGN_CONTAINER_FIXTURES,
  )("preserves a stopped foreign vLLM setup identified by $signal", (container) => {
    const base = fixture();
    const deps = {
      ...base.deps,
      probeHost: (candidate: ManagedClusterReadOnlyHostTransport) =>
        candidate === base.localTransport
          ? host("local", {
              runtimeSnapshot: {
                containers: [
                  {
                    id: "9".repeat(64),
                    name: container.name,
                    image: container.image,
                    running: false,
                    healthy: false,
                    labels: container.labels,
                  },
                ],
                listeningPorts: [],
              },
            })
          : host("peer"),
    };

    expect(probeManagedClusterManagedServingCapability({ env: {}, deps })).toMatchObject({
      kind: "not-selected",
      code: "runtime-conflict",
    });
    expect(base.bindingWrites()).toBe(0);
    expect(base.events).not.toContain("write-binding");
  });

  it("does not classify an arbitrary stopped container as a managed vLLM setup", () => {
    const base = fixture();
    const deps = {
      ...base.deps,
      probeHost: (candidate: ManagedClusterReadOnlyHostTransport) =>
        candidate === base.localTransport
          ? host("local", {
              runtimeSnapshot: {
                containers: [
                  {
                    id: "9".repeat(64),
                    name: "unrelated-service",
                    image: "example.invalid/worker:latest",
                    running: false,
                    healthy: false,
                    labels: { "example.foreign": "true" },
                  },
                ],
                listeningPorts: [],
              },
            })
          : host("peer"),
    };

    expect(probeManagedClusterManagedServingCapability({ env: {}, deps })).toMatchObject({
      kind: "ready",
    });
    expect(base.bindingWrites()).toBe(0);
  });

  it.each([
    {
      name: "an active earlyoom service",
      mutate: (value: ManagedClusterHostObservation) => ({
        ...value,
        earlyoom: {
          installed: true,
          active: "active" as const,
          enabled: "enabled" as const,
        },
      }),
      code: "no-match",
    },
    {
      name: "a related runtime",
      mutate: (value: ManagedClusterHostObservation) => ({
        ...value,
        runtimeSnapshot: {
          containers: [
            {
              id: "9".repeat(64),
              name: "managed-vllm",
              image: "example.invalid/vllm:latest",
              running: true,
              healthy: true,
              labels: { [MANAGED_CLUSTER_MANAGED_LABEL]: "true" },
            },
          ],
          listeningPorts: [],
        },
      }),
      code: "runtime-conflict",
    },
    {
      name: "an inconclusive runtime inspection",
      mutate: (value: ManagedClusterHostObservation) => ({
        ...value,
        runtimeInspectionComplete: false,
      }),
      code: "runtime-unknown",
    },
    {
      name: "a missing exact cache root",
      mutate: (value: ManagedClusterHostObservation) => ({
        ...value,
        storage: {
          ...value.storage,
          huggingFace: { ...value.storage.huggingFace, probePath: value.home },
        },
      }),
      code: "no-match",
    },
  ])("preserves host state for $name", ({ mutate, code }) => {
    const base = fixture();
    const deps = {
      ...base.deps,
      probeHost: (candidate: ManagedClusterReadOnlyHostTransport) =>
        candidate === base.localTransport ? mutate(host("local")) : host("peer"),
    };

    expect(probeManagedClusterManagedServingCapability({ env: {}, deps })).toMatchObject({
      kind: "not-selected",
      code,
    });
    expect(base.bindingWrites()).toBe(0);
    expect(base.events).not.toContain("write-binding");
  });

  it("does not claim when the exact pretrusted peer identity changes after confirmation", () => {
    const base = fixture();
    let inspections = 0;
    const deps: ManagedClusterDiscoveryDeps = {
      ...base.deps,
      inspectPretrustedTarget: (target) => {
        inspections += 1;
        const observed = identity(target);
        return inspections > 2
          ? {
              ...observed,
              sshTarget: "spark-worker.local",
              resolvedHost: "spark-worker.local",
            }
          : observed;
      },
      claimBinding: () => {
        base.events.push("claim-binding");
        return true;
      },
    };
    const detected = expectDetectedCluster(
      probeManagedClusterManagedServingCapability({ env: {}, deps }),
    );

    expect(
      confirmManagedClusterManagedServingCapability(detected, { env: {}, deps }),
    ).toMatchObject({
      kind: "unavailable",
      code: "peer-identity-ambiguous",
    });
    expect(base.events).not.toContain("claim-binding");
    expect(base.bindingWrites()).toBe(0);
  });

  it("rechecks related runtime and listeners before claiming the binding", () => {
    const base = fixture();
    let runtimeAppeared = false;
    const deps: ManagedClusterDiscoveryDeps = {
      ...base.deps,
      probeHost: (candidate) =>
        candidate === base.localTransport && runtimeAppeared
          ? host("local", {
              runtimeSnapshot: {
                containers: [
                  {
                    id: "9".repeat(64),
                    name: "managed-vllm",
                    image: "example.invalid/vllm:latest",
                    running: true,
                    healthy: true,
                    labels: { [MANAGED_CLUSTER_MANAGED_LABEL]: "true" },
                  },
                ],
                listeningPorts: [],
              },
            })
          : candidate === base.localTransport
            ? host("local")
            : host("peer"),
      claimBinding: () => {
        base.events.push("claim-binding");
        return true;
      },
    };
    const detected = expectDetectedCluster(
      probeManagedClusterManagedServingCapability({ env: {}, deps }),
    );
    runtimeAppeared = true;

    expect(
      confirmManagedClusterManagedServingCapability(detected, { env: {}, deps }),
    ).toMatchObject({
      kind: "unavailable",
      code: "runtime-conflict",
    });
    expect(base.events).not.toContain("claim-binding");
    expect(base.bindingWrites()).toBe(0);
  });

  it("preserves an existing binding as a hard automatic conflict", () => {
    const { deps, events, bindingWrites } = fixture({
      claimBinding: () => false,
    });
    const detected = expectDetectedCluster(
      probeManagedClusterManagedServingCapability({ env: {}, deps }),
    );

    expect(
      confirmManagedClusterManagedServingCapability(detected, { env: {}, deps }),
    ).toMatchObject({
      kind: "unavailable",
      code: "binding-conflict",
    });
    expect(bindingWrites()).toBe(0);
    expect(events).not.toContain("clear-binding");
  });

  it("cleans only the new transaction binding when persistence fails", () => {
    const { deps, events } = fixture({
      writeBinding: () => {
        events.push("write-binding");
        throw new Error("partial write");
      },
    });
    const detected = expectDetectedCluster(
      probeManagedClusterManagedServingCapability({ env: {}, deps }),
    );

    expect(
      confirmManagedClusterManagedServingCapability(detected, { env: {}, deps }),
    ).toMatchObject({
      kind: "unavailable",
      code: "binding-persistence-failed",
    });
    expect(events).toContain("clear-binding");
    expect(events.indexOf("clear-binding")).toBeGreaterThan(events.indexOf("write-binding"));
  });

  it("cleans its claimed binding when handle encoding fails", () => {
    const base = fixture();
    const deps = {
      ...base.deps,
      encodeBinding: () => {
        base.events.push("encode-binding");
        throw new Error("encode failed");
      },
    };
    const detected = expectDetectedCluster(
      probeManagedClusterManagedServingCapability({ env: {}, deps }),
    );

    expect(
      confirmManagedClusterManagedServingCapability(detected, { env: {}, deps }),
    ).toMatchObject({
      kind: "unavailable",
      code: "binding-persistence-failed",
    });
    expect(base.events.filter((event) => event === "clear-binding")).toEqual(["clear-binding"]);
    expect(base.events.indexOf("clear-binding")).toBeGreaterThan(
      base.events.indexOf("encode-binding"),
    );
  });

  it("fails closed when the controller UID differs from the local cache owner", () => {
    const { deps, bindingWrites } = fixture({ currentUid: () => 2000 });

    expect(probeManagedClusterManagedServingCapability({ env: {}, deps })).toMatchObject({
      kind: "not-selected",
      code: "no-match",
    });
    expect(bindingWrites()).toBe(0);
  });
});

function connectivityRequests(): ManagedClusterConnectivityRequest[] {
  return [
    {
      netdev: "enp1s0f0np0",
      sourceAddress: "192.168.100.1",
      peerAddress: "192.168.100.2",
      expectedPeerMac: "02:00:00:00:01:01",
    },
    {
      netdev: "enp2s0f0np0",
      sourceAddress: "192.168.101.1",
      peerAddress: "192.168.101.2",
      expectedPeerMac: "02:00:00:00:01:02",
    },
  ];
}

/**
 * Serves healthy route, ping, and neighbor output for every rail, degraded only where
 * the options ask for it. `neighborKeys` selects which keys the neighbor JSON carries,
 * so a test can reproduce the real `ip` output that omits the filtered-on `dev`.
 */
function connectivityTransport(
  requests: readonly ManagedClusterConnectivityRequest[],
  options: {
    neighborKeys?: readonly ("dst" | "dev" | "lladdr" | "state")[];
    jumboFailsOn?: string;
    neighborMissingOn?: string;
  },
): ManagedClusterReadOnlyHostTransport {
  const keys = options.neighborKeys ?? ["dst", "dev", "lladdr", "state"];
  return {
    execute: (argv) => {
      const routeResponse = () => ({
        status: 0,
        stdout: JSON.stringify([{ dev: argv.at(-1), prefsrc: argv[6], scope: "link" }]),
        stderr: "",
      });
      const pingResponse = () => ({
        status: Number(argv.at(-1) === options.jumboFailsOn),
        stdout: "",
        stderr: "",
      });
      const neighborResponse = () => {
        const request = requests.find(({ peerAddress }) => peerAddress === argv[5])!;
        const entry = {
          dst: request.peerAddress,
          dev: request.netdev,
          lladdr: request.expectedPeerMac,
          state: ["REACHABLE"],
        };
        const emitted = Object.fromEntries(keys.map((key) => [key, entry[key]]));
        const rows = [emitted].filter(() => request.peerAddress !== options.neighborMissingOn);
        return { status: 0, stdout: JSON.stringify(rows), stderr: "" };
      };
      return argv[1] === "-j" && argv[2] === "route"
        ? routeResponse()
        : argv[0] === "ping"
          ? pingResponse()
          : neighborResponse();
    },
    readFile: () => "",
    readdir: () => [],
  };
}

describe("production pinned peer transport", () => {
  it("atomically preserves an existing binding-root owner", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-spark-binding-"));
    fs.chmodSync(parent, 0o700);
    const statePath = path.join(parent, "managed-cluster.json");
    const bindingRoot = `${statePath}.ssh-binding`;
    const deps = createManagedClusterDiscoveryDeps(() => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    try {
      expect(deps.claimBinding(statePath)).toBe(true);
      fs.writeFileSync(path.join(bindingRoot, "owner"), "first\n", {
        mode: 0o600,
      });
      expect(deps.claimBinding(statePath)).toBe(false);
      expect(fs.readFileSync(path.join(bindingRoot, "owner"), "utf8")).toBe("first\n");
    } finally {
      deps.clearBinding(statePath);
      fs.rmSync(parent, { force: true, recursive: true });
    }
  });

  it("rejects a symlinked binding parent before creating a claim", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-spark-binding-link-"));
    const parent = path.join(root, "parent");
    const alias = path.join(root, "alias");
    fs.mkdirSync(parent, { mode: 0o700 });
    fs.symlinkSync(parent, alias, "dir");
    const statePath = path.join(alias, "managed-cluster.json");
    const deps = createManagedClusterDiscoveryDeps(() => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    try {
      expect(() => deps.claimBinding(statePath)).toThrow();
      expect(fs.existsSync(`${path.join(parent, "managed-cluster.json")}.ssh-binding`)).toBe(false);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("pins local and remote host probes to the physical default Docker daemon", () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: SpawnSyncOptionsWithStringEncoding;
    }> = [];
    const spawn: ManagedClusterSpawnSync = (file, args, options) => {
      calls.push({ file, args: [...args], options });
      return {
        status: 0,
        stdout: JSON.stringify(calls.length === 1 ? host("local") : host("peer")),
        stderr: "",
      };
    };
    const dockerNames = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"] as const;
    const previous = new Map(dockerNames.map((name) => [name, process.env[name]]));
    process.env.DOCKER_HOST = "tcp://ambient.example:2376";
    process.env.DOCKER_CONTEXT = "ambient-remote";
    process.env.DOCKER_CONFIG = "/tmp/ambient-docker-config";

    try {
      const deps = createManagedClusterDiscoveryDeps(spawn);
      expect(deps.probeHost(deps.localTransport()).hostname).toBe("spark-head");
      const pinned = deps.openPinnedPeerTransport(identity("192.168.100.2"));
      try {
        expect(deps.probeHost(pinned.transport).hostname).toBe("spark-worker");
      } finally {
        pinned.close();
      }
    } finally {
      for (const name of dockerNames) {
        const value = previous.get(name);
        value === undefined
          ? Reflect.deleteProperty(process.env, name)
          : Reflect.set(process.env, name, value);
      }
    }

    expect(calls).toHaveLength(2);
    const local = calls[0]!;
    expect(local.file).toBe("python3");
    expect(local.args).toHaveLength(2);
    expect(local.options.env).toMatchObject({ DOCKER_CONTEXT: "default" });
    expect(local.options.env).not.toHaveProperty("DOCKER_HOST");
    expect(local.options.env).not.toHaveProperty("DOCKER_CONFIG");

    const remote = calls[1]!;
    expect(remote.file).toBe("ssh");
    expect(remote.options.env).not.toHaveProperty("DOCKER_HOST");
    expect(remote.options.env).not.toHaveProperty("DOCKER_CONTEXT");
    expect(remote.options.env).not.toHaveProperty("DOCKER_CONFIG");
    const request = JSON.parse(Buffer.from(remote.args.at(-1)!, "base64url").toString("utf8"));
    expect(request.argv).toHaveLength(3);
    const script = request.argv[2] as string;
    expect(script).toContain("env.pop(name, None)");
    expect(script).toContain('env["DOCKER_CONTEXT"] = "default"');
    expect(script).not.toContain("MODEL_ID");
    expect(script).not.toContain("IMAGE_REF");
  });

  it("requires direct routes, exact neighbors, and jumbo reachability on both rails", () => {
    const deps = createManagedClusterDiscoveryDeps(() => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const requests = [
      {
        netdev: "enp1s0f0np0",
        sourceAddress: "192.168.100.1",
        peerAddress: "192.168.100.2",
        expectedPeerMac: "02:00:00:00:01:01",
      },
      {
        netdev: "enp2s0f0np0",
        sourceAddress: "192.168.101.1",
        peerAddress: "192.168.101.2",
        expectedPeerMac: "02:00:00:00:01:02",
      },
    ];
    let routedThroughGateway = false;
    const directTransport: ManagedClusterReadOnlyHostTransport = {
      execute: (argv) => {
        const routeResponse = () => ({
          status: 0,
          stdout: JSON.stringify([
            {
              dev: argv.at(-1),
              prefsrc: argv[6],
              scope: "link",
              ...(routedThroughGateway ? { gateway: "192.168.100.254" } : {}),
            },
          ]),
          stderr: "",
        });
        const pingResponse = () => ({ status: 0, stdout: "", stderr: "" });
        const neighborResponse = () => {
          const request = requests.find(({ peerAddress }) => peerAddress === argv[5])!;
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                dst: request.peerAddress,
                lladdr: request.expectedPeerMac,
                state: ["REACHABLE"],
              },
            ]),
            stderr: "",
          };
        };
        return argv[1] === "-j" && argv[2] === "route"
          ? routeResponse()
          : argv[0] === "ping"
            ? pingResponse()
            : neighborResponse();
      },
      readFile: () => "",
      readdir: () => [],
    };

    expect(deps.probeConnectivity(directTransport, requests)).toBeNull();
    routedThroughGateway = true;
    expect(deps.probeConnectivity(directTransport, requests)).toEqual({
      check: "route",
      netdev: "enp1s0f0np0",
    });
  });

  it("accepts a neighbor entry that omits the dev key filtered out by ip (#8519)", () => {
    const deps = createManagedClusterDiscoveryDeps(() => ({ status: 0, stdout: "", stderr: "" }));
    const requests = connectivityRequests();
    // `ip -j neigh show to <peer> dev <netdev>` filters on `dev` and then drops it
    // from the JSON, so the healthy fabric reports no `dev` at all.
    const transport = connectivityTransport(requests, {
      neighborKeys: ["dst", "lladdr", "state"],
    });

    expect(deps.probeConnectivity(transport, requests)).toBeNull();
  });

  it("names the rail and the sub-check that rejected the fabric (#8519)", () => {
    const deps = createManagedClusterDiscoveryDeps(() => ({ status: 0, stdout: "", stderr: "" }));
    const requests = connectivityRequests();

    expect(
      deps.probeConnectivity(
        connectivityTransport(requests, { jumboFailsOn: "192.168.101.2" }),
        requests,
      ),
    ).toEqual({ check: "jumbo", netdev: "enp2s0f0np0" });
    expect(
      deps.probeConnectivity(
        connectivityTransport(requests, { neighborMissingOn: "192.168.100.2" }),
        requests,
      ),
    ).toEqual({ check: "neighbor", netdev: "enp1s0f0np0" });
    expect(
      deps.probeConnectivity(connectivityTransport(requests, {}), requests.slice(0, 1)),
    ).toEqual({ check: "rails" });
  });

  it("uses strict SSH and a fixed argv executor without interpolated shell", () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: SpawnSyncOptionsWithStringEncoding;
    }> = [];
    const spawn: ManagedClusterSpawnSync = (file, args, options) => {
      calls.push({ file, args: [...args], options });
      return { status: 0, stdout: "aarch64\n", stderr: "" };
    };
    const deps = createManagedClusterDiscoveryDeps(spawn);
    const pinned = deps.openPinnedPeerTransport(identity("192.168.100.2"));

    try {
      expect(pinned.transport.execute(["uname", "-m"])).toMatchObject({
        status: 0,
      });
    } finally {
      pinned.close();
    }

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.file).toBe("ssh");
    expect(call.args.slice(0, 2)).toEqual(["-F", "/dev/null"]);
    expect(call.args).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "PasswordAuthentication=no",
        "ProxyCommand=none",
        "ProxyJump=none",
        "GlobalKnownHostsFile=/dev/null",
      ]),
    );
    expect(call.args.slice(-4, -1)).toEqual(["192.168.100.2", "python3", "-"]);
    const request = JSON.parse(Buffer.from(call.args.at(-1)!, "base64url").toString("utf8"));
    expect(request).toEqual({ argv: ["uname", "-m"] });
    expect(call.options.input).toContain("subprocess.run(");
    expect(call.options.input).toContain("shell=False");
    expect(call.options.input).not.toContain("uname");
  });
});
