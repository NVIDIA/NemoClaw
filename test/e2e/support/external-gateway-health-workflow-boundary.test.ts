// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  type ExternalGatewayHealthWorkflow,
  validateExternalGatewayHealthWorkflow,
} from "../../../tools/e2e/external-gateway-health-workflow-boundary.mts";
import { PREPARE_E2E_ACTION } from "../../../tools/e2e/prepare-e2e-workflow-boundary.mts";
import { UPLOAD_E2E_ARTIFACTS_ACTION } from "../../../tools/e2e/upload-e2e-artifacts-workflow-boundary.mts";
import { stopExternalGatewayHealthGateway } from "../fixtures/external-gateway-health-process.ts";

const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const VALID_HELPER_SOURCE = `const BLUEPRINT_RUNNER = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "dist",
  "lib",
  "blueprint-runner.js",
);
const address = externalHostAddress();
const config = \`bind_address = "\${address}:\${String(port)}"\`;
const args = [BLUEPRINT_RUNNER, "status", "--external-target"];
const certificateArgs = ["--server-san", address];
const result = await shellProbe.run(
    trustedShellCommand({
      command: process.execPath,
      args: [BLUEPRINT_RUNNER, "status", "--external-target"],
      captureLimitBytes: 64 * 1024,
      env: { NEMOCLAW_BLUEPRINT_PATH: blueprintRoot },
      redactionValues: [privateStateRoot],
    }),
);
const retry = {
  operation: "external-gateway-health.tcp-readiness",
  maxAttempts: 10,
};
artifacts.addRedactionValues([stateDir]);
const receipt = { runner: "dist/lib/blueprint-runner.js" };
`;

function validWorkflow(): ExternalGatewayHealthWorkflow {
  return {
    jobs: {
      "package-openshell-sdk": {
        if: "${{ github.event_name == 'workflow_dispatch' && contains(format(',{0},', inputs.jobs), ',external-gateway-health,') }}",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        permissions: { contents: "read", packages: "read" },
        outputs: { artifact_name: "${{ steps.identity.outputs.artifact_name }}" },
        steps: [
          {
            name: "Check out trusted OpenShell SDK package verifier",
            uses: CHECKOUT_ACTION,
            with: {
              ref: "${{ github.workflow_sha }}",
              "persist-credentials": false,
              "sparse-checkout": [
                "ci/reviewed-npm-audit.json",
                "scripts/audit-reviewed-npm-graph.mts",
                "scripts/checks/package-openshell-sdk-for-pr.mts",
                "scripts/lib/openclaw-npm-remediation.mts",
                "scripts/lib/reviewed-npm-archive.mts",
                "scripts/lib/reviewed-npm-audit.mts",
              ].join("\n"),
              "sparse-checkout-cone-mode": false,
            },
          },
          {
            name: "Set up Node for reviewed package download",
            uses: SETUP_NODE_ACTION,
            with: {
              "node-version": "22",
              "registry-url": "https://npm.pkg.github.com",
              scope: "@nvidia",
            },
          },
          {
            id: "package",
            name: "Download and verify exact OpenShell SDK package",
            env: {
              NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY: "${{ runner.temp }}/openshell-sdk",
              NODE_AUTH_TOKEN: "${{ github.token }}",
            },
            run: "node --experimental-strip-types scripts/checks/package-openshell-sdk-for-pr.mts",
          },
          {
            id: "identity",
            name: "Record reviewed OpenShell SDK artifact identity",
            env: {
              RUN_ATTEMPT: "${{ github.run_attempt }}",
              RUN_ID: "${{ github.run_id }}",
            },
            run: 'artifact_name="openshell-sdk-e2e-${RUN_ID}-${RUN_ATTEMPT}"',
          },
          {
            name: "Upload reviewed OpenShell SDK archive",
            uses: UPLOAD_ACTION,
            with: {
              name: "${{ steps.identity.outputs.artifact_name }}",
              path: "${{ steps.package.outputs.artifact_path }}",
              "if-no-files-found": "error",
              "retention-days": 1,
            },
          },
        ],
      },
      "external-gateway-health": {
        needs: ["generate-matrix", "package-openshell-sdk"],
        if: "${{ contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'external-gateway-health') }}",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 15,
        env: {
          E2E_AGENT_RUNTIME: "none",
          E2E_ARTIFACT_DIR:
            "${{ github.workspace }}/e2e-artifacts/live/external-gateway-health",
          E2E_DEFAULT_ENABLED: "0",
          E2E_ENVIRONMENT_OR_INFERENCE_ENDPOINT:
            "Ubuntu host with OpenShell 0.0.106; no inference endpoint",
          E2E_JOB: "1",
          E2E_OBSERVABLE_OUTCOME:
            "The exact Blueprint Runner observes public gateway health over explicit HTTPS and CA",
          E2E_TARGET_ID: "external-gateway-health",
          NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST: "1",
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_OPENSHELL_PIN_VERSION: "0.0.106",
          NEMOCLAW_RUN_LIVE_E2E: "1",
        },
        steps: [
          {
            name: "Check out candidate",
            uses: CHECKOUT_ACTION,
            with: {
              repository: "${{ inputs.checkout_repository || github.repository }}",
              ref: "${{ inputs.checkout_sha || github.sha }}",
              "fetch-depth": 0,
              "persist-credentials": false,
            },
          },
          {
            name: "Prepare E2E workspace",
            uses: PREPARE_E2E_ACTION,
            with: { "build-cli": "false" },
          },
          {
            name: "Restore exact-commit CLI artifact",
            uses:
              "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            with: {
              "provenance-json":
                "${{ needs.generate-matrix.outputs.cli_artifact_provenance }}",
            },
          },
          {
            name: "Download reviewed OpenShell SDK archive",
            uses: DOWNLOAD_ACTION,
            with: {
              name: "${{ needs.package-openshell-sdk.outputs.artifact_name }}",
              path: "${{ runner.temp }}/openshell-sdk",
            },
          },
          {
            name: "Install reviewed OpenShell SDK archive without package credentials",
            run: 'env -u NODE_AUTH_TOKEN -u GITHUB_TOKEN npm install --no-save --package-lock=false --ignore-scripts "${archives[0]}"',
          },
          {
            name: "Install OpenShell CLI",
            run: "env -u NODE_AUTH_TOKEN -u GITHUB_TOKEN bash scripts/install-openshell.sh",
          },
          {
            name: "Run external gateway health live test",
            run: "node tools/e2e/live-vitest-invocation.mts run test/e2e/live/external-gateway-health.test.ts",
          },
          {
            name: "Upload external gateway health artifacts",
            if: "always()",
            uses: UPLOAD_E2E_ARTIFACTS_ACTION,
            with: {
              name: "e2e-external-gateway-health",
              path: "e2e-artifacts/live/external-gateway-health/",
            },
          },
        ],
      },
    },
  };
}

function healthStep(workflow: ExternalGatewayHealthWorkflow, name: string) {
  const step = workflow.jobs["external-gateway-health"]!.steps!.find(
    (candidate) => candidate.name === name,
  );
  expect(step, `synthetic health step '${name}' is missing`).toBeDefined();
  return step!;
}

describe("external gateway health workflow boundary", () => {
  type FakeGateway = EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ChildProcess["kill"];
  };

  function gatewayWithForcedKill(onForcedKill: (gateway: FakeGateway) => void): {
    gateway: ChildProcess;
    kill: ReturnType<typeof vi.fn<ChildProcess["kill"]>>;
  } {
    const gateway = new EventEmitter() as FakeGateway;
    gateway.exitCode = null;
    gateway.signalCode = null;
    const kill = vi.fn<ChildProcess["kill"]>();
    kill.mockReturnValueOnce(true);
    kill.mockImplementationOnce(() => {
      onForcedKill(gateway);
      return true;
    });
    gateway.kill = kill;
    return { gateway: gateway as ChildProcess, kill };
  }

  it("accepts the credential-free reviewed SDK workflow boundary (#9872)", () => {
    expect(validateExternalGatewayHealthWorkflow(validWorkflow(), VALID_HELPER_SOURCE)).toEqual([]);
  });

  it("rejects a job-scoped package credential (#9872)", () => {
    const workflow = validWorkflow();
    workflow.jobs["external-gateway-health"]!.env!.NODE_AUTH_TOKEN = "untrusted";

    expect(validateExternalGatewayHealthWorkflow(workflow, VALID_HELPER_SOURCE)).toContain(
      "external-gateway-health must not expose NODE_AUTH_TOKEN at job scope",
    );
  });

  it("rejects a credential-bearing reviewed SDK install (#9872)", () => {
    const workflow = validWorkflow();
    healthStep(
      workflow,
      "Install reviewed OpenShell SDK archive without package credentials",
    ).run = 'npm install "${archives[0]}"';

    expect(validateExternalGatewayHealthWorkflow(workflow, VALID_HELPER_SOURCE)).toContain(
      "external-gateway-health SDK install must retain: env -u NODE_AUTH_TOKEN -u GITHUB_TOKEN",
    );
  });

  it("rejects a helper that bypasses the exact Runner status command (#9872)", () => {
    const helper = VALID_HELPER_SOURCE.replaceAll(
      '[BLUEPRINT_RUNNER, "status", "--external-target"]',
      '[BLUEPRINT_RUNNER, "status"]',
    );

    expect(validateExternalGatewayHealthWorkflow(validWorkflow(), helper)).toContain(
      "external gateway health helper must run exact Blueprint Runner external status",
    );
  });

  it("rejects SDK installation after the health test (#9872)", () => {
    const workflow = validWorkflow();
    const steps = workflow.jobs["external-gateway-health"]!.steps!;
    const installIndex = steps.findIndex(
      (step) =>
        step.name === "Install reviewed OpenShell SDK archive without package credentials",
    );
    const [install] = steps.splice(installIndex, 1);
    const runIndex = steps.findIndex(
      (step) => step.name === "Run external gateway health live test",
    );
    steps.splice(runIndex + 1, 0, install!);

    expect(validateExternalGatewayHealthWorkflow(workflow, VALID_HELPER_SOURCE)).toContain(
      "external-gateway-health step 'Install reviewed OpenShell SDK archive without package credentials' must precede 'Run external gateway health live test'",
    );
  });

  it("waits for forced gateway exit before cleanup completes (#9872)", async () => {
    vi.useFakeTimers();
    try {
      const { gateway, kill } = gatewayWithForcedKill((fakeGateway) => {
        setTimeout(() => {
          fakeGateway.signalCode = "SIGKILL";
          fakeGateway.emit("exit", null, "SIGKILL");
        }, 50);
      });
      let completed = false;
      const cleanup = stopExternalGatewayHealthGateway(gateway).then(() => {
        completed = true;
      });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(completed).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      await cleanup;
      expect(completed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a gateway that remains active after forced cleanup (#9872)", async () => {
    vi.useFakeTimers();
    try {
      const { gateway } = gatewayWithForcedKill(() => undefined);
      const cleanup = expect(stopExternalGatewayHealthGateway(gateway)).rejects.toThrow(
        "external gateway health gateway did not stop after SIGKILL",
      );

      await vi.advanceTimersByTimeAsync(4_000);
      await cleanup;
    } finally {
      vi.useRealTimers();
    }
  });
});
