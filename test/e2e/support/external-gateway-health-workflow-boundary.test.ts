// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { stopExternalGatewayHealthGateway } from "../fixtures/external-gateway-health-process.ts";

import {
  readExternalGatewayHealthHelper,
  readExternalGatewayHealthWorkflow,
  validateExternalGatewayHealthHelper,
  validateExternalGatewayHealthWorkflow,
  validateExternalGatewayHealthWorkflowBoundary,
} from "../../../tools/e2e/external-gateway-health-workflow-boundary.mts";

describe("external gateway health workflow boundary", () => {
  // source-shape-contract: security -- The checked-in workflow and helper must retain the trusted package and Runner execution boundaries.
  it("accepts the checked-in trusted package and live-test contract", () => {
    const workflow = readExternalGatewayHealthWorkflow();
    const helperSource = readExternalGatewayHealthHelper();
    expect(workflow.jobs).toHaveProperty("package-openshell-sdk");
    expect(helperSource).toContain("const BLUEPRINT_RUNNER = path.join(");
    expect(validateExternalGatewayHealthWorkflowBoundary()).toEqual([]);
  });

  // source-shape-contract: security -- The live helper must keep SDK access behind the packaged Runner, bounded retry, and redacted evidence.
  it("rejects a helper that bypasses the exact Runner or weakens its live boundary", () => {
    const helperSource = readExternalGatewayHealthHelper();
    expect(helperSource).toContain("const BLUEPRINT_RUNNER = path.join(");
    const source = helperSource
      .replace('"--external-target"', '"--managed-target"')
      .replace("const address = externalHostAddress();", 'const address = "127.0.0.1";')
      .replace("maxAttempts: 10,", "maxAttempts: 100,")
      .replace(
        'runner: "dist/lib/blueprint-runner.js"',
        'runner: "test/e2e/live/external-gateway-health-helpers.ts"',
      )
      .replace("artifacts.addRedactionValues([stateDir]);", "")
      .concat('\nimport "@nvidia/openshell-sdk";\n');

    expect(validateExternalGatewayHealthHelper(source)).toEqual([
      "external gateway health helper must run exact Blueprint Runner external status",
      "external gateway health helper must bind the gateway certificate to a non-loopback address",
      "external gateway health helper must retain the bounded readiness retry",
      "external gateway health helper must record the exact Runner artifact identity",
      "external gateway health helper must redact its private fixture path",
      "external gateway health helper must not bypass the Runner with a direct SDK import",
    ]);
  });

  // source-shape-contract: security -- The live helper must execute the candidate Runner module before its health evidence is trusted.
  it("rejects a different module-relative Runner artifact", () => {
    const helperSource = readExternalGatewayHealthHelper();
    expect(helperSource).toContain('  "blueprint-runner.js",');
    const source = helperSource.replace('  "blueprint-runner.js",', '  "other-runner.js",');

    expect(validateExternalGatewayHealthHelper(source)).toContain(
      "external gateway health helper must run exact Blueprint Runner external status",
    );
  });

  // source-shape-contract: security -- The live helper must keep Runner output behind the bounded redacted shell boundary.
  it("rejects a Runner invocation that bypasses the redacted shell fixture", () => {
    const helperSource = readExternalGatewayHealthHelper();
    expect(helperSource).toContain("const result = await shellProbe.run(");
    const source = helperSource.replace(
      "const result = await shellProbe.run(",
      "const result = spawnSync(",
    );

    expect(validateExternalGatewayHealthHelper(source)).toContain(
      "external gateway health helper must run exact Blueprint Runner external status",
    );
  });

  // source-shape-contract: security -- The trusted package job must not give package credentials or candidate code control of the SDK archive.
  it("rejects package credentials or untrusted candidate execution in the package job", () => {
    const workflow = readExternalGatewayHealthWorkflow();
    expect(workflow.jobs).toHaveProperty("package-openshell-sdk");
    const job = workflow.jobs["package-openshell-sdk"];
    job.if = "${{ always() }}";
    job.permissions = { contents: "write", packages: "write" };
    const checkout = job.steps!.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    checkout.with!.ref = "${{ inputs.checkout_sha }}";
    const download = job.steps!.find(
      (step) => step.name === "Download and verify exact OpenShell SDK package",
    )!;
    download.env!.NODE_AUTH_TOKEN = "${{ secrets.PACKAGE_TOKEN }}";

    expect(validateExternalGatewayHealthWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "package-openshell-sdk must run only for the explicit external health selector",
        "package-openshell-sdk must retain its bounded package-read trust boundary",
        "package-openshell-sdk must execute only the trusted sparse package verifier checkout",
        "package-openshell-sdk must scope its package credential to the reviewed downloader",
      ]),
    );
  });

  // source-shape-contract: security -- The live job must run the exact candidate with the reviewed SDK archive and no package credential.
  it("rejects credential exposure and candidate or artifact substitution in the live job", () => {
    const workflow = readExternalGatewayHealthWorkflow();
    expect(workflow.jobs).toHaveProperty("external-gateway-health");
    const job = workflow.jobs["external-gateway-health"];
    job.needs = "generate-matrix";
    delete job.env!.NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST;
    job.env = { ...job.env, GITHUB_TOKEN: "${{ github.token }}" };
    const checkout = job.steps!.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    checkout.with!.ref = "main";
    const download = job.steps!.find(
      (step) => step.name === "Download reviewed OpenShell SDK archive",
    )!;
    download.with!.name = "unreviewed-sdk";
    const install = job.steps!.find(
      (step) => step.name === "Install reviewed OpenShell SDK archive without package credentials",
    )!;
    install.run = "npm install @nvidia/openshell-sdk@latest";
    const run = job.steps!.find((step) => step.name === "Run external gateway health live test")!;
    run.env = { NODE_AUTH_TOKEN: "${{ secrets.PACKAGE_TOKEN }}" };

    expect(validateExternalGatewayHealthWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "external-gateway-health must wait for the candidate CLI and reviewed SDK archive",
        "external-gateway-health must retain NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST=1",
        "external-gateway-health must not expose GITHUB_TOKEN at job scope",
        "external-gateway-health must use the exact candidate checkout without persisted credentials",
        "external-gateway-health must download only this run's reviewed SDK archive",
        "external-gateway-health SDK install must retain: env -u NODE_AUTH_TOKEN -u GITHUB_TOKEN",
        'external-gateway-health SDK install must retain: npm install --no-save --package-lock=false --ignore-scripts "${archives[0]}"',
        "external-gateway-health must run only the credential-free external health test",
      ]),
    );
  });

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
