// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import { createPodmanHostLocalInferenceOperation } from "./podman-host-local-inference";

function runtimeFor(harness: ReturnType<typeof createPodmanHostLocalInferenceTestHarness>) {
  const operation = createPodmanHostLocalInferenceOperation({
    engine: harness.engine,
    env: harness.env,
    acceleration: harness.operationAcceleration,
    authorityStore: harness.authorityStore,
    routeAuthorityStore: harness.routeAuthorityStore,
    onFailureEvidence: harness.onFailureEvidence,
    redactSensitive: harness.redactSensitive,
  });
  return (
    operation.managedRuntime ??
    (() => {
      throw new Error("test operation lacks managed runtime");
    })()
  );
}

describe("Podman published inference resume", () => {
  it("finalizes without writing the published receipt again", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = runtimeFor(harness);
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    const writtenCount = harness.written.length;
    runtime.stopManaged(receipt);

    const resumed = runtime.resumeManaged?.(harness.input, receipt, harness.writer);
    expect(resumed?.finalizePublishedResume).toBeTypeOf("function");
    resumed?.validateBeforeCommit();

    expect(() => resumed?.commit()).toThrow(
      "must finalize a published resume without rewriting its receipt",
    );
    expect(resumed?.publicationState()).toBe("unpublished");
    expect(harness.written).toHaveLength(writtenCount);
    expect(resumed?.finalizePublishedResume?.(() => undefined)).toEqual(receipt);
    expect(resumed?.publicationState()).toBe("published");
    expect(harness.written).toHaveLength(writtenCount);
    expect(harness.container()).toMatchObject({ running: true });
  });

  it("keeps rollback available when final published authority changes", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = runtimeFor(harness);
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    const writtenCount = harness.written.length;
    runtime.stopManaged(receipt);
    const resumed = runtime.resumeManaged?.(harness.input, receipt, harness.writer);
    resumed?.validateBeforeCommit();

    expect(() =>
      resumed?.finalizePublishedResume?.(() => {
        throw new Error("published authority changed");
      }),
    ).toThrow("published authority changed");
    expect(resumed?.publicationState()).toBe("unpublished");
    expect(resumed?.rollback()).toMatchObject({ priorState: "stopped", status: "restored" });
    expect(harness.written).toHaveLength(writtenCount);
    expect(harness.container()).toMatchObject({ running: false, status: "exited" });
  });
});
