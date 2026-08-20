// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { PodmanSocketAuthority } from "../../../src/lib/adapters/podman/index.ts";
import {
  DEFAULT_DOCKER_DRIVER_NETWORK_NAME,
  DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
} from "../../../src/lib/onboard/experimental/docker-network-authority.ts";
import {
  inspectPortableCpuDelegation,
  type CpuDelegationPreflight,
} from "../../../src/lib/onboard/experimental/portable-cpu-delegation-preflight.ts";
import {
  portableHostPreparationInternals,
  preparePortableExperimentalHost,
} from "../../../src/lib/onboard/experimental/portable-host-preparation.ts";
import {
  PORTABLE_HOST_GATEWAY_IP,
  PORTABLE_REGISTRY_IP,
} from "../../../src/lib/onboard/experimental/portable-profile.ts";
import { test } from "../fixtures/e2e-test.ts";

type ExpectedState = "missing" | "delegated";
type SpawnResult = ReturnType<typeof spawnSync>;

interface AdmissionEvidence {
  readonly admissionCompleted: boolean;
  readonly admissionEffects: readonly string[];
  readonly effectsBeforeAdmission: number;
}

function expectedState(value: string | undefined): ExpectedState {
  assert.ok(
    value === "missing" || value === "delegated",
    "E2E_CPU_DELEGATION_STATE must be missing or delegated.",
  );
  return value;
}

function expectedUid(): number {
  const value = Number(process.env.E2E_CPU_DELEGATION_UID);
  assert.ok(Number.isInteger(value) && value >= 0, "E2E_CPU_DELEGATION_UID must be a user ID");
  return value;
}

function sourceRevision(): string {
  const value = process.env.E2E_SOURCE_REVISION;
  assert.match(value ?? "", /^[a-f0-9]{40}$/u, "E2E_SOURCE_REVISION must be a commit SHA");
  const checkoutRevision = execFileSync(
    "git",
    ["-c", `safe.directory=${process.cwd()}`, "rev-parse", "HEAD"],
    { encoding: "utf8", killSignal: "SIGKILL", timeout: 10_000 },
  ).trim();
  assert.equal(value, checkoutRevision, "CPU delegation proof must run the requested commit");
  return value!;
}

function commandResult(status = 0, stdout = ""): SpawnResult {
  return { status, stdout, stderr: "" } as SpawnResult;
}

function socketAuthority(uid: number, socketPath: string): PodmanSocketAuthority {
  return {
    directoryChain: [],
    device: "1",
    inode: "2",
    mode: String(0o140660),
    ownerUid: String(uid),
    socketPath,
  };
}

function proveFailureBeforeEffects(
  preflight: CpuDelegationPreflight,
  uid: number,
  artifactRoot: string,
): AdmissionEvidence {
  assert.equal(preflight.ok, false);
  assert.equal(preflight.failure, "systemd-user-delegation-missing");
  const effects: string[] = [];
  const home = fs.mkdtempSync(path.join(artifactRoot, "rejected-home-"));
  const effect = (name: string): never => {
    effects.push(name);
    throw new Error(`Portable host preparation reached ${name} after failed CPU delegation.`);
  };
  try {
    assert.throws(
      () =>
        preparePortableExperimentalHost(
          { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
          {
            platform: "linux",
            home,
            uid,
            cpuDelegationPreflight: () => preflight,
            validateConfigAuthority: () => effect("config authority validation"),
            systemctl: () => effect("systemd mutation"),
            podman: () => effect("Podman mutation"),
            docker: () => effect("Docker-compatible mutation"),
          },
        ),
      /Portable CPU-delegation preflight failed/u,
    );
    assert.deepEqual(fs.readdirSync(home), []);
    assert.equal(effects.length, 0);
    return {
      admissionCompleted: false,
      admissionEffects: [],
      effectsBeforeAdmission: effects.length,
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function proveAdmission(
  preflight: CpuDelegationPreflight,
  uid: number,
  artifactRoot: string,
): AdmissionEvidence {
  assert.equal(preflight.ok, true, preflight.detail);
  assert.equal(preflight.failure, undefined);
  const effects: string[] = [];
  const effectsBeforeAdmission = effects.length;
  const home = fs.mkdtempSync(path.join(artifactRoot, "admitted-home-"));
  const socketPath = `/run/user/${String(uid)}/podman/podman.sock`;
  const authority = socketAuthority(uid, socketPath);
  const networkName = DEFAULT_DOCKER_DRIVER_NETWORK_NAME;
  const registryContainer = portableHostPreparationInternals.REGISTRY_CONTAINER;
  const dockerResults: ReadonlyMap<string, SpawnResult> = new Map([
    [JSON.stringify(["--version"]), commandResult()],
    [
      JSON.stringify([
        "network",
        "inspect",
        "--format",
        DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
        networkName,
      ]),
      commandResult(0, JSON.stringify([{ Subnet: "169.254.1.0/24" }])),
    ],
    [
      JSON.stringify([
        "inspect",
        "--format",
        `{{ index .Config.Labels "com.nvidia.nemoclaw.portable" }} {{.State.Running}} {{with index .NetworkSettings.Networks ${JSON.stringify(networkName)}}}{{.IPAddress}}{{end}}`,
        registryContainer,
      ]),
      commandResult(0, `1 true ${PORTABLE_REGISTRY_IP}`),
    ],
  ]);
  const ipResults: ReadonlyMap<string, readonly [string, SpawnResult]> = new Map([
    [
      JSON.stringify(["-j", "-4", "address", "show"]),
      [
        "retired portable host gateway address inspection",
        commandResult(
          0,
          JSON.stringify([
            {
              ifname: "lo",
              addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8 }],
            },
          ]),
        ),
      ],
    ],
    [
      JSON.stringify(["-o", "-4", "address", "show"]),
      [
        "portable host gateway address inspection",
        commandResult(0, `1: lo    inet ${PORTABLE_HOST_GATEWAY_IP}/32 scope global lo\n`),
      ],
    ],
  ]);
  try {
    const prepared = preparePortableExperimentalHost(
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      {
        platform: "linux",
        home,
        uid,
        cpuDelegationPreflight: () => preflight,
        validateConfigAuthority: () => effects.push("config authority validation"),
        systemctl: (args) => {
          effects.push(`systemctl ${args.join(" ")}`);
          return commandResult();
        },
        hardenSocketDirectory: () => effects.push("socket directory hardening"),
        captureSocketAuthority: () => {
          effects.push("socket authority capture");
          return authority;
        },
        assertSocketAuthority: () => effects.push("socket authority assertion"),
        runtimeReadiness: {
          podmanCapture: () => {
            effects.push("Podman API health probe");
            return {
              status: 0,
              stdout: JSON.stringify({ Server: { Version: "proof" } }),
              stderr: "",
            };
          },
        },
        docker: (args) => {
          effects.push(`docker-compatible ${args.join(" ")}`);
          const result = dockerResults.get(JSON.stringify(args));
          assert.ok(result, `Unexpected Docker-compatible proof command: ${args.join(" ")}`);
          return result;
        },
        ip: (args) => {
          const result = ipResults.get(JSON.stringify(args));
          assert.ok(result, `Unexpected host address proof command: ${args.join(" ")}`);
          effects.push(result[0]);
          return result[1];
        },
        sudo: () => assert.fail("Existing portable host gateway address must not require sudo."),
      },
    );
    assert.ok(prepared, "Delegated CPU hierarchy must complete portable host admission.");
    assert.equal(prepared.authority.uid, uid);
    assert.equal(prepared.authority.socketPath, socketPath);
    assert.ok(effects.length > effectsBeforeAdmission);
    return {
      admissionCompleted: true,
      admissionEffects: effects,
      effectsBeforeAdmission,
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const proveState: Record<
  ExpectedState,
  (preflight: CpuDelegationPreflight, uid: number, artifactRoot: string) => AdmissionEvidence
> = {
  missing: proveFailureBeforeEffects,
  delegated: proveAdmission,
};

const proof = process.env.E2E_TARGET_ID === "portable-cpu-delegation" ? test : test.skip;

proof(
  "records portable CPU delegation evidence for the configured hierarchy (#9188)",
  {
    timeout: 30_000,
    meta: {
      e2ePhases: [
        "inspect the configured CPU delegation hierarchy",
        "record CPU delegation admission evidence",
      ],
    },
  },
  async ({ artifacts, progress }) => {
    assert.equal(process.platform, "linux", "CPU delegation proof requires Linux");
    const uid = expectedUid();
    assert.notEqual(uid, 0, "CPU delegation proof requires a non-root user");
    assert.equal(
      process.getuid?.(),
      uid,
      "CPU delegation proof must run as the dedicated non-root user",
    );
    const state = expectedState(process.env.E2E_CPU_DELEGATION_STATE);
    const revision = sourceRevision();
    progress.phase("inspect the configured CPU delegation hierarchy");
    const preflight = inspectPortableCpuDelegation({ uid });
    const evidence = proveState[state](preflight, uid, artifacts.rootDir);
    progress.phase("record CPU delegation admission evidence");
    await artifacts.writeJson(`${state}.json`, {
      schemaVersion: 1,
      sourceRevision: revision,
      state,
      uid,
      ok: preflight.ok,
      failure: preflight.failure ?? null,
      detail: preflight.detail,
      ...evidence,
    });
  },
);
