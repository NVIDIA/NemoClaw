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
  };
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
});

describe("Pi release cohort separation", () => {
  it("keeps pi a candidate agent and out of the shipped cohort", () => {
    expect(CANDIDATE_MANAGED_IMAGE_AGENTS).toContain("pi");
    expect(SHIPPED_MANAGED_IMAGE_AGENTS).not.toContain("pi");
  });

  // source-shape-contract: security -- A published Pi candidate digest must never reach the atomic all-agent release cohort, and the artifact names are the only boundary between the two publication lanes
  it("publishes candidate contracts outside the all-agent activation pattern", () => {
    const workflow = YAML.parse(readRepoFile(".github/workflows/managed-images.yaml")) as {
      jobs: Record<string, { steps?: Array<Record<string, unknown>> }>;
    };
    const candidateSteps = workflow.jobs["pi-candidate"]?.steps ?? [];
    const uploadNames = candidateSteps
      .map((step) => (step.with as { name?: string } | undefined)?.name)
      .filter((name): name is string => typeof name === "string");
    expect(uploadNames.some((name) => name.startsWith("managed-candidate-contract-"))).toBe(true);
    expect(uploadNames.some((name) => name.startsWith("managed-pr-contract-"))).toBe(false);
    const activationSteps = workflow.jobs["pr-managed-activation"]?.steps ?? [];
    const downloadPatterns = activationSteps
      .map((step) => (step.with as { pattern?: string } | undefined)?.pattern)
      .filter((pattern): pattern is string => typeof pattern === "string");
    expect(downloadPatterns.some((pattern) => pattern.startsWith("managed-pr-contract-"))).toBe(
      true,
    );
    expect(
      downloadPatterns.some((pattern) => pattern.startsWith("managed-candidate-contract-")),
    ).toBe(false);
  });

  // source-shape-contract: compatibility -- The accepted Pi launch matrix requires candidate qualification on both supported Linux architectures
  it("builds and validates the candidate image for linux/amd64 and linux/arm64", () => {
    const workflow = YAML.parse(readRepoFile(".github/workflows/managed-images.yaml")) as {
      jobs: Record<string, { strategy?: { matrix?: { include?: Array<{ platform?: string }> } } }>;
    };
    const platforms = (workflow.jobs["pi-candidate"]?.strategy?.matrix?.include ?? []).map(
      (entry) => entry.platform,
    );
    expect(platforms).toEqual(["linux/amd64", "linux/arm64"]);
  });

  // source-shape-contract: compatibility -- The candidate image can only build on an architecture whose base image the publisher produces
  it("publishes a Pi base image for linux/amd64 and linux/arm64", () => {
    const workflow = YAML.parse(readRepoFile(".github/workflows/base-image.yaml")) as {
      jobs: Record<string, { strategy?: { matrix?: { include?: Array<{ platform?: string }> } } }>;
    };
    const platforms = (workflow.jobs["build-pi-platforms"]?.strategy?.matrix?.include ?? []).map(
      (entry) => entry.platform,
    );
    expect(platforms).toEqual(["linux/amd64", "linux/arm64"]);
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
  // source-shape-contract: security -- An agent-writable binary path in the baseline policy would give the agent an attacker-controlled egress channel
  it("grants network capability only to image-owned binaries", () => {
    const policy = YAML.parse(readRepoFile("agents/pi/policy-additions.yaml")) as {
      network_policies: Record<string, { binaries?: Array<{ path: string }> }>;
    };
    expect(Object.keys(policy.network_policies)).toEqual(["managed_inference"]);
    const binaries = policy.network_policies.managed_inference.binaries ?? [];
    expect(binaries.length).toBeGreaterThan(0);
    for (const binary of binaries) {
      expect(binary.path.startsWith("/sandbox")).toBe(false);
    }
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
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      defaultModel: string;
      providers: Record<string, { baseUrl: string; type: string }>;
    };
    expect(config.defaultModel).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(config.providers.openshell.baseUrl).toBe("https://inference.local/v1");
    expect(config.providers.openshell.type).toBe("openai-compatible");
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
});
