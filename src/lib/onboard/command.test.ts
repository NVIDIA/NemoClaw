// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getCredential } from "../credentials/store";
import { loadServingCatalog } from "../inference/serving/catalog-loader";
import { servingProfileProvenance } from "../inference/serving/profile-provenance";
import { resolveOnboardOptions, runOnboardCommand } from "./command";
import type { OnboardFlags } from "./command-support";
import { PortableInferenceDescriptorError } from "./experimental/portable-inference-descriptor";
import { invalidGatewayManagementDeclarationError } from "./gateway-management";
import { GatewayAuthorityError } from "./gateway-teardown-authority";
import {
  LOCAL_MODEL_PROFILE_ENABLED_ENV,
  LOCAL_MODEL_PROFILE_RUNTIME_ENV,
} from "./local-model-profile/plan";

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
          agent: "dcode",
          "tool-disclosure": "direct",
          observability: true,
          "control-ui-port": 18790,
          gpu: true,
          yes: true,
          "no-ollama-autostart": true,
          "yes-i-accept-third-party-software": true,
        },
        { listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"] },
      ),
    ).toEqual({
      tempManagedRuntime: true,
      tempManagedRuntimeCatalog: managedCatalogPath,
      nonInteractive: true,
      resume: true,
      fresh: false,
      recreateSandbox: true,
      fromDockerfile: dockerfilePath,
      sandboxName: "second-assistant",
      sandboxGpu: "enable",
      sandboxGpuDevice: "nvidia.com/gpu=0",
      acceptThirdPartySoftware: true,
      agent: "langchain-deepagents-code",
      agentsManifest: null,
      toolDisclosure: "direct",
      observabilityEnabled: true,
      controlUiPort: 18790,
      gpu: true,
      noGpu: false,
      autoYes: true,
      noOllamaAutostart: true,
      experimentalProfile: null,
      portableInferenceActivation: null,
      servingProfile: null,
      servingProfileProvenance: null,
    });
  });

  it("uses explicit false/null defaults when flags are absent", () => {
    expect(resolve({})).toEqual({
      tempManagedRuntime: false,
      tempManagedRuntimeCatalog: null,
      nonInteractive: false,
      resume: false,
      fresh: false,
      recreateSandbox: false,
      fromDockerfile: null,
      sandboxName: null,
      sandboxGpu: null,
      sandboxGpuDevice: null,
      acceptThirdPartySoftware: false,
      agent: null,
      agentsManifest: null,
      toolDisclosure: null,
      observabilityEnabled: null,
      controlUiPort: null,
      gpu: false,
      noGpu: false,
      autoYes: false,
      noOllamaAutostart: false,
      experimentalProfile: null,
      portableInferenceActivation: null,
      servingProfile: null,
      servingProfileProvenance: null,
    });
  });

  it("maps repeated Linux host mounts and rejects unsupported host platforms", () => {
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
      expect(() => resolve({ "host-mount": values }, { platform: "darwin" })).toThrow("exit:1");
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it("rejects host mounts for the portable Podman profile before path or runtime effects", () => {
    const errors: string[] = [];

    expect(() =>
      resolve(
        {
          "experimental-profile": "portable",
          "host-mount": ["/path/that/need/not/exist:/sandbox/project"],
        },
        { platform: "linux", error: (message = "") => errors.push(message) },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("requires the OpenShell Docker driver");
  });

  it("resolves the portable profile to deterministic unattended defaults", () => {
    expect(resolve({ "experimental-profile": "portable" })).toMatchObject({
      experimentalProfile: "portable",
      nonInteractive: true,
      fresh: true,
      autoYes: true,
      noOllamaAutostart: true,
      noGpu: false,
      sandboxGpu: null,
    });
  });

  it("rejects resume when the portable profile requires a deterministic fresh install", () => {
    const errors: string[] = [];
    expect(() =>
      resolve(
        { "experimental-profile": "portable", resume: true },
        { error: (message = "") => errors.push(message) },
      ),
    ).toThrow("exit:1");
    expect(errors).toContain("  --resume cannot be combined with --experimental-profile portable.");
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

  it("selects only the broad Personal preset for local portable onboarding (#8991)", async () => {
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_EXPERIMENTAL_PROFILE: "previous-profile",
      NEMOCLAW_PROVIDER: "previous-provider",
      NEMOCLAW_MODEL: "previous-model",
      NEMOCLAW_OLLAMA_NO_AUTOSTART: "0",
      NEMOCLAW_POLICY_MODE: "previous-mode",
      NEMOCLAW_POLICY_PRESETS: "previous-presets",
      NEMOCLAW_POLICY_TIER: "previous-tier",
      NEMOCLAW_TOOL_DISCLOSURE: "progressive",
    };
    const observed: Record<string, string | undefined> = {};
    await runOnboardCommand({
      flags: { "experimental-profile": "portable" },
      env,
      loadPortableInferenceDescriptor: async () => null,
      runOnboard: async () => {
        for (const key of [
          "NEMOCLAW_EXPERIMENTAL_PROFILE",
          "NEMOCLAW_PROVIDER",
          "NEMOCLAW_MODEL",
          "NEMOCLAW_OLLAMA_NO_AUTOSTART",
          "NEMOCLAW_POLICY_MODE",
          "NEMOCLAW_POLICY_PRESETS",
          "NEMOCLAW_POLICY_TIER",
          "NEMOCLAW_TOOL_DISCLOSURE",
        ]) {
          observed[key] = env[key];
        }
      },
    });

    expect(observed).toEqual({
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
      NEMOCLAW_PROVIDER: "ollama",
      NEMOCLAW_MODEL: "qwen3-vl:4b",
      NEMOCLAW_OLLAMA_NO_AUTOSTART: "1",
      NEMOCLAW_POLICY_MODE: "custom",
      NEMOCLAW_POLICY_PRESETS: "personal-open-internet",
      NEMOCLAW_POLICY_TIER: "personal",
      NEMOCLAW_TOOL_DISCLOSURE: "direct",
    });
    expect(env).toMatchObject({
      NEMOCLAW_EXPERIMENTAL_PROFILE: "previous-profile",
      NEMOCLAW_PROVIDER: "previous-provider",
      NEMOCLAW_MODEL: "previous-model",
      NEMOCLAW_OLLAMA_NO_AUTOSTART: "0",
      NEMOCLAW_POLICY_MODE: "previous-mode",
      NEMOCLAW_POLICY_PRESETS: "previous-presets",
      NEMOCLAW_POLICY_TIER: "previous-tier",
      NEMOCLAW_TOOL_DISCLOSURE: "progressive",
    });
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
      expect(env).toMatchObject({
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_MODEL: "vendor/model-1",
        NEMOCLAW_ENDPOINT_URL: "https://inference.example.test/v1",
        NEMOCLAW_PREFERRED_API: "openai-completions",
      });
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
      ],
    },
    {
      name: "serving profile",
      flags: { profile: COMPATIBLE_NANO_PROFILE.id } as OnboardFlags,
      listServingProfiles: () => [COMPATIBLE_NANO_PROFILE],
      keys: ["NEMOCLAW_SERVING_PRESET"],
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
      for (const key of testCase.keys) expect(env[key]).toBeUndefined();
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

  it.each(
    RECREATE_SELECTIONS,
  )("reports a gateway authority refusal when recreation is selected by %s (#8103)", async (_selection, flags, env) => {
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
