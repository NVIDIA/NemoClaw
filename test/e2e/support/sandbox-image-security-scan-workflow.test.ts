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

type SandboxWorkflow = {
  on: {
    workflow_call: {
      inputs: Record<string, Input>;
      secrets: Record<string, { required: boolean }>;
    };
    workflow_dispatch: { inputs: Record<string, Input> };
  };
  jobs: Record<string, WorkflowJob>;
};

const workflow = readYaml<SandboxWorkflow>(".github/workflows/sandbox-images.yaml");
const scanJob = workflow.jobs["security-scan-sandbox-images"]!;

describe("optional sandbox image security scan workflow", () => {
  // source-shape-contract: security -- The reviewed workflow inputs must keep credential-bearing image scans explicitly disabled unless a maintainer opts in
  it("keeps direct and reusable scans off by default", () => {
    expect(workflow.on.workflow_dispatch.inputs.run_security_scans).toMatchObject({
      default: false,
      required: false,
      type: "boolean",
    });
    expect(workflow.on.workflow_call.inputs.run_security_scans).toMatchObject({
      default: false,
      required: false,
      type: "boolean",
    });
  });

  // source-shape-contract: security -- Exact repository, branch, runner, and secret boundaries keep Pulse credentials out of candidate-controlled workflow runs
  it("limits scan credentials to an opted-in NVIDIA main run", () => {
    expect(scanJob.if).toBe(
      "${{ inputs.run_security_scans && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' }}",
    );
    expect(scanJob.needs).toEqual(["build-sandbox-images", "build-hermes-sandbox-image"]);
    expect(scanJob["runs-on"]).toBe("linux-amd64-cpu4");
    expect(scanJob.env).toEqual({
      PULSE_MALWARE_IMAGE:
        "nvcr.io/0898940053369630/pulse/pulse-malware-scanner-cli@sha256:d89b0e81b7690bfc9aa6de7c3472f17aeccbcd54eaa61e18875a93391e26312c",
      PULSE_SECRET_IMAGE:
        "nvcr.io/0898940053369630/pulse/pulse-secret-scanner@sha256:5ba66735e5a5408c89025eb43f9fe0242e071d494a826e415964399bc9a85fc1",
    });
    const nodeSetup = scanJob.steps?.find(
      (candidate) => candidate.name === "Set up Node for report sanitization",
    );
    expect(nodeSetup).toMatchObject({
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: { "node-version": "24.18.1" },
    });
    expect(workflow.on.workflow_call.secrets).toMatchObject({
      NGC_API_KEY: { required: false },
      PULSE_SSA_CLIENT_ID: { required: false },
      PULSE_SSA_CLIENT_SECRET: { required: false },
    });
  });

  // source-shape-contract: security -- Both built agent images must retain the Critical vulnerability failure threshold on the immutable reviewed scan action
  it.each([
    ["Scan OpenClaw image for Critical vulnerabilities", "nemoclaw-production"],
    ["Scan Hermes image for Critical vulnerabilities", "nemoclaw-hermes-production"],
  ])("blocks Critical vulnerabilities in %s", (name, image) => {
    const scan = scanJob.steps?.find((candidate) => candidate.name === name);
    expect(scan?.uses).toBe("anchore/scan-action@27805bf3b4e84b4a5c980df22ed233c00390a439");
    expect(scan?.["continue-on-error"]).toBe(true);
    expect(scan?.with).toMatchObject({
      image,
      "severity-cutoff": "critical",
      "fail-build": true,
      "output-format": "json",
    });
  });

  // source-shape-contract: security -- The workflow must call the executable secret sanitizer and fail closed without placing raw scanner output in uploaded artifacts
  it("sanitizes secret reports and blocks verified results or scanner errors", () => {
    const scan = scanJob.steps?.find(
      (candidate) => candidate.name === "Scan image archives for verified secrets",
    );
    const source = scan?.run ?? "";
    expect(source).toContain("umask 077");
    expect(source).toContain('docker --image "file:///scan/${archive_name}"');
    expect(source).toContain("--allowlist=/allowlist/.nspect-allowlist.toml");
    expect(source).toContain("--json --results=verified,unknown --fail");
    expect(source).toContain("node .github/scripts/security-scan-results.mts redact-secrets");
    expect(source).toContain("node .github/scripts/security-scan-results.mts classify-secret-exit");
    expect(source).toContain("trap cleanup_secret_output EXIT");
  });

  // source-shape-contract: security -- Malware scanning must preserve digest-only scanner identity, private credential transport, and isolated report writes for both images
  it("isolates credentials and reports for both malware archive scans", () => {
    const scan = scanJob.steps?.find(
      (candidate) => candidate.name === "Scan image archives for malware",
    );
    const source = scan?.run ?? "";
    expect(source).toContain('"scope": "nspect.verify pms.read.malware pms.scan.file"');
    expect(source).toContain("--nspect NSPECT-SQ44-PJFM");
    expect(source).toContain("file-scan --file");
    expect(source).toContain("scan_archive openclaw isolation-image.tar.gz");
    expect(source).toContain("scan_archive hermes hermes-isolation-image.tar.gz");
    expect(source).toContain('chmod 600 "${ssa_env_file}"');
    expect(source).toContain("trap 'rm -f \"${ssa_env_file}\"' EXIT");
    expect(source).toContain('printf \'SSA_TOKEN=%s\\n\' "${ssa_token}" >"${ssa_env_file}"');
    expect(source).toContain("unset ssa_token token_response");
    expect(source).toContain('--env-file "${ssa_env_file}"');
    expect(source).toContain('--volume "${report_dir}:/reports"');
    expect(source).not.toContain('--env SSA_TOKEN="${ssa_token}"');
    expect(source).not.toContain('--user "${PULSE_SSA_CLIENT_ID}:${PULSE_SSA_CLIENT_SECRET}"');
  });

  // source-shape-contract: security -- Uploaded artifacts must stay within the sanitized report directory and precede the final gate for every scanner outcome
  it("uploads sanitized reports before enforcing every scan result", () => {
    const stepNames = scanJob.steps?.map((candidate) => candidate.name) ?? [];
    const uploadIndex = stepNames.indexOf("Upload sandbox image security reports");
    const enforceIndex = stepNames.indexOf("Enforce sandbox image security results");
    expect(uploadIndex).toBeGreaterThan(-1);
    expect(enforceIndex).toBeGreaterThan(uploadIndex);

    const upload = scanJob.steps?.[uploadIndex];
    expect(upload?.if).toBe("always()");
    expect(upload?.with).toMatchObject({
      path: "security-reports/",
      "if-no-files-found": "error",
      "retention-days": 14,
    });

    const enforce = scanJob.steps?.[enforceIndex];
    expect(enforce?.if).toBe("always()");
    expect(enforce?.env).toEqual({
      MALWARE_SCAN_OUTCOME: "${{ steps.malware-scan.outcome }}",
      OPENCLAW_OSS_OUTCOME: "${{ steps.oss-openclaw.outcome }}",
      HERMES_OSS_OUTCOME: "${{ steps.oss-hermes.outcome }}",
      SECRET_SCAN_OUTCOME: "${{ steps.secret-scan.outcome }}",
    });
  });
});
