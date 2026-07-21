// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { "cancel-in-progress"?: boolean };
  jobs?: Record<string, { if?: string; steps?: Step[]; "timeout-minutes"?: number }>;
};

const root = path.resolve(import.meta.dirname, "..");
const workflow = YAML.parse(
  fs.readFileSync(
    path.join(root, ".github", "workflows", "openclaw-tar-security-revision.yaml"),
    "utf8",
  ),
) as Workflow;
const steps = workflow.jobs?.["build-and-push"]?.steps ?? [];

function namedStep(name: string): Step {
  const step = steps.find((candidate) => candidate.name === name);
  expect(step, `workflow step not found: ${name}`).toBeDefined();
  return step as Step;
}

describe("historical OpenClaw security revision publication (#7272)", () => {
  it("keeps the manual publication inside immutable source and destination guards", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read", packages: "write" });
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);

    const job = workflow.jobs?.["build-and-push"];
    expect(job?.if).toContain("github.repository == 'NVIDIA/NemoClaw'");
    expect(job?.if).toContain("github.ref == 'refs/heads/main'");
    expect(job?.["timeout-minutes"]).toBe(120);
    for (const step of steps.filter((candidate) => candidate.uses)) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/u);
    }

    const plan = namedStep("Resolve immutable publication plan");
    expect(plan.run).toContain('source_image="${image}@${source_digest}"');
    expect(plan.run).toContain(
      'git fetch --no-tags --depth=1 origin "refs/tags/${source_tag}:refs/tags/${source_tag}"',
    );
    expect(plan.run).toContain('release_commit="$(git rev-parse "${source_tag}^{commit}")"');
    expect(plan.run).toContain("Refusing to overwrite existing revision tag");
    expect(plan.run).toContain("Could not prove revision tag is absent");

    const historicalCheckout = steps.find(
      (step) =>
        step.uses?.startsWith("actions/checkout@") && step.with?.path === "historical-source",
    );
    expect(historicalCheckout?.with).toMatchObject({
      path: "historical-source",
      "persist-credentials": false,
      ref: "${{ steps.plan.outputs.release_commit }}",
    });

    const lateGuard = namedStep("Recheck immutable destination immediately before publication");
    const publication = namedStep("Publish the validated local OCI index without rebuilding");
    expect(steps.indexOf(lateGuard)).toBe(steps.indexOf(publication) - 1);
    expect(lateGuard.run).toContain('test "$current_source" = "$SOURCE_DIGEST"');
    expect(lateGuard.run).toContain("Refusing to overwrite existing revision tag");
    expect(lateGuard.run).toContain(
      "Could not prove revision tag is absent immediately before publication",
    );
  });

  it("freezes and hashes one Trivy database set for every exact digest scan", () => {
    const freeze = namedStep("Freeze and record the Trivy databases");
    expect(freeze.env?.TRIVY_IMAGE).toBe(
      "aquasec/trivy@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f",
    );
    expect(freeze.run).toContain("image --download-db-only");
    expect(freeze.run).toContain("image --download-java-db-only");
    expect(freeze.run).toContain("trivy-db-metadata.txt");
    expect(freeze.run).toContain("trivy-databases-before.sha256");
    expect(freeze.run).toContain("find db java-db -type f -print0");
    expect(freeze.run).toContain("xargs -0 sha256sum");

    const validate = namedStep(
      "Validate both exact platform candidates against the historical release",
    );
    expect(validate.run).toContain("--skip-db-update");
    expect(validate.run).toContain("--skip-java-db-update");
    expect(validate.run).toContain("--skip-check-update");
    expect(validate.run).toContain("--skip-vex-repo-update");
    expect(validate.run).toContain("trivy-databases-after.sha256");
    expect(validate.run).toContain("cmp \\");
    expect(validate.run).toContain('"$EVIDENCE_DIRECTORY/trivy-databases-before.sha256"');
    expect(validate.run).toContain('"$EVIDENCE_DIRECTORY/trivy-databases-after.sha256"');
    expect(steps.indexOf(freeze)).toBeLessThan(steps.indexOf(validate));
  });

  it("scans the exact amd64 and arm64 outputs used by the final manifest", () => {
    const build = namedStep("Build the local multiarch candidate OCI archive");
    expect(build.run).toContain("--platform linux/amd64,linux/arm64");
    expect(build.run).toContain('--output "type=oci,dest=${CANDIDATE_ARCHIVE}"');
    expect(build.run).not.toContain("push=true");
    expect(build.run).not.toContain("ghcr.io");
    expect(build.run).toContain("for architecture in amd64 arm64");
    expect(build.run).toContain('scripts/check-production-build-args.sh "${build_args[@]}"');
    expect(build.run).toContain("docker buildx build");
    expect(build.run?.indexOf("scripts/check-production-build-args.sh")).toBeLessThan(
      build.run?.indexOf("docker buildx build") ?? -1,
    );
    expect(build.run).toContain("--metadata-file");
    expect(build.run).toContain("--provenance=mode=max");
    expect(build.run).toContain("--sbom=true");
    expect(build.run).toContain("candidate-index.digest");
    expect(build.run).toContain("candidate-${architecture}.digest");
    expect(build.run).toContain(".platform.architecture == $architecture");
    expect(build.run).toContain('"vnd.docker.reference.type" == "attestation-manifest"');
    expect(build.run).toContain('"vnd.docker.reference.digest" == $digest');
    expect(steps.some((step) => step.uses?.startsWith("docker/build-push-action@"))).toBe(false);

    const validate = namedStep(
      "Validate both exact platform candidates against the historical release",
    );
    expect(validate.run).toContain("for architecture in amd64 arm64");
    expect(validate.run).toContain(
      'candidate_context="oci-layout://${CANDIDATE_LAYOUT}@${candidate_digest}"',
    );
    expect(validate.run).toContain('--build-context "candidate=${candidate_context}"');
    expect(validate.run).toContain('build_args=(--build-arg "BASE_IMAGE=candidate")');
    expect(validate.run).toContain('scripts/check-production-build-args.sh "${build_args[@]}"');
    expect(validate.run).toContain("historical-source/Dockerfile");
    expect(validate.run).toContain("--load");
    expect(validate.run).toContain("--input /candidate.oci.tar");
    expect(validate.run).toContain('--platform "$platform"');
    expect(validate.run).toContain('scan_archive "$platform" "$candidate_report"');
    expect(validate.run).toContain('scan_docker_image "$historical_image" "$historical_report"');
    expect(validate.run).toContain('test "$candidate_findings" = 0');
    expect(validate.run).toContain('test "$historical_findings" = 0');
    expect(validate.run).not.toContain("--severity");

    for (const requiredPath of [
      "/usr/local/lib/node_modules/openclaw/node_modules/tar/package.json",
      "/usr/local/lib/node_modules/npm/node_modules/tar/package.json",
      "/opt/nemoclaw/node_modules/tar/package.json",
      "/sandbox/.openclaw/extensions/nemoclaw/node_modules/tar/package.json",
    ]) {
      expect(validate.run).toContain(requiredPath);
    }
    expect(validate.run).toContain("cannot inventory ${directory}");
    expect(validate.run).toContain('grep -Fqx "${required_path}"$\'\\t7.5.19\' "$inventory"');
    expect(validate.run).toContain('$2 != "7.5.19"');
    expect(validate.run).toContain('test ! -s "$EVIDENCE_DIRECTORY/historical-source-status.txt"');
  });

  it("copies the validated OCI index only after every local gate and retains failure evidence", () => {
    const build = namedStep("Build the local multiarch candidate OCI archive");
    const validate = namedStep(
      "Validate both exact platform candidates against the historical release",
    );
    const setupOras = namedStep("Set up pinned ORAS");
    const login = namedStep("Log in to GHCR");
    const publication = namedStep("Publish the validated local OCI index without rebuilding");
    expect(setupOras.uses).toBe("oras-project/setup-oras@8d34698a59f5ffe24821f0b48ab62a3de8b64b20");
    expect(setupOras.with?.version).toBe("1.2.3");
    expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(validate));
    expect(steps.indexOf(validate)).toBeLessThan(steps.indexOf(setupOras));
    expect(steps.indexOf(setupOras)).toBeLessThan(steps.indexOf(login));
    expect(steps.indexOf(login)).toBeLessThan(steps.indexOf(publication));
    expect(steps.indexOf(validate)).toBeLessThan(steps.indexOf(publication));
    expect(publication.run).toContain("oras cp --from-oci-layout --recursive");
    expect(publication.env?.CANDIDATE_LAYOUT).toContain(
      "openclaw-security-revision-candidate-layout",
    );
    expect(publication.run).toContain('"$CANDIDATE_LAYOUT@$index_digest"');
    expect(publication.run).toContain('"$DESTINATION_IMAGE"');
    expect(publication.run).not.toContain("docker build");

    const verification = namedStep(
      "Verify published revision contains exactly the scanned digests",
    );
    expect(verification.run).toContain("oras manifest fetch --output");
    expect(verification.run).toContain("candidate-index-manifest.json");
    expect(verification.run).toContain("published-manifest-raw.json");
    expect(verification.run).toContain('test "$revision_digest" = "$candidate_index_digest"');
    expect(verification.run).toContain('{architecture: "amd64", digest: $amd64, os: "linux"}');
    expect(verification.run).toContain('{architecture: "arm64", digest: $arm64, os: "linux"}');
    expect(verification.run).toContain('test "$exact_platforms" = true');
    expect(verification.run).toContain('"vnd.docker.reference.type" == "attestation-manifest"');
    expect(verification.run).toContain("jq '.manifests | length'");
    expect(verification.run).toContain('<<<"$published")" = 4');
    expect(verification.run).toContain("NEMOCLAW_SANDBOX_BASE_IMAGE_REF=");

    const finalizer = namedStep("Finalize validation evidence");
    const upload = namedStep("Upload validation and publication evidence");
    expect(finalizer.if).toBe("always()");
    expect(upload.if).toBe("always()");
    expect(upload.with).toMatchObject({ "if-no-files-found": "error", "retention-days": 90 });
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(verification));
  });
});
