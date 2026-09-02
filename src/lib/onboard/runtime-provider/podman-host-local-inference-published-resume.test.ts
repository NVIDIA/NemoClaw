// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import {
  createPodmanHostLocalInferenceOperation,
  type PodmanPublishedResumeTiming,
} from "./podman-host-local-inference";

function runtimeFor(
  harness: ReturnType<typeof createPodmanHostLocalInferenceTestHarness>,
  publishedResumeTiming?: PodmanPublishedResumeTiming,
) {
  const operation = createPodmanHostLocalInferenceOperation({
    engine: harness.engine,
    env: harness.env,
    acceleration: harness.operationAcceleration,
    probeCleanupTiming: harness.probeCleanupTiming,
    authorityStore: harness.authorityStore,
    routeAuthorityStore: harness.routeAuthorityStore,
    onFailureEvidence: harness.onFailureEvidence,
    redactSensitive: harness.redactSensitive,
    ...(publishedResumeTiming ? { publishedResumeTiming } : {}),
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

  it("aggregates both proof passes and emits timing only after published finalization", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const onComplete = vi.fn();
    let now = 0;
    const runtime = runtimeFor(harness, {
      now: () => {
        now += 1;
        const generatedProofs = harness.events.filter((event) =>
          event.includes("/v1/chat/completions"),
        ).length;
        return generatedProofs * 1_000 + now;
      },
      onComplete,
    });
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    runtime.stopManaged(receipt);
    harness.events.splice(0);

    const resumed = runtime.resumeManaged?.(harness.input, receipt, harness.writer);

    expect(resumed).toBeDefined();
    expect(onComplete).not.toHaveBeenCalled();
    resumed?.validateBeforeCommit();
    expect(onComplete).not.toHaveBeenCalled();
    expect(harness.events.filter((event) => event.includes("/v1/chat/completions"))).toHaveLength(
      2,
    );
    resumed?.finalizePublishedResume?.(() => undefined);
    expect(onComplete).toHaveBeenCalledOnce();
    const evidence = onComplete.mock.calls[0]?.[0];
    expect(Object.keys(evidence).sort()).toEqual([
      "cleanupCurrentnessMs",
      "generatedProofMs",
      "gpuIdentityMs",
      "managedReadyMs",
      "modelPlacementMs",
      "runtimeAction",
      "startMs",
      "totalMs",
    ]);
    expect(evidence).toMatchObject({ runtimeAction: "started" });
    expect(evidence.generatedProofMs).toBeGreaterThanOrEqual(2_000);
    expect(
      Object.entries(evidence)
        .filter(([key]) => key.endsWith("Ms"))
        .every(([, value]) => typeof value === "number" && value >= 0),
    ).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain(harness.input.model);
    expect(JSON.stringify(evidence)).not.toContain(harness.input.containerName);
  });

  it("does not emit successful timing when published finalization fails", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const onComplete = vi.fn();
    const runtime = runtimeFor(harness, { onComplete });
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    runtime.stopManaged(receipt);

    const resumed = runtime.resumeManaged?.(harness.input, receipt, harness.writer);
    resumed?.validateBeforeCommit();

    expect(() =>
      resumed?.finalizePublishedResume?.(() => {
        throw new Error("published authority changed");
      }),
    ).toThrow("published authority changed");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("keeps published recovery unchanged when the timing clock and writer fail", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = runtimeFor(harness, {
      now: () => {
        throw new Error("timing clock failed");
      },
      onComplete: () => {
        throw new Error("timing writer failed");
      },
    });
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    runtime.stopManaged(receipt);

    const resumed = runtime.resumeManaged?.(harness.input, receipt, harness.writer);

    expect(resumed).toBeDefined();
    expect(resumed?.validateBeforeCommit()).toEqual(receipt);
    expect(resumed?.finalizePublishedResume?.(() => undefined)).toEqual(receipt);
    expect(resumed?.publicationState()).toBe("published");
    expect(harness.container()).toMatchObject({ running: true });
  });
});
