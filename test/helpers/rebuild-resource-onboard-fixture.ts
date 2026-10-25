// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { Session } from "../../src/lib/state/onboard-session";
import { onboardSession, portableRetirementAuthority, resolve } from "./rebuild-flow-harness";
import type { RebuildFlowHarness } from "./rebuild-flow-test-support";

const core: typeof import("../../src/lib/onboard/machine/core-flow-composition") = require("../../src/lib/onboard/machine/core-flow-composition");
const initial: typeof import("../../src/lib/onboard/machine/initial-flow-composition") = require("../../src/lib/onboard/machine/initial-flow-composition");
const runtime: typeof import("../../src/lib/onboard/resume/locked-runtime") = require("../../src/lib/onboard/resume/locked-runtime");
const bootstrap: typeof import("../../src/lib/onboard/session-bootstrap") = require("../../src/lib/onboard/session-bootstrap");
const registration: typeof import("../../src/lib/onboard/sandbox-registration") = require("../../src/lib/onboard/sandbox-registration");
const resourceSelection: typeof import("../../src/lib/onboard/resource-profile-selection") = require("../../src/lib/onboard/resource-profile-selection");
const childProcess: typeof import("node:child_process") = require("node:child_process");

export const RESOURCE_CREATE_BOUNDARY = "resource create boundary reached";

/**
 * Run the real inner onboard entry and sandbox resource/create-plan path. Host
 * preparation and session persistence use fixtures; stop at createSandbox so
 * this source test never creates a live sandbox or enters agent finalization.
 */
export function installRebuildResourceOnboardFixture(harness: RebuildFlowHarness) {
  const session = harness.session as unknown as Session;
  const onboardPath = require.resolve("../../src/lib/onboard");
  delete require.cache[onboardPath];
  harness.onboardSpy.mockRestore();
  // Disk reads return independent snapshots; the generic handoff fixture shares one object.
  vi.mocked(onboardSession.loadSession).mockImplementation(() => structuredClone(session));
  vi.spyOn(onboardSession, "saveSession").mockImplementation(() => undefined);
  vi.spyOn(onboardSession, "markStepStarted").mockReturnValue(session);
  vi.spyOn(onboardSession, "markStepSkipped").mockReturnValue(session);
  vi.spyOn(onboardSession, "markStepFailed").mockReturnValue(session);
  vi.spyOn(portableRetirementAuthority, "beginPortableOnboardRetirementEntry").mockReturnValue({
    release: () => undefined,
    run: async (operation: () => unknown) => operation(),
    supersede: async () => undefined,
  });
  vi.spyOn(runtime, "prepare").mockResolvedValue({
    checkpointProfile: "default",
    environmentScope: null,
    portableRuntimeContext: null,
  });
  vi.spyOn(bootstrap, "prepareOnboardSessionValidated").mockImplementation(async () => ({
    session,
    fromDockerfile: null,
    fromImage: null,
  }));
  // The outer rebuild harness already supplies the validated provider/model.
  vi.spyOn(initial, "runInitialOnboardFlowSlice").mockImplementation(async ({ context }) => ({
    context: { ...context, sandboxGpuConfig: { sandboxGpuEnabled: false, mode: "0" } },
    session,
  }));
  vi.spyOn(core, "runCoreOnboardFlowSlice").mockImplementation(async ({ context, phases }) => {
    await phases.sandbox.run(context);
    return { context, session };
  });
  vi.spyOn(registration, "withSandboxImageRegistrationFence").mockImplementation(
    async (operation) => operation(),
  );
  vi.mocked(resolve.resolveOpenshell).mockReturnValue("/fixture/openshell");
  vi.spyOn(childProcess, "spawnSync").mockImplementation((command, args) => {
    if (command !== "/fixture/openshell" || !Array.isArray(args) || !args.includes("--help")) {
      throw new Error(`Unexpected resource fixture command: ${command}`);
    }
    return {
      pid: 1,
      signal: null,
      status: 0,
      output: [null, "--cpu --memory", ""],
      stdout: "--cpu --memory",
      stderr: "",
    };
  });
  const selectResourceProfile = vi.spyOn(resourceSelection, "selectResourceProfileForSandbox");
  const compose = core.createCoreOnboardFlowPhases;
  const createSandbox = vi.fn(async (..._args: unknown[]): Promise<string> => {
    throw new Error(RESOURCE_CREATE_BOUNDARY);
  });
  vi.spyOn(core, "createCoreOnboardFlowPhases").mockImplementation((input) =>
    compose({
      ...input,
      sandbox: {
        ...input.sandbox,
        deps: {
          ...input.sandbox.deps,
          getSandboxReuseState: () => "missing",
          getSandboxRecreateObservation: () => ({
            state: "missing",
            liveIdentityFingerprint: null,
          }),
          checkGatewayRouteCompatibility: () => ({ ok: true }),
          planRegisteredExtraProviders: () => ({ extraProviders: [], staleExtraProviders: [] }),
          createSandbox,
        },
      },
    }),
  );
  return {
    createSandbox,
    selectResourceProfile,
    cleanup: () => {
      delete require.cache[onboardPath];
    },
  };
}
