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
  managedImageFailureDetail,
  PROTECTED_MANAGED_IMAGE_AGENTS,
  resolveManagedImageLocalInferenceRoute,
  withManagedImageLocalInferenceProfile,
} from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";
import {
  assertOpenClawHeartbeatStart,
  createBootstrapCompletionFailureInjection,
  managedOpenClawHeartbeatLogProbe,
  assertFailedSandboxOwnerCleanupRetention,
  type ManagedImageCommandRunner,
  managedImageLocalInferenceBaseUrl,
  managedImageOpenShellBasePolicyPath,
  managedImageOpenShellCommittedProbe,
  managedImageOpenShellProbe,
  managedOpenClawHeartbeatProbe,
  parseManagedImageOpenShellE2eInputs,
  protectedManagedStateRootDriverConfig,
  removeManagedImageGatewayStateIfSafe,
  resolveManagedImageOnboardModule,
} from "../../../scripts/checks/run-managed-image-openshell-e2e.ts";
import { validateManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import type { RuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/contract.ts";

const IMAGE = `localhost:5000/nemoclaw-managed-protected/openclaw@sha256:${"a".repeat(64)}`;
const VALID_SANDBOX = "managed-openclaw";
const MANAGED_IMAGE_ONBOARD = resolveManagedImageOnboardModule(
  await import("../../../src/lib/onboard.ts"),
);

function runManagedOpenClawHeartbeatProbe(
  heartbeat: { every: string; isolatedSession: boolean },
  postHashAppend = "",
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-heartbeat-'$HOME`pwd`-"));
  const configPath = path.join(directory, "openclaw.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { heartbeat } } }));
    const hash = spawnSync("sha256sum", ["openclaw.json"], {
      cwd: directory,
      encoding: "utf8",
    });
    expect(hash.status, hash.stderr).toBe(0);
    fs.writeFileSync(path.join(directory, ".config-hash"), hash.stdout);
    fs.appendFileSync(configPath, postHashAppend);

    return spawnSync(
      "/bin/sh",
      ["-c", managedOpenClawHeartbeatProbe(configPath, process.execPath, "sha256sum")],
      { encoding: "utf8" },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("protected managed-image runtime contract", () => {
  it("projects declared managed state roots through the selected provider driver", () => {
    const mount = {
      type: "volume" as const,
      source: "nemoclaw-hermes-state-v1-alpha",
      target: "/sandbox/.hermes",
      read_only: false,
    };
    const provider = {
      workload: { managedStateMountDriverId: "docker" },
    } as Pick<RuntimeProviderBundle, "workload">;

    expect(JSON.parse(protectedManagedStateRootDriverConfig(provider, [mount])!)).toEqual({
      docker: { mounts: [mount] },
    });
    expect(protectedManagedStateRootDriverConfig(provider, [])).toBeNull();
    expect(() =>
      protectedManagedStateRootDriverConfig({ workload: {} } as typeof provider, [mount]),
    ).toThrow("provider-owned mount projection");
  });

  it("reads the structured heartbeat interval without exporting log credentials", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-log-"));
    try {
      fs.mkdirSync(path.join(root, "unreadable"), { mode: 0 });
      const log = path.join(root, "openclaw-2026-09-13.log");
      fs.writeFileSync(
        log,
        JSON.stringify({
          "0": JSON.stringify({ subsystem: "gateway/heartbeat" }),
          "1": { intervalMs: 120000, apiKey: "fixture-secret" },
          "2": "heartbeat: started",
        }) + "\n",
      );
      const probe = managedOpenClawHeartbeatLogProbe()
        .replace('"/tmp/openclaw"', JSON.stringify(path.join(root, "unreadable")))
        .replace('"/tmp/openclaw-" + process.getuid()', JSON.stringify(root));
      const result = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("heartbeat-interval-ms=120000");
      expect(result.stderr).toBe("");
      fs.writeFileSync(log, "malformed fixture-secret");
      const failed = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toBe("heartbeat-evidence-unavailable:parse:SyntaxError");
    } finally {
      fs.chmodSync(path.join(root, "unreadable"), 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { reason: "unrelated subsystem", subsystem: "gateway/other", create: fs.copyFileSync },
    { reason: "symlink log", subsystem: "gateway/heartbeat", create: fs.symlinkSync },
  ])("rejects heartbeat evidence from a $reason", ({ subsystem, create }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-denial-"));
    try {
      const source = path.join(root, "source.log");
      fs.writeFileSync(
        source,
        JSON.stringify({
          "0": JSON.stringify({ subsystem }),
          "1": { intervalMs: 120000, apiKey: "fixture-secret" },
          "2": "heartbeat: started",
        }) + "\n",
      );
      create(source, path.join(root, "openclaw-2026-09-13.log"));
      const probe = managedOpenClawHeartbeatLogProbe()
        .replace('"/tmp/openclaw"', JSON.stringify(root))
        .replace('"/tmp/openclaw-" + process.getuid()', JSON.stringify(root));
      const result = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        subsystem === "gateway/other"
          ? "heartbeat-evidence-unavailable:parse:invalid"
          : "heartbeat-evidence-unavailable:open:ELOOP",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { separateLogs: false, intervals: [120000, 1800000] },
    { separateLogs: false, intervals: [1800000, 120000] },
    { separateLogs: true, intervals: [120000, 1800000] },
    { separateLogs: true, intervals: [1800000, 120000] },
  ])(
    "rejects conflicting heartbeat intervals $intervals with separateLogs=$separateLogs",
    ({ separateLogs, intervals }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-conflict-"));
      try {
        intervals.forEach((intervalMs, index) => {
          const name = separateLogs ? `openclaw-2026-09-${13 + index}.log` : "openclaw.log";
          fs.appendFileSync(
            path.join(root, name),
            JSON.stringify({
              "0": JSON.stringify({ subsystem: "gateway/heartbeat" }),
              "1": { intervalMs, apiKey: "fixture-secret" },
              "2": "heartbeat: started",
            }) + "\n",
          );
        });
        const probe = managedOpenClawHeartbeatLogProbe()
          .replace('"/tmp/openclaw"', JSON.stringify(root))
          .replace('"/tmp/openclaw-" + process.getuid()', JSON.stringify(root));
        const result = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("heartbeat-evidence-unavailable:parse:invalid");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("requires the exact managed OpenClaw heartbeat interval in startup logs (#10262)", () => {
    const containerId = "a".repeat(64);
    const runCommand = vi.fn<ManagedImageCommandRunner>(() => ({
      status: 0,
      stderr: "",
      stdout: "heartbeat-interval-ms=120000",
    }));

    expect(() => assertOpenClawHeartbeatStart(containerId, {}, runCommand)).not.toThrow();
    expect(runCommand).toHaveBeenCalledWith(
      [
        "docker",
        "exec",
        "--user",
        "sandbox",
        containerId,
        "node",
        "-e",
        managedOpenClawHeartbeatLogProbe(),
      ],
      {},
      15_000,
    );

    runCommand.mockReturnValue({
      status: 0,
      stdout: "heartbeat-interval-ms=1800000",
      stderr: "",
    });
    expect(() => assertOpenClawHeartbeatStart(containerId, {}, runCommand)).toThrow(
      "managed OpenClaw did not start with the requested 120000 ms heartbeat",
    );
  });

  it("does not expose JSON credentials when managed OpenClaw startup logs cannot be read", () => {
    const containerId = "a".repeat(64);
    const secret = "json-api-key-secret";
    const runCommand = vi.fn<ManagedImageCommandRunner>(() => ({
      status: 1,
      stdout: JSON.stringify({ apiKey: secret }),
      stderr: JSON.stringify({ nested: { apiKey: secret } }),
    }));

    expect(() => assertOpenClawHeartbeatStart(containerId, {}, runCommand)).toThrow(
      "managed OpenClaw structured heartbeat evidence unavailable",
    );
    expect(() => assertOpenClawHeartbeatStart(containerId, {}, runCommand)).not.toThrow(secret);
    runCommand.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "heartbeat-evidence-unavailable:list:EACCES",
    });
    expect(() => assertOpenClawHeartbeatStart(containerId, {}, runCommand)).toThrow(
      "(list: EACCES)",
    );
    const diagnostic = managedImageFailureDetail(
      new Error(
        `startup failed: ${secret} https://user:password@example.test ${"x".repeat(8_000)}`,
      ),
      { NVIDIA_API_KEY: secret },
    );
    expect(diagnostic).toContain("Error: startup failed:");
    expect(diagnostic).not.toMatch(/json-api-key-secret|user:password/);
    expect(diagnostic).toHaveLength(8_000);
  });

  it("loads managed state-volume operations through the existing onboard boundary", () => {
    expect(MANAGED_IMAGE_ONBOARD.managedWorkloadOnboard.prepareManagedStateVolumes).toBeTypeOf(
      "function",
    );
    expect(MANAGED_IMAGE_ONBOARD.managedWorkloadOnboard.removeManagedStateVolumes).toBeTypeOf(
      "function",
    );
  });

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

  it("accepts an isolated OpenClaw heartbeat with a matching configuration hash (#10262)", () => {
    const result = runManagedOpenClawHeartbeatProbe({ every: "2m", isolatedSession: true });

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["a main-session heartbeat", { every: "2m", isolatedSession: false }],
    ["another heartbeat interval", { every: "30m", isolatedSession: true }],
  ])("rejects %s in the managed OpenClaw probe (#10262)", (_case, heartbeat) => {
    const result = runManagedOpenClawHeartbeatProbe(heartbeat);

    expect(result.status).toBe(1);
  });

  it("rejects a stale managed OpenClaw configuration hash (#10262)", () => {
    const result = runManagedOpenClawHeartbeatProbe({ every: "2m", isolatedSession: true }, "\n");

    expect(result.status).toBe(1);
  });

  it.each([
    ["openclaw", false],
    ["openclaw", true],
    ["hermes", false],
    ["hermes", true],
  ] as const)("supplies a valid local route for %s with providerless=%s", (agent, providerless) => {
    const original = managedStartupE2eProfile(agent, false, true, true);
    const profile = providerless
      ? validateManagedStartupProfile({ ...original, inference: null })
      : original;
    const route = resolveManagedImageLocalInferenceRoute("nim");
    const rewritten = withManagedImageLocalInferenceProfile(
      profile,
      route,
      "nvidia/nemotron-3-nano",
    );

    expect(validateManagedStartupProfile(rewritten)).toEqual(rewritten);
    expect(rewritten).toEqual({
      ...profile,
      inference: {
        api: "openai-completions",
        model: "nvidia/nemotron-3-nano",
        routedBaseUrl: "https://inference.local/v1",
        routeProvider: "inference",
        upstreamEndpointUrl: null,
        upstreamProvider: "vllm-local",
        primaryModelRef: agent === "openclaw" ? "inference/nvidia/nemotron-3-nano" : null,
        compatibility: profile.inference?.compatibility ?? (agent === "openclaw" ? {} : null),
        inputModalities:
          profile.inference?.inputModalities ?? (agent === "openclaw" ? ["text"] : null),
      },
    });
    expect(profile.inference).toEqual(providerless ? null : original.inference);
    expect(() =>
      validateManagedStartupProfile(withManagedImageLocalInferenceProfile(profile, route, "")),
    ).toThrow();
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

  it("injects bootstrap completion failure only after exact owner retention is proven", () => {
    const expectedSandboxId = "sandbox-id-rollback";
    const managedImage = parseManagedImageOpenShellE2eInputs([
      "--agent",
      "openclaw",
      "--image",
      IMAGE,
      "--sandbox",
      VALID_SANDBOX,
      "--inject-bootstrap-completion-failure",
    ]);
    const runOpenshell = vi.fn((argv: readonly string[]) =>
      argv[1] === "get"
        ? { status: 0, stdout: `Id: ${expectedSandboxId}\n`, stderr: "" }
        : { status: 0, stdout: `NAME STATUS\n${VALID_SANDBOX} Ready\n`, stderr: "" },
    );
    const onQualified = vi.fn();
    const write = vi.fn();
    const injection = createBootstrapCompletionFailureInjection({
      env: {},
      managedImage,
      onboard: { runOpenshell } as never,
      onQualified,
      write,
    });

    expect(() =>
      injection.flowInput.verifyCreatedSandboxBeforeEffects!({
        sandboxId: expectedSandboxId,
        liveIdentityFingerprint: "fingerprint",
        createAttemptNonce: "nonce",
        route: "none",
      }),
    ).toThrow(injection.expectedError);
    expect(onQualified).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("retained one exact quiescent openclaw sandbox for owner cleanup"),
    );
    expect(injection.flowInput.persistRetainedSandboxRecovery!("retained")).toBe(true);
  });
});
