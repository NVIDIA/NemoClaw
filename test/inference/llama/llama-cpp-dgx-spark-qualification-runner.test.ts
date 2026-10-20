// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
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
  parseQualificationBridgeGateway,
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
  runQualification,
  QualificationFailureError,
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

it("retains a phase-specific failure without leaking exception data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark-diagnostic-"));
  const privateValue = "private-key-and-model-prompt-must-not-be-retained";
  const spawn = vi.spyOn(childProcess, "spawnSync").mockImplementationOnce(() => {
    throw new Error(privateValue);
  });
  try {
    const invocation = { ...parsedInvocation(), output: path.join(root, "receipt.json") };
    await expect(
      runQualification(invocation, trustedEnvironment({ RUNNER_TEMP: root })),
    ).rejects.toMatchObject({
      name: "Error",
      diagnostic: {
        phase: "prerequisites",
        status: "failed",
        owner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
      },
    });
    const source = fs.readFileSync(path.join(root, "failure.json"), "utf8");
    expect(source).not.toContain(privateValue);
    const failure = JSON.parse(source);
    expect(new QualificationFailureError(failure).message).toContain("prerequisites");
    expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
  } finally {
    spawn.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const readableInterruptionDiagnostic = {
  label: "retained",
  prepare: (_file: string) => undefined,
  assert: (file: string, owner: string) => {
    const source = fs.readFileSync(file, "utf8");
    expect(source).not.toContain("private-test-key");
    expect(JSON.parse(source)).toMatchObject({
      phase: "interrupted",
      status: "failed",
      owner,
      cleanupComplete: true,
    });
  },
};
const unavailableInterruptionDiagnostic = {
  label: "unavailable",
  prepare: (file: string) => fs.mkdirSync(file),
  assert: (file: string) => expect(fs.statSync(file).isDirectory()).toBe(true),
};

it.runIf(process.platform === "linux" && process.arch === "arm64").each([
  ["SIGINT", readableInterruptionDiagnostic],
  ["SIGTERM", readableInterruptionDiagnostic],
  ["SIGINT", unavailableInterruptionDiagnostic],
  ["SIGTERM", unavailableInterruptionDiagnostic],
] as const)(
  "interrupts a real worker with %s (diagnostic: %s) without claiming success",
  async (signal, diagnostic) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark-signal-process-"));
    const owner = expectedRegistryOwner(RUN_ID, RUN_ATTEMPT);
    const stateFile = path.join(root, "resources.json");
    const marker = path.join(root, "blocked.json");
    const tempRoot = path.join(root, owner);
    const resources = {
      [`nemoclaw-llama-cpp-server-${RUN_ID}-${RUN_ATTEMPT}`]: owner,
      [`nemoclaw-llama-cpp-network-${RUN_ID}-${RUN_ATTEMPT}`]: owner,
      [expectedRegistryName(RUN_ID, RUN_ATTEMPT)]: owner,
      "foreign-container": "foreign-owner",
    };
    fs.writeFileSync(stateFile, JSON.stringify(resources));
    fs.mkdirSync(tempRoot);
    diagnostic.prepare(path.join(root, "failure.json"));
    fs.writeFileSync(path.join(tempRoot, "api-key"), "private-test-key", { mode: 0o600 });
    const docker = path.join(root, "docker");
    fs.writeFileSync(
      docker,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
if (args[0] === "--version") {
  const listener = require("node:net").createServer();
  listener.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, port: listener.address().port}));
    require("node:child_process").spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    process.exit(0);
  });
} else {
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const name = args.at(-1);
if (args.includes("inspect")) {
  if (state[name]) process.stdout.write(state[name]);
  else { process.stderr.write("Error: No such object: " + name); process.exitCode = 1; }
} else if (args.includes("rm") && state[name] === ${JSON.stringify(owner)}) {
  delete state[name];
  fs.writeFileSync(stateFile, JSON.stringify(state));
} else process.exitCode = 1;
}
`,
      { mode: 0o700 },
    );
    const args = invocationArguments();
    args[args.indexOf("--output") + 1] = path.join(root, "receipt.json");
    const launcher = childProcess.spawn(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(repoRoot, "scripts/checks/run-llama-cpp-dgx-spark-qualification.cts"),
        ...args,
      ],
      {
        cwd: repoRoot,
        stdio: "ignore",
        env: { ...trustedEnvironment(), RUNNER_TEMP: root, PATH: root, HOME: root },
      },
    );
    const closed = new Promise<number | null>((resolve, reject) => {
      launcher.once("error", reject);
      launcher.once("close", resolve);
    });
    try {
      await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), {
        timeout: 10000,
        interval: 25,
      });
      launcher.kill(signal);
      expect(await closed).toBe(signal === "SIGINT" ? 130 : 143);
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual({
        "foreign-container": "foreign-owner",
      });
      expect(fs.existsSync(tempRoot)).toBe(false);
      expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
      diagnostic.assert(path.join(root, "failure.json"), owner);
      const blockedPid = JSON.parse(fs.readFileSync(marker, "utf8")).pid;
      expect(() => process.kill(blockedPid, 0)).toThrow();
      const port = JSON.parse(fs.readFileSync(marker, "utf8")).port;
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = net.createConnection({ host: "127.0.0.1", port });
          socket.once("connect", () => {
            socket.destroy();
            reject(new Error("interrupted listener remains open"));
          });
          socket.once("error", () => {
            socket.destroy();
            resolve();
          });
          socket.setTimeout(1000, () => {
            socket.destroy();
            reject(new Error("listener check timed out"));
          });
        }),
      ).resolves.toBeUndefined();
    } finally {
      launcher.kill("SIGTERM");
      await closed;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);

it("boots the actual trusted CLI and records a failed prerequisite without running Docker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark-cli-"));
  try {
    const args = invocationArguments();
    args[args.indexOf("--output") + 1] = path.join(root, "receipt.json");
    const result = childProcess.spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(repoRoot, "scripts/checks/run-llama-cpp-dgx-spark-qualification.cts"),
        ...args,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...trustedEnvironment(), RUNNER_TEMP: root, PATH: "", HOME: root },
        timeout: 20000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `failed at prerequisites for ${expectedRegistryOwner(RUN_ID, RUN_ATTEMPT)}`,
    );
    expect(JSON.parse(fs.readFileSync(path.join(root, "failure.json"), "utf8"))).toMatchObject({
      phase: "prerequisites",
      status: "failed",
      cleanupComplete: false,
    });
    expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function mutatedPlan(mutate: (value: Record<string, any>) => void): [string, string] {
  const value = JSON.parse(planSource) as Record<string, any>;
  mutate(value);
  const source = JSON.stringify(value);
  return [source, sha256Text(source)];
}

it("rejects cleanup when Docker inspection is unavailable and identifies the owned run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark-cleanup-cli-"));
  try {
    const result = childProcess.spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(repoRoot, "scripts/checks/run-llama-cpp-dgx-spark-qualification.cts"),
        "--cleanup-only",
        "--registry-name",
        expectedRegistryName(RUN_ID, RUN_ATTEMPT),
        "--run-id",
        RUN_ID,
        "--run-attempt",
        RUN_ATTEMPT,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 20000,
        env: {
          ...trustedEnvironment(),
          BASE_SHA,
          CHECKOUT_SHA: HEAD_SHA,
          WORKFLOW_SHA,
          PLAN_SHA256: planDigest,
          RUNNER_TEMP: root,
          PATH: "",
          HOME: root,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `failed at cleanup for ${expectedRegistryOwner(RUN_ID, RUN_ATTEMPT)}: cleanup-incomplete`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function valuesAfter(argv: string[], option: string): string[] {
  return argv.flatMap((value, index) => (argv[index - 1] === option ? [value] : []));
}

it("loads the deferred OpenClaw consumer dependency with the actual CLI loader", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark-agent-loader-"));
  try {
    const source = `const {resolveManagedImageOnboardModule} = require('./scripts/checks/run-managed-image-openshell-e2e.ts');
      import('./src/lib/onboard.ts').then(value => {
        const onboard = resolveManagedImageOnboardModule(value);
        process.stdout.write(JSON.stringify({ready: typeof onboard.startGatewayForRecovery === 'function'}));
      });`;
    const result = childProcess.spawnSync(
      process.execPath,
      ["--no-warnings", "--import", "tsx", "-e", source],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 20000,
        env: { HOME: root, PATH: process.env.PATH },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ready: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
        "CUDA_ARCHITECTURES=103-real;120-real;121a-real",
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

  it("launches native llama.cpp with unpublished ports and no API key in Docker arguments (#8667)", () => {
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
      expect(valuesAfter(argv, "--host")).toEqual(["0.0.0.0"]);
      expect(valuesAfter(argv, "--port")).toEqual([String(testPlan.recipe.serve.port)]);
      expect(valuesAfter(argv, "--timeout")).toEqual([
        String(testPlan.recipe.serve.limits.requestTimeoutSeconds),
      ]);
      expect(valuesAfter(argv, "--api-key-file")).toEqual(["/run/secrets/llama-cpp-api-key"]);
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
      expect(valuesAfter(alternatePortArgv, "--port")).toEqual([String(alternateContainerPort)]);
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

  it("accepts only the selected private Docker bridge gateway", () => {
    const network = {
      Name: "nemoclaw-managed-run-1",
      Driver: "bridge",
      Internal: false,
      IPAM: { Config: [{ Gateway: "172.20.0.1", Subnet: "172.20.0.0/16" }] },
    };
    expect(parseQualificationBridgeGateway(JSON.stringify(network), network.Name)).toBe(
      "172.20.0.1",
    );
    expect(() => parseQualificationBridgeGateway(JSON.stringify(network), "another-run")).toThrow(
      /exact private IPv4 gateway/u,
    );
    expect(() =>
      parseQualificationBridgeGateway(
        JSON.stringify({ ...network, IPAM: { Config: [{ Gateway: "8.8.8.8" }] } }),
        network.Name,
      ),
    ).toThrow(/exact private IPv4 gateway/u);
    expect(() =>
      parseQualificationBridgeGateway(
        JSON.stringify({ ...network, Driver: "macvlan" }),
        network.Name,
      ),
    ).toThrow(/exact private IPv4 gateway/u);
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
    "NVIDIA GB10, 580.1599.03",
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

  it("accepts the GB10 driver with a three-digit minor version", () => {
    expect(parseNvidiaSmi("NVIDIA GB10, 580.159.03\n", "580.65.06")).toEqual({
      count: 1,
      driverVersion: "580.159.03",
      name: "NVIDIA GB10",
    });
  });

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
