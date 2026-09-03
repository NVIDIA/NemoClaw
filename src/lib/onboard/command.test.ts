// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getCredential } from "../credentials/store";
import { loadServingCatalog } from "../inference/serving/catalog-loader";
import { listServingProfiles } from "../inference/serving/profile-list";
import { servingProfileProvenance } from "../inference/serving/profile-provenance";
import { NEMOCLAW_VLLM_GPU_DEVICE_ENV } from "../inference/vllm-models";
import type { SystemReadinessReport } from "../readiness/types";
import { resolveOnboardOptions, runOnboardCommand, servingProfileProviderKey } from "./command";
import type { OnboardFlags } from "./command-support";
import { PortableInferenceDescriptorError } from "./experimental/portable-inference-descriptor";
import { invalidGatewayManagementDeclarationError } from "./gateway-management";
import { GatewayAuthorityError } from "./gateway-teardown-authority";
import {
  LOCAL_MODEL_PROFILE_ENABLED_ENV,
  LOCAL_MODEL_PROFILE_RUNTIME_ENV,
} from "./local-model-profile/plan";
import { OnboardResumeIntentError, OnboardResumeIntentRaceError } from "./session-bootstrap";
import { MANAGED_VLLM_PROVIDER_KEY } from "./vllm-menu";

afterEach(() => {
  vi.unstubAllEnvs();
});

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

function resolve(
  flags: OnboardFlags,
  overrides: Partial<Parameters<typeof resolveOnboardOptions>[1]> = {},
) {
  return resolveOnboardOptions(flags, {
    env: {},
    error: () => {},
    exit: exitWithCode,
    ...overrides,
  });
}

const COMPATIBLE_NANO_PROFILE = {
  id: "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b",
  displayName: "NVIDIA Nemotron 3 Nano 30B-A3B on one DGX Spark",
  backend: "install-llama-cpp",
  model: "unsloth/Nemotron-3-Nano-30B-A3B-GGUF",
  topology: "single-host",
  selectionMode: "explicit-only" as const,
  supportState: "experimental" as const,
  estimatedImageDownloadBytes: 1,
  estimatedModelDownloadBytes: 1,
  compatible: true,
  incompatibilityReason: null,
};

// Recreation is selected three ways and only the first sets the flag that
// `resolveOnboardOptions` records: the explicit flag, NEMOCLAW_RECREATE_SANDBOX
// read inside `runOnboard`, and drift detected mid-run. All three reach the same
// recreate journal, so all three must report an authority refusal (#8103).
const RECREATE_SELECTIONS: [string, OnboardFlags, Record<string, string>][] = [
  ["the explicit --recreate-sandbox flag", { "recreate-sandbox": true }, {}],
  ["NEMOCLAW_RECREATE_SANDBOX without the flag", {}, { NEMOCLAW_RECREATE_SANDBOX: "1" }],
  ["drift detected with neither the flag nor the environment request", {}, {}],
];

describe("onboard command options", () => {
  it("records only explicit APF interceptor selection (#9833)", () => {
    expect(resolve({ "apf-interceptor": true }).apfInterceptorRequested).toBe(true);
    expect(resolve({}).apfInterceptorRequested).toBeNull();
  });

  it("resolves a generic serving profile ID without changing defaults (#8384)", () => {
    expect(
      resolve(
        { profile: "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b" },
        { listServingProfiles: () => [COMPATIBLE_NANO_PROFILE] },
      ).servingProfile,
    ).toBe("llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b");
    expect(
      resolve(
        { profile: COMPATIBLE_NANO_PROFILE.displayName },
        { listServingProfiles: () => [COMPATIBLE_NANO_PROFILE] },
      ).servingProfile,
    ).toBe(COMPATIBLE_NANO_PROFILE.id);
    expect(resolve({}).servingProfile).toBeNull();
  });

  it("rejects unknown or conflicting serving profile intent before onboarding (#8384)", () => {
    const errors: string[] = [];
    expect(() =>
      resolve({ profile: "missing-profile" }, { error: (message = "") => errors.push(message) }),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("Run 'nemoclaw profiles list'");

    errors.length = 0;
    expect(() =>
      resolve(
        { profile: "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b" },
        {
          env: { NEMOCLAW_PROVIDER: "ollama" },
          listServingProfiles: () => [COMPATIBLE_NANO_PROFILE],
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("cannot be combined with inference overrides");
    expect(errors.join("\n")).toContain("NEMOCLAW_PROVIDER");

    errors.length = 0;
    expect(() =>
      resolve(
        { profile: COMPATIBLE_NANO_PROFILE.id },
        {
          listServingProfiles: () => [
            {
              ...COMPATIBLE_NANO_PROFILE,
              compatible: false,
              incompatibilityReason: "A host requirement is not met.",
            },
          ],
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("incompatible: A host requirement is not met");
  });

  it("reuses exact recorded profile identity on resume and rejects catalog drift (#8246)", () => {
    const catalog = loadServingCatalog();
    const recorded = servingProfileProvenance(catalog, catalog.presets[0]!.metadata.id);
    const resumed = resolve(
      { resume: true },
      {
        loadServingCatalog: () => catalog,
        loadSession: () => ({ servingProfileProvenance: recorded }) as never,
      },
    );
    expect(resumed.servingProfile).toBe(recorded.preset.id);
    expect(resumed.servingProfileProvenance).toEqual(recorded);

    const errors: string[] = [];
    expect(() =>
      resolve(
        { resume: true },
        {
          loadServingCatalog: () => ({
            ...catalog,
            catalogDigest: `sha256:${"f".repeat(64)}`,
          }),
          loadSession: () => ({ servingProfileProvenance: recorded }) as never,
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("changed since onboarding started");
  });

  it("records installer local-model profile intent before onboarding and reuses it on resume", () => {
    const catalog = loadServingCatalog();
    const fresh = resolve(
      {},
      {
        env: {
          [LOCAL_MODEL_PROFILE_ENABLED_ENV]: "1",
          [LOCAL_MODEL_PROFILE_RUNTIME_ENV]: "vllm",
        },
        loadServingCatalog: () => catalog,
      },
    );

    expect(fresh.servingProfile).toBeNull();
    expect(fresh.servingProfileProvenance?.preset.id).toBe("local-model-profile.vllm.spark.v1");

    const resumed = resolve(
      { resume: true },
      {
        env: {},
        loadServingCatalog: () => catalog,
        loadSession: () => ({
          servingProfileProvenance: fresh.servingProfileProvenance,
        }),
      },
    );
    expect(resumed.servingProfileProvenance).toEqual(fresh.servingProfileProvenance);
  });

  it("keeps legacy resume compatible but refuses to add new profile intent (#8384)", () => {
    expect(
      resolve({ resume: true }, { loadSession: () => ({}) as never }).servingProfile,
    ).toBeNull();
    const errors: string[] = [];
    expect(() =>
      resolve(
        { resume: true, profile: COMPATIBLE_NANO_PROFILE.id },
        {
          listServingProfiles: () => [COMPATIBLE_NANO_PROFILE],
          loadSession: () => ({}) as never,
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("legacy onboarding session");
  });

  it("normalizes a vLLM GPU index or UUID and reuses the recorded device on resume", () => {
    expect(resolve({ "vllm-gpu-device": "002" }).vllmGpuDevice).toBe("2");
    const uuid = "GPU-69ADB14E-820E-BFB4-0993-171E73F68504";
    const normalizedUuid = "GPU-69adb14e-820e-bfb4-0993-171e73f68504";
    expect(resolve({ "vllm-gpu-device": uuid }).vllmGpuDevice).toBe(normalizedUuid);
    expect(
      resolve({ resume: true }, { loadSession: () => ({ vllmGpuDevice: normalizedUuid }) })
        .vllmGpuDevice,
    ).toBe(normalizedUuid);
  });

  it.each([
    {
      caseName: "a CDI device name",
      flags: { "vllm-gpu-device": "nvidia.com/gpu=0" } as OnboardFlags,
      session: null,
    },
    {
      caseName: "a device added to a legacy resume",
      flags: { resume: true, "vllm-gpu-device": "1" } as OnboardFlags,
      session: {},
    },
    {
      caseName: "a device changed during resume",
      flags: { resume: true, "vllm-gpu-device": "1" } as OnboardFlags,
      session: { vllmGpuDevice: "0" },
    },
  ])("rejects $caseName", ({ flags, session }) => {
    const errors: string[] = [];
    expect(() =>
      resolve(flags, {
        ...(session ? { loadSession: () => session } : {}),
        error: (message = "") => errors.push(message),
      }),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toMatch(/vllm-gpu-device|resumed GPU device/);
  });

  it("maps typed oclif flags to onboarding options", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-options-"));
    const dockerfilePath = path.join(tmpDir, "Custom.Dockerfile");
    const managedCatalogPath = path.join(tmpDir, "managed-catalog.json");
    fs.writeFileSync(dockerfilePath, "FROM scratch\n");
    fs.writeFileSync(managedCatalogPath, "{}\n");

    expect(
      resolve(
        {
          "temp-managed-runtime": true,
          "temp-managed-runtime-catalog": managedCatalogPath,
          "non-interactive": true,
          resume: true,
          "recreate-sandbox": true,
          from: dockerfilePath,
          name: "second-assistant",
          "sandbox-gpu": true,
          "sandbox-gpu-device": "nvidia.com/gpu=0",
          "vllm-gpu-device": "2",
          agent: "dcode",
          "tool-disclosure": "direct",
          observability: true,
          "control-ui-port": 18790,
          gpu: true,
          yes: true,
          "no-ollama-autostart": true,
          "yes-i-accept-third-party-software": true,
        },
        {
          listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
          loadSession: () => ({ vllmGpuDevice: "2" }),
        },
      ),
    ).toEqual({
      tempManagedRuntime: true,
      tempManagedRuntimeCatalog: managedCatalogPath,
      nonInteractive: true,
      resume: true,
      fresh: false,
      recreateSandbox: true,
      apfInterceptorRequested: null,
      fromDockerfile: dockerfilePath,
      sandboxName: "second-assistant",
      sandboxGpu: "enable",
      sandboxGpuDevice: "nvidia.com/gpu=0",
      vllmGpuDevice: "2",
      acceptThirdPartySoftware: true,
      agent: "langchain-deepagents-code",
      agentsManifest: null,
      toolDisclosure: "direct",
      observabilityEnabled: true,
      controlUiPort: 18790,
      deferProcessExit: true,
      gpu: true,
      noGpu: false,
      autoYes: true,
      noOllamaAutostart: true,
      experimentalProfile: null,
      portableInferenceActivation: null,
      resumeIntentSnapshot: null,
      servingProfile: null,
      servingProfileProvenance: null,
    });
  });

  it("accepts an exact qualification catalog without enabling candidate activation", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-catalog-only-"));
    const managedCatalogPath = path.join(tmpDir, "managed-catalog.json");
    fs.writeFileSync(managedCatalogPath, "{}\n");

    try {
      expect(resolve({ "temp-managed-runtime-catalog": managedCatalogPath })).toMatchObject({
        tempManagedRuntime: false,
        tempManagedRuntimeCatalog: managedCatalogPath,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses explicit false/null defaults when flags are absent", () => {
    expect(resolve({})).toEqual({
      tempManagedRuntime: false,
      tempManagedRuntimeCatalog: null,
      nonInteractive: false,
      resume: false,
      fresh: false,
      recreateSandbox: false,
      apfInterceptorRequested: null,
      fromDockerfile: null,
      sandboxName: null,
      sandboxGpu: null,
      sandboxGpuDevice: null,
      vllmGpuDevice: null,
      acceptThirdPartySoftware: false,
      agent: null,
      agentsManifest: null,
      toolDisclosure: null,
      observabilityEnabled: null,
      controlUiPort: null,
      deferProcessExit: true,
      gpu: false,
      noGpu: false,
      autoYes: false,
      noOllamaAutostart: false,
      experimentalProfile: null,
      portableInferenceActivation: null,
      resumeIntentSnapshot: null,
      servingProfile: null,
      servingProfileProvenance: null,
    });
  });

  it("maps repeated host mounts when the selected runtime provider supports them", () => {
    const first = fs.mkdtempSync(path.join(process.cwd(), ".onboard-host-mount-test-"));
    const second = fs.mkdtempSync(path.join(process.cwd(), ".onboard-host-mount-test-"));
    const values = [`${first}:/sandbox/project`, `${second}:/sandbox/reference`];
    try {
      expect(resolve({ "host-mount": values }, { platform: "linux" }).hostMounts).toEqual([
        {
          source: first,
          target: "/sandbox/project",
          readOnly: true,
          sourceIdentity: { device: expect.any(String), inode: expect.any(String) },
        },
        {
          source: second,
          target: "/sandbox/reference",
          readOnly: true,
          sourceIdentity: { device: expect.any(String), inode: expect.any(String) },
        },
      ]);
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it("reports the Podman capability reason for portable host mounts", () => {
    const errors: string[] = [];
    const source = fs.mkdtempSync(path.join(process.cwd(), ".onboard-host-mount-test-"));

    try {
      expect(() =>
        resolve(
          {
            "experimental-profile": "portable",
            "host-mount": [`${source}:/sandbox/project`],
          },
          { platform: "linux", error: (message = "") => errors.push(message) },
        ),
      ).toThrow("exit:1");
      expect(errors.join("\n")).toContain("Runtime provider 'podman'");
      expect(errors.join("\n")).toContain("not qualified for the Podman runtime provider");
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it.each([
    ["darwin", "arm64", "docker", "has not qualified read-only host mounts"],
    ["win32", "x64", "kubernetes", "Kubernetes hostPath semantics"],
  ] as const)(
    "reports why the runtime provider selected for %s rejects host mounts",
    (platform, arch, provider, reason) => {
      const source = fs.mkdtempSync(path.join(process.cwd(), ".onboard-host-mount-test-"));
      const error = vi.fn();
      try {
        expect(() =>
          resolve({ "host-mount": [`${source}:/sandbox/project`] }, { platform, arch, error }),
        ).toThrow("exit:1");
        expect(error.mock.calls.flat().join("\n")).toContain(`Runtime provider '${provider}'`);
        expect(error.mock.calls.flat().join("\n")).toContain(reason);
      } finally {
        fs.rmSync(source, { recursive: true, force: true });
      }
    },
  );

  it("resolves the portable profile to deterministic unattended defaults", () => {
    expect(resolve({ "experimental-profile": "portable" })).toMatchObject({
      experimentalProfile: "portable",
      nonInteractive: true,
      fresh: true,
      autoYes: true,
      noOllamaAutostart: true,
      noGpu: false,
      sandboxGpu: null,
      toolDisclosure: "direct",
    });
  });

  it("uses direct disclosure for fresh Portable when the installer exports its generic default (#9211)", async () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_TOOL_DISCLOSURE: "progressive" };
    const observed: Array<string | null> = [];

    await runOnboardCommand({
      flags: { "experimental-profile": "portable" },
      env,
      loadPortableInferenceDescriptor: async () => null,
      runOnboard: async (options) => {
        observed.push(options.toolDisclosure);
      },
    });

    expect(observed).toEqual(["direct"]);
    expect(env.NEMOCLAW_TOOL_DISCLOSURE).toBe("progressive");
  });

  it("keeps an explicit Portable disclosure selection and defers resume to durable state (#9211)", () => {
    const env = { NEMOCLAW_TOOL_DISCLOSURE: "progressive" };

    expect(
      resolve({ "experimental-profile": "portable", "tool-disclosure": "progressive" }, { env })
        .toolDisclosure,
    ).toBe("progressive");
    expect(
      resolve(
        { "experimental-profile": "portable", resume: true },
        { env, resumeIntent: { effectiveResume: true, snapshot: null } },
      ).toolDisclosure,
    ).toBeNull();
  });

  it("allows an exact portable checkpoint profile on resume (#9035)", () => {
    expect(
      resolve(
        { "experimental-profile": "portable", resume: true },
        {
          resumeIntent: {
            effectiveResume: true,
            snapshot: {
              fingerprint: "a".repeat(64),
              sessionId: "session-1",
              checkpointUpdatedAt: "2026-08-13T00:00:00.000Z",
              machineRevision: 1,
              profile: "portable",
            },
          },
        },
      ),
    ).toMatchObject({ resume: true, fresh: false, experimentalProfile: "portable" });
  });

  it("maps --no-observability to an explicit disabled request", () => {
    expect(
      resolve(
        { agent: "dcode", observability: false },
        { listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"] },
      ).observabilityEnabled,
    ).toBe(false);
  });

  it("accepts the environment-based third-party notice acknowledgement", () => {
    expect(
      resolve({}, { env: { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" } }).acceptThirdPartySoftware,
    ).toBe(true);
  });

  it("uses the agent-neutral tool-disclosure env and rejects unknown values", () => {
    expect(resolve({}, { env: { NEMOCLAW_TOOL_DISCLOSURE: " DIRECT " } }).toolDisclosure).toBe(
      "direct",
    );
    const errors: string[] = [];
    expect(() =>
      resolve(
        {},
        {
          env: { NEMOCLAW_TOOL_DISCLOSURE: "sometimes" },
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("must be one of: progressive, direct");
  });

  it("preserves the requested Dockerfile path after validating the resolved file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-"));
    const dockerfilePath = path.join(tmpDir, "Custom.Dockerfile");
    fs.writeFileSync(dockerfilePath, "FROM scratch\n");
    const relativeDockerfilePath = path.relative(process.cwd(), dockerfilePath);

    expect(resolve({ from: relativeDockerfilePath }).fromDockerfile).toBe(relativeDockerfilePath);
  });

  it("rejects missing and non-file Dockerfile paths before onboarding", () => {
    const errors: string[] = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-errors-"));
    const deps = { error: (message = "") => errors.push(message) };

    expect(() => resolve({ from: path.join(tmpDir, "missing") }, deps)).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--from path not found:");

    errors.length = 0;
    expect(() => resolve({ from: tmpDir }, deps)).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--from must point to a Dockerfile:");
  });

  it("canonicalizes known agent aliases", () => {
    const listAgents = () => ["openclaw", "hermes", "langchain-deepagents-code"];
    expect(resolve({ agent: "dcode" }, { listAgents }).agent).toBe("langchain-deepagents-code");
    expect(resolve({ agent: "nemohermes" }, { listAgents }).agent).toBe("hermes");
  });

  it("rejects observability for an explicitly unsupported agent", () => {
    const errors: string[] = [];
    expect(() =>
      resolve(
        { agent: "hermes", observability: true },
        {
          listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain(
      "--observability is supported only with --agent langchain-deepagents-code",
    );
  });

  it("allows an explicit observability opt-out while selecting another agent", () => {
    expect(
      resolve(
        { agent: "hermes", observability: false },
        { listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"] },
      ).observabilityEnabled,
    ).toBe(false);
  });

  it("rejects unknown agents with the available aliases", () => {
    const errors: string[] = [];
    expect(() =>
      resolve(
        { agent: "bogus" },
        {
          listAgents: () => ["openclaw", "hermes"],
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("Unknown agent 'bogus'");
    expect(errors.join("\n")).toContain("aliases: nemohermes → hermes");
  });

  it("rejects an unknown NEMOCLAW_AGENT cleanly instead of throwing uncaught (#5972)", () => {
    // #5972: an unknown NEMOCLAW_AGENT must fail via the clean error/exit path,
    // matching --agent, not by throwing uncaught deep in runOnboard.
    const errors: string[] = [];
    expect(() =>
      resolve(
        {},
        {
          env: { NEMOCLAW_AGENT: "bogus-agent" },
          listAgents: () => ["openclaw", "hermes"],
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("Unknown agent 'bogus-agent' (from NEMOCLAW_AGENT)");
    expect(errors.join("\n")).toContain("aliases: nemohermes → hermes");
  });

  it("accepts a valid NEMOCLAW_AGENT (and its aliases) without forcing the flag value", () => {
    const listAgents = () => ["openclaw", "hermes", "langchain-deepagents-code"];
    // Valid env agents resolve downstream, so resolveAgent leaves `agent` null.
    expect(resolve({}, { env: { NEMOCLAW_AGENT: "hermes" }, listAgents }).agent).toBeNull();
    expect(resolve({}, { env: { NEMOCLAW_AGENT: "nemohermes" }, listAgents }).agent).toBeNull();
    expect(resolve({}, { env: {}, listAgents }).agent).toBeNull();
  });

  it("prefers the --agent flag over NEMOCLAW_AGENT for validation", () => {
    const listAgents = () => ["openclaw", "hermes"];
    // Flag is valid even when the env var is bogus — flag takes precedence.
    expect(
      resolve({ agent: "hermes" }, { env: { NEMOCLAW_AGENT: "bogus" }, listAgents }).agent,
    ).toBe("hermes");
  });

  it("runs onboard with resolved options", async () => {
    const runOnboard = vi.fn(async () => {});
    await runOnboardCommand({
      flags: { resume: true },
      env: {},
      runOnboard,
      error: () => {},
      exit: exitWithCode,
    });

    expect(runOnboard).toHaveBeenCalledWith(expect.objectContaining({ resume: true }));
  });

  it("scopes the selected vLLM GPU device to one onboarding run", async () => {
    const env: NodeJS.ProcessEnv = { [NEMOCLAW_VLLM_GPU_DEVICE_ENV]: "9" };
    let observed: string | undefined;
    await runOnboardCommand({
      flags: { "vllm-gpu-device": "2" },
      env,
      runOnboard: async (options) => {
        observed = env[NEMOCLAW_VLLM_GPU_DEVICE_ENV];
        expect(options.vllmGpuDevice).toBe("2");
      },
    });

    expect(observed).toBe("2");
    expect(env[NEMOCLAW_VLLM_GPU_DEVICE_ENV]).toBe("9");
  });

  it("re-resolves once after onboard reports a pre-read race (#9035)", async () => {
    const snapshots = ["first", "second"].map((fingerprint) => ({
      effectiveResume: true,
      snapshot: {
        fingerprint,
        sessionId: "session-1",
        checkpointUpdatedAt: "2026-08-13T20:00:00.000Z",
        machineRevision: 2,
        profile: "portable" as const,
      },
    }));
    const resolveResumeIntent = vi
      .fn()
      .mockReturnValueOnce(snapshots[0])
      .mockReturnValueOnce(snapshots[1]);
    const runOnboard = vi
      .fn()
      .mockRejectedValueOnce(new OnboardResumeIntentRaceError())
      .mockResolvedValueOnce(undefined);

    await runOnboardCommand({
      flags: { resume: true },
      env: {},
      resolveResumeIntent,
      loadPortableInferenceDescriptor: async () => null,
      runOnboard,
    });

    expect(resolveResumeIntent).toHaveBeenCalledTimes(2);
    expect(runOnboard).toHaveBeenCalledTimes(2);
    expect(runOnboard.mock.calls[1]?.[0].resumeIntentSnapshot?.fingerprint).toBe("second");
  });

  it("keeps early legacy recovery guidance agent-neutral for an alias (#9035)", async () => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: { resume: true },
        env: { NEMOCLAW_AGENT: "nemohermes" },
        resolveResumeIntent: () => {
          throw new OnboardResumeIntentError(
            "This onboarding checkpoint predates recorded runtime authority and cannot be resumed safely. Start a new onboarding attempt with the `--fresh` option.",
          );
        },
        runOnboard: vi.fn(async () => {}),
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain(
      "Start a new onboarding attempt with the `--fresh` option.",
    );
    expect(errors.join("\n")).not.toContain("nemoclaw onboard");
  });

  it("fails after a second pre-read race instead of looping (#9035)", async () => {
    const resolveResumeIntent = vi.fn(() => ({
      effectiveResume: true,
      snapshot: {
        fingerprint: "changed",
        sessionId: "session-1",
        checkpointUpdatedAt: "2026-08-13T20:00:00.000Z",
        machineRevision: 2,
        profile: "default" as const,
      },
    }));
    const runOnboard = vi.fn(async () => {
      throw new OnboardResumeIntentRaceError();
    });
    const errors: string[] = [];

    await expect(
      runOnboardCommand({
        flags: { resume: true },
        env: {},
        resolveResumeIntent,
        runOnboard,
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");
    expect(resolveResumeIntent).toHaveBeenCalledTimes(2);
    expect(runOnboard).toHaveBeenCalledTimes(2);
    expect(errors.join("\n")).toContain("checkpoint changed while resume acquired its lock");
  });

  it("does not handle an unbranded deferred-exit lookalike (#9035)", async () => {
    const lookalike = Object.assign(new Error("unknown failure"), {
      code: 1,
      name: "OnboardDeferredExitError",
    });
    const exit = vi.fn((_code: number): never => {
      throw new Error("unexpected exit");
    });

    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw lookalike;
        },
        exit,
      }),
    ).rejects.toBe(lookalike);
    expect(exit).not.toHaveBeenCalled();
  });

  it("restores scoped command environment before exiting after a second resume race (#9035)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resume-race-environment-"));
    const manifestPath = path.join(tmpDir, "agents.yaml");
    fs.writeFileSync(manifestPath, "agents: []\n");
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_EXTRA_AGENTS_JSON: "previous-agents",
      NEMOCLAW_OLLAMA_NO_AUTOSTART: "previous-autostart",
      NEMOCLAW_TOOL_DISCLOSURE: "previous-disclosure",
    };
    let environmentAtExit: NodeJS.ProcessEnv | null = null;

    try {
      await expect(
        runOnboardCommand({
          flags: {
            resume: true,
            agents: manifestPath,
            "no-ollama-autostart": true,
            "tool-disclosure": "direct",
          },
          env,
          resolveResumeIntent: () => ({ effectiveResume: true, snapshot: null }),
          runOnboard: async () => {
            throw new OnboardResumeIntentRaceError();
          },
          error: () => {},
          exit: (code): never => {
            environmentAtExit = { ...env };
            throw new Error(`exit:${code}`);
          },
        }),
      ).rejects.toThrow("exit:1");
      expect(environmentAtExit).toEqual({
        NEMOCLAW_EXTRA_AGENTS_JSON: "previous-agents",
        NEMOCLAW_OLLAMA_NO_AUTOSTART: "previous-autostart",
        NEMOCLAW_TOOL_DISCLOSURE: "previous-disclosure",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    { providerState: "unset", previousProvider: undefined },
    { providerState: "blank", previousProvider: "" },
  ])(
    "restores every scoped command value before a handled-error exit when the provider is $providerState (#9035)",
    async ({ previousProvider }) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-handled-error-environment-"));
      const manifestPath = path.join(tmpDir, "agents.yaml");
      fs.writeFileSync(manifestPath, "agents: []\n");
      const env: NodeJS.ProcessEnv = {
        NEMOCLAW_EXTRA_AGENTS_JSON: "previous-agents",
        NEMOCLAW_OLLAMA_NO_AUTOSTART: "previous-autostart",
        NEMOCLAW_SERVING_PRESET: COMPATIBLE_NANO_PROFILE.id,
        NEMOCLAW_TOOL_DISCLOSURE: "previous-disclosure",
        ...(previousProvider === undefined ? {} : { NEMOCLAW_PROVIDER: previousProvider }),
      };
      let environmentAtExit: NodeJS.ProcessEnv | null = null;
      const runOnboard = vi.fn(async () => {
        throw invalidGatewayManagementDeclarationError("unsupported contract");
      });

      try {
        await expect(
          runOnboardCommand({
            flags: {
              agents: manifestPath,
              "no-ollama-autostart": true,
              profile: COMPATIBLE_NANO_PROFILE.id,
              "tool-disclosure": "direct",
            },
            env,
            listServingProfiles: () => [COMPATIBLE_NANO_PROFILE],
            runOnboard,
            error: () => {},
            exit: (code): never => {
              environmentAtExit = { ...env };
              throw new Error(`exit:${code}`);
            },
          }),
        ).rejects.toThrow("exit:1");
        expect(runOnboard).toHaveBeenCalledOnce();
        expect(environmentAtExit).toEqual({
          NEMOCLAW_EXTRA_AGENTS_JSON: "previous-agents",
          NEMOCLAW_OLLAMA_NO_AUTOSTART: "previous-autostart",
          NEMOCLAW_SERVING_PRESET: COMPATIBLE_NANO_PROFILE.id,
          NEMOCLAW_TOOL_DISCLOSURE: "previous-disclosure",
          ...(previousProvider === undefined ? {} : { NEMOCLAW_PROVIDER: previousProvider }),
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it("scopes the selected catalog preset to one onboarding run (#8384)", async () => {
    const env: NodeJS.ProcessEnv = {};
    let observed: string | undefined;
    await runOnboardCommand({
      flags: { profile: COMPATIBLE_NANO_PROFILE.id },
      env,
      listServingProfiles: () => [COMPATIBLE_NANO_PROFILE],
      runOnboard: async (options) => {
        observed = env.NEMOCLAW_SERVING_PRESET;
        expect(options.servingProfile).toBe(COMPATIBLE_NANO_PROFILE.id);
      },
    });

    expect(observed).toBe(COMPATIBLE_NANO_PROFILE.id);
    expect(env.NEMOCLAW_SERVING_PRESET).toBeUndefined();
  });

  it("selects the profile's inference provider so onboarding skips the menu (#9313)", async () => {
    // The preset alone only picks the model once a provider is chosen. Without
    // a provider the run fell through to the interactive provider menu with the
    // requested profile never applied.
    const vllmProfile = {
      ...COMPATIBLE_NANO_PROFILE,
      id: "vllm.dgx-spark-gb10.single.muse-glimmer-30b-nvfp4-w4a4",
      displayName: "Muse Glimmer 30B NVFP4 W4A4 on one DGX Spark",
      backend: "vllm",
    };
    const env: NodeJS.ProcessEnv = {};
    let observedProvider: string | undefined;
    let observedPreset: string | undefined;
    await runOnboardCommand({
      flags: { profile: vllmProfile.id },
      env,
      listServingProfiles: () => [vllmProfile],
      runOnboard: async () => {
        observedProvider = env.NEMOCLAW_PROVIDER;
        observedPreset = env.NEMOCLAW_SERVING_PRESET;
      },
    });

    expect(observedProvider).toBe("install-vllm");
    expect(observedPreset).toBe(vllmProfile.id);
    // Scoped to the run, like the preset itself.
    expect(env.NEMOCLAW_PROVIDER).toBeUndefined();
    expect(env.NEMOCLAW_SERVING_PRESET).toBeUndefined();
  });

  it("rejects native Podman --profile before onboarding while managed vLLM requires Docker (#10891)", () => {
    const catalog = loadServingCatalog();
    const profileId = "vllm.dgx-spark-gb10.single.qwen3-6-35b-a3b-nvfp4";
    const dockerUnavailableReport = {
      schemaVersion: "1.1.0",
      mutated: false,
      provenance: {
        nemoclawVersion: "0.1.0",
        sourceRevision: "a".repeat(40),
        observedAt: new Date().toISOString(),
      },
      observations: [],
      capabilities: [{ id: "host.docker.available", state: "unknown" }],
      qualifications: [],
      findings: [
        {
          id: "host.docker.unavailable",
          severity: "blocking",
          summary: "Docker is unavailable.",
          capabilityIds: ["host.docker.available"],
        },
      ],
      evidence: [],
      status: "incompatible",
      exitCode: 2,
    } satisfies SystemReadinessReport;
    const profiles = listServingProfiles(catalog, {
      readinessReports: [{ nodeId: "podman-host", report: dockerUnavailableReport }],
    });
    const errors: string[] = [];

    expect(() =>
      resolve(
        { profile: profileId },
        {
          env: { NEMOCLAW_GATEWAY_RUNTIME: "podman" },
          listServingProfiles: () => profiles,
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors).toEqual([
      `  Serving profile '${profileId}' is incompatible: podman-host: readiness status is incompatible.`,
    ]);
  });

  it("selects the managed llama.cpp provider for a llama-cpp profile (#9313)", async () => {
    const env: NodeJS.ProcessEnv = {};
    let observedProvider: string | undefined;
    await runOnboardCommand({
      flags: { profile: COMPATIBLE_NANO_PROFILE.id },
      env,
      listServingProfiles: () => [COMPATIBLE_NANO_PROFILE],
      runOnboard: async () => {
        observedProvider = env.NEMOCLAW_PROVIDER;
      },
    });

    expect(observedProvider).toBe("install-llama-cpp");
    expect(env.NEMOCLAW_PROVIDER).toBeUndefined();
  });

  it("rejects an unmapped backend on the resume path too (#9313)", () => {
    // Explicit --profile, the installer path, and resume all converge on the
    // same environment application, so the check lives at the end of the
    // lifecycle rather than on the explicit path alone. Resume replays a
    // recorded profile: a backend with no provider must be reported instead of
    // resuming into the provider menu.
    const catalog = loadServingCatalog();
    // Retarget preset and recipe together; provenance requires them to agree.
    const patchedCatalog = {
      ...catalog,
      presets: catalog.presets.map((preset) => ({
        ...preset,
        spec: { ...preset.spec, plan: { ...preset.spec.plan, backend: "future-backend" } },
      })),
      recipes: catalog.recipes.map((recipe) => ({
        ...recipe,
        spec: { ...recipe.spec, backend: "future-backend" },
      })),
    };
    const recorded = servingProfileProvenance(
      patchedCatalog as never,
      catalog.presets[0]!.metadata.id,
    );
    const errors: string[] = [];

    expect(() =>
      resolve(
        { resume: true },
        {
          loadServingCatalog: () => patchedCatalog as never,
          loadSession: () => ({ servingProfileProvenance: recorded }) as never,
          error: (message = "") => errors.push(message),
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("which onboarding cannot configure");
  });

  it("maps each serving backend to the provider that can run it (#9313)", () => {
    // A backend with no provider returns null, which `resolveServingProfile`
    // reports instead of accepting the flag and then asking for a provider.
    const withBackend = (backend: string) => ({ recipe: { backend } }) as never;

    // Uses the provider menu's exported key so the two cannot drift.
    expect(servingProfileProviderKey(withBackend("vllm"))).toBe(MANAGED_VLLM_PROVIDER_KEY);
    expect(servingProfileProviderKey(withBackend("install-llama-cpp"))).toBe("install-llama-cpp");
    expect(servingProfileProviderKey(withBackend("future-backend"))).toBeNull();
  });

  it("records an installer profile without activating the disabled generic preset", async () => {
    const env: NodeJS.ProcessEnv = {
      [LOCAL_MODEL_PROFILE_ENABLED_ENV]: "1",
      [LOCAL_MODEL_PROFILE_RUNTIME_ENV]: "vllm",
    };
    await runOnboardCommand({
      flags: {},
      env,
      runOnboard: async (options) => {
        expect(options.servingProfile).toBeNull();
        expect(options.servingProfileProvenance?.preset.id).toBe(
          "local-model-profile.vllm.spark.v1",
        );
        expect(env.NEMOCLAW_SERVING_PRESET).toBeUndefined();
      },
    });

    expect(env.NEMOCLAW_SERVING_PRESET).toBeUndefined();
  });

  it("preserves an explicit preset list during portable onboarding (#8991)", async () => {
    const explicitPresets = "weather,public-reference,github";
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_EXPERIMENTAL_PROFILE: "previous-profile",
      NEMOCLAW_PROVIDER: "previous-provider",
      NEMOCLAW_MODEL: "previous-model",
      NEMOCLAW_OLLAMA_NO_AUTOSTART: "0",
      NEMOCLAW_POLICY_MODE: "previous-mode",
      NEMOCLAW_POLICY_PRESETS: explicitPresets,
      NEMOCLAW_POLICY_TIER: "previous-tier",
      NEMOCLAW_TOOL_DISCLOSURE: "progressive",
    };
    const observed: Record<string, string | undefined> = {};
    await runOnboardCommand({
      flags: { "experimental-profile": "portable" },
      env,
      loadPortableInferenceDescriptor: async () => null,
      runOnboard: async () => {
        Object.assign(observed, env);
      },
    });

    expect(observed).toEqual({
      NEMOCLAW_EXPERIMENTAL_PROFILE: "previous-profile",
      NEMOCLAW_PROVIDER: "previous-provider",
      NEMOCLAW_MODEL: "previous-model",
      NEMOCLAW_OLLAMA_NO_AUTOSTART: "0",
      NEMOCLAW_POLICY_MODE: "previous-mode",
      NEMOCLAW_POLICY_PRESETS: explicitPresets,
      NEMOCLAW_POLICY_TIER: "previous-tier",
      NEMOCLAW_TOOL_DISCLOSURE: "progressive",
    });
    expect(env).toMatchObject({
      NEMOCLAW_EXPERIMENTAL_PROFILE: "previous-profile",
      NEMOCLAW_PROVIDER: "previous-provider",
      NEMOCLAW_MODEL: "previous-model",
      NEMOCLAW_OLLAMA_NO_AUTOSTART: "0",
      NEMOCLAW_POLICY_MODE: "previous-mode",
      NEMOCLAW_POLICY_PRESETS: explicitPresets,
      NEMOCLAW_POLICY_TIER: "previous-tier",
      NEMOCLAW_TOOL_DISCLOSURE: "progressive",
    });
  });

  it("defers the portable policy default to the scoped onboarding environment (#8991)", async () => {
    const env: NodeJS.ProcessEnv = {};
    let observedPresets: string | undefined;

    await runOnboardCommand({
      flags: { "experimental-profile": "portable" },
      env,
      loadPortableInferenceDescriptor: async () => null,
      runOnboard: async () => {
        observedPresets = env.NEMOCLAW_POLICY_PRESETS;
      },
    });

    expect(observedPresets).toBeUndefined();
    expect(env.NEMOCLAW_POLICY_PRESETS).toBeUndefined();
  });

  it("does not change an explicit preset list outside portable onboarding (#8991)", async () => {
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_POLICY_PRESETS: "weather,public-reference,github",
    };
    let observedPresets: string | undefined;

    await runOnboardCommand({
      flags: {},
      env,
      runOnboard: async () => {
        observedPresets = env.NEMOCLAW_POLICY_PRESETS;
      },
    });

    expect(observedPresets).toBe("weather,public-reference,github");
    expect(env.NEMOCLAW_POLICY_PRESETS).toBe("weather,public-reference,github");
  });

  it("configures portable onboarding from an admitted descriptor without exporting its credential", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", undefined);
    const env: NodeJS.ProcessEnv = {};
    const runOnboard = vi.fn(async (options) => {
      expect(options.portableInferenceActivation).toEqual({
        schemaVersion: 1,
        baseUrl: "https://inference.example.test/v1",
        model: "vendor/model-1",
        expiresAt: "2026-08-10T18:05:00Z",
      });
      expect(env.NEMOCLAW_PROVIDER).toBeUndefined();
      expect(env.NEMOCLAW_MODEL).toBeUndefined();
      expect(env.NEMOCLAW_ENDPOINT_URL).toBeUndefined();
      expect(env.NEMOCLAW_PREFERRED_API).toBeUndefined();
      expect(env.COMPATIBLE_API_KEY).toBeUndefined();
      expect(process.env.COMPATIBLE_API_KEY).toBeUndefined();
      expect(getCredential("COMPATIBLE_API_KEY")).toBe("runtime-only-secret");
    });

    await runOnboardCommand({
      flags: { "experimental-profile": "portable" },
      env,
      loadPortableInferenceDescriptor: async () => ({
        schemaVersion: 1,
        apiKey: "runtime-only-secret",
        baseUrl: "https://inference.example.test/v1",
        model: "vendor/model-1",
        expiresAt: "2026-08-10T18:05:00Z",
      }),
      runOnboard,
    });

    expect(runOnboard).toHaveBeenCalledOnce();
    expect(env.NEMOCLAW_PROVIDER).toBeUndefined();
    expect(env.NEMOCLAW_ENDPOINT_URL).toBeUndefined();
    expect(getCredential("COMPATIBLE_API_KEY")).toBeNull();
  });

  it("fails before onboarding when a present portable descriptor is invalid", async () => {
    const env: NodeJS.ProcessEnv = {};
    const errors: string[] = [];
    const runOnboard = vi.fn(async () => {});

    await expect(
      runOnboardCommand({
        flags: { "experimental-profile": "portable" },
        env,
        loadPortableInferenceDescriptor: async () => {
          throw new PortableInferenceDescriptorError("Runtime inference descriptor has expired.");
        },
        runOnboard,
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(runOnboard).not.toHaveBeenCalled();
    expect(env).toEqual({});
    expect(errors).toEqual(["  Runtime inference descriptor has expired."]);
  });

  it("scopes an agents manifest to one onboarding run", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agents-manifest-"));
    const manifestPath = path.join(tmpDir, "agents.yaml");
    fs.writeFileSync(manifestPath, "agents: []\n");
    const env: NodeJS.ProcessEnv = { NEMOCLAW_EXTRA_AGENTS_JSON: "previous-manifest" };
    let observed: string | undefined;

    try {
      await runOnboardCommand({
        flags: { agents: manifestPath },
        env,
        runOnboard: async () => {
          observed = env.NEMOCLAW_EXTRA_AGENTS_JSON;
        },
      });
      expect(observed).toBe('{"agents":[]}');
      expect(env.NEMOCLAW_EXTRA_AGENTS_JSON).toBe("previous-manifest");

      const initiallyUnsetEnv: NodeJS.ProcessEnv = {};
      await runOnboardCommand({
        flags: { agents: manifestPath },
        env: initiallyUnsetEnv,
        runOnboard: async () => {},
      });
      expect(initiallyUnsetEnv.NEMOCLAW_EXTRA_AGENTS_JSON).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "portable profile",
      flags: { "experimental-profile": "portable" } as OnboardFlags,
      listServingProfiles: undefined,
      keys: [
        "NEMOCLAW_EXPERIMENTAL_PROFILE",
        "NEMOCLAW_PROVIDER",
        "NEMOCLAW_MODEL",
        "NEMOCLAW_OLLAMA_NO_AUTOSTART",
        "NEMOCLAW_POLICY_PRESETS",
      ],
    },
    {
      name: "serving profile",
      flags: { profile: COMPATIBLE_NANO_PROFILE.id } as OnboardFlags,
      listServingProfiles: () => [COMPATIBLE_NANO_PROFILE],
      keys: ["NEMOCLAW_PROVIDER", "NEMOCLAW_SERVING_PRESET"],
    },
  ])("restores the $name environment when an agents manifest is invalid", async (testCase) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-invalid-agents-manifest-"));
    const manifestPath = path.join(tmpDir, "agents.yaml");
    fs.writeFileSync(manifestPath, "agents: [\n");
    const env: NodeJS.ProcessEnv = {};

    try {
      await expect(
        runOnboardCommand({
          flags: { ...testCase.flags, agents: manifestPath },
          env,
          listServingProfiles: testCase.listServingProfiles,
          runOnboard: vi.fn(),
        }),
      ).rejects.toThrow("--agents YAML parse error");
      expect(testCase.keys.every((key) => env[key] === undefined)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("treats a prompt EOF during onboarding as cancellation and exits non-zero (#5976)", async () => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw Object.assign(new Error("Prompt closed before input"), { code: "EOF" });
        },
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");
    expect(errors.join("\n")).toContain("Installation cancelled");
  });

  it("prints a clean CLI error for an invalid gateway management contract (#7627)", async () => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw invalidGatewayManagementDeclarationError(
            "unsupported gateway-management contract version; this NemoClaw build supports version 1",
          );
        },
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");
    const output = errors.join("\n");
    expect(output).toContain("Invalid gateway management declaration");
    expect(output).toContain("unsupported gateway-management contract version");
    // No stack frames leaked into the user-facing output.
    expect(output).not.toContain(".js:");
    expect(output).not.toContain("    at ");
  });

  it("redacts credentials in a gateway declaration diagnostic (#9035)", async () => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw invalidGatewayManagementDeclarationError(
            "invalid metadata NVIDIA_API_KEY=nvapi-secret-value",
          );
        },
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain("Invalid gateway management declaration");
    expect(errors.join("\n")).toContain("NVIDIA_API_KEY=<REDACTED>");
    expect(errors.join("\n")).not.toContain("nvapi-secret-value");
  });

  it.each(RECREATE_SELECTIONS)(
    "reports a gateway authority refusal when recreation is selected by %s (#8103)",
    async (_selection, flags, env) => {
      const errors: string[] = [];
      await expect(
        runOnboardCommand({
          flags,
          env,
          runOnboard: async () => {
            throw new GatewayAuthorityError(
              "Gateway lifecycle authority changed since onboarding (packaged-service -> standalone).",
            );
          },
          error: (message = "") => errors.push(message),
          exit: exitWithCode,
        }),
      ).rejects.toThrow("exit:1");

      const output = errors.join("\n");
      expect(output).toContain(
        "Refusing sandbox recreate because the gateway lifecycle authority could not be revalidated.",
      );
      expect(output).toContain("packaged-service -> standalone");
      expect(output).toContain("Re-run onboarding to bind the current gateway authority");
      expect(output).not.toContain(".js:");
      expect(output).not.toContain("    at ");
    },
  );

  it("redacts credentials while preserving gateway authority context (#9035)", async () => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: { "recreate-sandbox": true },
        env: {},
        runOnboard: async () => {
          throw new GatewayAuthorityError(
            "Gateway lifecycle authority changed; OPENAI_API_KEY=secret-authority-value.",
          );
        },
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    const output = errors.join("\n");
    expect(output).toContain("gateway lifecycle authority could not be revalidated");
    expect(output).toContain("OPENAI_API_KEY=<REDACTED>");
    expect(output).not.toContain("secret-authority-value");
  });

  it("escapes terminal controls in gateway declaration errors before printing (#7627)", async () => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw invalidGatewayManagementDeclarationError(
            "unknown declaration field(s): forged\n\u001b[31mError: \u202efake failure",
          );
        },
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors).toEqual([
      "  Invalid gateway management declaration: unknown declaration field(s): forged\\u000a\\u001b[31mError: \\u202efake failure",
    ]);
    expect(errors[0]?.split(/\r?\n/u)).toHaveLength(1);
    expect(errors[0]).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
  });

  it("re-throws a non-cancellation, non-gateway error so genuine bugs still surface (#7627)", async () => {
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw new Error("unexpected boom");
        },
        error: () => {},
        exit: exitWithCode,
      }),
    ).rejects.toThrow("unexpected boom");
  });

  it("returns without rethrowing when a prompt rejects with SIGINT (#7439)", async () => {
    const exit = vi.fn<(code: number) => never>();
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" });
        },
        error: () => {},
        exit,
      }),
    ).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("rethrows non-cancellation onboarding failures unchanged (#5976)", async () => {
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw new Error("docker is not reachable");
        },
        error: () => {},
        exit: exitWithCode,
      }),
    ).rejects.toThrow("docker is not reachable");
  });

  it("sets the Ollama autostart override before onboarding", async () => {
    const env: NodeJS.ProcessEnv = {};
    let observed: string | undefined;
    await runOnboardCommand({
      flags: { "no-ollama-autostart": true },
      env,
      runOnboard: async () => {
        observed = env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
      },
    });
    expect(observed).toBe("1");
  });
});
