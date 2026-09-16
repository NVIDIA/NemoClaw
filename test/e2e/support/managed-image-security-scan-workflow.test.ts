// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";

import { readYaml, type WorkflowJob } from "../../helpers/e2e-workflow-contract";

type Input = {
  default: boolean;
  description: string;
  required: boolean;
  type: string;
};

type Workflow = {
  on: {
    push?: { paths: string[] };
    pull_request?: { paths: string[] };
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
  const successfulOutcomes = {
    MALWARE_SCAN_OUTCOME: "success",
    OSS_SCAN_OUTCOME: "success",
    PULSE_IMAGES_OUTCOME: "success",
    SECRET_SCAN_OUTCOME: "success",
  };
  it.each([
    { outcomes: successfulOutcomes, succeeds: true },
    ...Object.keys(successfulOutcomes).flatMap((key) =>
      ["failure", "cancelled", "skipped", "", undefined].map((outcome) => ({
        outcomes: { ...successfulOutcomes, [key]: outcome },
        succeeds: false,
      })),
    ),
  ])("requires every scan outcome to succeed: %j", ({ outcomes, succeeds }) => {
    const result = spawnSync(
      "bash",
      ["-c", namedStep("Enforce managed image security results").run!],
      { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin", ...outcomes } },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(succeeds ? 0 : 1);
  });

  it.each([
    [0, "normal", true],
    [185, "normal", true],
    [183, "normal", false],
    [1, "normal", false],
    [0, "failed", false],
    [0, "unknown", false],
  ] as const)("gates scanner exit %i with classifier %s", (scannerExit, classifier, succeeds) => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-scan-result-gate-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    const rawSecret = "workflow-fixture-raw-secret";
    const finding = {
      DetectorName: "Fixture",
      Verified: scannerExit === 183,
      Redacted: "[REDACTED]",
      SourceMetadata: { Data: { Docker: { file: "/fixture.env", line: 1 } } },
    };
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/bash
printf '%s\\n' "$SCANNER_RESULT"
printf '%s\\n' "$RAW_SECRET" >&2
exit "$SCANNER_EXIT"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "node"),
      `#!/bin/bash
if [ "$2" = "classify-secret-exit" ]; then
  case "$CLASSIFIER_MODE" in
    failed) exit 42 ;;
    unknown) echo unexpected; exit 0 ;;
  esac
fi
exec "$NODE_BINARY" "$@"
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      "bash",
      ["-c", namedStep("Scan exact digest archive for verified secrets").run!],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          RUNNER_TEMP: root,
          GITHUB_WORKSPACE: root,
          REPORT: join(root, "report.jsonl"),
          PULSE_SECRET_IMAGE: "scanner@sha256:fixture",
          SCANNER_EXIT: String(scannerExit),
          SCANNER_RESULT: JSON.stringify({
            ...finding,
            Raw: rawSecret,
            RawV2: rawSecret,
            ExtraData: { token: rawSecret },
          }),
          RAW_SECRET: rawSecret,
          CLASSIFIER_MODE: classifier,
          NODE_BINARY: process.execPath,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status === 0, result.stderr).toBe(succeeds);
    const report = readFileSync(join(root, "report.jsonl"), "utf8");
    expect(
      report
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([finding]);
    expect(report + result.stdout + result.stderr).not.toContain(rawSecret);
    expect(existsSync(join(root, "pulse-secret-results.jsonl"))).toBe(false);
    expect(existsSync(join(root, "pulse-secret.stderr"))).toBe(false);
  });

  it.each([false, true])(
    "cleans scratch files and all image references when removal fails: %s",
    (fails) => {
      const root = mkdtempSync(join(tmpdir(), "nemoclaw-scan-cleanup-"));
      onTestFinished(() => rmSync(root, { recursive: true, force: true }));
      const bin = join(root, "bin");
      const log = join(root, "removed-images");
      mkdirSync(bin);
      mkdirSync(join(root, "managed-image-scan"));
      mkdirSync(join(root, "managed-image-scan-candidate"));
      const scratch = join(root, "pulse-secret-results.jsonl");
      const credentialFile = join(root, "pulse-ssa-token-test.env");
      writeFileSync(scratch, "raw finding");
      writeFileSync(credentialFile, "placeholder");
      writeFileSync(
        join(bin, "docker"),
        `#!/bin/bash
if [ "$1 $2" = "image inspect" ]; then exit 0; fi
if [ "$1 $2" != "image rm" ]; then exit 2; fi
printf '%s\\n' "$3" >> "$REMOVAL_LOG"
if [ "$3" = "$FAILED_REFERENCE" ]; then exit 1; fi
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        "bash",
        ["-c", namedStep("Remove security scan scratch files").run!],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            RUNNER_TEMP: root,
            REMOVAL_LOG: log,
            LOCAL_REFERENCE: "local-scan:run-attempt",
            MANAGED_REFERENCE: "managed@sha256:fixture",
            PULSE_SECRET_IMAGE: "secret@sha256:fixture",
            PULSE_MALWARE_IMAGE: "malware@sha256:fixture",
            FAILED_REFERENCE: fails ? "local-scan:run-attempt" : "",
          },
        },
      );
      expect(result.status, result.stderr).toBe(fails ? 1 : 0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "local-scan:run-attempt",
        "managed@sha256:fixture",
        "secret@sha256:fixture",
        "malware@sha256:fixture",
      ]);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(credentialFile)).toBe(false);
      expect(existsSync(join(root, "managed-image-scan"))).toBe(false);
      expect(existsSync(join(root, "managed-image-scan-candidate"))).toBe(false);
    },
  );
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

    expect(baseWorkflow.on.workflow_dispatch?.inputs.run_security_scans?.description).toContain(
      "On main with the default OpenClaw version",
    );

    expect(baseWorkflow.on.push?.paths).toContain(".github/scripts/security-scan-results.mts");
    expect(managedWorkflow.on.pull_request?.paths).toContain(
      ".github/scripts/security-scan-results.mts",
    );

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
    const inventory = managedWorkflow.jobs["build-and-validate"]!.strategy?.matrix;
    expect(scanJob.strategy?.matrix).toBe(inventory);
    expect(inventory?.include).toHaveLength(6);
    expect(namedStep("Prepare exact published digest for scanning").env?.IMAGE).toBe(
      "${{ env.REGISTRY }}/${{ matrix.image }}",
    );
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
    const cleanup = namedStep("Remove security scan scratch files");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.env).toEqual({
      MANAGED_REFERENCE: "${{ steps.candidate.outputs.reference }}",
      LOCAL_REFERENCE: "${{ steps.candidate.outputs.local-reference }}",
    });
    expect(cleanup.run).toContain(
      '"$LOCAL_REFERENCE" "$MANAGED_REFERENCE" "$PULSE_SECRET_IMAGE" "$PULSE_MALWARE_IMAGE"',
    );
    expect(cleanup.run).toContain('docker image rm "$reference"');
    expect(cleanup.run).toContain('exit "$cleanup_failed"');
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
