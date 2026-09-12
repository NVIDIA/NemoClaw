// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import { createMxcNativeArtifactBootstrapSurface } from "../../../src/lib/onboard/runtime-provider/mxc-bootstrap.ts";
import {
  mxcOpenShellAttachmentDigestMap,
  mxcOpenShellAttachmentObservationRequest,
  mxcOpenShellDistributionTestFixture,
} from "../../../src/lib/onboard/runtime-provider/mxc-openshell-attachment-test-fixture.ts";
import type { MxcWindowsOpenShellExecutorRuntime } from "../../../src/lib/onboard/runtime-provider/mxc-windows-openshell-executor.ts";
import { nativeArtifactWorkloadReceiptFixture } from "../../../src/lib/onboard/workload/native-artifact-test-fixture.ts";
import {
  createWindowsMxcInactiveOnboardingComposition,
  createWindowsMxcInactiveOnboardingLifecycle,
  type WindowsMxcInactiveOnboardingCompositionInput,
} from "../live/windows-mxc-inactive-onboarding-composition.ts";

const REQUIRED_ENVIRONMENT = [
  "HOME",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
] as const;

function missingTestDigest(): never {
  throw new Error("unknown test path");
}

function bootstrap() {
  const workload = nativeArtifactWorkloadReceiptFixture(
    encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
  );
  return {
    sandboxName: "alpha",
    lifecycleGeneration: "generation-7",
    driveRoot: "C:\\",
    artifactRoot: "C:\\openclaw-2026-7-1",
    workload: {
      ...workload,
      launch: { ...workload.launch, environmentNames: REQUIRED_ENVIRONMENT },
    },
  } as const;
}

function executorRuntime(): MxcWindowsOpenShellExecutorRuntime {
  const digests = mxcOpenShellAttachmentDigestMap();
  return {
    platform: "win32",
    environment: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      GITHUB_TOKEN: "must-not-reach-openshell",
      NVIDIA_API_KEY: "must-not-reach-openshell",
      OPENAI_API_KEY: "must-not-reach-openshell",
      OPENCLAW_GATEWAY_TOKEN: "must-not-reach-openshell",
    },
    observeFileDigest: vi.fn(async (filePath) => {
      return digests.get(filePath) ?? missingTestDigest();
    }),
    observeArtifactTree: vi.fn(() => ({
      directories: ["C:\\openclaw-2026-7-1"],
      files: [
        {
          path: "C:\\openclaw-2026-7-1\\node\\node.exe",
          sha256: "c".repeat(64),
        },
      ],
      sha256: "a".repeat(64),
    })),
    acquirePins: vi.fn(async () => ({
      isActive: () => true,
      waitForLoss: () => new Promise<void>(() => undefined),
      release: async () => undefined,
    })),
    runCommand: vi.fn(async () => ({ status: null, stdout: "", stderr: "" })),
  };
}

function argumentValue(argumentsList: readonly string[], name: string): string {
  const index = argumentsList.indexOf(name);
  return argumentsList[index + 1] ?? `missing-${name}`;
}

function sandboxFromCreate(argumentsList: readonly string[]) {
  const assignments = argumentsList.flatMap((argument, index) =>
    argument === "--label" ? [argumentsList[index + 1] ?? ""] : [],
  );
  const labels = Object.fromEntries(
    assignments.map((assignment) => {
      const separator = assignment.indexOf("=");
      return [assignment.slice(0, separator), assignment.slice(separator + 1)];
    }),
  );
  return {
    id: "sandbox-id-1",
    labels,
    name: argumentValue(argumentsList, "--name"),
    phase: "Pending",
    workspace: argumentValue(argumentsList, "--workspace"),
  };
}

async function runComposedBootstrap(runtime: MxcWindowsOpenShellExecutorRuntime) {
  const composed = await createWindowsMxcInactiveOnboardingComposition(compositionInput(runtime));
  const surface = createMxcNativeArtifactBootstrapSurface(
    composed.installation.bootstrapControlPlane,
  );
  return await surface.run({ providerId: "mxc", ...bootstrap() });
}

function compositionInput(
  runtime: MxcWindowsOpenShellExecutorRuntime,
): WindowsMxcInactiveOnboardingCompositionInput {
  const distribution = mxcOpenShellDistributionTestFixture();
  return {
    distributionAuthority: distribution.authority,
    attachmentObservation: mxcOpenShellAttachmentObservationRequest(distribution.observation),
    gatewayName: "local",
    workspace: "default",
    policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
    bootstrap: bootstrap(),
    executorRuntime: runtime,
  };
}

async function issuedPlan() {
  let issued:
    | Parameters<
        Awaited<
          ReturnType<typeof createWindowsMxcInactiveOnboardingComposition>
        >["installation"]["bootstrapControlPlane"]["verifyAndCreate"]
      >[0]
    | undefined;
  const surface = createMxcNativeArtifactBootstrapSurface({
    verifyAndCreate: async (plan) => {
      issued = plan;
      return { status: "not-created", reason: "create-rejected" };
    },
    verifyReadiness: async () => {
      throw new Error("unreachable");
    },
    recoverCreate: async () => ({ status: "absent" }),
  });
  await surface.run({ providerId: "mxc", ...bootstrap() });
  return issued!;
}

describe("inactive Windows MXC qualification composition", () => {
  it("keeps the physical qualification target on the provider-owned composition (#10585)", () => {
    const physicalTarget = fs.readFileSync(
      new URL("../live/windows-mxc-openclaw-process-container-helpers.ts", import.meta.url),
      "utf8",
    );

    expect(physicalTarget).toContain("createWindowsMxcInactiveOnboardingLifecycle");
    expect(physicalTarget).not.toMatch(
      /runOpenShellCommand\(\s*\[\s*"sandbox"\s*,\s*"(?:create|delete|get|list)"/u,
    );
  });

  it("binds the accepted attachment, trusted executor, and request-scoped create (#10585)", async () => {
    const runtime = executorRuntime();
    const input = compositionInput(runtime);
    const composed = await createWindowsMxcInactiveOnboardingLifecycle(input).qualify();

    await expect(
      composed.installation.bootstrapControlPlane.verifyAndCreate(await issuedPlan()),
    ).resolves.toEqual({ status: "unknown" });

    expect(composed.installation.openshellDistributionAuthority).toBe(input.distributionAuthority);
    expect(composed.installation.attachmentObservation).toBe(input.attachmentObservation);
    expect(runtime.runCommand).toHaveBeenCalledOnce();
    const [command, environment] = vi.mocked(runtime.runCommand).mock.calls[0]!;
    expect(command.executablePath).toMatch(/openshell[.]exe$/u);
    expect(command.arguments).toEqual(
      expect.arrayContaining(["sandbox", "create", "--driver-config-json"]),
    );
    expect(JSON.stringify(environment)).not.toContain("must-not-reach-openshell");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("rejects attachment drift before composing a mutable control plane (#10585)", async () => {
    const runtime = executorRuntime();
    vi.mocked(runtime.observeFileDigest).mockResolvedValue("f".repeat(64));

    await expect(
      createWindowsMxcInactiveOnboardingComposition(compositionInput(runtime)),
    ).rejects.toThrow(/does not match the accepted identity/u);
    expect(runtime.acquirePins).not.toHaveBeenCalled();
    expect(runtime.runCommand).not.toHaveBeenCalled();
  });

  it("reconciles ambiguous creation without issuing a second create (#10585)", async () => {
    const runtime = executorRuntime();
    vi.mocked(runtime.runCommand).mockImplementation(async (command) => {
      const operation = command.arguments[command.arguments.indexOf("sandbox") + 1];
      const outcomes = {
        create: { status: null, stdout: "", stderr: "" },
        get: { status: 1, stdout: "", stderr: "" },
        list: { status: 0, stdout: "[]", stderr: "" },
      } as const;
      return (
        outcomes[operation as keyof typeof outcomes] ?? {
          status: 1,
          stdout: "",
          stderr: `unexpected operation ${operation}`,
        }
      );
    });

    await expect(runComposedBootstrap(runtime)).resolves.toMatchObject({
      outcome: "not-created",
      reason: "recovered",
      resourceState: "absent",
      cleanup: { attempted: true, resourceRemovalAuthorized: true, removed: true },
    });
    const commands = vi.mocked(runtime.runCommand).mock.calls.map(([command]) => command);
    expect(
      commands.filter(
        (command) => command.arguments[command.arguments.indexOf("sandbox") + 1] === "create",
      ),
    ).toHaveLength(1);
    expect(commands.some((command) => command.arguments.includes("list"))).toBe(true);
  });

  it("reports a possibly retained sandbox when identity-guarded deletion fails (#10585)", async () => {
    const runtime = executorRuntime();
    let candidate: ReturnType<typeof sandboxFromCreate> | undefined;
    vi.mocked(runtime.runCommand).mockImplementation(async (command) => {
      const operation = command.arguments[command.arguments.indexOf("sandbox") + 1];
      const actions = {
        create: () => {
          candidate = sandboxFromCreate(command.arguments);
          return { status: null, stdout: "", stderr: "" };
        },
        get: () => ({ status: 1, stdout: "", stderr: "" }),
        list: () => ({ status: 0, stdout: JSON.stringify([candidate]), stderr: "" }),
      } as const;
      return (
        actions[operation as keyof typeof actions] ??
        (() => ({
          status: 1,
          stdout: "",
          stderr: `unexpected operation ${operation}`,
        }))
      )();
    });

    await expect(runComposedBootstrap(runtime)).resolves.toMatchObject({
      outcome: "retained",
      reason: "recovery-not-proven",
      resourceState: "possibly-retained",
      cleanup: { attempted: true, resourceRemovalAuthorized: true, removed: false },
      recoveryRequired: true,
    });
    const commands = vi.mocked(runtime.runCommand).mock.calls.map(([command]) => command);
    expect(commands.filter((command) => command.arguments.includes("create"))).toHaveLength(1);
    const deleteCommand = commands.find((command) => command.arguments.includes("delete"));
    expect(deleteCommand?.arguments).toEqual(
      expect.arrayContaining(["sandbox", "delete", "alpha", "--expected-id", "sandbox-id-1"]),
    );
  });
});
