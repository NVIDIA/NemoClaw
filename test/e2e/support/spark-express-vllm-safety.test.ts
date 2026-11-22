// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_IMAGE_REPOSITORIES } from "../../../src/lib/onboard/managed-image/contract.ts";
import {
  REVISION,
  ARM64_REFERENCE,
  candidateCatalogEnvironment,
  managedReceipt,
  selectedEnvironment,
  writeManagedImageRegistry,
} from "./managed-image-receipt-fixture.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import "../live/dgx-express.test.ts";
import "../../../src/lib/inference/vllm.ts";

const capturedDgx = vi.hoisted(() => ({ run: undefined as unknown }));
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: Object.assign(vi.fn(), {
    for: () => (_title: string, _options: object, run: unknown) => {
      capturedDgx.run = run;
    },
  }),
}));
vi.mock("../live/inference-routing-helpers.ts", () => ({
  requireLivePrerequisites: vi.fn(),
  cleanupSandbox: vi.fn(),
  expectOpenAiChatThroughSandbox: vi.fn(),
}));
const SPARK_SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-spark-vllm";
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
import {
  assertLocalDockerEnvironment,
  classifyDockerContainerInspection,
  inspectSandboxIdentity,
  listedSandboxNames,
  vllmPublicationProbeUrls,
} from "./spark-express-vllm-safety.ts";

const result = (exitCode: number, stdout = "", stderr = "") => ({
  command: ["docker"],
  cwd: "/tmp",
  durationMs: 1,
  exitCode,
  stderr,
  stdout,
});

describe("DGX Spark Express vLLM qualification safety", () => {
  it("probes both allowed addresses and every unintended IPv4 and IPv6 address (#14083)", () => {
    const ipv4 = (address: string, internal = false) => ({
      address,
      internal,
      family: "IPv4" as const,
      netmask: "255.255.255.0",
      mac: "",
      cidr: null,
    });
    const ipv6 = (address: string, scopeid = 0) => ({
      address,
      scopeid,
      internal: address === "::1",
      family: "IPv6" as const,
      netmask: "ffff:ffff:ffff:ffff::",
      mac: "",
      cidr: null,
    });
    expect(
      vllmPublicationProbeUrls("172.18.0.1", {
        lo: [ipv4("127.0.0.1", true), ipv6("::1")],
        openshell: [ipv4("172.18.0.1")],
        eth0: [ipv4("192.0.2.10"), ipv6("2001:db8::10"), ipv6("fe80::10", 2)],
      }),
    ).toEqual({
      allowed: ["http://127.0.0.1:8000/health", "http://172.18.0.1:8000/health"],
      denied: [
        "http://[::1]:8000/health",
        "http://192.0.2.10:8000/health",
        "http://[2001:db8::10]:8000/health",
        "http://[fe80::10%25eth0]:8000/health",
      ],
      ipv6: "configured",
    });
  });

  it("reports an IPv4-only host and rejects an empty denial sample", () => {
    const entry = {
      address: "192.0.2.10",
      internal: false,
      family: "IPv4" as const,
      netmask: "255.255.255.0",
      mac: "",
      cidr: null,
    };
    expect(vllmPublicationProbeUrls("172.18.0.1", { eth0: [entry] }).ipv6).toBe("unconfigured");
    expect(() => vllmPublicationProbeUrls("172.18.0.1", {})).toThrow("unintended non-loopback");
  });

  it("accepts only local Docker selectors (#8379)", () => {
    expect(() => assertLocalDockerEnvironment({})).not.toThrow();
    expect(() =>
      assertLocalDockerEnvironment({ DOCKER_HOST: "unix:///var/run/docker.sock" }),
    ).not.toThrow();
    expect(() => assertLocalDockerEnvironment({ DOCKER_HOST: "ssh://spark.example" })).toThrow(
      "local Docker socket",
    );
    expect(() => assertLocalDockerEnvironment({ DOCKER_CONTEXT: "remote-spark" })).toThrow(
      "default local Docker context",
    );
  });

  it("distinguishes an absent container from Docker daemon failures (#8379)", () => {
    expect(classifyDockerContainerInspection(result(0, "[]"))).toBe("present");
    expect(
      classifyDockerContainerInspection(result(1, "", "Error: No such object: nemoclaw-vllm")),
    ).toBe("absent");
    expect(() =>
      classifyDockerContainerInspection(
        result(1, "", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"),
      ),
    ).toThrow("Docker container inspection failed");
  });

  it("refuses to treat a failed sandbox listing as an empty host (#8379)", () => {
    expect(listedSandboxNames(result(0, "alpha\nbeta\n"))).toEqual(new Set(["alpha", "beta"]));
    expect(() => listedSandboxNames(result(1, "", "gateway unavailable"))).toThrow(
      "OpenShell sandbox listing failed",
    );
  });

  it("requires an exact sandbox identity and distinguishes absence from inspection failure (#8379)", () => {
    const id = "05d120e4-484c-47d4-9a59-77a08cbb6e67";
    expect(
      inspectSandboxIdentity(result(0, JSON.stringify({ id, name: "spark-e2e" })), "spark-e2e"),
    ).toEqual({ kind: "present", id });
    expect(inspectSandboxIdentity(result(1, "", "sandbox not found"), "spark-e2e")).toEqual({
      kind: "absent",
    });
    expect(() =>
      inspectSandboxIdentity(result(0, JSON.stringify({ id, name: "replacement" })), "spark-e2e"),
    ).toThrow("expected identity");
    expect(() => inspectSandboxIdentity(result(1, "", "gateway unavailable"), "spark-e2e")).toThrow(
      "sandbox inspection failed",
    );
    expect(() =>
      inspectSandboxIdentity(result(1, "", "gateway 'nemoclaw' not found"), "spark-e2e"),
    ).toThrow("sandbox inspection failed");
  });
});

describe("DGX Spark callback safety", () => {
  it.each([
    {
      state: "sandbox-capture-failed-present",
      failure: false,
      removalAttempted: true,
      lostOwnership: ["remove sandbox e2e-spark-vllm"],
    },
    {
      state: "capture-failed-present",
      failure: true,
      removalAttempted: false,
      lostOwnership: ["remove nemoclaw-vllm"],
    },
    { state: "capture-failed-absent", failure: false, removalAttempted: false },
    { state: "owned", failure: false, removalAttempted: true },
    { state: "absent", failure: false, removalAttempted: false },
    { state: "daemon", failure: true, removalAttempted: false },
    { state: "permission", failure: true, removalAttempted: false },
    { state: "replacement", failure: true, removalAttempted: false },
    { state: "unmanaged", failure: true, removalAttempted: false },
    { state: "label-failure", failure: true, removalAttempted: false },
    { state: "remove-failure", failure: true, removalAttempted: true },
  ])(
    "records $state without hiding inspection or removal failures",
    async ({ state, failure, removalAttempted, lostOwnership = [] }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark-cleanup-"));
      directories.push(directory);
      const marker = path.join(directory, "removed");
      const id = "a".repeat(64);
      fs.writeFileSync(
        path.join(directory, "docker"),
        `#!/bin/bash
set -eu
case "$1" in
inspect)
  case "$CLEANUP_STATE" in
    absent|capture-failed-absent) echo 'Error: No such object: nemoclaw-vllm' >&2; exit 1 ;;
    daemon) echo 'Cannot connect to the Docker daemon' >&2; exit 1 ;;
    permission) echo 'permission denied connecting to Docker' >&2; exit 1 ;;
  esac
  if [[ "$3" == '{{.Id}}' ]]; then
    if [[ "$CLEANUP_STATE" == replacement ]]; then printf '%064d\n' 0; else echo "$CREATED_ID"; fi
  else
    [[ "$CLEANUP_STATE" != label-failure ]] || { echo 'Docker label inspection failed' >&2; exit 1; }
    if [[ "$CLEANUP_STATE" == unmanaged ]]; then echo false; else echo true; fi
  fi ;;
rm)
  printf '%s\n' "$*" > "$REMOVE_MARKER"
  [[ "$CLEANUP_STATE" != remove-failure ]] || { echo 'Docker removal failed' >&2; exit 1; } ;;
*) exit 99 ;;
esac
`,
        { mode: 0o700 },
      );
      vi.stubEnv("DOCKER_HOST", "");
      vi.stubEnv("DOCKER_CONTEXT", "");
      const cleanup = new CleanupRegistry();
      const responses = {
        "spark-express-platform": result(0, "DGX Spark"),
        "spark-express-nvidia-smi": result(0),
        "spark-extra-arguments-physical-memory": result(0, "63082733568"),
        "preflight-spark-express-vllm-container": result(1, "", "No such container"),
        "preflight-spark-express-sandbox-list": result(0),
        "spark-express-vllm-onboard": result(1, "", "interrupted onboarding"),
        "spark-express-vllm-container-inspect": state.startsWith("capture-failed")
          ? result(1, "", "inspection interrupted")
          : result(0, JSON.stringify([{ Id: id }])),
        "spark-express-vllm-sandbox-inspect": result(
          1,
          "",
          state === "sandbox-capture-failed-present" ? "gateway unavailable" : "sandbox not found",
        ),
        "cleanup-spark-express-sandbox-inspect":
          state === "sandbox-capture-failed-present"
            ? result(
                0,
                JSON.stringify({
                  name: SPARK_SANDBOX_NAME,
                  id: "05d120e4-484c-47d4-9a59-77a08cbb6e67",
                }),
              )
            : result(1, "", "sandbox not found"),
        "failure-spark-express-vllm-container-logs": result(0),
        "failure-spark-express-sandbox-get": result(0),
      };
      const executeCleanup = (command: string, args: string[]) => {
        const child = spawnSync(command, args, {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            PATH: `${directory}:${process.env.PATH}`,
            CLEANUP_STATE: state,
            CREATED_ID: id,
            REMOVE_MARKER: marker,
          },
        });
        return child.error
          ? Promise.reject(child.error)
          : result(child.status ?? 1, child.stdout, child.stderr);
      };
      const host = {
        command: vi.fn(
          async (command: string, args: string[], options: { artifactName: string }) =>
            options.artifactName.startsWith("cleanup-") &&
            options.artifactName !== "cleanup-spark-express-sandbox-inspect"
              ? executeCleanup(command, args)
              : (responses[options.artifactName as keyof typeof responses] ??
                Promise.reject(new Error(`Unexpected command: ${options.artifactName}`))),
        ),
      };
      const run = capturedDgx.run as (
        selection: readonly string[],
        fixtures: object,
      ) => Promise<void>;
      await expect(
        run(["spark-vllm-extra-arguments", "extra-arguments"], {
          artifacts: { target: { declare: vi.fn() } },
          cleanup,
          host,
          sandbox: {},
          runtimeProvider: {},
          progress: { phase: vi.fn() },
        }),
      ).rejects.toThrow(
        state === "sandbox-capture-failed-present"
          ? "sandbox inspection failed"
          : "interrupted onboarding",
      );
      const receipt = await cleanup.runAll();
      expect(receipt.failures.map(({ name }) => name)).toEqual(
        state === "sandbox-capture-failed-present"
          ? ["remove sandbox e2e-spark-vllm"]
          : failure
            ? ["remove nemoclaw-vllm"]
            : [],
      );
      expect(receipt.passed.includes("remove sandbox e2e-spark-vllm")).toBe(
        state !== "sandbox-capture-failed-present",
      );
      expect(
        receipt.failures
          .filter(({ message }) => message.includes("Cannot establish ownership"))
          .map(({ name }) => name),
      ).toEqual(lostOwnership);
      expect(receipt.passed.includes("remove nemoclaw-vllm")).toBe(!failure);
      expect(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : null).toBe(
        removalAttempted ? `rm -f ${id}` : null,
      );
    },
  );
  const armWorkload = (rev = REVISION) => ({
    ...managedReceipt(rev),
    platform: "linux/arm64",
    reference: ARM64_REFERENCE,
  });
  it.each([
    {
      evidence: "cohort",
      workload: () => armWorkload(),
      environment: selectedEnvironment,
      expected: "selected managed image accepted",
    },
    {
      evidence: "catalog",
      workload: () => armWorkload(),
      environment: (home: string) => candidateCatalogEnvironment(home, "linux/arm64"),
      expected: "selected managed image accepted",
    },
    {
      evidence: "wrong platform",
      workload: () => managedReceipt(),
      environment: selectedEnvironment,
      expected: "must use a linux/arm64 managed image",
    },
    {
      evidence: "wrong revision",
      workload: () => armWorkload("b".repeat(40)),
      environment: selectedEnvironment,
      expected: "does not match the selected cohort",
    },
    {
      evidence: "wrong image",
      workload: () => ({
        ...armWorkload(),
        reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"9".repeat(64)}`,
      }),
      environment: selectedEnvironment,
      expected: "exact agent image from the selected cohort",
    },
    {
      evidence: "missing workload",
      workload: () => null,
      environment: selectedEnvironment,
      expected: "must record a managed-image receipt",
    },
    {
      evidence: "missing authority",
      workload: () => armWorkload(),
      environment: (home: string) => ({ HOME: home }),
      expected: "one exact managed-image cohort revision",
    },
  ])("checks $evidence before runtime probes", async ({ workload, environment, expected }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spark-managed-image-"));
    directories.push(home);
    writeManagedImageRegistry(home, workload(), "openclaw", SPARK_SANDBOX_NAME);
    const selected: NodeJS.ProcessEnv = environment(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("E2E_MANAGED_IMAGE_REVISION", selected.E2E_MANAGED_IMAGE_REVISION ?? "");
    vi.stubEnv("E2E_MANAGED_IMAGE_COHORT_RECEIPT", selected.E2E_MANAGED_IMAGE_COHORT_RECEIPT ?? "");
    vi.stubEnv(
      "NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG",
      selected.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG ?? "",
    );
    vi.stubEnv("NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON", "");
    vi.stubEnv("NEMOCLAW_E2E_EXPECTED_SHA", REVISION);
    vi.stubEnv("NEMOCLAW_RUN_LIVE_E2E", "1");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("DOCKER_HOST", "");
    vi.stubEnv("DOCKER_CONTEXT", "");
    const result = (stdout = "", exitCode = 0, stderr = "") => ({ stdout, exitCode, stderr });
    const responses: Record<string, ReturnType<typeof result>> = {
      "spark-express-platform": result("DGX Spark"),
      "spark-express-nvidia-smi": result(),
      "spark-extra-arguments-physical-memory": result("63082733568"),
      "preflight-spark-express-vllm-container": result("", 1, "No such container"),
      "preflight-spark-express-sandbox-list": result(),
      "spark-express-vllm-onboard": result(),
      "spark-express-vllm-container-inspect": result(JSON.stringify([{ Id: "a".repeat(64) }])),
      "spark-express-vllm-sandbox-inspect": result(
        JSON.stringify({ id: "05d120e4-484c-47d4-9a59-77a08cbb6e67", name: SPARK_SANDBOX_NAME }),
      ),
    };
    const host = {
      command: vi.fn(
        async (_command: string, _args: string[], options: { artifactName: string }) =>
          responses[options.artifactName] ??
          Promise.reject(new Error(`Unexpected probe: ${options.artifactName}`)),
      ),
    };
    const run = capturedDgx.run as (
      selection: readonly string[],
      fixtures: object,
    ) => Promise<void>;
    const execution = run(["spark-vllm-extra-arguments", "extra-arguments"], {
      artifacts: { target: { declare: vi.fn() }, writeJson: vi.fn() },
      cleanup: { add: vi.fn() },
      host,
      sandbox: {},
      runtimeProvider: {},
      progress: {
        phase: (phase: string) => {
          expect(phase, "selected managed image accepted").not.toBe(
            "verify selected vLLM runtime configuration",
          );
        },
      },
    });
    await expect(execution).rejects.toThrow(expected);
    expect(host.command).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "get", "-o", "json", SPARK_SANDBOX_NAME],
      expect.objectContaining({ artifactName: "spark-express-vllm-sandbox-inspect" }),
    );
  });
});
