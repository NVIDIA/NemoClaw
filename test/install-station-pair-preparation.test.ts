// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  type DualStationPreparationDeps,
  type DualStationResumeState,
  deriveDiscoveryCandidates,
  deriveSlash30Counterpart,
  type PretrustedSshTarget,
  parseDualStationResumeState,
  prepareDualStationPair,
  STATION_PREP_EXISTING_VLLM_EXIT,
  validateResumeFileMetadata,
  validateStationPeerTarget,
} from "../scripts/lib/dgx-station-peer.mts";
import {
  buildRemoteHelperCommand,
  buildStationPrepSubprocessEnv,
  clearDualStationResumeState,
  inspectPretrustedSshTarget,
  readDualStationResumeState,
  stationPrepSshArgs,
  writeDualStationResumeState,
} from "../scripts/prepare-dual-dgx-station.mts";
import { DUAL_STATION_VLLM_LAUNCH_SCHEMA } from "../src/lib/inference/vllm-station-cluster-lifecycle.ts";
import { strictVllmSshTransportArgs } from "../src/lib/inference/serving/vllm-ssh-transport-policy.ts";
import {
  HELPER_SHA256,
  HOST_KEY_DATA,
  HOST_KEY_DIGEST,
  HOST_KEY_FINGERPRINT,
  preparationOptions,
  REVISION,
  sshBinding,
  stationConnectivity,
  stationHost,
} from "./helpers/dgx-station-peer-fixture";
import { runInstallerSourcedBody } from "./helpers/installer-run-fixture";
import { TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const COORDINATOR = path.join(REPO_ROOT, "scripts", "prepare-dual-dgx-station.mts");
const STATION_HELPER = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");

function throwFixtureError(error: Error): never {
  throw error;
}

class PreparationHarness {
  readonly calls: string[] = [];
  readonly statePhases: DualStationResumeState["phase"][] = [];
  readonly trusted = new Map<string, PretrustedSshTarget | null>();
  readonly trustErrors = new Map<string, Error>();
  readonly localHelperStatus = new Map<string, number>();
  readonly remoteHelperStatus = new Map<string, number>();
  local = stationHost("local");
  peer = stationHost("peer");
  resume: DualStationResumeState | null = null;
  localConnectivity = true;
  peerConnectivity = true;
  peerProbeError: Error | null = null;

  readonly deps: DualStationPreparationDeps = {
    runLocalHelper: (mode) => {
      this.calls.push(`local:${mode}`);
      return this.localHelperStatus.get(mode) ?? 0;
    },
    probeLocalHost: () => {
      this.calls.push("probe:local");
      return structuredClone(this.local);
    },
    inspectPretrustedTarget: (target) => {
      this.calls.push(`trust:${target}`);
      const error = this.trustErrors.get(target);
      error && throwFixtureError(error);
      return this.trusted.get(target) ?? null;
    },
    probePeerHost: (binding) => {
      this.calls.push(`probe:peer:${binding.sshTarget}`);
      this.peerProbeError && throwFixtureError(this.peerProbeError);
      return structuredClone(this.peer);
    },
    probeLocalConnectivity: () => {
      this.calls.push("connectivity:local");
      return this.localConnectivity;
    },
    probePeerConnectivity: (binding) => {
      this.calls.push(`connectivity:peer:${binding.sshTarget}`);
      return this.peerConnectivity;
    },
    runRemoteHelper: (binding, mode) => {
      this.calls.push(`remote:${binding.sshTarget}:${mode}`);
      return this.remoteHelperStatus.get(mode) ?? 0;
    },
    readResumeState: () => {
      this.calls.push("state:read");
      return this.resume ? structuredClone(this.resume) : null;
    },
    writeResumeState: (state) => {
      this.calls.push(`state:write:${state.phase}`);
      this.resume = structuredClone(state);
      this.statePhases.push(state.phase);
    },
    clearResumeState: () => {
      this.calls.push("state:clear");
      this.resume = null;
    },
    log: (message) => this.calls.push(`log:${message}`),
  };
}

function trustFirstRail(harness: PreparationHarness): void {
  harness.trusted.set("10.10.0.2", sshBinding());
}

function readyState(): DualStationResumeState {
  return {
    schemaVersion: 1,
    revision: REVISION,
    helperSha256: HELPER_SHA256,
    phase: "ready",
    peerTarget: "10.10.0.2",
    hostKeyDigest: HOST_KEY_DIGEST,
    localGpuUuid: "GPU-LOCAL-0001",
    peerGpuUuid: "GPU-PEER-0002",
    rails: [
      {
        localAddress: "10.10.0.1",
        localMac: "02:00:00:00:00:01",
        peerAddress: "10.10.0.2",
        peerMac: "02:00:00:00:00:02",
      },
      {
        localAddress: "10.10.0.5",
        localMac: "02:00:00:00:00:05",
        peerAddress: "10.10.0.6",
        peerMac: "02:00:00:00:00:06",
      },
    ],
  };
}

const runInstallerBody = (body: string, extraEnv: Record<string, string> = {}) => {
  const run = runInstallerSourcedBody(body, {
    homePrefix: "nemoclaw-pair-installer-",
    extraEnv,
    includeNodeOnPath: true,
    timeoutMs: 20_000,
  });
  onTestFinished(run.remove);
  return run;
};

function coordinatorResult(kind: "ready" | "reboot-required", peer = "10.10.0.2"): string {
  const state = readyState();
  state.peerTarget = peer;
  const sshBinding = Buffer.from(
    JSON.stringify({
      bindingFile: "/tmp/nemoclaw-station-pair/resume.json.ssh-binding/binding.json",
      hostKeyDigest: state.hostKeyDigest,
    }),
    "utf8",
  ).toString("base64url");
  return JSON.stringify({
    kind,
    peerTarget: peer,
    identity: {
      peerTarget: peer,
      hostKeyDigest: state.hostKeyDigest,
      localGpuUuid: state.localGpuUuid,
      peerGpuUuid: state.peerGpuUuid,
      rails: state.rails,
    },
    sshBinding,
  });
}

describe("deterministic dual-DGX Station peer discovery", () => {
  it.each([
    ["10.0.0.1", "10.0.0.2"],
    ["10.0.0.2", "10.0.0.1"],
    ["172.16.8.5", "172.16.8.6"],
    ["172.16.8.6", "172.16.8.5"],
    ["192.168.20.1", "192.168.20.2"],
  ])("derives only the other usable /30 address: %s -> %s", (address, counterpart) => {
    expect(deriveSlash30Counterpart(address)).toBe(counterpart);
  });

  it.each([
    ["10.0.0.0", 30],
    ["10.0.0.3", 30],
    ["10.0.0.1", 24],
    ["8.8.8.1", 30],
    ["not-an-ip", 30],
  ])("refuses non-usable, non-/30, public, and malformed addresses", (address, prefix) => {
    expect(deriveSlash30Counterpart(address, prefix)).toBeNull();
  });

  it("derives exactly the two reciprocal CX-8 candidates", () => {
    expect(deriveDiscoveryCandidates(stationHost("local"))).toEqual(["10.10.0.2", "10.10.0.6"]);
  });

  it.each(["DGX-Station", "P3830", "NVIDIA Station GB300"])(
    "accepts an existing Station firmware product identifier: %s",
    (productName) => {
      const host = stationHost("local");
      host.productName = productName;

      expect(deriveDiscoveryCandidates(host)).toEqual(["10.10.0.2", "10.10.0.6"]);
    },
  );

  it("rejects extra rails, duplicate identities, and non-jumbo links", () => {
    const extraRail = stationHost("local");
    extraRail.rails.push({
      ...structuredClone(extraRail.rails[1]),
      netdev: "enp3s0f0np0",
      pciAddress: "0000:03:00.0",
      macAddress: "02:00:00:00:00:09",
      ipv4Addresses: [{ address: "10.10.0.9", prefixLength: 30 }],
    });
    expect(() => deriveDiscoveryCandidates(extraRail)).toThrow(/exactly two CX-8 rails/);

    const duplicate = stationHost("local");
    duplicate.rails[1].macAddress = duplicate.rails[0].macAddress;
    expect(() => deriveDiscoveryCandidates(duplicate)).toThrow(/identity is ambiguous/);

    const nonJumbo = stationHost("local");
    nonJumbo.rails[0].mtu = 1500;
    expect(() => deriveDiscoveryCandidates(nonJumbo)).toThrow(/MTU 9000/);
  });

  it("inspects only the two mathematically derived candidates and preserves single-Station behavior", () => {
    const harness = new PreparationHarness();
    const result = prepareDualStationPair(preparationOptions(), harness.deps);

    expect(result).toEqual({
      kind: "single-station",
      reason: "No derived dual-rail peer address has pre-existing SSH host-key trust",
    });
    expect(harness.calls.filter((call) => call.startsWith("trust:"))).toEqual([
      "trust:10.10.0.2",
      "trust:10.10.0.6",
    ]);
    expect(harness.calls.some((call) => call.startsWith("probe:peer"))).toBe(false);
    expect(harness.calls.some((call) => call.startsWith("remote:"))).toBe(false);
  });

  it("accepts one pretrusted reciprocal peer and runs preparation in order", () => {
    const harness = new PreparationHarness();
    trustFirstRail(harness);
    harness.remoteHelperStatus.set("--apply", 11);
    const result = prepareDualStationPair(preparationOptions(), harness.deps);
    expect(result.kind).toBe("ready");
    expect(result.kind === "ready" && result.peerTarget).toBe("10.10.0.2");
    expect(result.kind === "ready" && result.binding).toEqual(sshBinding());
    expect(harness.statePhases).toEqual(["remote-preparation", "ready"]);
    expect(harness.calls.indexOf("local:--verify")).toBeLessThan(
      harness.calls.indexOf("probe:peer:10.10.0.2"),
    );
    expect(harness.calls.indexOf("remote:10.10.0.2:--check")).toBeLessThan(
      harness.calls.indexOf("state:write:remote-preparation"),
    );
    expect(harness.calls).toContain("local:--bind-controller");
    expect(harness.calls.filter((call) => call.startsWith("remote:"))).toEqual([
      "remote:10.10.0.2:--check",
      "remote:10.10.0.2:--apply",
      "remote:10.10.0.2:--bind-controller",
      "remote:10.10.0.2:--verify",
    ]);
    expect(harness.calls).toContain(
      "log:Peer Docker access requires a new login; reopening SSH before verification",
    );
  });
  it("accepts two rail aliases only when their exact SSH identity is coherent", () => {
    const coherent = new PreparationHarness();
    coherent.trusted.set("10.10.0.2", sshBinding("10.10.0.2"));
    coherent.trusted.set("10.10.0.6", sshBinding("10.10.0.6"));
    expect(prepareDualStationPair(preparationOptions(), coherent.deps).kind).toBe("ready");
    expect(coherent.calls.filter((call) => call.startsWith("probe:peer:"))).toHaveLength(1);
    const ambiguous = new PreparationHarness();
    ambiguous.trusted.set("10.10.0.2", sshBinding("10.10.0.2"));
    ambiguous.trusted.set("10.10.0.6", sshBinding("10.10.0.6", "AAAAC3NzaChangedKey"));
    const result = prepareDualStationPair(preparationOptions(), ambiguous.deps);
    expect(result).toMatchObject({
      kind: "single-station",
      reason: expect.stringMatching(/different/),
    });
    expect(ambiguous.calls.some((call) => call.startsWith("probe:peer:"))).toBe(false);
  });

  it("treats an unusable automatic trust entry as untrusted without contact", () => {
    const harness = new PreparationHarness();
    harness.trustErrors.set("10.10.0.2", new Error("unsafe HostKeyAlias"));

    expect(prepareDualStationPair(preparationOptions(), harness.deps)).toMatchObject({
      kind: "single-station",
    });
    expect(harness.calls).toContain(
      "log:Ignoring derived peer 10.10.0.2: pre-existing SSH trust is unusable (unsafe HostKeyAlias)",
    );
    expect(harness.calls.some((call) => call.startsWith("probe:peer:"))).toBe(false);
  });

  it("rejects altered endpoint, port, and known-hosts evidence before peer contact", () => {
    const oversizedLines = Array.from(
      { length: 5 },
      (_, index) => `10.10.0.${String(index + 2)} ssh-ed25519 A${"B".repeat(14_000)}`,
    );
    const scenarios: Array<{
      name: string;
      mutate(binding: PretrustedSshTarget): void;
    }> = [
      {
        name: "requested target substitution",
        mutate: (binding) => {
          binding.requestedTarget = "10.10.0.6";
        },
      },
      {
        name: "fractional port",
        mutate: (binding) => {
          binding.port = 22.5;
        },
      },
      {
        name: "blank known-hosts line",
        mutate: (binding) => {
          binding.knownHostsLines = [""];
        },
      },
      {
        name: "untrimmed known-hosts line",
        mutate: (binding) => {
          binding.knownHostsLines = [`${binding.knownHostsLines[0]} `];
        },
      },
      {
        name: "comment known-hosts line",
        mutate: (binding) => {
          binding.knownHostsLines = ["# no trust evidence"];
        },
      },
      {
        name: "oversized known-hosts evidence",
        mutate: (binding) => {
          binding.knownHostsLines = oversizedLines;
        },
      },
      {
        name: "known-hosts digest mismatch",
        mutate: (binding) => {
          binding.knownHostsLines = ["10.10.0.2 ssh-ed25519 AAAAC3NzaChangedKey"];
        },
      },
    ];

    scenarios.forEach((scenario) => {
      const harness = new PreparationHarness();
      const binding = sshBinding();
      scenario.mutate(binding);
      harness.trusted.set("10.10.0.2", binding);
      expect(
        prepareDualStationPair(preparationOptions(), harness.deps),
        scenario.name,
      ).toMatchObject({ kind: "single-station" });
      expect(
        harness.calls.some((call) => call.startsWith("probe:peer:")),
        scenario.name,
      ).toBe(false);
      expect(
        harness.calls.some((call) => call.startsWith("remote:")),
        scenario.name,
      ).toBe(false);
    });
  });

  it("rejects an explicit target whose resolved SSH user changed before peer contact", () => {
    const explicit = "ubuntu@station-b";
    const harness = new PreparationHarness();
    const binding = sshBinding(explicit);
    binding.sshUser = "root";
    harness.trusted.set(explicit, binding);

    expect(() =>
      prepareDualStationPair({ ...preparationOptions(), explicitPeer: explicit }, harness.deps),
    ).toThrow(/unsafe user or port/);
    expect(harness.calls.some((call) => call.startsWith("probe:peer:"))).toBe(false);
    expect(harness.calls.some((call) => call.startsWith("remote:"))).toBe(false);
  });

  it("requires reciprocal rail addresses and MACs plus a distinct peer GPU", () => {
    const nonreciprocal = new PreparationHarness();
    trustFirstRail(nonreciprocal);
    nonreciprocal.peer.rails[1].ipv4Addresses = [{ address: "10.10.0.10", prefixLength: 30 }];
    expect(prepareDualStationPair(preparationOptions(), nonreciprocal.deps)).toMatchObject({
      kind: "single-station",
      reason: expect.stringMatching(/not reciprocal/),
    });
    expect(nonreciprocal.calls.some((call) => call.startsWith("remote:"))).toBe(false);

    const sameGpu = new PreparationHarness();
    trustFirstRail(sameGpu);
    sameGpu.peer.gpus[0].uuid = sameGpu.local.gpus[0].uuid;
    expect(prepareDualStationPair(preparationOptions(), sameGpu.deps)).toMatchObject({
      kind: "single-station",
      reason: expect.stringMatching(/local Station GPU/),
    });
    expect(sameGpu.calls.some((call) => call.startsWith("remote:"))).toBe(false);
  });

  it("keeps an explicit peer authoritative and fail-closed", () => {
    const explicit = "ubuntu@station-b";
    const harness = new PreparationHarness();
    harness.trusted.set(explicit, sshBinding(explicit));

    expect(
      prepareDualStationPair({ ...preparationOptions(), explicitPeer: explicit }, harness.deps)
        .kind,
    ).toBe("ready");
    expect(harness.calls.filter((call) => call.startsWith("trust:"))).toEqual([
      `trust:${explicit}`,
    ]);

    const untrusted = new PreparationHarness();
    expect(() =>
      prepareDualStationPair({ ...preparationOptions(), explicitPeer: explicit }, untrusted.deps),
    ).toThrow(/not pretrusted/);
    expect(untrusted.calls.some((call) => call.startsWith("probe:peer:"))).toBe(false);
  });

  it.each([
    "root@station;reboot",
    "station-b -o ProxyCommand=evil",
    "station-b/path",
    "user@@station-b",
    "[10.10.0.2]",
    "$(touch pwned)",
    "station-b:2222",
    "010.010.000.002",
  ])("rejects a malicious or noncanonical peer string: %s", (target) => {
    expect(() => validateStationPeerTarget(target)).toThrow(/canonical SSH host/);
  });

  it("fails local verification before trust inspection or remote mutation", () => {
    const harness = new PreparationHarness();
    trustFirstRail(harness);
    harness.localHelperStatus.set("--verify", 1);

    expect(() => prepareDualStationPair(preparationOptions(), harness.deps)).toThrow(
      /verification failed before peer contact/,
    );
    expect(harness.calls.some((call) => call.startsWith("trust:"))).toBe(false);
    expect(harness.calls.some((call) => call.startsWith("remote:"))).toBe(false);
  });

  it("falls back only before mutation and fails closed for explicit connectivity failure", () => {
    const automatic = new PreparationHarness();
    trustFirstRail(automatic);
    automatic.localConnectivity = false;
    expect(prepareDualStationPair(preparationOptions(), automatic.deps)).toMatchObject({
      kind: "single-station",
      reason: expect.stringMatching(/jumbo-frame/),
    });
    expect(automatic.statePhases).toEqual([]);

    const explicitTarget = "ubuntu@station-b";
    const explicit = new PreparationHarness();
    explicit.trusted.set(explicitTarget, sshBinding(explicitTarget));
    explicit.peerConnectivity = false;
    expect(() =>
      prepareDualStationPair(
        { ...preparationOptions(), explicitPeer: explicitTarget },
        explicit.deps,
      ),
    ).toThrow(/jumbo-frame/);
  });

  it("leaves an automatically discovered peer with active vLLM unchanged", () => {
    const harness = new PreparationHarness();
    trustFirstRail(harness);
    harness.remoteHelperStatus.set("--check", STATION_PREP_EXISTING_VLLM_EXIT);

    expect(prepareDualStationPair(preparationOptions(), harness.deps)).toEqual({
      kind: "single-station",
      reason:
        "Trusted reciprocal peer has an active vLLM workload; leaving it unchanged and using single-Station inference",
    });
    expect(harness.statePhases).toEqual([]);
    expect(harness.resume).toBeNull();
    expect(harness.calls.filter((call) => call.startsWith("remote:"))).toEqual([
      "remote:10.10.0.2:--check",
    ]);
    expect(harness.calls).not.toContain("local:--bind-controller");
  });

  it("keeps other automatic peer check failures pinned and fail-closed", () => {
    const harness = new PreparationHarness();
    trustFirstRail(harness);
    harness.remoteHelperStatus.set("--check", 1);

    expect(() => prepareDualStationPair(preparationOptions(), harness.deps)).toThrow(
      /selected pair remains pinned/,
    );
    expect(harness.resume?.phase).toBe("remote-preparation");
    expect(harness.calls).toContain("local:--bind-controller");
    expect(harness.calls).not.toContain("remote:10.10.0.2:--apply");
  });

  it("keeps an explicit peer with active vLLM pinned and fail-closed", () => {
    const explicitTarget = "ubuntu@station-b";
    const harness = new PreparationHarness();
    harness.trusted.set(explicitTarget, sshBinding(explicitTarget));
    harness.remoteHelperStatus.set("--check", STATION_PREP_EXISTING_VLLM_EXIT);

    expect(() =>
      prepareDualStationPair(
        { ...preparationOptions(), explicitPeer: explicitTarget },
        harness.deps,
      ),
    ).toThrow(/selected pair remains pinned/);
    expect(harness.resume?.phase).toBe("remote-preparation");
    expect(harness.calls).toContain("local:--bind-controller");
    expect(harness.calls.filter((call) => call.startsWith("remote:"))).toEqual([
      `remote:${explicitTarget}:--check`,
    ]);
  });
});

describe("dual-DGX Station reboot resume and reuse", () => {
  it("persists the exact pair after the read-only check and before remote mutation", () => {
    const first = new PreparationHarness();
    trustFirstRail(first);
    first.remoteHelperStatus.set("--apply", 10);
    const interrupted = prepareDualStationPair(preparationOptions(), first.deps);
    expect(interrupted.kind).toBe("reboot-required");
    expect(interrupted.kind === "reboot-required" && interrupted.binding).toEqual(sshBinding());
    expect(first.resume?.phase).toBe("remote-reboot-required");
    expect(first.resume?.helperSha256).toBe(HELPER_SHA256);
    expect(first.calls.some((call) => call.endsWith(":--verify"))).toBe(true);
    expect(first.calls).not.toContain("remote:10.10.0.2:--verify");
    const resumed = new PreparationHarness();
    resumed.resume = structuredClone(first.resume);
    trustFirstRail(resumed);
    expect(prepareDualStationPair(preparationOptions(), resumed.deps).kind).toBe("ready");
    expect(resumed.statePhases).toEqual(["remote-preparation", "ready"]);
    expect(resumed.calls.filter((call) => call.startsWith("remote:"))).toEqual([
      "remote:10.10.0.2:--check",
      "remote:10.10.0.2:--apply",
      "remote:10.10.0.2:--bind-controller",
      "remote:10.10.0.2:--verify",
    ]);
  });

  it("keeps a resumed pair with active vLLM pinned and fail-closed", () => {
    const harness = new PreparationHarness();
    harness.resume = readyState();
    trustFirstRail(harness);
    harness.remoteHelperStatus.set("--check", STATION_PREP_EXISTING_VLLM_EXIT);

    expect(() => prepareDualStationPair(preparationOptions(), harness.deps)).toThrow(
      /selected pair remains pinned/,
    );
    expect(harness.resume?.phase).toBe("remote-preparation");
    expect(harness.calls).toContain("local:--bind-controller");
    expect(harness.calls).not.toContain("remote:10.10.0.2:--apply");
  });
  it.each([
    {
      name: "revision",
      configure: () => undefined,
      options: { revision: "d".repeat(40), helperSha256: HELPER_SHA256 },
      expected: /requires NemoClaw revision/,
    },
    {
      name: "helper",
      configure: () => undefined,
      options: { revision: REVISION, helperSha256: "d".repeat(64) },
      expected: /helper changed/,
    },
    {
      name: "host key",
      configure: (harness) => {
        harness.trusted.set("10.10.0.2", sshBinding("10.10.0.2", "AAAAC3NzaChangedKey"));
      },
      expected: /host-key identity changed/,
    },
    {
      name: "GPU",
      configure: (harness) => {
        harness.peer.gpus[0].uuid = "GPU-SUBSTITUTED-0003";
      },
      expected: /physical dual-Station pair changed/,
    },
    {
      name: "rail",
      configure: (harness) => {
        harness.peer.rails[0].macAddress = "02:00:00:00:00:12";
      },
      expected: /physical dual-Station pair changed/,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    configure: (harness: PreparationHarness) => void;
    options?: ReturnType<typeof preparationOptions>;
    expected: RegExp;
  }>)(
    "rejects revision, helper, host-key, GPU, and rail substitution on resume [$name]",
    (scenario) => {
      const harness = new PreparationHarness();
      harness.resume = readyState();
      trustFirstRail(harness);
      scenario.configure(harness);
      expect(
        () => prepareDualStationPair(scenario.options ?? preparationOptions(), harness.deps),
        scenario.name,
      ).toThrow(scenario.expected);
      expect(
        harness.calls.some((call) => call.startsWith("remote:")),
        scenario.name,
      ).toBe(false);
    },
  );

  it("preserves a remote mismatch as a pinned fail-closed state", () => {
    const harness = new PreparationHarness();
    trustFirstRail(harness);
    harness.remoteHelperStatus.set("--apply", 1);

    expect(() => prepareDualStationPair(preparationOptions(), harness.deps)).toThrow(
      /refusing single-Station fallback/,
    );
    expect(harness.resume?.phase).toBe("remote-preparation");
    expect(harness.calls).not.toContain("remote:10.10.0.2:--verify");
  });

  it("fails closed when active vLLM appears after the read-only peer check", () => {
    const harness = new PreparationHarness();
    trustFirstRail(harness);
    harness.remoteHelperStatus.set("--apply", STATION_PREP_EXISTING_VLLM_EXIT);

    expect(() => prepareDualStationPair(preparationOptions(), harness.deps)).toThrow(
      /refusing single-Station fallback/,
    );
    expect(harness.resume?.phase).toBe("remote-preparation");
    expect(harness.calls).toContain("local:--bind-controller");
    expect(harness.calls).not.toContain("remote:10.10.0.2:--bind-controller");
  });

  it("revalidates an exact managed pair and binds both controllers without workload probes", () => {
    const harness = new PreparationHarness();
    trustFirstRail(harness);

    const result = prepareDualStationPair(
      { ...preparationOptions(), reuseExistingManagedPair: true },
      harness.deps,
    );
    expect(result.kind).toBe("ready");
    expect(harness.calls.filter((call) => call.startsWith("local:"))).toEqual([
      "local:--bind-controller",
    ]);
    expect(harness.calls.filter((call) => call.startsWith("remote:"))).toEqual([
      "remote:10.10.0.2:--bind-controller",
    ]);
    expect(harness.calls).toContain("connectivity:local");
    expect(harness.calls).toContain("connectivity:peer:10.10.0.2");
    expect(harness.resume?.phase).toBe("ready");
  });

  it("binds only the active local controller before preparing a peer for legacy migration", () => {
    const harness = new PreparationHarness();
    trustFirstRail(harness);
    expect(
      prepareDualStationPair(
        { ...preparationOptions(), migrateLegacySingleStationHead: true },
        harness.deps,
      ).kind,
    ).toBe("ready");
    expect(harness.calls.filter((call) => call.startsWith("local:"))).toEqual([
      "local:--bind-controller",
    ]);
    expect(harness.calls.filter((call) => call.startsWith("remote:"))).toEqual([
      "remote:10.10.0.2:--check",
      "remote:10.10.0.2:--apply",
      "remote:10.10.0.2:--bind-controller",
      "remote:10.10.0.2:--verify",
    ]);
  });
});

describe.sequential("dual-DGX Station trust and resume-state boundaries", () => {
  it("validates owner-only regular-file metadata", () => {
    expect(() =>
      validateResumeFileMetadata(
        { isFile: true, isSymbolicLink: false, uid: 1000, mode: 0o600, size: 100 },
        1000,
      ),
    ).not.toThrow();
    expect(() =>
      validateResumeFileMetadata(
        { isFile: true, isSymbolicLink: false, uid: 1001, mode: 0o600, size: 100 },
        1000,
      ),
    ).toThrow(/not owned/);
    expect(() =>
      validateResumeFileMetadata(
        { isFile: true, isSymbolicLink: false, uid: 1000, mode: 0o644, size: 100 },
        1000,
      ),
    ).toThrow(/0600/);
    expect(() =>
      validateResumeFileMetadata(
        { isFile: false, isSymbolicLink: true, uid: 1000, mode: 0o600, size: 100 },
        1000,
      ),
    ).toThrow(/symlink/);
  });

  it("writes, fsyncs, reads, and clears canonical owner-only state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-state-"));
    fs.chmodSync(directory, 0o700);
    const statePath = path.join(directory, "resume.json");
    try {
      const state = readyState();
      state.rails.reverse();
      writeDualStationResumeState(statePath, state);
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
      const loaded = readDualStationResumeState(statePath);
      expect(loaded?.rails.map((rail) => rail.localAddress)).toEqual(["10.10.0.1", "10.10.0.5"]);
      clearDualStationResumeState(statePath);
      expect(fs.existsSync(statePath)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clears an owner-only SSH binding orphan even when pair state is absent", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-state-"));
    fs.chmodSync(directory, 0o700);
    const statePath = path.join(directory, "resume.json");
    const bindingDirectory = `${statePath}.ssh-binding`;
    try {
      fs.mkdirSync(bindingDirectory, { mode: 0o700 });
      fs.writeFileSync(path.join(bindingDirectory, "orphan"), "binding\n", { mode: 0o600 });
      clearDualStationResumeState(statePath);
      expect(fs.existsSync(bindingDirectory)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, permissive, symlinked, and substitution-prone state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-state-"));
    fs.chmodSync(directory, 0o700);
    const statePath = path.join(directory, "resume.json");
    try {
      fs.writeFileSync(statePath, "not-json\n", { mode: 0o600 });
      expect(() => readDualStationResumeState(statePath)).toThrow(/malformed JSON/);

      fs.writeFileSync(statePath, `${JSON.stringify(readyState())}\n`, { mode: 0o600 });
      fs.chmodSync(statePath, 0o644);
      expect(() => readDualStationResumeState(statePath)).toThrow(/0600/);

      fs.rmSync(statePath);
      const target = path.join(directory, "target.json");
      fs.writeFileSync(target, `${JSON.stringify(readyState())}\n`, { mode: 0o600 });
      fs.symlinkSync(target, statePath);
      expect(() => readDualStationResumeState(statePath)).toThrow(/symlink/);

      const changed = readyState();
      changed.peerGpuUuid = changed.localGpuUuid;
      expect(() => parseDualStationResumeState(changed)).toThrow(/GPU identity/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires an existing owner-only resume directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-state-"));
    const missingState = path.join(root, "missing", "resume.json");
    try {
      expect(() => readDualStationResumeState(missingState)).toThrow(/must already exist/);
      fs.chmodSync(root, 0o755);
      expect(() => readDualStationResumeState(path.join(root, "resume.json"))).toThrow(
        /owner-only/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins the Station preparation endpoint after the strict SSH policy (#9519)", () => {
    const args = stationPrepSshArgs(sshBinding(), "/tmp/nemoclaw-known-hosts", "python3 -");
    expect(args).toEqual([
      ...strictVllmSshTransportArgs(),
      "-o",
      "UserKnownHostsFile=/tmp/nemoclaw-known-hosts",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "HostKeyAlias=10.10.0.2",
      "--",
      "10.10.0.2",
      "python3 -",
    ]);
  });

  it("builds the exact-byte noninteractive helper command", () => {
    const command = buildRemoteHelperCommand(HELPER_SHA256, "--apply");
    expect(command).toContain(HELPER_SHA256);
    expect(command).toContain("sudo -n true");
    expect(command).toContain("NEMOCLAW_STATION_PREP_SUDO_NONINTERACTIVE=1");
    expect(command).toContain('bash "$f" --apply');
    expect(buildRemoteHelperCommand(HELPER_SHA256, "--bind-controller")).toContain(
      'bash "$f" --bind-controller',
    );
  });

  it.each(["NVIDIA_API_KEY", "HF_TOKEN", "BASH_ENV", "ENV", "LD_PRELOAD", "SSH_ASKPASS"])(
    "does not expose ambient credentials or shell-loader variables to probes and helpers [case %#]",
    (forbidden) => {
      const env = buildStationPrepSubprocessEnv({
        HOME: "/home/operator",
        PATH: "/usr/bin:/bin",
        SSH_AUTH_SOCK: "/run/user/1000/agent",
        HTTPS_PROXY: "http://proxy.example:8080",
        LC_CTYPE: "en_US.UTF-8",
        NVIDIA_API_KEY: "secret",
        HF_TOKEN: "secret",
        BASH_ENV: "/tmp/evil",
        ENV: "/tmp/evil",
        LD_PRELOAD: "/tmp/evil.so",
        SSH_ASKPASS: "/tmp/evil",
      });
      expect(env).toMatchObject({
        HOME: "/home/operator",
        PATH: "/usr/bin:/bin",
        SSH_AUTH_SOCK: "/run/user/1000/agent",
        HTTPS_PROXY: "http://proxy.example:8080",
        LC_ALL: "C",
        LC_CTYPE: "en_US.UTF-8",
        LANG: "C",
      });

      expect(env).not.toHaveProperty(forbidden);
    },
  );

  it("forces every remote helper sudo call through noninteractive mode", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-sudo-"));
    const fakeSudo = path.join(root, "sudo");
    fs.writeFileSync(fakeSudo, "#!/usr/bin/env bash\nprintf 'SUDO_ARGS=%s\\n' \"$*\"\n", {
      mode: 0o700,
    });
    try {
      const strict = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          'source "$STATION_HELPER" >/dev/null; NEMOCLAW_STATION_PREP_SUDO_NONINTERACTIVE=1; sudo true',
        ],
        {
          encoding: "utf8",
          env: { HOME: root, PATH: `${root}:${TEST_SYSTEM_PATH}`, STATION_HELPER },
        },
      );
      const local = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-c", 'source "$STATION_HELPER" >/dev/null; sudo true'],
        {
          encoding: "utf8",
          env: { HOME: root, PATH: `${root}:${TEST_SYSTEM_PATH}`, STATION_HELPER },
        },
      );
      expect(strict.status, strict.stderr).toBe(0);
      expect(strict.stdout).toContain("SUDO_ARGS=-n true");
      expect(local.status, local.stderr).toBe(0);
      expect(local.stdout).toContain("SUDO_ARGS=true");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves matching revoked host keys in the pinned trust evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-trust-"));
    const bin = path.join(root, "bin");
    const knownHosts = path.join(root, "known_hosts");
    fs.mkdirSync(bin, { mode: 0o700 });
    fs.writeFileSync(knownHosts, "fixture\n", { mode: 0o600 });
    const ssh = path.join(bin, "ssh");
    const keygen = path.join(bin, "ssh-keygen");
    fs.writeFileSync(
      ssh,
      `#!/usr/bin/env bash
cat <<'EOF'
user ubuntu
hostname 10.10.0.2
port 22
batchmode yes
stricthostkeychecking true
verifyhostkeydns false
nohostauthenticationforlocalhost no
permitlocalcommand no
forwardagent no
forwardx11 no
forwardx11trusted no
tunnel false
updatehostkeys false
controlmaster false
controlpath none
remotecommand none
proxycommand none
proxyjump none
localcommand none
knownhostscommand none
userknownhostsfile ${knownHosts}
globalknownhostsfile none
sendenv LANG
sendenv LC_*
EOF
`,
      { mode: 0o700 },
    );
    fs.writeFileSync(
      keygen,
      `#!/usr/bin/env bash
if [[ " $* " == *" -F "* ]]; then
  printf '%s\n' '@revoked 10.10.0.2 ssh-ed25519 AAAAC3NzaRevoked'
  printf '%s\n' '10.10.0.2 ssh-ed25519 AAAAC3NzaTrusted'
else
  printf '%s\n' '256 ${HOST_KEY_FINGERPRINT} fixture (ED25519)'
fi
`,
      { mode: 0o700 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const binding = inspectPretrustedSshTarget("10.10.0.2");
      expect(binding?.knownHostsLines).toContain("@revoked 10.10.0.2 ssh-ed25519 AAAAC3NzaRevoked");
      expect(binding?.knownHostsLines).toContain("10.10.0.2 ssh-ed25519 AAAAC3NzaTrusted");
      fs.chmodSync(knownHosts, 0o666);
      expect(inspectPretrustedSshTarget("10.10.0.2")).toBeNull();
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["ssh-keyscan", "arp-scan", "avahi-browse", "dns-sd", "lldpctl", "nmap", "mdns-scan"])(
    "uses only deterministic rail candidates without trust enrollment or network discovery [%s]",
    (command) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-command-boundary-"));
      const bin = path.join(root, "bin");
      const stateDirectory = path.join(root, "state");
      const helper = path.join(root, "prepare-dgx-station-host.sh");
      const state = path.join(stateDirectory, "resume.json");
      const forbiddenLog = path.join(root, "forbidden.log");
      fs.mkdirSync(bin, { mode: 0o700 });
      fs.mkdirSync(stateDirectory, { mode: 0o700 });
      fs.writeFileSync(helper, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
      fs.writeFileSync(
        path.join(bin, "python3"),
        `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(stationHost("local"))}\nJSON\n`,
        { mode: 0o700 },
      );
      fs.writeFileSync(path.join(bin, "ssh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });

      fs.writeFileSync(
        path.join(bin, command),
        `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(command)} >>${JSON.stringify(forbiddenLog)}\nexit 97\n`,
        { mode: 0o700 },
      );

      try {
        const result = spawnSync(
          process.execPath,
          [
            "--no-warnings",
            "--experimental-strip-types",
            COORDINATOR,
            "--helper",
            helper,
            "--state",
            state,
            "--revision",
            REVISION,
          ],
          {
            cwd: REPO_ROOT,
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: root,
              PATH: `${bin}:${TEST_SYSTEM_PATH}`,
            },
            timeout: 20_000,
            killSignal: "SIGKILL",
          },
        );

        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ kind: "single-station" });
        expect(fs.existsSync(forbiddenLog)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["ssh-keyscan", "arp-scan", "avahi-browse", "dns-sd", "lldpctl", "nmap", "mdns-scan"])(
    "keeps forbidden discovery and trust enrollment unreachable through pair qualification [%s]",
    (command) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-ready-boundary-"));
      const bin = path.join(root, "bin");
      const stateDirectory = path.join(root, "state");
      const helper = path.join(root, "prepare-dgx-station-host.sh");
      const state = path.join(stateDirectory, "resume.json");
      const knownHosts = path.join(root, "known_hosts");
      const forbiddenLog = path.join(root, "forbidden.log");
      fs.mkdirSync(bin, { mode: 0o700 });
      fs.mkdirSync(stateDirectory, { mode: 0o700 });
      fs.writeFileSync(helper, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
      fs.writeFileSync(knownHosts, "fixture\n", { mode: 0o600 });
      fs.writeFileSync(path.join(bin, "docker"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o700,
      });
      fs.writeFileSync(
        path.join(bin, "python3"),
        `#!/usr/bin/env bash
set -Eeuo pipefail
cat >/dev/null
if (($# == 1)); then
  cat <<'JSON'
${JSON.stringify(stationHost("local"))}
JSON
else
  cat <<'JSON'
${stationConnectivity("local")}
JSON
fi
`,
        { mode: 0o700 },
      );
      fs.writeFileSync(
        path.join(bin, "ssh-keygen"),
        `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ " $* " == *" -F 10.10.0.2 "* ]]; then
  printf '%s\n' '10.10.0.2 ssh-ed25519 ${HOST_KEY_DATA}'
  exit 0
fi
if [[ " $* " == *" -F "* ]]; then
  exit 1
fi
printf '%s\n' '256 ${HOST_KEY_FINGERPRINT} fixture (ED25519)'
`,
        { mode: 0o700 },
      );
      fs.writeFileSync(
        path.join(bin, "ssh"),
        `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ " $* " == *" -G "* ]]; then
  target=''
  for value in "$@"; do target="$value"; done
  [[ "$target" == '10.10.0.2' ]] || exit 1
  cat <<'EOF'
user ubuntu
hostname 10.10.0.2
port 22
batchmode yes
stricthostkeychecking true
verifyhostkeydns false
nohostauthenticationforlocalhost no
permitlocalcommand no
forwardagent no
forwardx11 no
forwardx11trusted no
tunnel false
updatehostkeys false
controlmaster false
controlpath none
remotecommand none
proxycommand none
proxyjump none
localcommand none
knownhostscommand none
userknownhostsfile ${knownHosts}
globalknownhostsfile none
sendenv LANG
sendenv LC_*
EOF
  exit 0
fi
if [[ " $* " == *'python3 - enp1s0f0np0'* ]]; then
  cat >/dev/null
  cat <<'JSON'
${stationConnectivity("peer")}
JSON
  exit 0
fi
if [[ " $* " == *'python3 -'* ]]; then
  cat >/dev/null
  cat <<'JSON'
${JSON.stringify(stationHost("peer"))}
JSON
  exit 0
fi
if [[ " $* " == *'prepare-dgx-station-host.sh'* ]]; then
  cat >/dev/null
  exit 0
fi
exit 96
`,
        { mode: 0o700 },
      );

      fs.writeFileSync(
        path.join(bin, command),
        `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(command)} >>${JSON.stringify(forbiddenLog)}\nexit 97\n`,
        { mode: 0o700 },
      );

      try {
        const result = spawnSync(
          process.execPath,
          [
            "--no-warnings",
            "--experimental-strip-types",
            COORDINATOR,
            "--helper",
            helper,
            "--state",
            state,
            "--revision",
            REVISION,
          ],
          {
            cwd: REPO_ROOT,
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: root,
              PATH: `${bin}:${TEST_SYSTEM_PATH}`,
            },
            timeout: 20_000,
            killSignal: "SIGKILL",
          },
        );

        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ kind: "ready", peerTarget: "10.10.0.2" });
        expect(fs.existsSync(forbiddenLog)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("dual-DGX Station installer handoff", () => {
  it("changes the Ultra topology only after the coordinator returns a validated ready pair", () => {
    const argsFile = path.join(os.tmpdir(), `nemoclaw-pair-args-${process.pid}-${Date.now()}`);
    const { result, output, home } = runInstallerBody(
      `
node() {
  if [[ "\${1:-}" == "--no-warnings" ]]; then
    printf '%s\n' "$PAIR_RESULT"
    printf '%s\n' "$*" >"$PAIR_ARGS_FILE"
    return 0
  fi
  command node "$@"
}
station_installer_revision() { printf '%s' "$PAIR_REVISION"; }
station_dual_pair_resume_pending() { return 0; }
_SELECTED_EXPRESS_PLATFORM='DGX Station'
_STATION_EXPRESS_MODEL_WAS_EXPLICIT=0
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
NEMOCLAW_MODEL='nvidia/nemotron-3-ultra-550b-a55b'
unset NEMOCLAW_DGX_STATION_PEER NEMOCLAW_DGX_STATION_SSH_BINDING
ensure_station_express_pair
printf 'RESULT peer=%s model=%s selector=%s binding=%s\n' "\${NEMOCLAW_DGX_STATION_PEER:-}" "\${NEMOCLAW_MODEL:-}" "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_DGX_STATION_SSH_BINDING:-}"
`,
      {
        PAIR_ARGS_FILE: argsFile,
        PAIR_RESULT: coordinatorResult("ready"),
        PAIR_REVISION: REVISION,
      },
    );
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain(
        "RESULT peer=10.10.0.2 model=nemotron-ultra selector=nemotron-3-ultra-550b-a55b",
      );
      const expectedToken = JSON.parse(coordinatorResult("ready")).sshBinding;
      expect(output).toContain(`binding=${expectedToken}`);
      const args = fs.readFileSync(argsFile, "utf8");
      expect(args).toContain("--helper");
      expect(args).toContain("prepare-dgx-station-host.sh");
      expect(args).toContain(`--revision ${REVISION}`);
      expect(args).not.toContain("--explicit-peer");
    } finally {
      fs.rmSync(argsFile, { force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("passes explicit peer and exact managed-pair reuse without shell interpolation", () => {
    const argsFile = path.join(os.tmpdir(), `nemoclaw-pair-args-${process.pid}-${Date.now()}`);
    const explicitPeer = "ubuntu@station-b";
    const { result, output, home } = runInstallerBody(
      `
node() {
  if [[ "\${1:-}" == "--no-warnings" ]]; then
    printf '%s\n' "$PAIR_RESULT"
    printf '%s\n' "$*" >"$PAIR_ARGS_FILE"
    return 0
  fi
  command node "$@"
}
station_installer_revision() { printf '%s' "$PAIR_REVISION"; }
station_dual_pair_resume_pending() { return 0; }
_SELECTED_EXPRESS_PLATFORM='DGX Station'
_STATION_EXPRESS_MODEL_WAS_EXPLICIT=0
_STATION_EXPRESS_DEFERRED_MANAGED_PAIR=1
NEMOCLAW_DGX_STATION_PEER="$PAIR_PEER"
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
NEMOCLAW_MODEL='nvidia/nemotron-3-ultra-550b-a55b'
unset NEMOCLAW_DGX_STATION_SSH_BINDING
ensure_station_express_pair
printf 'RESULT peer=%s model=%s binding=%s\n' "$NEMOCLAW_DGX_STATION_PEER" "$NEMOCLAW_MODEL" "$NEMOCLAW_DGX_STATION_SSH_BINDING"
`,
      {
        PAIR_ARGS_FILE: argsFile,
        PAIR_PEER: explicitPeer,
        PAIR_RESULT: coordinatorResult("ready", explicitPeer),
        PAIR_REVISION: REVISION,
      },
    );
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain(`RESULT peer=${explicitPeer} model=nemotron-ultra`);
      expect(output).toContain(`binding=${JSON.parse(coordinatorResult("ready")).sshBinding}`);
      const args = fs.readFileSync(argsFile, "utf8");
      expect(args).toContain(`--explicit-peer ${explicitPeer}`);
      expect(args).toContain("--reuse-existing-managed-pair");
    } finally {
      fs.rmSync(argsFile, { force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves the Station resume receipt when an automatic peer is unavailable", () => {
    const { result, output, home } = runInstallerBody(
      `
node() {
  if [[ "\${1:-}" == "--no-warnings" ]]; then
    printf '%s\n' '{"kind":"single-station","reason":"peer has an active vLLM workload"}'
    return 0
  fi
  command node "$@"
}
station_installer_revision() { printf '%s' "$PAIR_REVISION"; }
station_express_resume_generation() { printf '0123456789abcdef0123456789abcdef'; }
_SELECTED_EXPRESS_PLATFORM='DGX Station'
_STATION_EXPRESS_MODEL_WAS_EXPLICIT=0
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
NEMOCLAW_MODEL='nvidia/nemotron-3-ultra-550b-a55b'
unset NEMOCLAW_DGX_STATION_PEER
NEMOCLAW_DGX_STATION_SSH_BINDING='stale'
ensure_station_express_pair
printf 'RESULT peer=%s model=%s selector=%s binding=%s receipt=%s\n' "\${NEMOCLAW_DGX_STATION_PEER:-}" "\${NEMOCLAW_MODEL:-}" "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_DGX_STATION_SSH_BINDING:-}" "$(sed -n '3p' "$HOME/.nemoclaw/station-express-resume")"
`,
      { PAIR_REVISION: REVISION },
    );
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain("No eligible reciprocal dual-DGX Station pair is available");
      expect(output).toContain(
        "RESULT peer= model=nvidia/nemotron-3-ultra-550b-a55b selector=nemotron-3-ultra-550b-a55b binding= receipt=generation=0123456789abcdef0123456789abcdef",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an explicit peer combined with an explicit non-dual model", () => {
    const { result, output, home } = runInstallerBody(
      `
node() { printf 'COORDINATOR_CALLED\n'; return 0; }
_SELECTED_EXPRESS_PLATFORM='DGX Station'
_STATION_EXPRESS_MODEL_WAS_EXPLICIT=1
NEMOCLAW_VLLM_MODEL='deepseek-v4-flash'
NEMOCLAW_DGX_STATION_PEER='ubuntu@station-b'
ensure_station_express_pair
`,
    );
    try {
      expect(result.status, output).not.toBe(0);
      expect(output).toContain(
        "NEMOCLAW_DGX_STATION_PEER requires the DGX Station dual-serving model",
      );
      expect(output).not.toContain("COORDINATOR_CALLED");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects conflicting peer and model selections before local host preparation", () => {
    const { result, output, home } = runInstallerBody(
      `
maybe_offer_express_install() {
  _SELECTED_EXPRESS_PLATFORM='DGX Station'
  _STATION_EXPRESS_MODEL_WAS_EXPLICIT=1
  NEMOCLAW_VLLM_MODEL='deepseek-v4-flash'
  NEMOCLAW_DGX_STATION_PEER='ubuntu@station-b'
}
ensure_station_express_host() { printf 'LOCAL_HELPER_CALLED\n'; }
ensure_docker() { printf 'DOCKER_CALLED\n'; }
ensure_openshell_build_deps() { printf 'BUILD_DEPS_CALLED\n'; }
prepare_installer_host
`,
    );
    try {
      expect(result.status, output).not.toBe(0);
      expect(output).toContain(
        "NEMOCLAW_DGX_STATION_PEER requires the DGX Station dual-serving model",
      );
      expect(output).not.toContain("LOCAL_HELPER_CALLED");
      expect(output).not.toContain("DOCKER_CALLED");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("propagates peer exit 10 with manual reboot and exact-revision rerun guidance", () => {
    const { result, output, home } = runInstallerBody(
      `
node() {
  if [[ "\${1:-}" == "--no-warnings" ]]; then
    printf '%s\n' "$PAIR_RESULT"
    return 10
  fi
  command node "$@"
}
station_installer_revision() { printf '%s' "$PAIR_REVISION"; }
save_station_express_resume() { _STATION_EXPRESS_RESUME_REVISION="$PAIR_REVISION" _STATION_EXPRESS_RESUME_AGENT='openclaw' _STATION_EXPRESS_RESUME_SANDBOX='my-assistant' _STATION_EXPRESS_RESUME_POLICY_TIER='balanced' _STATION_EXPRESS_RESUME_GATEWAY_PORT='8080' _STATION_EXPRESS_RESUME_DASHBOARD_PORT='18789' _STATION_EXPRESS_RESUME_VLLM_PORT='8000'; printf 'SAVED_EXPRESS_RESUME\n'; }
station_dual_pair_resume_pending() { return 0; }
_SELECTED_EXPRESS_PLATFORM='DGX Station'
_STATION_EXPRESS_MODEL_WAS_EXPLICIT=0
_STATION_INSTALL_MODE='express'
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
NEMOCLAW_MODEL='nvidia/nemotron-3-ultra-550b-a55b'
unset NEMOCLAW_DGX_STATION_PEER
ensure_station_express_pair
`,
      { PAIR_RESULT: coordinatorResult("reboot-required"), PAIR_REVISION: REVISION },
    );
    try {
      expect(result.status, output).toBe(10);
      expect(output).toContain("SAVED_EXPRESS_RESUME");
      expect(output).toContain("requires a manual reboot");
      expect(output).toContain(`NEMOCLAW_INSTALL_TAG=${REVISION}`);
      expect(output).not.toMatch(/reboot.*-[a-z]*f/i);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves companion resume state when coordinator failure follows pair-state publication", () => {
    const { result, output, home } = runInstallerBody(
      `
node() {
  if [[ "\${1:-}" == "--no-warnings" ]]; then
    while (( $# > 0 )); do
      if [[ "$1" == "--state" ]]; then
        printf '{}\n' >"$2"
        break
      fi
      shift
    done
    return 1
  fi
  command node "$@"
}
station_installer_revision() { printf '%s' "$PAIR_REVISION"; }
_SELECTED_EXPRESS_PLATFORM='DGX Station'
_STATION_EXPRESS_MODEL_WAS_EXPLICIT=0
_STATION_INSTALL_MODE='express'
station_express_resume_generation() { printf '0123456789abcdef0123456789abcdef'; }
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
NEMOCLAW_MODEL='nvidia/nemotron-3-ultra-550b-a55b'
unset NEMOCLAW_DGX_STATION_PEER
ensure_station_express_pair
`,
      { PAIR_REVISION: REVISION },
    );
    try {
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("Dual DGX Station preparation failed");
      expect(fs.existsSync(path.join(home, ".nemoclaw", "station-dual-pair-resume.json"))).toBe(
        true,
      );
      expect(fs.readFileSync(path.join(home, ".nemoclaw", "station-express-resume"), "utf8")).toBe(
        `revision=${REVISION}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=0123456789abcdef0123456789abcdef\n` +
          "agent=openclaw\nsandbox=my-assistant\npolicy_tier=balanced\n" +
          "gateway_port=8080\ndashboard_port=18789\nvllm_port=8000\nmode=express\n",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("defers host preparation only for a complete current or schema-2 managed dual-head candidate", () => {
    const valid = [
      "/nemoclaw-vllm",
      "true",
      "true",
      "head",
      DUAL_STATION_VLLM_LAUNCH_SCHEMA,
      "c".repeat(64),
      "d".repeat(64),
      "e".repeat(64),
      "f".repeat(32),
    ].join(" ");
    const accepted = runInstallerBody(
      `
command_exists() { return 0; }
docker() { printf '%s\n' "$DOCKER_INSPECTION"; }
station_managed_dual_head_running
`,
      { DOCKER_INSPECTION: valid },
    );
    const previousSchemaAccepted = runInstallerBody(
      `
command_exists() { return 0; }
docker() { printf '%s\n' "$DOCKER_INSPECTION"; }
station_managed_dual_head_running
`,
      { DOCKER_INSPECTION: valid.replace(` head ${DUAL_STATION_VLLM_LAUNCH_SCHEMA} `, " head 2 ") },
    );
    const malformed = runInstallerBody(
      `
command_exists() { return 0; }
docker() { printf '%s\n' "$DOCKER_INSPECTION"; }
station_managed_dual_head_running
`,
      { DOCKER_INSPECTION: valid.replace(" head ", " worker ") },
    );
    try {
      expect(accepted.result.status, accepted.output).toBe(0);
      expect(previousSchemaAccepted.result.status, previousSchemaAccepted.output).toBe(0);
      expect(malformed.result.status, malformed.output).not.toBe(0);
    } finally {
      fs.rmSync(accepted.home, { recursive: true, force: true });
      fs.rmSync(previousSchemaAccepted.home, { recursive: true, force: true });
      fs.rmSync(malformed.home, { recursive: true, force: true });
    }
  });

  it("applies Station preparation to an explicitly selected managed-vLLM provider", () => {
    const { result, output, home } = runInstallerBody(
      `
detect_express_platform() { printf 'DGX Station'; }
NON_INTERACTIVE=''
NEMOCLAW_NO_EXPRESS=''
NEMOCLAW_PROVIDER='install-vllm'
unset NEMOCLAW_VLLM_MODEL
maybe_offer_express_install
printf 'RESULT selected=%s provider=%s selector=%s\n' "$_SELECTED_EXPRESS_PLATFORM" "$NEMOCLAW_PROVIDER" "\${NEMOCLAW_VLLM_MODEL:-}"
`,
    );
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain("explicitly selected managed-vLLM provider");
      expect(output).toContain("RESULT selected=DGX Station provider=install-vllm selector=");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
