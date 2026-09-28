// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { createManagedWorkloadOnboardRuntime } from "../../src/lib/onboard/managed-workload/onboard-orchestration";
import {
  getSandboxInferenceConfig,
  resolveAgentInferenceApi,
} from "../../src/lib/inference/config";
import { patchStagedDockerfile } from "../../src/lib/onboard/dockerfile-patch";
import { buildManagedStartupProfile } from "../../src/lib/onboard/managed-startup/profile-builder";
import { mapManagedStartupProfileToAgentEnvironment } from "../../src/lib/onboard/managed-startup/agent-environment";
import {
  decodeManagedStartupProfile,
  validateManagedStartupProfile,
} from "../../src/lib/onboard/managed-startup/profile";
import {
  patchHermesInferenceConfig,
  patchOpenClawInferenceConfig,
  runInferenceSet,
} from "../../src/lib/actions/inference-set";
import {
  createDeps,
  OPENCLAW_TARGET,
  HERMES_TARGET,
} from "../../src/lib/actions/inference-set.test-support";
import { PROVIDERLESS_INFERENCE_ENV } from "../../src/lib/providerless-inference";

const root = path.resolve(import.meta.dirname, "../..");
const temporary: string[] = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "providerless-config-"));
  temporary.push(dir);
  return dir;
}
afterEach(() =>
  temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);

type Agent = "openclaw" | "hermes";
function dockerEnvironment(agent: Agent, model = "", provider = "") {
  const recipe = path.join(temp(), "Dockerfile");
  fs.copyFileSync(
    path.join(root, agent === "openclaw" ? "Dockerfile" : "agents/hermes/Dockerfile"),
    recipe,
  );
  patchStagedDockerfile(
    recipe,
    model,
    "http://127.0.0.1:18789",
    "providerless-regression",
    provider || null,
    null,
    null,
    null,
    false,
    null,
    [],
    { agentName: agent },
  );
  // Feed the patched recipe to the real generator, including its default build arguments.
  return Object.fromEntries(
    [
      ...fs.readFileSync(recipe, "utf8").matchAll(/^ARG (NEMOCLAW_[A-Z_]+|CHAT_UI_URL)=(.*)$/gm),
    ].map((match) => [match[1], match[2]]),
  );
}
function profile(agent: Agent) {
  return buildManagedStartupProfile({
    agent,
    inference: null,
    dashboard:
      agent === "openclaw"
        ? {
            agent,
            mode: "loopback",
            url: "http://127.0.0.1:18789",
            port: 18789,
            bindAddress: "127.0.0.1",
            wslExposure: false,
          }
        : {
            agent,
            mode: "disabled",
            url: "http://127.0.0.1:18789",
            browserUrl: "http://127.0.0.1:18789",
            publicPort: null,
            internalPort: null,
            tuiEnabled: false,
          },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment: {},
  });
}
function generate(agent: Agent, environment: NodeJS.ProcessEnv) {
  const home = temp();
  fs.mkdirSync(path.join(home, ".hermes"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(
        root,
        agent === "openclaw"
          ? "scripts/generate-openclaw-config.mts"
          : "agents/hermes/generate-config.ts",
      ),
    ],
    {
      env: { PATH: process.env.PATH, ...environment, HOME: home },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  const configPath = path.join(
    home,
    agent === "openclaw" ? ".openclaw/openclaw.json" : ".hermes/config.yaml",
  );
  return { result, home, configPath, read: () => YAML.parse(fs.readFileSync(configPath, "utf8")) };
}
const expectAbsent: Record<Agent, (config: any) => void> = {
  openclaw(config) {
    expect(config.models).toBeUndefined();
    expect(config.agents.defaults.model).toBeUndefined();
    expect(config.plugins.allow).toBeUndefined();
  },
  hermes(config) {
    for (const key of ["model", "providers", "custom_providers", "_nemoclaw_upstream"])
      expect(config[key]).toBeUndefined();
    expect(config.approvals.mode).toBe("manual");
    expect(config.platforms.api_server.enabled).toBe(true);
  },
};
const expectConfigured: Record<Agent, (config: any) => void> = {
  openclaw(config) {
    expect(config.agents.defaults.model.primary).toBe("inference/fixture/model");
    expect(config.models.providers.inference.models[0].id).toBe("fixture/model");
  },
  hermes(config) {
    expect(config.model.default).toBe("fixture/model");
    expect(config.model.provider).toBe("custom");
    expect(config.model.api_key).toBe("sk-OPENSHELL-PROXY-REWRITE");
  },
};

describe.each<Agent>(["openclaw", "hermes"])("providerless %s configuration", (agent) => {
  it("generates configuration from the actual Dockerfile without a selected model", () => {
    const generated = generate(agent, dockerEnvironment(agent));
    expect(generated.result.status, generated.result.stderr).toBe(0);
    expectAbsent[agent](generated.read());
    expect(fs.statSync(generated.configPath).mode & 0o777).toBe(0o600);
  });
  it("maps absent managed inference to the real configuration generator", () => {
    const built = profile(agent);
    const decoded = decodeManagedStartupProfile(built.encodedProfile);
    expect(decoded.inference).toBeNull();
    const mapped = mapManagedStartupProfileToAgentEnvironment(decoded);
    const generated = generate(agent, mapped.configurationEnvironment);
    expect(generated.result.status, generated.result.stderr).toBe(0);
    expectAbsent[agent](generated.read());
  });
  it("preserves absent inference through managed workload preparation", () => {
    const runtime = createManagedWorkloadOnboardRuntime(
      {
        computePlan: { driverName: "docker", gatewayLauncher: "nemoclaw" },
        managedWorkloadRebuild: null,
        tempManagedRuntime: false,
        stockManagedRuntime: true,
        tempManagedRuntimeCatalog: null,
        agentName: agent,
        legacyDockerfilePath: agent === "hermes" ? "agents/hermes/Dockerfile" : "Dockerfile",
        customDockerfilePath: null,
        rootDir: root,
        model: "",
        provider: "",
        preferredInferenceApi: null,
        endpointUrl: null,
        startupProfile: {
          chatUiUrl: "http://127.0.0.1:18789",
          effectiveDashboardPort: 18789,
          manageDashboard: true,
          dashboardBindAddress: undefined,
          wslExposure: false,
          hermesDashboardState: { config: null, enabled: false },
          webSearch: null,
          toolDisclosure: "progressive",
          hermesToolGateways: [],
          messagingPlan: null,
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
          environment: {},
        },
        note: () => {},
        fallbackBuildEstimate: () => null,
      },
      { getSandboxInferenceConfig, resolveAgentInferenceApi },
    );
    const prepared = runtime.ensurePreparedProfile({ source: { kind: "managed-image" } } as never);
    expect(prepared?.profile.inference).toBeNull();
    const generated = generate(
      agent,
      mapManagedStartupProfileToAgentEnvironment(prepared!.profile).configurationEnvironment,
    );
    expect(generated.result.status, generated.result.stderr).toBe(0);
    expectAbsent[agent](generated.read());
  });
  it("preserves ordinary provider-backed Dockerfile generation", () => {
    const environment = dockerEnvironment(agent, "fixture/model", "nvidia-prod");
    expect(environment.NEMOCLAW_UPSTREAM_PROVIDER).toBe("nvidia-prod");
    const generated = generate(agent, environment);
    expect(generated.result.status, generated.result.stderr).toBe(0);
    expectConfigured[agent](generated.read());
  });
  it("supplies a model later through the existing managed inference configuration updater", () => {
    const generated = generate(agent, dockerEnvironment(agent));
    expect(generated.result.status, generated.result.stderr).toBe(0);
    const config = generated.read();
    const patch = agent === "openclaw" ? patchOpenClawInferenceConfig : patchHermesInferenceConfig;
    expect(
      patch(config, "nvidia-prod", "fixture/model", "openai-completions", 131072).changed,
    ).toBe(true);
    expectConfigured[agent](config);
    expect(
      patch(config, "nvidia-prod", "fixture/model", "openai-completions", 131072).changed,
    ).toBe(false);
  });
  it("commits later inference through the managed command without creating a provider", async () => {
    const generated = generate(agent, dockerEnvironment(agent));
    expect(generated.result.status, generated.result.stderr).toBe(0);
    const config = generated.read();
    const deps = createDeps({
      config,
      entry: { name: "alpha", agent, provider: null, model: null },
      target: agent === "hermes" ? HERMES_TARGET : OPENCLAW_TARGET,
      contextWindow: 131072,
    });
    const result = await runInferenceSet(
      { sandboxName: "alpha", provider: "nvidia-prod", model: "fixture/model" },
      deps,
    );
    expect(result.inSandboxConfigSynced).toBe(true);
    expectConfigured[agent](config);
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalled();
    expect(deps.calls.recomputeSandboxConfigHash).toHaveBeenCalled();
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => args[0] === "provider" && ["create", "update"].includes(args[1]),
      ),
    ).toBe(false);
  });
  it("leaves generated configuration absent when the later route update fails", async () => {
    const generated = generate(agent, dockerEnvironment(agent));
    expect(generated.result.status, generated.result.stderr).toBe(0);
    const config = generated.read();
    const deps = createDeps({
      config,
      entry: { name: "alpha", agent, provider: null, model: null },
      target: agent === "hermes" ? HERMES_TARGET : OPENCLAW_TARGET,
      openshellStatus: 1,
    });
    await expect(
      runInferenceSet(
        { sandboxName: "alpha", provider: "nvidia-prod", model: "fixture/model" },
        deps,
      ),
    ).rejects.toThrow();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expectAbsent[agent](config);
  });
  it.each([
    "NEMOCLAW_UPSTREAM_PROVIDER",
    "NEMOCLAW_INFERENCE_PROVIDER_ID",
    "NEMOCLAW_INFERENCE_BASE_URL",
    "NEMOCLAW_INFERENCE_API",
    "NEMOCLAW_PRIMARY_MODEL_REF",
    "NEMOCLAW_UPSTREAM_ENDPOINT_URL",
  ])("rejects an empty model with partial inference input in %s", (key) => {
    const generated = generate(agent, { ...PROVIDERLESS_INFERENCE_ENV, [key]: "selected" });
    expect(generated.result.status).not.toBe(0);
    expect(generated.result.stderr).toContain("NEMOCLAW_MODEL is required");
    expect(fs.existsSync(generated.configPath)).toBe(false);
  });
  it("rejects missing build inputs instead of assuming providerless onboarding", () => {
    const generated = generate(agent, {});
    expect(generated.result.status).not.toBe(0);
    expect(fs.existsSync(generated.configPath)).toBe(false);
  });
  it("retains configured-profile validation for an empty model", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...profile(agent).profile,
        inference: {
          routeProvider: "inference",
          upstreamProvider: "nvidia-prod",
          model: "",
          routedBaseUrl: "https://inference.local/v1",
          upstreamEndpointUrl: null,
          api: "openai-completions",
          primaryModelRef: agent === "openclaw" ? "inference/" : null,
          compatibility: agent === "openclaw" ? {} : null,
          inputModalities: agent === "openclaw" ? ["text"] : null,
        },
      }),
    ).toThrow("inference.model");
  });
});

function seedHermes(generated: ReturnType<typeof generate>, destination: string) {
  return spawnSync(
    "python3",
    [
      "-I",
      path.join(root, "agents/hermes/seed-dashboard-config.py"),
      path.join(generated.home, ".hermes/managed-policy.json"),
      generated.configPath,
      destination,
    ],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
}
const pythonYamlAvailable =
  spawnSync("python3", ["-I", "-c", "import yaml"], { stdio: "ignore" }).status === 0;
describe.skipIf(!pythonYamlAvailable)("providerless Hermes dashboard configuration", () => {
  it("seeds without inference and applies a later managed route", () => {
    const generated = generate("hermes", dockerEnvironment("hermes"));
    expect(generated.result.status, generated.result.stderr).toBe(0);
    const destination = path.join(generated.home, "dashboard.yaml");
    const absent = seedHermes(generated, destination);
    expect(absent.status, absent.stderr).toBe(0);
    const initial = YAML.parse(fs.readFileSync(destination, "utf8"));
    expect(initial.model).toBeUndefined();
    expect(initial.approvals.mode).toBe("manual");
    const config = generated.read();
    patchHermesInferenceConfig(
      config,
      "nvidia-prod",
      "fixture/model",
      "openai-completions",
      131072,
    );
    fs.writeFileSync(generated.configPath, YAML.stringify(config));
    const configured = seedHermes(generated, destination);
    expect(configured.status, configured.stderr).toBe(0);
    const dashboard = YAML.parse(fs.readFileSync(destination, "utf8"));
    expect(dashboard.model.default).toBe("fixture/model");
    expect(dashboard.model.api_key).toBe("sk-OPENSHELL-PROXY-REWRITE");
  });
  it.each([
    {
      name: "partial",
      corrupt(config: any) {
        config.model = { default: "fixture/model" };
      },
    },
    {
      name: "credential",
      corrupt(config: any) {
        patchHermesInferenceConfig(config, "nvidia-prod", "fixture/model");
        config.model.api_key = "forbidden-fixture-credential";
      },
    },
  ])("rejects $name routing without replacing dashboard state", ({ corrupt }) => {
    const generated = generate("hermes", dockerEnvironment("hermes"));
    expect(generated.result.status, generated.result.stderr).toBe(0);
    const destination = path.join(generated.home, "dashboard.yaml");
    expect(seedHermes(generated, destination).status).toBe(0);
    const before = fs.readFileSync(destination, "utf8");
    const config = generated.read();
    corrupt(config);
    fs.writeFileSync(generated.configPath, YAML.stringify(config));
    const result = seedHermes(generated, destination);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("forbidden-fixture-credential");
    expect(fs.readFileSync(destination, "utf8")).toBe(before);
  });
});
