// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  type PiArtifactSources,
  verifyPiCandidateArtifacts,
  verifyPiTrustBoundary,
} from "../scripts/checks/pi-candidate-artifacts.mts";
import {
  CANDIDATE_MANAGED_IMAGE_AGENTS,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../src/lib/onboard/managed-image/contract.ts";
import { validateCandidateContract } from "../tools/managed-images/validate-candidate-contract.mts";

const root = path.resolve(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function currentSources(): PiArtifactSources {
  return {
    dependencyReview: readRepoFile("agents/pi/dependency-review.md"),
    dockerfile: readRepoFile("agents/pi/Dockerfile"),
    dockerfileBase: readRepoFile("agents/pi/Dockerfile.base"),
    lock: readRepoFile("agents/pi/pi-runtime/package-lock.json"),
    managedImageContract: readRepoFile("src/lib/onboard/managed-image/contract.ts"),
    managedImagesWorkflow: readRepoFile(".github/workflows/managed-images.yaml"),
    manifest: readRepoFile("agents/pi/manifest.yaml"),
    packageJson: readRepoFile("agents/pi/pi-runtime/package.json"),
    policyAdditions: readRepoFile("agents/pi/policy-additions.yaml"),
  };
}

function withPolicy(mutate: (policy: Record<string, any>) => void): PiArtifactSources {
  const sources = currentSources();
  const policy = YAML.parse(sources.policyAdditions);
  mutate(policy);
  return { ...sources, policyAdditions: YAML.stringify(policy) };
}

function withManifest(mutate: (manifest: Record<string, any>) => void): PiArtifactSources {
  const sources = currentSources();
  const manifest = YAML.parse(sources.manifest);
  mutate(manifest);
  return { ...sources, manifest: YAML.stringify(manifest) };
}

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

describe("Pi candidate runtime artifacts", () => {
  it("accepts the Pi artifacts committed in this repository", () => {
    expect(verifyPiCandidateArtifacts(currentSources())).toEqual([]);
  });

  it("rejects a manifest version that drifts from the locked package", () => {
    const sources = currentSources();
    const failures = verifyPiCandidateArtifacts({
      ...sources,
      manifest: sources.manifest.replace(/^expected_version: .*$/mu, 'expected_version: "0.85.0"'),
    });
    expect(failures).toContain("agents/pi/manifest.yaml: expected_version must be 0.84.1");
  });

  it("rejects an image integrity pin that no longer matches the lockfile", () => {
    const sources = currentSources();
    const failures = verifyPiCandidateArtifacts({
      ...sources,
      dockerfileBase: sources.dockerfileBase.replace(
        /^ARG PI_NPM_INTEGRITY=.*$/mu,
        "ARG PI_NPM_INTEGRITY=sha512-tampered",
      ),
    });
    expect(failures).toContain(
      "agents/pi/Dockerfile.base: PI_NPM_INTEGRITY must match the locked integrity",
    );
  });

  it("rejects a resolved archive without canonical SHA-512 integrity", () => {
    const sources = currentSources();
    const lock = JSON.parse(sources.lock) as {
      packages: Record<string, { integrity?: string }>;
    };
    const location =
      "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core";
    delete lock.packages[location]?.integrity;
    const failures = verifyPiCandidateArtifacts({
      ...sources,
      lock: `${JSON.stringify(lock, null, 2)}\n`,
    });
    expect(failures).toContain(
      `agents/pi/pi-runtime/package-lock.json: resolved archives must use committed SHA-512 integrity: ${location}`,
    );
  });

  it("rejects an install that re-enables package lifecycle scripts", () => {
    const sources = currentSources();
    const failures = verifyPiCandidateArtifacts({
      ...sources,
      dockerfileBase: sources.dockerfileBase.replace(
        "ci --omit=dev --ignore-scripts",
        "ci --omit=dev",
      ),
    });
    expect(failures).toContain(
      "agents/pi/Dockerfile.base: the Pi install must disable lifecycle scripts",
    );
  });

  it("rejects a dependency review whose recorded lockfile SHA-256 does not match the lockfile", () => {
    const sources = currentSources();
    const failures = verifyPiCandidateArtifacts({
      ...sources,
      lock: `${sources.lock}\n`,
    });
    expect(failures.some((failure) => failure.includes("lockfile SHA-256 must be"))).toBe(true);
  });

  it("rejects a manifest that omits the supported-architecture declaration", () => {
    const sources = currentSources();
    const failures = verifyPiCandidateArtifacts({
      ...sources,
      manifest: sources.manifest.replace(/^managed_image:\n(?:^ {2}.*\n)*/mu, ""),
    });
    expect(failures).toContain(
      'agents/pi/manifest.yaml: managed_image.architectures must be ["linux/amd64","linux/arm64"]',
    );
    expect(failures).toContain(
      "agents/pi/manifest.yaml: managed_image.startup_profile_contract_version must be 1",
    );
  });

  it("rejects a startup-profile contract version that drifts from the managed-image contract", () => {
    const sources = currentSources();
    const failures = verifyPiCandidateArtifacts({
      ...sources,
      manifest: sources.manifest.replace(
        /^  startup_profile_contract_version: 1$/mu,
        "  startup_profile_contract_version: 2",
      ),
    });
    expect(failures).toContain(
      "agents/pi/manifest.yaml: managed_image.startup_profile_contract_version must be 1",
    );
  });
});

describe("Pi release cohort separation", () => {
  it("keeps pi a candidate agent and out of the shipped cohort", () => {
    expect(CANDIDATE_MANAGED_IMAGE_AGENTS).toContain("pi");
    expect(SHIPPED_MANAGED_IMAGE_AGENTS).not.toContain("pi");
  });
});

describe("Pi candidate contract validation", () => {
  it("accepts an exact candidate contract", () => {
    const contract = validateCandidateContract(candidateContract(), "linux/amd64");
    expect(contract.reference).toBe(`ghcr.io/nvidia/nemoclaw/pi-sandbox@${DIGEST}`);
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

describe("Pi runtime boundaries", () => {
  it("accepts the Pi trust boundary committed in this repository (#7924)", () => {
    expect(verifyPiTrustBoundary(currentSources())).toEqual([]);
  });

  it("rejects a direct provider endpoint added beside the managed route (#7924)", () => {
    const sources = withPolicy((policy) => {
      policy.network_policies.managed_inference.endpoints.push({
        host: "api.openai.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        rules: [{ allow: { method: "POST", path: "/v1/chat/completions" } }],
      });
    });
    expect(verifyPiTrustBoundary(sources)).toEqual([
      "agents/pi/policy-additions.yaml: managed_inference must declare exactly one endpoint",
      "agents/pi/policy-additions.yaml: the baseline permits only inference.local:443",
    ]);
  });

  it("rejects a package registry policy added to the Pi baseline (#7924)", () => {
    const sources = withPolicy((policy) => {
      policy.network_policies.npm_registry = {
        name: "npm_registry",
        endpoints: [{ host: "registry.npmjs.org", port: 443, enforcement: "enforce", rules: [] }],
      };
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/policy-additions.yaml: the baseline must declare only managed_inference, found managed_inference, npm_registry",
    );
  });

  it("rejects an agent-writable binary in the network policy (#7924)", () => {
    const sources = withPolicy((policy) => {
      policy.network_policies.managed_inference.binaries.push({ path: "/sandbox/agent-proxy" });
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/policy-additions.yaml: network capability must stay on the root-owned image binaries /usr/local/bin/node, /usr/local/bin/pi, /usr/local/lib/nemoclaw/pi-runtime/**",
    );
  });

  it("rejects a managed inference rule that allows a path outside /v1/ (#7924)", () => {
    const sources = withPolicy((policy) => {
      policy.network_policies.managed_inference.endpoints[0].rules.push({
        allow: { method: "GET", path: "/**" },
      });
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/policy-additions.yaml: every managed inference rule must allow an explicit /v1/ route, found /**",
    );
  });

  it("rejects a managed inference endpoint that is observed instead of enforced (#7924)", () => {
    const sources = withPolicy((policy) => {
      policy.network_policies.managed_inference.endpoints[0].enforcement = "observe";
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/policy-additions.yaml: inference.local must stay enforced, not observed",
    );
  });

  it("rejects a managed inference endpoint with its protocol removed (#7924)", () => {
    const sources = withPolicy((policy) => {
      delete policy.network_policies.managed_inference.endpoints[0].protocol;
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/policy-additions.yaml: inference.local must enforce protocol rest, not an unset protocol",
    );
  });

  it("rejects a managed inference endpoint with a non-REST protocol (#7924)", () => {
    const sources = withPolicy((policy) => {
      policy.network_policies.managed_inference.endpoints[0].protocol = "tcp";
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/policy-additions.yaml: inference.local must enforce protocol rest, not tcp",
    );
  });

  it("rejects a managed inference endpoint with an empty rule set (#7924)", () => {
    const sources = withPolicy((policy) => {
      policy.network_policies.managed_inference.endpoints[0].rules = [];
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/policy-additions.yaml: every managed inference endpoint must declare at least one explicit /v1/ route",
    );
  });

  it("rejects a managed inference endpoint with its rule set removed (#7924)", () => {
    const sources = withPolicy((policy) => {
      delete policy.network_policies.managed_inference.endpoints[0].rules;
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/policy-additions.yaml: every managed inference endpoint must declare at least one explicit /v1/ route",
    );
  });

  it("rejects a manifest that enables device pairing (#7924)", () => {
    const sources = withManifest((manifest) => {
      manifest.device_pairing = true;
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/manifest.yaml: device_pairing must stay false",
    );
  });

  it("rejects a container-runtime socket added to the read-write paths (#7924)", () => {
    const sources = withPolicy((policy) => {
      policy.filesystem_policy.read_write.push("/var/run/docker.sock");
    });
    expect(verifyPiTrustBoundary(sources).join("\n")).toContain(
      "read-write paths must stay /dev/null, /sandbox, /sandbox/.pi, /tmp",
    );
  });

  it("rejects a Landlock compatibility that does not fail closed (#7924)", () => {
    const sources = withPolicy((policy) => {
      policy.landlock.compatibility = "best-effort";
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/policy-additions.yaml: landlock.compatibility must be strict so filesystem policy fails closed",
    );
  });

  it("rejects a root process identity in the Pi policy (#7924)", () => {
    const sources = withPolicy((policy) => {
      policy.process.run_as_user = "root";
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/policy-additions.yaml: Pi must run as the sandbox user and group",
    );
  });

  it("rejects a headless command that omits --no-approve (#7924)", () => {
    const sources = withManifest((manifest) => {
      manifest.runtime.headless_command = "pi --print";
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/manifest.yaml: runtime.headless_command must pass --no-approve so non-interactive runs ignore project-local resources",
    );
  });

  it("rejects an enabled MCP surface in the Pi manifest (#7924)", () => {
    const sources = withManifest((manifest) => {
      manifest.mcp.support = "enabled";
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/manifest.yaml: mcp.support must stay disabled",
    );
  });

  it("rejects a manifest that declares the trust.json project-trust store (#7924)", () => {
    const sources = withManifest((manifest) => {
      manifest.state_files.push({ path: "trust.json" });
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/manifest.yaml: trust.json must stay undeclared so a restore cannot carry a project-trust decision",
    );
  });

  it("rejects defaultProjectTrust in the restore allowlist (#7924)", () => {
    const sources = withManifest((manifest) => {
      manifest.state_files[0].restore.user_keys.push({
        key: "defaultProjectTrust",
        type: "enum",
        values: ["ask", "always", "never"],
      });
    });
    expect(verifyPiTrustBoundary(sources)).toContain(
      "agents/pi/manifest.yaml: defaultProjectTrust must stay outside the restore allowlist so a backup cannot widen project trust",
    );
  });
});

describe("Pi managed model catalog generation", () => {
  function generate(env: Record<string, string>): {
    home: string;
    status: number | null;
    stderr: string;
  } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-config-"));
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", path.join(root, "agents/pi/generate-config.ts")],
      {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
      },
    );
    return { home, status: result.status, stderr: result.stderr };
  }

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
  });

  it("rejects a model name that is empty after trimming", () => {
    const { status, stderr } = generate({
      NEMOCLAW_MODEL: "   ",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("NEMOCLAW_MODEL must not be empty.");
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
