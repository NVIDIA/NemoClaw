// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedSparkVllmProfilePlan,
  vllmPublicationProbes,
} from "../../../tools/e2e/spark-vllm-probes.mts";
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
vi.mock("../live/inference-routing-helpers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../live/inference-routing-helpers.ts")>()),
  expectOpenAiChatThroughSandbox: vi.fn(),
}));
const ownerAction = vi.hoisted(() => vi.fn(async (_prompt: string, _expected: string) => {}));
vi.mock("./spark-express-vllm-safety.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spark-express-vllm-safety.ts")>()),
  confirmSparkOwnerAction: ownerAction,
}));
const SPARK_SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-spark-vllm";
const directories: string[] = [];
function persistRemoteContext(home: string) {
  fs.mkdirSync(path.join(home, ".docker"));
  fs.writeFileSync(
    path.join(home, ".docker/config.json"),
    JSON.stringify({ currentContext: "remote-spark" }),
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("DOCKER_CONTEXT", undefined);
}
afterEach(() => {
  vi.restoreAllMocks();
  ownerAction.mockReset();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
import {
  assertLocalDockerEnvironment,
  classifyDockerContainerInspection,
  inspectSandboxIdentity,
  listedSandboxNames,
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
  it("rejects a piped confirmation without a controlling terminal", async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `
      const { confirmSparkOwnerAction } = require("./test/e2e/support/spark-express-vllm-safety.ts");
      confirmSparkOwnerAction("Reserve the gateway", "reserved").then(
        () => { process.exitCode = 1; },
        error => { console.log(error.message); },
      );
    `,
      ],
      { detached: true, stdio: "pipe", timeout: 4000, killSignal: "SIGKILL" },
    );
    const result = Promise.all([once(child, "close"), text(child.stdout), text(child.stderr)]);
    child.stdin.end("reserved\n");
    const [[code], stdout, stderr] = await result;
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("Spark owner confirmation unavailable");
  });

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
      vllmPublicationProbes("172.18.0.1", {
        lo: [ipv4("127.0.0.1", true), ipv6("::1")],
        openshell: [ipv4("172.18.0.1")],
        eth0: [ipv4("192.0.2.10"), ipv6("2001:db8::10"), ipv6("fe80::10", 2)],
      }),
    ).toEqual({
      allowed: ["http://127.0.0.1:8000/health", "http://172.18.0.1:8000/health"],
      denied: ["::1", "192.0.2.10", "2001:db8::10", "fe80::10%eth0"],
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
    expect(vllmPublicationProbes("172.18.0.1", { eth0: [entry] }).ipv6).toBe("unconfigured");
    expect(() => vllmPublicationProbes("172.18.0.1", {})).toThrow("unintended non-loopback");
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
  it("stops before any host command or cleanup registration without an owner", async () => {
    vi.stubEnv("DOCKER_HOST", "");
    vi.stubEnv("DOCKER_CONTEXT", "");
    ownerAction.mockRejectedValueOnce(new Error("no runner owner"));
    const host = { command: vi.fn() };
    const cleanup = { add: vi.fn() };
    const run = capturedDgx.run as (
      selection: readonly string[],
      fixtures: object,
    ) => Promise<void>;
    await expect(
      run(["spark-vllm-extra-arguments", "extra-arguments"], { host, cleanup }),
    ).rejects.toThrow("no runner owner");
    expect(host.command).not.toHaveBeenCalled();
    expect(cleanup.add).not.toHaveBeenCalled();
  });
  it.each([
    {
      state: "sandbox-capture-failed-present",
      sandboxFailure: true,
      failure: false,
      removalAttempted: true,
      lostOwnership: ["remove sandbox e2e-spark-vllm"],
    },
    { state: "sandbox-present", sandboxFailure: false, failure: false, removalAttempted: true },
    {
      state: "sandbox-replaced",
      sandboxFailure: true,
      failure: false,
      removalAttempted: true,
      lostOwnership: ["remove sandbox e2e-spark-vllm"],
    },
    {
      state: "sandbox-replaced-after",
      sandboxFailure: true,
      failure: false,
      removalAttempted: true,
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
    async ({ state, failure, removalAttempted, sandboxFailure = false, lostOwnership = [] }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark-cleanup-"));
      directories.push(directory);
      const marker = path.join(directory, "removed");
      let removedSandbox = false;
      ownerAction
        .mockResolvedValueOnce(undefined)
        .mockImplementation(async (_prompt, confirmation) => {
          expect(confirmation).toBe("05d120e4-484c-47d4-9a59-77a08cbb6e67");
          removedSandbox = true;
        });
      persistRemoteContext(directory);
      const id = "a".repeat(64);
      fs.writeFileSync(
        path.join(directory, "docker"),
        `#!/bin/bash
set -eu
if [[ "$1" == context ]]; then
  if [[ -n "\${DOCKER_CONTEXT:-}" ]]; then echo "$DOCKER_CONTEXT"; else node -p 'require(process.env.HOME + "/.docker/config.json").currentContext'; fi
  exit 0
fi
[[ "$DOCKER_CONTEXT" == default ]] || exit 98
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
      const cleanup = new CleanupRegistry();
      const deleteByName = vi.fn((identity: string) => result(0, identity));
      const observedSandbox = (id: string) =>
        result(0, JSON.stringify({ name: SPARK_SANDBOX_NAME, id }));
      const originalSandbox = observedSandbox("05d120e4-484c-47d4-9a59-77a08cbb6e67");
      const responses = {
        "prereq-docker-info-inference-routing": result(0),
        "prereq-openshell-version-inference-routing": result(0),
        "spark-express-platform": result(0, "DGX Spark"),
        "spark-express-nvidia-smi": result(0),
        "spark-extra-arguments-physical-memory": result(0, "63082733568"),
        "preflight-spark-express-vllm-container": result(1, "", "No such container"),
        "preflight-spark-express-sandbox-list": result(0),
        "spark-express-vllm-onboard": result(1, "", "interrupted onboarding"),
        "spark-express-vllm-container-inspect": state.startsWith("capture-failed")
          ? result(1, "", "inspection interrupted")
          : result(0, JSON.stringify([{ Id: id }])),
        "spark-express-vllm-sandbox-inspect": [
          "sandbox-present",
          "sandbox-replaced",
          "sandbox-replaced-after",
        ].includes(state)
          ? originalSandbox
          : result(
              1,
              "",
              state === "sandbox-capture-failed-present"
                ? "gateway unavailable"
                : "sandbox not found",
            ),
        "cleanup-spark-express-sandbox-inspect":
          state === "sandbox-replaced"
            ? observedSandbox("05d120e4-484c-47d4-9a59-77a08cbb6e68")
            : sandboxFailure || state === "sandbox-present"
              ? originalSandbox
              : result(1, "", "sandbox not found"),
        "failure-spark-express-vllm-container-logs": result(0),
        "failure-spark-express-sandbox-get": result(0),
      };
      const executeCleanup = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
        const child = spawnSync(command, args, {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...env,
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
          async (
            command: string,
            args: string[],
            options: { artifactName: string; env: NodeJS.ProcessEnv },
          ) =>
            options.artifactName === "cleanup-spark-express-sandbox-verify"
              ? removedSandbox && state !== "sandbox-replaced-after"
                ? result(1, "", "sandbox not found")
                : observedSandbox("05d120e4-484c-47d4-9a59-77a08cbb6e68")
              : args.includes("destroy")
                ? deleteByName("original")
                : options.artifactName.startsWith("cleanup-") &&
                    options.artifactName !== "cleanup-spark-express-sandbox-inspect"
                  ? executeCleanup(command, args, options.env)
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
          sandbox: {
            openshell: () => deleteByName("replacement after destroy"),
            list: () => result(0),
          },
          progress: { phase: vi.fn() },
        }),
      ).rejects.toThrow(
        state === "sandbox-capture-failed-present"
          ? "sandbox inspection failed"
          : "interrupted onboarding",
      );
      expect(
        host.command.mock.calls.filter(([, , options]) =>
          options.artifactName.startsWith("failure-spark-"),
        ),
      ).toEqual([
        [
          "docker",
          ["logs", "--tail", "300", "nemoclaw-vllm"],
          expect.objectContaining({ timeoutMs: 30_000 }),
        ],
        [
          "openshell",
          ["sandbox", "get", SPARK_SANDBOX_NAME],
          expect.objectContaining({ timeoutMs: 30_000 }),
        ],
      ]);
      const receipt = await cleanup.runAll();
      expect(removedSandbox).toBe(
        state === "sandbox-present" || state === "sandbox-replaced-after",
      );
      const dockerContexts = await Promise.all(
        host.command.mock.calls
          .filter(([command]) => ["docker", "bash"].includes(command))
          .map(async ([, , { env }]) =>
            (
              await executeCleanup(path.join(directory, "docker"), ["context", "show"], env)
            ).stdout.trim(),
          ),
      );
      expect(new Set(dockerContexts)).toEqual(new Set(["default"]));
      expect(receipt.failures.map(({ name }) => name)).toEqual(
        sandboxFailure
          ? ["remove sandbox e2e-spark-vllm"]
          : failure
            ? ["remove nemoclaw-vllm"]
            : [],
      );
      expect(receipt.passed.includes("remove sandbox e2e-spark-vllm")).toBe(!sandboxFailure);
      expect(deleteByName.mock.calls).toEqual([]);
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
  const boundedCommand = [
    "export HF_HOME=/root/.cache/huggingface && export HF_HUB_OFFLINE=1 && export TRANSFORMERS_OFFLINE=1 &&",
    "pip install vllm[fastsafetensors] && vllm serve nvidia/Qwen3.6-35B-A3B-NVFP4",
    "--tensor-parallel-size 1 --pipeline-parallel-size 1 --data-parallel-size 1 --port 8000",
    "--max-model-len 32768 --revision 491c2f1ea524c639598bf8fa787a93fed5a6fbce",
    "--served-model-name nvidia/Qwen3.6-35B-A3B-NVFP4 --gpu-memory-utilization 0.5 --dtype auto",
    "--quantization modelopt --kv-cache-dtype fp8 --attention-backend flashinfer --moe-backend marlin",
    "--max-num-seqs 1 --max-num-batched-tokens 4096 --enable-chunked-prefill --async-scheduling",
    "--enable-prefix-caching --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3",
    "--load-format safetensors --safetensors-load-strategy lazy --max-num-seqs 2",
  ].join(" ");
  it.each([
    ...[
      ["missing override", boundedCommand.replace(/ --max-num-seqs 2$/u, "")],
      [
        "reversed override",
        boundedCommand.replace("--max-num-seqs 1", "--max-num-seqs 2").replace(/2$/u, "1"),
      ],
      ["wrong context", boundedCommand.replace("32768", "65536")],
    ].map(([evidence, command]) => ({
      evidence,
      command,
      workload: () => armWorkload(),
      environment: selectedEnvironment,
      expected: "inspected vLLM command",
    })),
    ...["ENETUNREACH", "EHOSTUNREACH", "timeout", "connect"].map((event) => ({
      evidence: event,
      event,
      workload: () => armWorkload(),
      environment: selectedEnvironment,
      expected: "unintended vLLM addresses",
    })),
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
  ])("checks $evidence before sandbox inference", async (scenario) => {
    const { workload, environment, expected } = scenario;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spark-managed-image-"));
    directories.push(home);
    writeManagedImageRegistry(home, workload(), "openclaw", SPARK_SANDBOX_NAME);
    const selected: NodeJS.ProcessEnv = environment(home);
    persistRemoteContext(home);
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
    const result = (stdout = "", exitCode = 0, stderr = "") => ({ stdout, exitCode, stderr });
    const plan = await boundedSparkVllmProfilePlan();
    assert(plan?.recipe.spec.serve.directInstall, "missing bounded Spark recipe");
    const { runtime } = plan.recipe.spec;
    const cmd = "command" in scenario ? scenario.command : boundedCommand;
    const responses: Record<string, ReturnType<typeof result>> = {
      "prereq-docker-info-inference-routing": result(),
      "prereq-openshell-version-inference-routing": result(),
      "spark-express-platform": result("DGX Spark"),
      "spark-express-nvidia-smi": result(),
      "spark-extra-arguments-physical-memory": result("63082733568"),
      "preflight-spark-express-vllm-container": result("", 1, "No such container"),
      "preflight-spark-express-sandbox-list": result(),
      "spark-express-vllm-onboard": result(),
      "spark-express-vllm-container-inspect": result(
        JSON.stringify([
          {
            Id: "a".repeat(64),
            Config: {
              Image: runtime.image,
              Entrypoint: ["/bin/bash"],
              Cmd: ["-lc", cmd],
              Labels: { "com.nvidia.nemoclaw.managed-vllm": "true" },
            },
            HostConfig: {
              NetworkMode: runtime.networkMode,
              IpcMode: runtime.ipcMode,
              ShmSize: runtime.sharedMemoryBytes,
              DeviceRequests: [{ Count: -1, Capabilities: [["gpu"]] }],
            },
            Mounts: [{ Destination: `${runtime.modelCache.target}/hub`, RW: false, Type: "bind" }],
          },
        ]),
      ),
      "spark-express-vllm-publication-allowed": result("0 200\n0 200"),
      "spark-express-vllm-bridge-inspect": result('[{"Gateway":"172.18.0.1"}]'),
      "spark-express-vllm-sandbox-inspect": result(
        JSON.stringify({ id: "05d120e4-484c-47d4-9a59-77a08cbb6e67", name: SPARK_SANDBOX_NAME }),
      ),
    };
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [
        {
          address: "192.0.2.1",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: "192.0.2.1/24",
        },
        {
          address: "fe80::a",
          family: "IPv6",
          scopeid: 2,
          internal: false,
          netmask: "ffff:ffff:ffff:ffff::",
          mac: "",
          cidr: null,
        },
      ],
    });
    const event = "event" in scenario ? scenario.event : "ECONNREFUSED";
    const connect = vi
      .spyOn(net, "connect")
      .mockImplementation((options: net.NetConnectOpts | string | number) => {
        const socket = new net.Socket();
        const outcome =
          typeof options === "object" && "host" in options && options.host === "fe80::a%eth0"
            ? event
            : "ECONNREFUSED";
        queueMicrotask(() =>
          outcome === "connect" || outcome === "timeout"
            ? socket.emit(outcome)
            : socket.emit("error", Object.assign(new Error(outcome), { code: outcome })),
        );
        return socket;
      });
    const writeJson = vi.fn();
    const host = {
      command: vi.fn(
        async (
          command: string,
          args: string[],
          options: { artifactName: string; env: NodeJS.ProcessEnv },
        ) =>
          responses[options.artifactName] ??
          Promise.reject(new Error(`Unexpected probe: ${options.artifactName}`)),
      ),
    };
    const run = capturedDgx.run as (
      selection: readonly string[],
      fixtures: object,
    ) => Promise<void>;
    const execution = run(["spark-vllm-extra-arguments", "extra-arguments"], {
      artifacts: { target: { declare: vi.fn() }, writeJson },
      cleanup: { add: vi.fn() },
      host,
      sandbox: {},
      progress: {
        phase: (phase: string) => {
          expect(phase, "selected managed image accepted").not.toBe(
            "prove sandbox inference and unrelated egress denial",
          );
        },
      },
    });
    await expect(execution).rejects.toThrow(expected);
    const reachesNetwork = expected === "selected managed image accepted" || "event" in scenario;
    expect(connect.mock.calls).toEqual(
      reachesNetwork
        ? [[{ host: "192.0.2.1", port: 8000 }], [{ host: "fe80::a%eth0", port: 8000 }]]
        : [],
    );
    const refusalReceipts = writeJson.mock.calls
      .filter(([name]) => name === "spark-express-vllm-publication-denied.json")
      .map(([, rows]) => rows);
    expect(refusalReceipts).toEqual(
      reachesNetwork
        ? [
            [
              { address: "192.0.2.1", port: 8000, result: "ECONNREFUSED" },
              {
                address: "fe80::a%eth0",
                port: 8000,
                result:
                  event === "timeout" ? "ETIMEDOUT" : event === "connect" ? "connected" : event,
              },
            ],
          ]
        : [],
    );
    expect(
      new Set(
        host.command.mock.calls
          .filter(([command]) => command === "docker")
          .map(([, , { env }]) => env.DOCKER_CONTEXT),
      ),
    ).toEqual(new Set(["default"]));
    expect(host.command).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "get", "-o", "json", SPARK_SANDBOX_NAME],
      expect.objectContaining({ artifactName: "spark-express-vllm-sandbox-inspect" }),
    );
  });
});
