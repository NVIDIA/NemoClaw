// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTED_NATIVE_PROVIDERS } from "../../../../src/lib/inference/native-provider/hosted.ts";
import {
  CANDIDATE_MANAGED_IMAGE_AGENTS,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../../../src/lib/onboard/managed-image/contract.ts";
import { validateCandidateContract } from "../../../../tools/managed-images/validate-candidate-contract.mts";
import {
  readWorkflow,
  required,
  step,
} from "../../../helpers/managed-image-publication-workflow.ts";

const root = path.resolve(import.meta.dirname, "../../../..");

const DIGEST = `sha256:${"a".repeat(64)}`;

function candidateContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    agent: "pi",
    platform: "linux/amd64",
    image: "ghcr.io/nvidia/nemoclaw/pi-sandbox",
    digest: DIGEST,
    reference: `ghcr.io/nvidia/nemoclaw/pi-sandbox@${DIGEST}`,
    source: {
      repository: "NVIDIA/NemoClaw",
      revision: "b".repeat(40),
      release: "v0.0.104",
      cohort: "ghrun-12345-1",
    },
    startupProfileContractVersion: 1,
    capabilityContractVersion: 1,
    ...overrides,
  };
}

describe("Pi release cohort separation", () => {
  it("keeps pi a candidate agent and out of the shipped cohort", () => {
    expect(CANDIDATE_MANAGED_IMAGE_AGENTS).toContain("pi");
    expect(SHIPPED_MANAGED_IMAGE_AGENTS).not.toContain("pi");
  });
});

describe("Pi candidate contract validation", () => {
  it.each([
    "Validate the Pi candidate runtime contract",
    "Validate the published Pi candidate digest",
  ])("%s requires the direct startup runtime", (stepName) => {
    const workflow = readWorkflow("managed-images.yaml");
    const piCandidate = required(
      workflow.jobs?.["pi-candidate"],
      "managed-image workflow is missing its Pi candidate job",
    );
    const validation = step(piCandidate, stepName).run ?? "";

    expect(validation).toContain("managed-startup-image-runtime.cjs");
    expect(validation).toContain("nemoclaw-managed-startup-hold");
    expect(validation).toContain("test ! -e /usr/local/bin/nemoclaw-managed-bootstrap");
    expect(validation).toContain(
      "test ! -e /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh",
    );
    expect(validation).not.toContain("test -x /usr/local/bin/nemoclaw-managed-bootstrap");
  });

  it("accepts an exact candidate contract", () => {
    const contract = validateCandidateContract(candidateContract(), "linux/amd64");
    expect(contract.agent).toBe("pi");
    expect(contract.platform).toBe("linux/amd64");
    expect(contract.source.repository).toBe("NVIDIA/NemoClaw");
    expect(contract.reference).toBe(`ghcr.io/nvidia/nemoclaw/pi-sandbox@${DIGEST}`);
  });

  it("validates a published candidate contract with plain Node", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-contract-"));
    try {
      const contractPath = path.join(directory, "contract.json");
      fs.writeFileSync(
        contractPath,
        JSON.stringify(candidateContract({ platform: "linux/arm64" })),
      );
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, "tools/managed-images/validate-candidate-contract.mts"),
          "--contract",
          contractPath,
          "--platform",
          "linux/arm64",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "" },
          timeout: 5_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Validated candidate contract for pi on linux/arm64");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a contract whose agent is not a candidate managed-image agent", () => {
    expect(() =>
      validateCandidateContract(
        candidateContract({
          agent: "hermes",
          image: "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
          reference: `ghcr.io/nvidia/nemoclaw/hermes-sandbox@${DIGEST}`,
        }),
        "linux/amd64",
      ),
    ).toThrow(/not a candidate managed-image agent/u);
  });

  it("rejects a candidate contract published for another platform", () => {
    expect(() => validateCandidateContract(candidateContract(), "linux/arm64")).toThrow(
      /contract.platform must be/u,
    );
  });
});

describe("Pi managed model catalog generation", () => {
  function generate(
    env: Record<string, string>,
    initialize: (home: string) => void = () => undefined,
  ): {
    home: string;
    status: number | null;
    stderr: string;
  } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-config-"));
    initialize(home);
    const result = spawnSync(process.execPath, [path.join(root, "agents/pi/generate-config.ts")], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
    });
    return { home, status: result.status, stderr: result.stderr };
  }

  function nativeCatalog() {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "selected-local-model",
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
      NEMOCLAW_LOCAL_INFERENCE_TOKEN: "raw-build-secret-must-not-be-serialized",
    });
    try {
      expect(status, stderr).toBe(0);
      const text = fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8");
      expect(text).not.toContain("raw-build-secret-must-not-be-serialized");
      return JSON.parse(text).providers.openshell as {
        apiKey: string;
        headers: { Authorization: string };
      };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  function resolveCommand(value: string, token: string) {
    expect(value.startsWith("!")).toBe(true);
    return spawnSync("/bin/sh", ["-c", value.slice(1)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NEMOCLAW_LOCAL_INFERENCE_TOKEN: token },
    });
  }

  it.each(["v2", `s${"a".repeat(64)}`])(
    "resolves a Pi native-local request with the issued %s credential",
    (identity) => {
      const provider = nativeCatalog();
      const token = `openshell:resolve:env:${identity}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
      expect(resolveCommand(provider.apiKey, token).stdout).toBe(token);
      // A stored Pi key can override apiKey; pin the actual request header.
      const header = resolveCommand(provider.headers.Authorization, token);
      expect(header.status, header.stderr).toBe(0);
      expect(header.stdout).toBe(`Bearer ${token}`);
    },
  );

  it.each([
    "",
    "raw-host-secret",
    "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    "openshell:resolve:env:v2_OTHER_TOKEN",
    "openshell:resolve:env:v2_NEMOCLAW_LOCAL_INFERENCE_TOKEN\n",
  ])("refuses invalid Pi native-local credential %j", (token) => {
    const provider = nativeCatalog();
    const key = resolveCommand(provider.apiKey, token);
    expect(key.status).not.toBe(0);
    expect(key.stdout).toBe("");
    expect(key.stderr).toBe("");
    const header = resolveCommand(provider.headers.Authorization, token);
    expect(header.status).not.toBe(0);
    expect(header.stdout).toBe("");
    expect(header.stderr).toBe("");
  });

  it.each(["http://host.openshell.internal:11434/v1", "https://inference.local/v1"])(
    "initializes managed defaults from empty Pi settings at %s",
    (endpoint) => {
      const { home, status, stderr } = generate(
        {
          NEMOCLAW_MODEL: "selected-model",
          NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
          NEMOCLAW_INFERENCE_BASE_URL: endpoint,
        },
        (home) => {
          const configDir = path.join(home, ".pi/agent");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "settings.json"), "");
        },
      );
      try {
        expect(status, stderr).toBe(0);
        const settingsPath = path.join(home, ".pi/agent/settings.json");
        expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
          defaultProvider: "openshell",
          defaultModel: "selected-model",
        });
        expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.each([" ", "{broken", "null", "[]", "42"])(
    "rejects invalid nonempty Pi settings %j without overwriting them",
    (settings) => {
      const { home, status } = generate(
        {
          NEMOCLAW_MODEL: "selected-model",
          NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
          NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
        },
        (home) => {
          const configDir = path.join(home, ".pi/agent");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "settings.json"), settings);
        },
      );
      try {
        expect(status).not.toBe(0);
        expect(fs.readFileSync(path.join(home, ".pi/agent/settings.json"), "utf8")).toBe(settings);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("updates Pi's managed defaults when the native-local model changes and preserves other settings", () => {
    const selected = {
      NEMOCLAW_MODEL: "selected-local-model",
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
    };
    const { home, status, stderr } = generate(selected);
    try {
      expect(status, stderr).toBe(0);
      const settingsPath = path.join(home, ".pi/agent/settings.json");
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
        defaultProvider: "openshell",
        defaultModel: "selected-local-model",
      });
      const userSettings =
        '{"defaultProvider":"other","defaultModel":"old-model","futurePiSetting":true}\n';
      fs.writeFileSync(settingsPath, userSettings);
      const rerun = spawnSync(process.execPath, [path.join(root, "agents/pi/generate-config.ts")], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          ...selected,
          NEMOCLAW_MODEL: "next-local-model",
        },
      });
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
        defaultProvider: "openshell",
        defaultModel: "next-local-model",
        futurePiSetting: true,
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(home, ".pi/agent/models.json"), "utf8")).defaultModel,
      ).toBe("next-local-model");
      const hosted = spawnSync(
        process.execPath,
        [path.join(root, "agents/pi/generate-config.ts")],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            ...selected,
            NEMOCLAW_MODEL: "next-hosted-model",
            NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
          },
        },
      );
      expect(hosted.status, hosted.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
        defaultProvider: "openshell",
        defaultModel: "next-hosted-model",
        futurePiSetting: true,
      });
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["ollama-local", "http://host.openshell.internal:11434/v1", true],
    ["vllm-local", "http://host.docker.internal:8000/v1", true],
    ["llama-cpp-local", "http://192.168.1.2:8080/v1", true],
    ["compatible-endpoint", "http://10.0.0.2:11434/v1", true],
    ["compatible-endpoint", "http://192.168.1.20:9001/v1", true],
    ["compatible-endpoint", "https://inference.local/v1", false],
    ["compatible-endpoint", "https://api.example.com/v1", false],
    ["nvidia", "http://host.openshell.internal:8000/v1", false],
  ])("keeps Pi %s at %s on the selected credential route", (provider, endpoint, native) => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "selected-model",
      NEMOCLAW_UPSTREAM_PROVIDER: provider,
      NEMOCLAW_INFERENCE_BASE_URL: endpoint,
    });
    try {
      expect(status, stderr).toBe(0);
      const config = JSON.parse(fs.readFileSync(path.join(home, ".pi/agent/models.json"), "utf8"));
      expect(config.providers.openshell.baseUrl).toBe(endpoint);
      expect(config.providers.openshell.models[0].id).toBe("selected-model");
      expect(config.providers.openshell.apiKey).toEqual(
        native
          ? expect.stringMatching(/^!/)
          : provider === "compatible-endpoint" && endpoint !== "https://inference.local/v1"
            ? "${COMPATIBLE_API_KEY}"
            : "nemoclaw-managed-inference",
      );
      expect(config.providers.openshell.headers !== undefined).toBe(native);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes an owner-only catalog that routes the managed model", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });
    expect(status, stderr).toBe(0);
    const configPath = path.join(home, ".pi", "agent", "models.json");
    const configFd = fs.openSync(configPath, "r");
    let config: {
      defaultModel: string;
      providers: Record<string, { baseUrl: string; api: string; apiKey: string }>;
    };
    try {
      expect(fs.fstatSync(configFd).mode & 0o777).toBe(0o600);
      config = JSON.parse(fs.readFileSync(configFd, "utf8"));
    } finally {
      fs.closeSync(configFd);
    }
    expect(config.defaultModel).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(config.providers.openshell.baseUrl).toBe("https://inference.local/v1");
    expect(config.providers.openshell.api).toBe("openai-completions");
    expect(config.providers.openshell.apiKey).toBe("nemoclaw-managed-inference");
    expect(fs.existsSync(path.join(home, ".pi/agent/settings.json"))).toBe(false);
  });

  it("rejects a model name that is empty after trimming", () => {
    const { status, stderr } = generate({
      NEMOCLAW_MODEL: "   ",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("NEMOCLAW_MODEL must not be empty.");
  });

  it.each([
    ...HOSTED_NATIVE_PROVIDERS.filter((provider) => provider.api === "openai-completions"),
    {
      label: "NVIDIA",
      logicalProvider: "nvidia-prod",
      endpoint: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    },
  ])("generates native $label routing without writing the host credential (#12589)", (provider) => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "selected-model",
      NEMOCLAW_UPSTREAM_PROVIDER: provider.logicalProvider,
      NEMOCLAW_INFERENCE_BASE_URL: provider.endpoint,
      [provider.credentialEnv]: "host-credential-must-not-be-written",
    });
    try {
      expect(status, stderr).toBe(0);
      const text = fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8");
      expect(JSON.parse(text).providers.openshell).toEqual({
        api: "openai-completions",
        apiKey: `\${${provider.credentialEnv}}`,
        baseUrl: provider.endpoint,
        models: [{ id: "selected-model" }],
        ...(provider.logicalProvider === "openrouter-api"
          ? {
              headers: {
                "HTTP-Referer": "https://www.nvidia.com/nemoclaw/",
                "X-OpenRouter-Title": "NVIDIA NemoClaw",
              },
            }
          : {}),
      });
      expect(text).not.toContain("host-credential-must-not-be-written");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps every provider credential out of the generated catalog", () => {
    const { home } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NVIDIA_API_KEY: "nvapi-should-never-be-written",
      OPENAI_API_KEY: "sk-proj-should-never-be-written",
    });
    const config = fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8");
    expect(config).not.toContain("nvapi-");
    expect(config).not.toContain("sk-proj-");
  });

  it("rejects an inference API family other than openai-completions", () => {
    const { status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_API: "openai-responses",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("NEMOCLAW_INFERENCE_API must be openai-completions for Pi.");
  });

  it("rejects an inference base URL that carries credentials", () => {
    const { status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://user:secret@inference.local/v1",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("NEMOCLAW_INFERENCE_BASE_URL must not include credentials.");
  });

  function readManagedModel(home: string): Record<string, unknown> {
    const config = JSON.parse(
      fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8"),
    ) as { providers: Record<string, { models: Record<string, unknown>[] }> };
    return config.providers.openshell.models[0] as Record<string, unknown>;
  }

  it("writes the context window, output limit, and reasoning support Pi documents (#7930)", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_CONTEXT_WINDOW: "262144",
      NEMOCLAW_MAX_TOKENS: "32000",
      NEMOCLAW_REASONING: "true",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({
      id: "nvidia/nemotron-3-super-120b-a12b",
      contextWindow: 262_144,
      maxTokens: 32_000,
      reasoning: true,
    });
  });

  it("omits unset model tuning so Pi keeps its own defaults (#7930)", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_CONTEXT_WINDOW: "",
      NEMOCLAW_MAX_TOKENS: "",
      NEMOCLAW_REASONING: "",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({ id: "nvidia/nemotron-3-super-120b-a12b" });
  });

  it("records a disabled reasoning decision instead of dropping it (#7930)", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_REASONING: "false",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({
      id: "nvidia/nemotron-3-super-120b-a12b",
      reasoning: false,
    });
  });

  it.each([
    ["NEMOCLAW_CONTEXT_WINDOW", "128k", "NEMOCLAW_CONTEXT_WINDOW must be a positive integer."],
    ["NEMOCLAW_MAX_TOKENS", "0", "NEMOCLAW_MAX_TOKENS must be a positive integer."],
    ["NEMOCLAW_REASONING", "yes", 'NEMOCLAW_REASONING must be "true" or "false".'],
  ])("rejects %s=%s before writing a catalog (#7930)", (name, value, message) => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      [name]: value,
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain(message);
    expect(fs.existsSync(path.join(home, ".pi", "agent", "models.json"))).toBe(false);
  });
});

const PI_PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "OPENAI_PROXY",
  "grpc_proxy",
  "GRPC_PROXY",
  "NODE_USE_ENV_PROXY",
  "NEMOCLAW_PROXY_HOST",
  "NEMOCLAW_PROXY_PORT",
];

function piStartupFixture(directory: string): { script: string; runtimeEnv: string } {
  const script = path.join(directory, "start.sh");
  const runtimeEnv = path.join(directory, "runtime-env.sh");
  const rlimits = path.join(directory, "sandbox-rlimits.sh");
  fs.writeFileSync(
    rlimits,
    "harden_resource_limits() { :; }\nverify_resource_limits_exact() { :; }\n",
  );
  const source = fs
    .readFileSync(path.join(root, "agents/pi/start.sh"), "utf8")
    .replace(
      "/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh",
      path.join(root, "scripts/lib/entrypoint-env-wrapper.sh"),
    )
    .replace("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimits)
    // Exercise the sandbox-user pass without changing host ownership or limits.
    .replace('if [ "$(id -u)" -eq 0 ]; then', "if false; then")
    .replace(
      "/usr/local/share/nemoclaw/corporate-ca.pem",
      path.join(directory, "absent-corporate-ca.pem"),
    )
    .replace("local target=/tmp/nemoclaw-proxy-env.sh", `local target="${runtimeEnv}"`)
    .replace("/tmp/nemoclaw-proxy-env.XXXXXX", path.join(directory, "proxy-env.XXXXXX"));
  fs.writeFileSync(script, source);
  return { script, runtimeEnv };
}

describe("Pi native network mediation", () => {
  it.each([
    { label: "native mediation", append: "", accepted: true },
    {
      label: "an HTTP proxy",
      append: "export HTTP_PROXY=http://retired-proxy.invalid:3128\n",
      accepted: false,
    },
    {
      label: "a SOCKS proxy",
      append: "export ALL_PROXY=socks5://retired-proxy.invalid:1080\n",
      accepted: false,
    },
    { label: "missing TLS trust", append: "unset SSL_CERT_FILE\n", accepted: false },
  ])("checks the workflow shell with $label", ({ append, accepted }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-workflow-"));
    try {
      const { script, runtimeEnv } = piStartupFixture(directory);
      const ambient = Object.fromEntries(
        PI_PROXY_VARIABLES.map((name) => [name, "http://retired-proxy.invalid:3128"]),
      );
      const started = spawnSync("/bin/bash", [script, "/usr/bin/true"], {
        env: {
          HOME: directory,
          PATH: process.env.PATH ?? "",
          ...ambient,
          ...Object.fromEntries(
            [
              "SSL_CERT_FILE",
              "CURL_CA_BUNDLE",
              "REQUESTS_CA_BUNDLE",
              "GIT_SSL_CAINFO",
              "NODE_EXTRA_CA_CERTS",
            ].map((name) => [name, "/tmp/nemoclaw-ca-bundle.pem"]),
          ),
        },
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(started.status, started.stderr).toBe(0);
      fs.chmodSync(runtimeEnv, 0o600);
      fs.appendFileSync(runtimeEnv, append);
      const job = required(
        readWorkflow("managed-images.yaml").jobs?.["pi-candidate"],
        "Pi job missing",
      );
      const command =
        step(job, "Exercise the Pi candidate through its declared entrypoint").run ?? "";
      const shell = required(
        /docker exec --user 999:999 "\$entrypoint_container" \/bin\/bash -ceu '([\s\S]*?)'\s*$/u.exec(
          command,
        )?.[1],
        "Pi independent-shell probe missing",
      ).replace("/tmp/nemoclaw-proxy-env.sh", runtimeEnv);
      const checked = spawnSync("/bin/bash", ["-ceu", shell], {
        env: { HOME: directory, PATH: process.env.PATH ?? "", ...ambient },
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(checked.status === 0, checked.stderr).toBe(accepted);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["startup", "sourced shell"])(
    "clears ambient proxy settings in %s and preserves TLS trust",
    (mode) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-start-"));
      try {
        const { script, runtimeEnv } = piStartupFixture(directory);
        const trust = {
          SSL_CERT_FILE: "/etc/openshell-tls/ca-bundle.pem",
          CURL_CA_BUNDLE: "/etc/openshell-tls/ca-bundle.pem",
          REQUESTS_CA_BUNDLE: "/etc/openshell-tls/ca-bundle.pem",
          GIT_SSL_CAINFO: "/etc/openshell-tls/ca-bundle.pem",
          NODE_EXTRA_CA_CERTS: "/etc/openshell-tls/ca-bundle.pem",
        };
        const ambient = {
          PATH: process.env.PATH ?? "",
          ...trust,
          ...Object.fromEntries(
            PI_PROXY_VARIABLES.map((name) => [name, "http://retired-proxy.invalid:3128"]),
          ),
        };
        const started = spawnSync("/bin/bash", [script, "/usr/bin/env"], {
          env: ambient,
          encoding: "utf8",
          timeout: 5_000,
        });
        expect(started.status, started.stderr).toBe(0);
        const sourced = spawnSync(
          "/bin/bash",
          ["-c", 'source "$1"; exec /usr/bin/env', "pi-shell", runtimeEnv],
          {
            env: ambient,
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        expect(sourced.status, sourced.stderr).toBe(0);
        const output = mode === "startup" ? started.stdout : sourced.stdout;
        const environment = Object.fromEntries(
          output
            .trim()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
        expect(PI_PROXY_VARIABLES.filter((name) => Object.hasOwn(environment, name))).toEqual([]);
        expect(environment).toMatchObject({ ...trust, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
        expect(fs.statSync(runtimeEnv).mode & 0o777).toBe(0o444);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
