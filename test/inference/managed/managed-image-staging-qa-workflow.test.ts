// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";
import type { Job, Workflow } from "../../helpers/managed-image-publication-workflow-types";

const fullShaAction = /^[^@]+@[0-9a-f]{40}$/iu;

function inlineNodeStdinValidator(source: string): string {
  return required(
    source.match(/if ! node -e '([\s\S]+?)' <<< "\$actual_discovery_contract"/u)?.[1],
    "managed-image workflow is missing or has an incomplete inline Node validator",
  ).trim();
}

function managedPrBuilder(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["pr-build-and-entrypoint"],
    "managed-image workflow is missing its all-agent PR build and runtime gate",
  );
}

function stagingQaDeepCodeBuilder(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["pr-staging-qa-deep-code"],
    "managed-image workflow is missing its staging QA Deep Agents Code regression",
  );
}

function writeOverlayFixture(root: string, relative: string, content: string) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

describe("managed-image staging QA workflow", () => {
  it("rebuilds the staging QA base from exact source before validating the Deep Agents Code repair (#8665)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const qaBuilder = stagingQaDeepCodeBuilder(workflow);
    const steps = qaBuilder.steps ?? [];
    const prCheckout = step(qaBuilder, "Checkout latest PR commit");
    const baseCheckout = step(qaBuilder, "Checkout exact staging QA base source");
    const setupNode = step(qaBuilder, "Set up Node.js");
    const overlay = step(qaBuilder, "Overlay exact PR dependency inputs on staging QA base");
    const drift = step(qaBuilder, "Reproduce staging discovery permission drift");
    const baseBuild = step(qaBuilder, "Rebuild staging QA Deep Agents Code base from exact source");
    const finalBuild = step(qaBuilder, "Build latest PR commit against reproduced staging QA base");
    const darwinBuild = step(
      qaBuilder,
      "Build Darwin compatibility image against reproduced staging QA base",
    );
    const contract = step(qaBuilder, "Validate staging QA final image contract");

    expect(qaBuilder.if).toBe("github.event_name == 'pull_request'");
    expect(qaBuilder["runs-on"]).toBe("ubuntu-22.04");
    expect(qaBuilder["timeout-minutes"]).toBe(90);
    expect(qaBuilder.permissions).toEqual({ contents: "read" });
    expect(qaBuilder.env).toMatchObject({
      CANDIDATE_SHA: "${{ github.event.pull_request.head.sha }}",
      STAGING_QA_SOURCE_SHA: "ce96811ddb418ad01c040521a1fe912b5bcb405e",
      STAGING_QA_BASE_IMAGE: "nemoclaw-deepagents-code-base:staging-31396519688",
      STAGING_QA_DARWIN_IMAGE: "nemoclaw-managed-pr/langchain-deepagents-code-staging-qa-darwin",
    });
    expect(qaBuilder.env).not.toHaveProperty("STAGING_PRODUCER_SHA");
    expect(qaBuilder.env).not.toHaveProperty("STAGING_QA_RECORDED_INDEX_DIGEST");
    expect(JSON.stringify(qaBuilder)).not.toContain(":latest");
    expect(prCheckout.with).toMatchObject({
      ref: "${{ github.event.pull_request.head.sha }}",
      path: "candidate",
      "persist-credentials": false,
    });
    expect(baseCheckout.with).toMatchObject({
      ref: "${{ env.STAGING_QA_SOURCE_SHA }}",
      path: "staging-qa-base-source",
      "persist-credentials": false,
    });
    expect(prCheckout.uses).toMatch(fullShaAction);
    expect(baseCheckout.uses).toMatch(fullShaAction);
    expect(setupNode.uses).toMatch(fullShaAction);
    expect(drift.run).toBe(
      step(managedPrBuilder(workflow), "Reproduce reviewed discovery permission drift").run,
    );
    expect(drift["working-directory"]).toBe("candidate");
    expect(steps.indexOf(prCheckout)).toBeLessThan(steps.indexOf(overlay));
    expect(steps.indexOf(overlay)).toBeLessThan(steps.indexOf(drift));
    expect(steps.indexOf(drift)).toBeLessThan(steps.indexOf(baseBuild));
    expect(steps.indexOf(baseBuild)).toBeLessThan(steps.indexOf(finalBuild));
    expect(steps.indexOf(finalBuild)).toBeLessThan(steps.indexOf(darwinBuild));
    expect(steps.indexOf(darwinBuild)).toBeLessThan(steps.indexOf(contract));

    const overlaySource = required(overlay.run, "staging QA dependency overlay is missing");
    expect(overlaySource).toContain("agents/langchain-deepagents-code/Dockerfile.base");
    expect(overlaySource).toContain("agents/langchain-deepagents-code/requirements.lock");
    expect(overlaySource).toContain("scripts/lib/bundled-npm-package.mts");
    expect(overlaySource).toContain(
      "scripts/security/patches/perl-5.44.0-net-ping-capability-tests.patch",
    );

    const overlayFixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-staging-overlay-"));
    const candidateRoot = path.join(overlayFixture, "candidate");
    const stagingRoot = path.join(overlayFixture, "staging-qa-base-source");
    const dockerfile = "agents/langchain-deepagents-code/Dockerfile.base";
    const packageBuilder = "scripts/security/build-native-security-packages.sh";
    const requirements = "agents/langchain-deepagents-code/requirements.lock";
    const npmBundler = "scripts/lib/bundled-npm-package.mts";
    const perlPatch = "scripts/security/patches/perl-5.44.0-net-ping-capability-tests.patch";
    try {
      writeOverlayFixture(candidateRoot, dockerfile, "candidate Dockerfile\n");
      writeOverlayFixture(candidateRoot, packageBuilder, "exit 42\n");
      writeOverlayFixture(candidateRoot, requirements, "candidate requirements\n");
      writeOverlayFixture(candidateRoot, npmBundler, "candidate npm bundler\n");
      writeOverlayFixture(candidateRoot, perlPatch, "candidate Perl patch\n");
      writeOverlayFixture(stagingRoot, dockerfile, "staging Dockerfile\n");
      writeOverlayFixture(stagingRoot, packageBuilder, "exit 41\n");
      writeOverlayFixture(stagingRoot, requirements, "staging requirements\n");
      writeOverlayFixture(stagingRoot, npmBundler, "staging npm bundler\n");
      writeOverlayFixture(stagingRoot, perlPatch, "staging Perl patch\n");
      const summary = path.join(overlayFixture, "summary.md");
      const result = spawnSync("bash", ["-c", overlaySource], {
        encoding: "utf-8",
        env: {
          ...process.env,
          CANDIDATE_SHA: "candidate-sha",
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_WORKSPACE: overlayFixture,
        },
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({
        status: 0,
        stderr: "",
      });
      expect(spawnSync("bash", [path.join(stagingRoot, packageBuilder)]).status).toBe(42);
    } finally {
      fs.rmSync(overlayFixture, { recursive: true, force: true });
    }

    const baseSource = required(baseBuild.run, "staging QA base build is missing");
    expect(baseBuild.env?.DOCKER_BUILDKIT).toBe("1");
    expect(baseSource).toContain(
      '-f "$source_root/agents/langchain-deepagents-code/Dockerfile.base"',
    );
    expect(baseSource).toContain('-t "$STAGING_QA_BASE_IMAGE"');
    expect(baseSource).toContain('"$source_root"');

    const finalSource = required(finalBuild.run, "staging QA final build is missing");
    expect(finalBuild["working-directory"]).toBe("candidate");
    expect(finalSource).toContain("-f agents/langchain-deepagents-code/Dockerfile");
    expect(finalSource).toContain('--build-arg BASE_IMAGE="$STAGING_QA_BASE_IMAGE"');
    expect(finalSource).toContain("--build-arg NEMOCLAW_MODEL=nvidia/nemotron-3-ultra-550b-a55b");
    expect(finalSource).toContain("--build-arg NEMOCLAW_INFERENCE_PROVIDER_ID=inference");
    expect(finalSource).not.toContain("--build-arg NEMOCLAW_PROVIDER_KEY=");
    expect(finalSource).toContain("--build-arg NEMOCLAW_UPSTREAM_PROVIDER=nvidia-nim");
    expect(finalSource).toContain(
      "--build-arg NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
    );
    expect(finalSource).toContain("--build-arg NEMOCLAW_INFERENCE_API=openai-completions");
    expect(finalSource).toContain("--build-arg NEMOCLAW_DCODE_AUTO_APPROVAL=thread-opt-in");
    expect(finalSource).toContain('--build-arg NEMOCLAW_BUILD_ID="$STAGING_QA_SOURCE_SHA"');
    expect(finalSource).toContain("--build-arg NEMOCLAW_DARWIN_VM_COMPAT=0");
    expect(finalSource).toMatch(/-t "\$final_reference"\s+\\\n\s+\./u);

    const darwinSource = required(darwinBuild.run, "Darwin compatibility image build is missing");
    expect(darwinBuild["working-directory"]).toBe("candidate");
    expect(darwinBuild.env?.DOCKER_BUILDKIT).toBe("1");
    expect(darwinSource).toContain("-f agents/langchain-deepagents-code/Dockerfile");
    expect(darwinSource).toContain('--build-arg BASE_IMAGE="$STAGING_QA_BASE_IMAGE"');
    expect(darwinSource).toContain("--build-arg NEMOCLAW_DARWIN_VM_COMPAT=1");
    expect(darwinSource).toContain("${STAGING_QA_DARWIN_IMAGE}:${CANDIDATE_SHA}");

    const contractSource = required(contract.run, "staging QA final contract is missing");
    expect(contractSource).toMatch(
      /if ! jq -n -e \\\n\s+--argjson base "\$base_layers" \\\n\s+--argjson final "\$final_layers"/u,
    );
    expect(contractSource).toContain("$final[.] == $base[.]");
    expect(contract.env).toMatchObject({
      DARWIN_FINAL_ID: "${{ steps.staging-darwin-final.outputs.id }}",
      FINAL_ID: "${{ steps.staging-final.outputs.id }}",
    });
    expect(contractSource).toMatch(
      /verify-dcode-conversation-history-image\.sh \\\n\s+"\$FINAL_ID" linux\/amd64 0/u,
    );
    expect(contractSource).toMatch(
      /verify-dcode-conversation-history-image\.sh \\\n\s+"\$DARWIN_FINAL_ID" linux\/amd64 1/u,
    );
    expect(contractSource).toContain('find -P "$discovery_runtime" ! -user root');
    expect(contractSource).toContain("\\( ! -user root -o -perm /022 \\) -print -quit");
    expect(contractSource).toContain("-type d ! -perm 0555");
    expect(contractSource).toContain("-type f ! -perm 0444");
    expect(contractSource).toContain('node "$discovery_runtime/mcp-tool-discovery.mjs"');
    expect(contractSource).toContain('result = JSON.parse(require("node:fs").readFileSync(0');
    expect(contractSource).not.toContain('actual_discovery_contract" !=');
    const mainContract = required(
      step(managedPrBuilder(workflow), "Validate exact PR managed image contract").run,
      "main PR managed-image contract is missing",
    );
    expect(inlineNodeStdinValidator(contractSource)).toBe(inlineNodeStdinValidator(mainContract));
  });
});
