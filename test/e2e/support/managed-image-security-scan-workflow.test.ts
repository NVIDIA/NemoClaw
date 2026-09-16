// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob } from "../../helpers/e2e-workflow-contract";

type Input = {
  default: boolean;
  description: string;
  required: boolean;
  type: string;
};

type Workflow = {
  on: {
    workflow_call?: {
      inputs: Record<string, Input>;
      secrets: Record<string, { required: boolean }>;
    };
    workflow_dispatch?: { inputs: Record<string, Input> };
  };
  jobs: Record<string, WorkflowJob>;
};

const baseWorkflow = readYaml<Workflow>(".github/workflows/base-image.yaml");
const managedWorkflow = readYaml<Workflow>(".github/workflows/managed-images.yaml");
const scanJob = managedWorkflow.jobs["security-scan-managed-images"]!;

function namedStep(name: string) {
  const step = scanJob.steps?.find((candidate) => candidate.name === name);
  expect(step, `missing scan step: ${name}`).toBeDefined();
  return step!;
}

describe("optional managed image security scans", () => {
  // source-shape-contract: security -- The trusted publication caller must keep credential-bearing image scans disabled until a maintainer selects them
  it("keeps publication scans off by default", () => {
    expect(baseWorkflow.on.workflow_dispatch?.inputs.run_security_scans).toMatchObject({
      default: false,
      required: false,
      type: "boolean",
    });
    expect(managedWorkflow.on.workflow_call?.inputs.run_security_scans).toMatchObject({
      default: false,
      required: false,
      type: "boolean",
    });

    const caller = baseWorkflow.jobs["publish-managed-images"]!;
    expect(caller.with?.run_security_scans).toBe("${{ inputs.run_security_scans || false }}");
    expect(caller.secrets).toEqual({
      NGC_API_KEY: "${{ github.ref == 'refs/heads/main' && secrets.NGC_API_KEY || '' }}",
      PULSE_SSA_CLIENT_ID:
        "${{ github.ref == 'refs/heads/main' && secrets.PULSE_SSA_CLIENT_ID || '' }}",
      PULSE_SSA_CLIENT_SECRET:
        "${{ github.ref == 'refs/heads/main' && secrets.PULSE_SSA_CLIENT_SECRET || '' }}",
    });
  });

  // source-shape-contract: security -- Repository, event, and ref checks must prevent candidate-controlled workflows from receiving the Pulse credentials
  it("limits scan credentials to trusted manual publications", () => {
    expect(scanJob.if?.replace(/\s+/gu, " ").trim()).toBe(
      "${{ inputs.run_security_scans && github.repository == 'NVIDIA/NemoClaw' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' }}",
    );
    expect(scanJob.permissions).toEqual({ contents: "read" });
    expect(scanJob["runs-on"]).toBe("linux-amd64-cpu4");
    expect(managedWorkflow.on.workflow_call?.secrets).toEqual({
      NGC_API_KEY: { required: false },
      PULSE_SSA_CLIENT_ID: { required: false },
      PULSE_SSA_CLIENT_SECRET: { required: false },
    });
  });

  // source-shape-contract: security -- The scan matrix must cover every published final agent image and platform without adding base or llama.cpp images
  it("scans all six published managed-image digests", () => {
    expect(scanJob.strategy?.matrix?.include).toEqual([
      {
        agent: "openclaw",
        arch: "amd64",
        display_name: "OpenClaw",
        image: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
      },
      {
        agent: "openclaw",
        arch: "arm64",
        display_name: "OpenClaw",
        image: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
      },
      {
        agent: "hermes",
        arch: "amd64",
        display_name: "Hermes",
        image: "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
      },
      {
        agent: "hermes",
        arch: "arm64",
        display_name: "Hermes",
        image: "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "amd64",
        display_name: "Deep Agents Code",
        image: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "arm64",
        display_name: "Deep Agents Code",
        image: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
      },
    ]);
  });

  // source-shape-contract: security -- Scans must consume each validated publication digest without rebuilding and must retain every blocking scan policy
  it("reuses exact published digests and enforces scan results", () => {
    expect(scanJob.needs).toBe("build-and-validate");
    expect(namedStep("Download exact managed image contract").with?.name).toBe(
      "managed-image-candidate-${{ github.run_id }}-${{ matrix.agent }}-${{ matrix.artifact_platform }}",
    );
    const source = namedStep("Prepare exact published digest for scanning").run ?? "";
    expect(source).toContain('.reference == (.image + "@" + .digest)');
    expect(source).toContain('docker pull --platform "$PLATFORM" "$reference"');
    expect(source).toContain('docker save "$local_reference"');
    expect(source).not.toMatch(/docker\s+build(?:x)?\b/u);

    const oss = namedStep("Scan exact digest for Critical vulnerabilities");
    expect(oss.uses).toBe("anchore/scan-action@27805bf3b4e84b4a5c980df22ed233c00390a439");
    expect(oss.env).toEqual({ GRYPE_PLATFORM: "${{ matrix.platform }}" });
    expect(oss.with).toMatchObject({
      image: "${{ steps.candidate.outputs.reference }}",
      "severity-cutoff": "critical",
      "fail-build": true,
      "output-format": "json",
    });

    const secretSource = namedStep("Scan exact digest archive for verified secrets").run ?? "";
    expect(secretSource).toContain("--allowlist=/allowlist/.nspect-allowlist.toml");
    expect(secretSource).toContain("--json --results=verified,unknown --fail");
    expect(secretSource).toContain("security-scan-results.mts redact-secrets");
    expect(secretSource).toContain("security-scan-results.mts classify-secret-exit");

    const malwareSource = namedStep("Scan exact digest archive for malware").run ?? "";
    expect(malwareSource).toContain('"scope": "nspect.verify pms.read.malware pms.scan.file"');
    expect(malwareSource).toContain("--nspect NSPECT-SQ44-PJFM");
    expect(malwareSource).toContain("file-scan --file /scan/image.tar.gz");
  });

  // source-shape-contract: security -- Scan artifacts must exclude raw secret output and promotion must wait only when a maintainer selected the optional scan
  it("uploads sanitized reports before the optional promotion gate", () => {
    const upload = namedStep("Upload managed image security reports");
    expect(upload.if).toBe("always()");
    expect(upload.with).toMatchObject({
      path: "security-reports/",
      "if-no-files-found": "error",
      "retention-days": 14,
    });
    const enforce = namedStep("Enforce managed image security results");
    expect(enforce.if).toBe("always()");
    expect(enforce.env).toEqual({
      MALWARE_SCAN_OUTCOME: "${{ steps.malware-scan.outcome }}",
      OSS_SCAN_OUTCOME: "${{ steps.oss-scan.outcome }}",
      PULSE_IMAGES_OUTCOME: "${{ steps.pulse-images.outcome }}",
      SECRET_SCAN_OUTCOME: "${{ steps.secret-scan.outcome }}",
    });

    const promote = managedWorkflow.jobs.promote!;
    expect(promote.needs).toEqual([
      "publication-identity",
      "build-and-validate",
      "security-scan-managed-images",
    ]);
    expect(promote.if).toContain("needs.security-scan-managed-images.result == 'success'");
    expect(promote.if).toContain("needs.security-scan-managed-images.result == 'skipped'");
  });
});
