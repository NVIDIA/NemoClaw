// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PodmanBoundContainerEngine } from "../../../src/lib/adapters/podman/index.ts";
import { isValidName } from "../../../src/lib/name-validation.ts";
import { nativeRuntimeQualificationCaseInternals } from "../live/native-runtime-qualification-case-executor.ts";
import { NATIVE_RUNTIME_QUALIFICATION_AGENTS } from "../registry/native-runtime-qualification.ts";

const NETWORK_ID = "a".repeat(64);
const NETWORK_NAME = "nemoclaw-q-0123456789ab";
const CASE_ID = "podman-openclaw-linux-amd64-cpu-ollama";
const QUALIFICATION_LABEL = "ai.nvidia.nemoclaw.qualification";
const GPU_PROBE_IMAGE = `nvcr.io/nvidia/k8s/cuda-sample@sha256:${"d".repeat(64)}`;

function inspection(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      id: NETWORK_ID,
      labels: { [QUALIFICATION_LABEL]: CASE_ID },
      name: NETWORK_NAME,
      subnets: [{ gateway: "10.89.0.1" }],
      ...overrides,
    },
  ]);
}

type EngineOutput =
  | string
  | (() => never)
  | { readonly status: number; readonly stdout?: string; readonly stderr?: string };

function engine(outputs: readonly EngineOutput[]): {
  readonly capture: ReturnType<typeof vi.fn>;
  readonly value: PodmanBoundContainerEngine;
} {
  let index = 0;
  const capture = vi.fn((args: readonly string[]) => {
    const configured = outputs[index++];
    const output = typeof configured === "function" ? configured() : configured;
    return typeof output === "object"
      ? { status: output.status, stdout: output.stdout ?? "", stderr: output.stderr ?? "" }
      : {
          status: output === undefined && args[0] === "network" && args[1] === "exists" ? 1 : 0,
          stdout: output ?? "",
          stderr: "",
        };
  });
  return {
    capture,
    value: {
      operation: "host-local-inference",
      engineId: "podman",
      displayName: "Podman",
      authorityId: `podman-sha256:${"b".repeat(64)}`,
      endpointAuthorityId: `podman-sha256:${"c".repeat(64)}`,
      capture,
      captureHost: vi.fn(),
      assertAuthority: vi.fn(),
    } as unknown as PodmanBoundContainerEngine,
  };
}

describe("native runtime GPU evidence", () => {
  it("overrides the probe image entrypoint with the exact nvidia-smi UUID query", () => {
    const gpuUuid = "GPU-8932f937-d72c-4106-c12f-20bd9faed9f6";
    const runtime = engine([gpuUuid]);

    expect(
      nativeRuntimeQualificationCaseInternals.proveGpuDevices(runtime.value, GPU_PROBE_IMAGE),
    ).toEqual([gpuUuid]);
    expect(runtime.capture.mock.calls.map(([args]) => args)).toEqual([
      [
        "run",
        "--rm",
        "--pull=never",
        "--device",
        "nvidia.com/gpu=all",
        "--entrypoint",
        "nvidia-smi",
        GPU_PROBE_IMAGE,
        "--query-gpu=uuid",
        "--format=csv,noheader",
      ],
    ]);
  });

  it("accepts bounded NVIDIA physical GPU identities and sorts them exactly", () => {
    expect(
      nativeRuntimeQualificationCaseInternals.parsePhysicalGpuDevices(
        [
          "GPU-z9Y8x7W6-v5U4-t3S2-r1Q0-p9O8n7M6l5K4",
          "GPU-8932f937-d72c-4106-c12f-20bd9faed9f6",
        ].join("\n"),
      ),
    ).toEqual([
      "GPU-8932f937-d72c-4106-c12f-20bd9faed9f6",
      "GPU-z9Y8x7W6-v5U4-t3S2-r1Q0-p9O8n7M6l5K4",
    ]);
  });

  it.each([
    ["empty output", ""],
    [
      "duplicate identities",
      "GPU-8932f937-d72c-4106-c12f-20bd9faed9f6\nGPU-8932f937-d72c-4106-c12f-20bd9faed9f6",
    ],
    ["MIG identities", "MIG-8932f937-d72c-4106-c12f-20bd9faed9f6"],
    ["leading hyphens", "GPU--932f937"],
    ["trailing hyphens", "GPU-8932f937-"],
    ["control characters", "GPU-8932f937\u0000"],
  ])("rejects %s as physical GPU proof", (_label, output) => {
    expect(() => nativeRuntimeQualificationCaseInternals.parsePhysicalGpuDevices(output)).toThrow(
      "NVIDIA CDI runtime proof did not return exact physical GPU UUIDs",
    );
  });

  it("reports the bounded rejected rows for protected-run diagnosis", () => {
    expect(() =>
      nativeRuntimeQualificationCaseInternals.parsePhysicalGpuDevices("unexpected-row"),
    ).toThrow(
      'NVIDIA CDI runtime proof did not return exact physical GPU UUIDs: ["unexpected-row"]',
    );
  });
});

describe("native runtime failure diagnosis", () => {
  it("emits only allowlisted inference state without logs or child output", () => {
    const containerId = "e".repeat(64);
    const runtime = engine([
      JSON.stringify({
        Status: "exited",
        ExitCode: 1,
        OOMKilled: false,
        Running: false,
        Error: "Authorization: Bearer credential-like-value",
        Request: "private request content",
      }),
    ]);

    const diagnostic = nativeRuntimeQualificationCaseInternals.inferenceFailureDiagnostic(
      runtime.value,
      containerId,
    );

    expect(diagnostic).toBe(
      'state={"status":"exited","exitCode":1,"oomKilled":false,"running":false}',
    );
    expect(diagnostic).not.toContain("credential-like-value");
    expect(diagnostic).not.toContain("private request content");
    expect(runtime.capture.mock.calls.map(([args]) => args)).toEqual([
      ["inspect", "--format", "{{json .State}}", containerId],
    ]);
  });

  it("does not echo an unexpected state string", () => {
    const diagnostic = nativeRuntimeQualificationCaseInternals.inferenceFailureDiagnostic(
      engine([JSON.stringify({ Status: "credential-like-value" })]).value,
      "e".repeat(64),
    );

    expect(diagnostic).toBe(
      'state={"status":"unknown","exitCode":null,"oomKilled":false,"running":false}',
    );
    expect(diagnostic).not.toContain("credential-like-value");
  });
});

describe("native runtime failed-case cleanup", () => {
  it.each([
    ["container", ["rm", "--force", "container-id"], ["container", "exists", "container-id"]],
    ["volume", ["volume", "rm", "--force", "volume-id"], ["volume", "exists", "volume-id"]],
    ["network", ["network", "rm", "--force", "network-id"], ["network", "exists", "network-id"]],
  ] as const)("reports an unproven %s removal without child output", (kind, remove, exists) => {
    const runtime = engine([
      { status: 1, stderr: "Authorization: Bearer cleanup-secret" },
      { status: 0 },
    ]);

    const failures = nativeRuntimeQualificationCaseInternals.collectOwnedResourceCleanupFailures([
      { engine: runtime.value, identities: [`${kind}-id`], kind },
    ]);

    expect(failures.map((failure) => failure.message)).toEqual([
      `Native runtime qualification ${kind} cleanup failed for ${kind}-id (remove exit 1; exists exit 0)`,
    ]);
    expect(failures[0]?.message).not.toContain("cleanup-secret");
    expect(runtime.capture.mock.calls.map(([args]) => args)).toEqual([remove, exists]);
  });

  it("routes each resource to its owning engine and continues after one removal throws", () => {
    const lifecycle = engine([
      () => {
        throw new Error("container removal failed");
      },
      { status: 0 },
      { status: 0 },
      { status: 1 },
    ]);
    const inference = engine([{ status: 0 }, { status: 1 }, { status: 0 }, { status: 1 }]);

    const failures =
      nativeRuntimeQualificationCaseInternals.collectQualificationResourceCleanupFailures({
        inferenceContainers: ["inference-id"],
        inferenceEngine: inference.value,
        lifecycleContainers: ["container-id"],
        lifecycleEngine: lifecycle.value,
        networks: ["network-id"],
        volumes: ["volume-id"],
      });

    expect(failures.map((failure) => failure.message)).toEqual([
      "Native runtime qualification container cleanup failed for container-id (remove threw; exists exit 0)",
    ]);
    expect(lifecycle.capture.mock.calls.map(([args]) => args)).toEqual([
      ["rm", "--force", "container-id"],
      ["container", "exists", "container-id"],
      ["volume", "rm", "--force", "volume-id"],
      ["volume", "exists", "volume-id"],
    ]);
    expect(inference.capture.mock.calls.map(([args]) => args)).toEqual([
      ["rm", "--force", "inference-id"],
      ["container", "exists", "inference-id"],
      ["network", "rm", "--force", "network-id"],
      ["network", "exists", "network-id"],
    ]);
  });
});

describe("native runtime vLLM launch", () => {
  it("provides the pinned NGC image entrypoint with an exact serve command", () => {
    expect(
      nativeRuntimeQualificationCaseInternals.vllmServeArguments(
        "Qwen/Qwen2.5-0.5B-Instruct",
        8000,
      ),
    ).toEqual([
      "vllm",
      "serve",
      "/models",
      "--served-model-name",
      "Qwen/Qwen2.5-0.5B-Instruct",
      "--host",
      "0.0.0.0",
      "--port",
      "8000",
      "--max-model-len",
      "2048",
    ]);
  });
});

describe("native runtime provider-network authority", () => {
  it("uses distinct canonical sandbox names for every qualified agent", () => {
    const names = NATIVE_RUNTIME_QUALIFICATION_AGENTS.map((agent) =>
      nativeRuntimeQualificationCaseInternals.lifecycleSandboxName(agent),
    );

    expect(names).toEqual(["q-openclaw", "q-hermes", "q-deepagents"]);
    expect(names.every((name) => isValidName(name))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("resolves Podman 6.1 name output to one immutable labeled network ID", () => {
    const runtime = engine([NETWORK_NAME, inspection(), inspection()]);

    expect(
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        runtime.value,
        NETWORK_NAME,
        CASE_ID,
      ),
    ).toEqual({ id: NETWORK_ID, name: NETWORK_NAME, gateway: "10.89.0.1" });
    expect(runtime.capture.mock.calls.map(([args]) => args)).toEqual([
      ["network", "create", "--label", `${QUALIFICATION_LABEL}=${CASE_ID}`, NETWORK_NAME],
      ["network", "inspect", NETWORK_NAME],
      ["network", "inspect", NETWORK_ID],
    ]);
  });

  it("also binds an implementation that returns the immutable network ID", () => {
    const runtime = engine([NETWORK_ID, inspection(), inspection()]);

    expect(
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        runtime.value,
        NETWORK_NAME,
        CASE_ID,
      ).id,
    ).toBe(NETWORK_ID);
  });

  it("rejects creation output outside the requested name or immutable-ID forms", () => {
    const runtime = engine(["unexpected-network"]);

    expect(() =>
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        runtime.value,
        NETWORK_NAME,
        CASE_ID,
      ),
    ).toThrow("Provider network creation returned an unexpected identity");
    expect(runtime.capture.mock.calls.map(([args]) => args)).toEqual([
      ["network", "create", "--label", `${QUALIFICATION_LABEL}=${CASE_ID}`, NETWORK_NAME],
      ["network", "rm", "--force", NETWORK_NAME],
      ["network", "exists", NETWORK_NAME],
    ]);
  });

  it("rejects label or immutable re-inspection drift", () => {
    const missingLabel = engine([NETWORK_NAME, inspection({ labels: {} }), inspection()]);
    expect(() =>
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        missingLabel.value,
        NETWORK_NAME,
        CASE_ID,
      ),
    ).toThrow("Provider network inspection lacks exact identity");

    const changedGateway = engine([
      NETWORK_NAME,
      inspection(),
      inspection({ subnets: [{ gateway: "10.90.0.1" }] }),
    ]);
    expect(() =>
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        changedGateway.value,
        NETWORK_NAME,
        CASE_ID,
      ),
    ).toThrow("Provider network identity changed after immutable-ID resolution");
    expect(changedGateway.capture).toHaveBeenNthCalledWith(
      4,
      ["network", "rm", "--force", NETWORK_NAME],
      60_000,
    );
    expect(changedGateway.capture).toHaveBeenLastCalledWith(
      ["network", "exists", NETWORK_NAME],
      60_000,
    );
  });

  it("reports validation and cleanup together when network removal cannot be proven", () => {
    const runtime = engine([
      "unexpected-network",
      { status: 1, stderr: "remove failed" },
      { status: 0 },
    ]);

    expect(() =>
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        runtime.value,
        NETWORK_NAME,
        CASE_ID,
      ),
    ).toThrow(
      "Provider network creation returned an unexpected identity; provider network cleanup could not prove removal (remove exit 1; exists exit 0)",
    );
    expect(runtime.capture.mock.calls.map(([args]) => args)).toEqual([
      ["network", "create", "--label", `${QUALIFICATION_LABEL}=${CASE_ID}`, NETWORK_NAME],
      ["network", "rm", "--force", NETWORK_NAME],
      ["network", "exists", NETWORK_NAME],
    ]);
  });

  it("removes an exported snapshot without replacing the case failure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-runtime-snapshot-cleanup-"));
    const snapshot = path.join(root, "nemoclaw-q-fixture.tar");
    const original = new Error("failure after export");
    fs.writeFileSync(snapshot, "snapshot");

    const failAfterExport = () => {
      try {
        throw original;
      } finally {
        nativeRuntimeQualificationCaseInternals.removeQualificationSnapshot(snapshot);
      }
    };

    expect(failAfterExport).toThrow(original);
    expect(fs.existsSync(snapshot)).toBe(false);
    fs.rmSync(root, { force: true, recursive: true });
  });

  it("routes inference inside the provider network without a host port publication", () => {
    const plan = nativeRuntimeQualificationCaseInternals.inferenceContainerPlan({
      acceleration: "cpu",
      caseId: CASE_ID,
      imageRef: `docker.io/ollama/ollama@sha256:${"e".repeat(64)}`,
      inference: "ollama",
      model: "qwen2.5:0.5b",
      name: "nemoclaw-inference-fixture",
      network: NETWORK_NAME,
      port: 11434,
    });

    expect(plan.endpoint).toBe("http://nemoclaw-inference-fixture:11434");
    expect(plan.arguments).toContain("--network");
    expect(plan.arguments).toContain(NETWORK_NAME);
    expect(plan.arguments).not.toContain("--publish");
  });
});
