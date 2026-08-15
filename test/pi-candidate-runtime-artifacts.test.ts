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

  // source-shape-contract: security -- Pull-request candidate builds must not inherit package-write authority from the trusted publication job
  it("does not grant package write permission to pull request candidate builds", () => {
    const workflow = YAML.parse(readRepoFile(".github/workflows/managed-images.yaml")) as {
      jobs: Record<
        string,
        {
          if?: string;
          permissions?: Record<string, string>;
          steps?: Array<Record<string, unknown>>;
        }
      >;
    };
    const candidateJob = workflow.jobs["pi-candidate"];
    const publishJob = workflow.jobs["pi-candidate-publish"];
    expect(candidateJob?.if).toContain("github.event_name == 'pull_request'");
    expect(candidateJob?.permissions).toEqual({ contents: "read" });
    expect(publishJob?.if).toContain("github.event_name != 'pull_request'");
    expect(publishJob?.permissions).toEqual({ contents: "read", packages: "write" });
    expect(publishJob?.steps).toEqual(candidateJob?.steps);
  });

  // source-shape-contract: security -- Candidate and publication builds must import one digest-bound OCI base through a Buildx driver that supports digest-only outputs
  it("imports the local base into Buildx for digest-only candidate publication", () => {
    type WorkflowStep = {
      id?: string;
      name?: string;
      run?: string;
      with?: Record<string, unknown>;
    };
    const workflow = YAML.parse(readRepoFile(".github/workflows/managed-images.yaml")) as {
      jobs: Record<string, { steps?: WorkflowStep[] }>;
    };
    const steps = workflow.jobs["pi-candidate"]?.steps ?? [];
    const requiredStep = (name: string): WorkflowStep => {
      const selected = steps.find((step) => step.name === name);
      expect(selected, `missing workflow step: ${name}`).toBeDefined();
      return selected ?? {};
    };

    const buildx = requiredStep("Set up Docker Buildx");
    expect(buildx.id).toBe("buildx");
    expect(buildx.with?.["driver"]).not.toBe("docker");

    const baseBuild = requiredStep("Build the exact Pi candidate base").run ?? "";
    expect(baseBuild).toContain('--output "type=docker,dest=${local_base_archive}"');
    expect(baseBuild).toContain('--output "type=oci,dest=${local_base_oci_archive}"');
    expect(baseBuild).toContain('docker load --input "$local_base_archive"');
    expect(baseBuild).toContain('tar -C "$local_base_oci" -xf "$local_base_oci_archive"');
    expect(baseBuild).toContain("if length == 1 then .[0].digest");
    expect(baseBuild).toContain(
      'printf \'oci=%s@%s\\n\' "$local_base_oci" "$local_base_oci_digest"',
    );

    const expectedContext = "nemoclaw-pi-base=oci-layout://${{ steps.base.outputs.oci }}";
    for (const name of [
      "Build the Pi candidate managed image",
      "Publish the Pi candidate image by digest",
    ]) {
      const build = requiredStep(name);
      expect(build.with?.builder).toBe("${{ steps.buildx.outputs.name }}");
      expect(build.with?.["build-contexts"]).toBe(expectedContext);
      expect(build.with?.["build-args"]).toContain("BASE_IMAGE=nemoclaw-pi-base");
    }
    expect(requiredStep("Publish the Pi candidate image by digest").with?.outputs).toContain(
      "push-by-digest=true",
    );
  });

  // source-shape-contract: security -- Pull-request and published-digest qualification must bind the declared OCI entrypoint and empty command to the held-state contract
  it("qualifies local and published candidates through the declared entrypoint", () => {
    const workflow = readRepoFile(".github/workflows/managed-images.yaml");
    const dockerfile = readRepoFile("agents/pi/Dockerfile");
    const entrypointStep = workflow.slice(
      workflow.indexOf("- name: Exercise the Pi candidate through its declared entrypoint"),
      workflow.indexOf("- name: Record the exact Pi candidate contract"),
    );
    expect(entrypointStep).not.toContain("if: github.event_name");
    expect(entrypointStep).toContain("EVENT_NAME: ${{ github.event_name }}");
    expect(entrypointStep).toContain(
      "IMAGE_REFERENCE: nemoclaw-managed-candidate/pi:${{ github.sha }}",
    );
    expect(entrypointStep).toContain('if [ "$EVENT_NAME" = "pull_request" ]; then');
    expect(entrypointStep).toContain('reference="$IMAGE_REFERENCE"');
    const publishedReference = 'reference="$' + "{REPOSITORY}@$" + '{DIGEST}"';
    expect(entrypointStep).toContain(publishedReference);
    expect(entrypointStep).not.toContain("--entrypoint /usr/local/bin/nemoclaw-start");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]');
    expect(dockerfile).toContain("CMD []");
    expect(dockerfile).not.toContain('CMD ["/bin/bash"]');
    expect(entrypointStep).toContain("openssl req -x509 -newkey rsa:2048");
    expect(entrypointStep).toContain("dst=/usr/local/share/nemoclaw/corporate-ca.pem,readonly");
    expect(entrypointStep).toContain("docker exec --user 999:999");
    for (const name of [
      "SSL_CERT_FILE",
      "CURL_CA_BUNDLE",
      "REQUESTS_CA_BUNDLE",
      "GIT_SSL_CAINFO",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      expect(entrypointStep).toContain(name);
    }
    expect(entrypointStep).toContain("source /tmp/nemoclaw-proxy-env.sh");
    expect(entrypointStep).toContain(
      "for proxy_variable in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy",
    );
    expect(entrypointStep).toContain("for no_proxy_variable in NO_PROXY no_proxy");
    expect(entrypointStep).toContain("merged_ca=/tmp/nemoclaw-ca-bundle.pem");
    expect(entrypointStep).toContain("merged_ca_status");
    expect(entrypointStep).toContain('!= "0:0:444"');
    expect(entrypointStep).toContain(
      'fs.readFileSync("/usr/local/share/nemoclaw/corporate-ca.pem")',
    );
    expect(entrypointStep).toContain('fs.readFileSync(process.argv[1], "utf8")');
    expect(entrypointStep).toContain("new X509Certificate(block).fingerprint256");
    expect(entrypointStep).toContain("mounted.fingerprint256");
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
  const APPROVED_MANAGED_INFERENCE_BINARY_PATHS = [
    "/usr/local/bin/pi",
    "/usr/local/bin/node",
    "/usr/local/lib/nemoclaw/pi-runtime/**",
  ];

  // source-shape-contract: security -- An agent-writable binary path in the baseline policy would give the agent an attacker-controlled egress channel
  it("grants network capability only to the approved image-owned binaries", () => {
    const policy = YAML.parse(readRepoFile("agents/pi/policy-additions.yaml")) as {
      network_policies: Record<string, { binaries?: Array<{ path: string }> }>;
    };
    expect(Object.keys(policy.network_policies)).toEqual(["managed_inference"]);
    const binaries = policy.network_policies.managed_inference.binaries ?? [];
    expect(binaries.map((binary) => binary.path)).toEqual(APPROVED_MANAGED_INFERENCE_BINARY_PATHS);
  });

  it("excludes an agent-writable binary path from the approved allowlist", () => {
    expect(APPROVED_MANAGED_INFERENCE_BINARY_PATHS).not.toContain("/tmp/agent-proxy");
    expect(APPROVED_MANAGED_INFERENCE_BINARY_PATHS).not.toContain("/sandbox/agent-proxy");
  });

  // source-shape-contract: security -- A corporate CA baked into the image but never merged into the runtime trust bundle leaves external TLS unverifiable through a corporate proxy
  it("merges a baked corporate CA into the trust bundle Node reads", () => {
    const startSh = readRepoFile("agents/pi/start.sh");
    expect(startSh).toContain("merge_corporate_proxy_ca");
    expect(startSh).toContain('export SSL_CERT_FILE="$_merged"');
    expect(startSh).toContain('export NODE_EXTRA_CA_CERTS="$_merged"');
    expect(startSh.indexOf("merge_corporate_proxy_ca()")).toBeLessThan(
      startSh.indexOf("prepare_runtime_env()"),
    );
    expect(startSh.indexOf("\nmerge_corporate_proxy_ca\n")).toBeLessThan(
      startSh.indexOf("exec /usr/bin/setpriv"),
    );
    expect(startSh).toContain('!= "0:0:444"');
  });

  // source-shape-contract: security -- A merged CA variable that prepare_runtime_env does not persist is unavailable to independent login and exec shells, which read only the persisted runtime-env file
  it("persists every merged CA variable into the runtime environment file", () => {
    const startSh = readRepoFile("agents/pi/start.sh");
    const prepareRuntimeEnv = startSh.slice(
      startSh.indexOf("prepare_runtime_env()"),
      startSh.indexOf("\nprepare_runtime_env\n", startSh.indexOf("prepare_runtime_env()")),
    );
    for (const name of [
      "SSL_CERT_FILE",
      "CURL_CA_BUNDLE",
      "REQUESTS_CA_BUNDLE",
      "GIT_SSL_CAINFO",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      expect(prepareRuntimeEnv).toContain(`write_export_if_set ${name}`);
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
});
