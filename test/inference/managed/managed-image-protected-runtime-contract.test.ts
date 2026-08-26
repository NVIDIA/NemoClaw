// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  MANAGED_IMAGE_LOCAL_INFERENCE_KINDS,
  MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX,
  managedImageProtectedSandboxName,
  PROTECTED_MANAGED_IMAGE_AGENTS,
  resolveManagedImageLocalInferenceRoute,
  withManagedImageLocalInferenceProfile,
} from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";
import {
  assertExactSandboxImage,
  assertFailedBootstrapOwnerCleanupRetention,
  assertFailedSandboxOwnerCleanupRetention,
  createProtectedManagedImageBootstrapInput,
  failureInjectingAdapter,
  MANAGED_IMAGE_OPENSHELL_SUPERVISOR_ARGV,
  type ManagedImageCommandResult,
  type ManagedImageCommandRunner,
  managedImageLocalInferenceBaseUrl,
  managedImageOpenShellBasePolicyPath,
  managedImageOpenShellCommittedProbe,
  managedImageOpenShellProbe,
  parseManagedImageOpenShellE2eInputs,
  removeManagedImageGatewayStateIfSafe,
  resolveManagedImageOnboardModule,
} from "../../../scripts/checks/run-managed-image-openshell-e2e.ts";
import { resolveOnboardManagedBootstrapLaunch } from "../../../src/lib/onboard/managed-workload/onboard-orchestration.js";

const IMAGE = `localhost:5000/nemoclaw-managed-protected/openclaw@sha256:${"a".repeat(64)}`;
const VALID_SANDBOX = "managed-openclaw";

const SUCCESS_WITHOUT_OUTPUT: ManagedImageCommandResult = {
  status: 0,
  stdout: "",
  stderr: "",
};

function managedContainerInspectResult(
  contentId: string,
  running: boolean,
): ManagedImageCommandResult {
  return {
    status: 0,
    stdout: `${JSON.stringify([
      {
        Config: {
          Labels: {
            "openshell.ai/managed-by": "openshell",
            "openshell.ai/sandbox-name": VALID_SANDBOX,
          },
        },
        Image: contentId,
        NetworkSettings: { Networks: { "managed-network": {} } },
        State: { Paused: false, Restarting: false, Running: running },
      },
    ])}\n`,
    stderr: "",
  };
}

function createManagedImageCommandRunner(
  contentId: string,
  containerId: string,
  listScope: "-q" | "-aq",
  listOutput: string,
  calls: string[][],
  running = listScope === "-q",
): ManagedImageCommandRunner {
  const responses = new Map<string, ManagedImageCommandResult>([
    ["docker image inspect", { status: 0, stdout: `${contentId}\n`, stderr: "" }],
    [`docker ps ${listScope}`, { status: 0, stdout: listOutput, stderr: "" }],
    [`docker inspect ${containerId}`, managedContainerInspectResult(contentId, running)],
  ]);
  return (argv) => {
    calls.push([...argv]);
    return responses.get(argv.slice(0, 3).join(" ")) ?? SUCCESS_WITHOUT_OUTPUT;
  };
}

describe("protected managed-image runtime contract", () => {
  it("binds the rollback failure adapter to the canonical managed-bootstrap state root", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-protected-rollback-"));
    const journalRoot = path.join(stateRoot, "managed-bootstrap");
    try {
      const adapter = failureInjectingAdapter(
        {
          runCaptureOpenshell: () => "",
          runOpenshell: () => ({ status: 0, stdout: "", stderr: "" }),
          sleepSeconds: () => undefined,
        } as never,
        stateRoot,
      );

      expect(adapter.awaitBootstrap).toEqual(expect.any(Function));
      expect(fs.statSync(stateRoot).isDirectory()).toBe(true);
      expect(fs.existsSync(journalRoot)).toBe(false);
      await expect(adapter.recoverUnfinishedTransactions()).resolves.toEqual({
        receipts: [],
        failures: [],
      });
      expect(fs.statSync(journalRoot).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("binds the public and protected managed-image plans to one supervisor argv (#7744)", () => {
    const authorityStore = {};
    const publicLaunch = resolveOnboardManagedBootstrapLaunch({
      runtime: {
        runtimeProvider: {
          bootstrap: {
            supported: true,
            bootstrapKind: "managed-image",
            createAuthorityStore: () => authorityStore,
          },
        },
      } as never,
      workload: {
        source: {
          kind: "managed-image",
          contract: {
            agent: "openclaw",
            image: "registry.example/nemoclaw/openclaw",
            digest: `sha256:${"a".repeat(64)}`,
          },
        },
      } as never,
      stateRoot: "/tmp/nemoclaw-state",
      bootstrapIdentity: "bootstrap-identity",
      request: {} as never,
      intendedWorkloadArgv: ["/usr/local/bin/nemoclaw-start"],
    })!;
    const protectedLaunch = createProtectedManagedImageBootstrapInput(publicLaunch);

    expect(protectedLaunch.expectedSupervisorArgv).toBe(publicLaunch.expectedSupervisorArgv);
    expect(protectedLaunch.expectedSupervisorArgv).toBe(MANAGED_IMAGE_OPENSHELL_SUPERVISOR_ARGV);
    expect(protectedLaunch.expectedSupervisorArgv).toEqual([
      "/opt/openshell/bin/openshell-sandbox",
      "--workdir",
      "/sandbox",
    ]);
    expect(Object.isFrozen(protectedLaunch.expectedSupervisorArgv)).toBe(true);
  });

  it.each([
    "openshellArgv",
    "runOpenshell",
    "runCaptureOpenshell",
    "sleepSeconds",
    "startGatewayForRecovery",
  ] as const)(
    "loads every OpenShell operation required before protected image launch [%s] (#7744)",
    async (operation) => {
      const onboard = resolveManagedImageOnboardModule(await import("../../../src/lib/onboard.ts"));

      expect(onboard[operation], operation).toBeTypeOf("function");
    },
  );

  it("rejects a missing protected OpenShell operation with a precise contract error (#8759)", () => {
    expect(() =>
      resolveManagedImageOnboardModule({
        default: {
          openshellArgv: () => [],
          runCaptureOpenshell: () => "",
          sleepSeconds: () => undefined,
          startGatewayForRecovery: async () => undefined,
        },
      }),
    ).toThrow("managed-image onboard module is missing required operation(s): runOpenshell");
  });

  it.each([
    ["unknown ownership", { failed: [], ownershipFailures: ["status cannot be proven"] }, 0],
    ["denied signal", { failed: [9_999_601], ownershipFailures: [] }, 0],
    ["failed gateway removal", { failed: [], ownershipFailures: [] }, 1],
  ])("retains gateway evidence after %s (#7744)", (_case, gatewayStop, removalStatus) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-state-retain-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, "9999601\n");

    try {
      expect(removeManagedImageGatewayStateIfSafe(stateDir, gatewayStop, removalStatus)).toBe(
        false,
      );
      expect(fs.readFileSync(pidFile, "utf8")).toBe("9999601\n");
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("removes gateway state only after scoped stop and gateway removal succeed (#7744)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-state-remove-"));
    fs.writeFileSync(path.join(stateDir, "openshell-gateway.pid"), "9999601\n");

    expect(
      removeManagedImageGatewayStateIfSafe(stateDir, { failed: [], ownershipFailures: [] }, 0),
    ).toBe(true);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it("distinguishes the running image from exact quiescent rollback retention (#7744)", () => {
    const calls: string[][] = [];
    const contentId = `sha256:${"b".repeat(64)}`;
    const containerId = "c".repeat(64);
    const input = parseManagedImageOpenShellE2eInputs([
      "--agent",
      "openclaw",
      "--image",
      IMAGE,
      "--sandbox",
      VALID_SANDBOX,
    ]);
    const runningCommand = createManagedImageCommandRunner(
      contentId,
      containerId,
      "-q",
      `${containerId}\n`,
      calls,
    );
    const retainedCommand = createManagedImageCommandRunner(
      contentId,
      containerId,
      "-aq",
      `${containerId}\n`,
      calls,
    );

    expect(assertExactSandboxImage(input, "managed-network", {}, runningCommand)).toBe(containerId);
    assertFailedBootstrapOwnerCleanupRetention(
      input,
      "managed-network",
      containerId,
      {},
      retainedCommand,
    );

    expect(calls.filter((argv) => argv[1] === "ps").map((argv) => argv[2])).toEqual(["-q", "-aq"]);
  });

  it.each([
    ["missing", "", false, "one exact owner-cleanup runtime"],
    ["running", `${"c".repeat(64)}\n`, true, "quiescent owner-cleanup runtime"],
  ] as const)(
    "rejects a %s owner-cleanup runtime after failed bootstrap",
    (_case, list, running, message) => {
      const contentId = `sha256:${"b".repeat(64)}`;
      const containerId = "c".repeat(64);
      const input = parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        VALID_SANDBOX,
      ]);
      const runCommand = createManagedImageCommandRunner(
        contentId,
        containerId,
        "-aq",
        list,
        [],
        running,
      );

      expect(() =>
        assertFailedBootstrapOwnerCleanupRetention(
          input,
          "managed-network",
          containerId,
          {},
          runCommand,
        ),
      ).toThrow(message);
    },
  );

  it("accepts an exact retained OpenShell sandbox name", () => {
    const expectedSandboxId = "sandbox-id-123";
    const input = parseManagedImageOpenShellE2eInputs([
      "--agent",
      "openclaw",
      "--image",
      IMAGE,
      "--sandbox",
      VALID_SANDBOX,
    ]);
    const responses = new Map([
      ["get", { status: 0, stdout: `Id: ${expectedSandboxId}\n`, stderr: "" }],
      ["list", { status: 0, stdout: `NAME STATUS\n${VALID_SANDBOX} Ready\n`, stderr: "" }],
    ]);
    const runOpenshell = vi.fn(
      (argv: readonly string[]) =>
        responses.get(argv[1] ?? "") ?? { status: 1, stdout: "", stderr: "unexpected command" },
    );

    expect(() =>
      assertFailedSandboxOwnerCleanupRetention(
        { runOpenshell } as never,
        input,
        expectedSandboxId,
        {},
      ),
    ).not.toThrow();
  });

  it("rejects a containing sandbox name and an exact name mentioned only in stderr", () => {
    const expectedSandboxId = "sandbox-id-123";
    const input = parseManagedImageOpenShellE2eInputs([
      "--agent",
      "openclaw",
      "--image",
      IMAGE,
      "--sandbox",
      VALID_SANDBOX,
    ]);
    const responses = new Map([
      ["get", { status: 0, stdout: `Id: ${expectedSandboxId}\n`, stderr: "" }],
      [
        "list",
        {
          status: 0,
          stdout: `NAME STATUS\n${VALID_SANDBOX}-other Ready\n`,
          stderr: `diagnostic mentions ${VALID_SANDBOX}`,
        },
      ],
    ]);
    const runOpenshell = vi.fn(
      (argv: readonly string[]) =>
        responses.get(argv[1] ?? "") ?? { status: 1, stdout: "", stderr: "unexpected command" },
    );
    const assertion = () =>
      assertFailedSandboxOwnerCleanupRetention(
        { runOpenshell } as never,
        input,
        expectedSandboxId,
        {},
      );

    expect(assertion).toThrow("exact OpenShell owner-cleanup state");
    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["sandbox", "list"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("assigns every protected agent and route a unique OpenShell-compatible sandbox name (#8497)", () => {
    const routeKinds = [...MANAGED_IMAGE_LOCAL_INFERENCE_KINDS, "rollback"] as const;
    const qualifications = PROTECTED_MANAGED_IMAGE_AGENTS.flatMap((agent) =>
      routeKinds.map((routeKind) => ({
        agent,
        sandbox: managedImageProtectedSandboxName(agent, routeKind),
      })),
    );
    const names = qualifications.map(({ sandbox }) => sandbox);

    expect(names).toEqual([
      "nmc-mi-oc-lc",
      "nmc-mi-oc-ol",
      "nmc-mi-oc-ni",
      "nmc-mi-oc-vl",
      "nmc-mi-oc-rb",
      "nmc-mi-he-lc",
      "nmc-mi-he-ol",
      "nmc-mi-he-ni",
      "nmc-mi-he-vl",
      "nmc-mi-he-rb",
      "nmc-mi-dc-lc",
      "nmc-mi-dc-ol",
      "nmc-mi-dc-ni",
      "nmc-mi-dc-vl",
      "nmc-mi-dc-rb",
    ]);
    expect(new Set(names).size).toBe(names.length);
    qualifications.forEach(({ agent, sandbox: name }) => {
      expect(name.startsWith(MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(19);
      expect(name).not.toContain("--");
      expect(
        parseManagedImageOpenShellE2eInputs(["--agent", agent, "--image", IMAGE, "--sandbox", name])
          .sandbox,
      ).toBe(name);
    });
  });

  it("enforces the canonical OpenShell sandbox-name length and delimiter contract (#8497)", () => {
    const parseSandbox = (sandbox: string) =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        sandbox,
      ]);

    expect(parseSandbox(`a${"b".repeat(18)}`).sandbox).toHaveLength(19);
    expect(() => parseSandbox(`a${"b".repeat(19)}`)).toThrow(/1-19 characters/u);
    expect(() => parseSandbox("managed--openclaw")).toThrow(/single internal hyphens/u);
  });

  it.each([
    ["llama-cpp", "llama-cpp-local", "NEMOCLAW_LLAMACPP_LOCAL_TOKEN", 8081],
    ["ollama", "ollama-local", "NEMOCLAW_OLLAMA_PROXY_TOKEN", 11435],
    ["nim", "vllm-local", "NEMOCLAW_VLLM_LOCAL_TOKEN", 8000],
    ["vllm", "vllm-local", "NEMOCLAW_VLLM_LOCAL_TOKEN", 8000],
  ] as const)("maps %s to its exact host-local route", (kind, provider, credential, port) => {
    const route = resolveManagedImageLocalInferenceRoute(kind);

    expect(MANAGED_IMAGE_LOCAL_INFERENCE_KINDS).toContain(kind);
    expect(route).toMatchObject({
      kind,
      providerName: provider,
      credentialEnv: credential,
    });
    expect(new URL(route.defaultBaseUrl)).toMatchObject({
      hostname: "host.openshell.internal",
      port: String(port),
      pathname: "/v1",
      protocol: "http:",
    });
  });

  it("accepts an exact protected local-inference URL override", () => {
    expect(
      managedImageLocalInferenceBaseUrl("ollama", "http://host.openshell.internal:11435/v1/"),
    ).toBe("http://host.openshell.internal:11435/v1");
  });

  it.each([
    ["HTTPS", "https://host.openshell.internal:11435/v1"],
    ["another host", "http://example.invalid:11435/v1"],
    ["a missing port", "http://host.openshell.internal/v1"],
    ["port zero", "http://host.openshell.internal:0/v1"],
    ["an out-of-range port", "http://host.openshell.internal:65536/v1"],
    ["another path", "http://host.openshell.internal:11435/v2"],
    ["credentials", "http://user:secret@host.openshell.internal:11435/v1"],
    ["a query", "http://host.openshell.internal:11435/v1?model=other"],
    ["a fragment", "http://host.openshell.internal:11435/v1#other"],
  ])("rejects a protected local-inference override with %s", (_case, value) => {
    expect(() => managedImageLocalInferenceBaseUrl("ollama", value)).toThrow(
      /protected local inference/u,
    );
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "binds %s to an exact GPU/local-inference launch",
    (agent) => {
      const parsed = parseManagedImageOpenShellE2eInputs([
        "--agent",
        agent,
        "--image",
        IMAGE,
        "--sandbox",
        managedImageProtectedSandboxName(agent, "nim"),
        "--gpu",
        "--local-provider",
        "nim",
        "--model",
        "nvidia/nemotron-3-nano",
      ]);

      expect(parsed).toEqual({
        agent,
        gpu: true,
        image: IMAGE,
        localProvider: "nim",
        model: "nvidia/nemotron-3-nano",
        sandbox: managedImageProtectedSandboxName(agent, "nim"),
      });
      expect(path.isAbsolute(managedImageOpenShellBasePolicyPath(agent))).toBe(true);
      const probe = managedImageOpenShellProbe(agent);
      const syntax = spawnSync("/bin/sh", ["-n", "-c", probe], { encoding: "utf8" });
      expect(syntax.status, syntax.stderr).toBe(0);
      expect(probe).toContain("managed-startup-complete.json");
      expect(probe).toContain(
        `managed-image startup probe failed: ${
          agent === "openclaw"
            ? "OpenClaw health endpoint"
            : agent === "hermes"
              ? "Hermes health endpoint"
              : "LangChain Deep Agents Code version command"
        }`,
      );
      expect(probe).toContain(
        "managed-image startup probe failed: managed startup completion owner, group, and mode must equal 0:0:444",
      );
    },
  );

  it("rewrites only the inference route while preserving the managed agent profile", () => {
    const profile = managedStartupE2eProfile("hermes", false, true, true);
    const route = resolveManagedImageLocalInferenceRoute("nim");
    const rewritten = withManagedImageLocalInferenceProfile(
      profile,
      route,
      "nvidia/nemotron-3-nano",
    );

    expect(rewritten).toMatchObject({
      agent: "hermes",
      inference: {
        api: "openai-completions",
        model: "nvidia/nemotron-3-nano",
        routedBaseUrl: "https://inference.local/v1",
        routeProvider: "inference",
        upstreamEndpointUrl: null,
        upstreamProvider: "vllm-local",
      },
    });
    expect(rewritten.agentConfig).toEqual(profile.agentConfig);
  });

  it("rejects mutable images and incomplete GPU provider tuples", () => {
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        "localhost:5000/openclaw:latest",
        "--sandbox",
        VALID_SANDBOX,
      ]),
    ).toThrow(/immutable repository@sha256/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        VALID_SANDBOX,
        "--gpu",
      ]),
    ).toThrow(/--gpu requires/u);
  });

  it("allows only llama.cpp local inference without direct sandbox GPU access", () => {
    expect(
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
        "--model",
        "nvidia-nemotron-3-nano-30b-a3b",
      ]),
    ).toMatchObject({
      agent: "openclaw",
      localProvider: "llama-cpp",
      model: "nvidia-nemotron-3-nano-30b-a3b",
    });
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-vllm",
        "--local-provider",
        "vllm",
        "--model",
        "nvidia/nemotron-3-nano",
      ]),
    ).toThrow(/require --gpu/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
        "--model",
        "nvidia-nemotron-3-nano-30b-a3b",
        "--gpu",
      ]),
    ).toThrow(/must not grant direct sandbox GPU access/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
      ]),
    ).toThrow(/requires --model/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
        "--model",
        "nvidia-nemotron-3-nano-30b-a3b",
        "--inject-bootstrap-completion-failure",
      ]),
    ).toThrow(/cannot be combined/u);
  });

  it("keeps rollback cleanup distinct from initial readiness", () => {
    expect(managedImageOpenShellCommittedProbe()).toContain(
      "managed-startup-shared-state-transaction-v1",
    );
    expect(
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-rollback",
        "--inject-bootstrap-completion-failure",
      ]),
    ).toMatchObject({ failureInjection: "bootstrap-completion" });
  });
});
