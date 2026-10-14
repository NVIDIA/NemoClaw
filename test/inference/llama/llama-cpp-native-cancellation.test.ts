// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNativeLlamaDockerFixture } from "./llama-cpp-native-cancellation.test-support";

const image = process.env.NEMOCLAW_NATIVE_LLAMA_TEST_IMAGE;
const modelPath = process.env.NEMOCLAW_NATIVE_LLAMA_TEST_MODEL;
const evidencePath = process.env.NEMOCLAW_NATIVE_LLAMA_TEST_EVIDENCE;

// Opt-in native backend qualification uses one owned server and the approved CPU image/GGUF.
describe
  .runIf(Boolean(image && modelPath))
  .sequential("native llama.cpp Docker cancellation", { shuffle: false }, () => {
    let fixture: Awaited<ReturnType<typeof createNativeLlamaDockerFixture>>;
    beforeAll(async () => {
      fixture = await createNativeLlamaDockerFixture(image!, modelPath!, evidencePath);
    }, 60_000);
    afterAll(() => fixture?.close(), 60_000);

    it("rejects a completion without native bearer authentication", async () => {
      const denied = JSON.parse(
        await fixture.finished(
          fixture.client("/v1/chat/completions", fixture.body(false, 16), 10, false),
        ),
      );
      expect(denied.error.code).toBe(401);
      fixture.record.unauthenticatedCompletionStatus = denied.error.code;
      fixture.passed.add("authentication");
    });

    it.each([1, 2, 3, 4, 5])(
      "stops owned remote SSE work and releases native admission promptly [cancellation %s]",
      async (iteration) => {
        const active = await fixture.stream();
        expect((await fixture.metrics())["llamacpp:requests_processing"]).toBe(1);
        const queued = fixture.client("/v1/chat/completions", fixture.body(false, 16));
        let occupied = await fixture.metrics();
        await expect
          .poll(
            async () => {
              occupied = await fixture.metrics();
              return occupied["llamacpp:requests_deferred"];
            },
            { timeout: 5_000, interval: 20 },
          )
          .toBe(1);
        expect(occupied["llamacpp:requests_processing"]).toBe(1);
        fixture.owned(active.id);
        const cancelledAt = performance.now();
        fixture.capture(["kill", "--signal", "KILL", active.id]);
        await fixture.finished(active, 137);
        expect(JSON.parse(await fixture.finished(queued)).usage.completion_tokens).toBe(16);
        const recoveryMilliseconds = performance.now() - cancelledAt;
        expect(recoveryMilliseconds).toBeLessThan(fixture.normalLatencyBound);
        const stopped = await fixture.idle();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const stable = await fixture.metrics();
        expect(stable["llamacpp:requests_processing"]).toBe(0);
        expect(stable["llamacpp:requests_deferred"]).toBe(0);
        expect(stable["llamacpp:n_decode_total"]).toBe(stopped["llamacpp:n_decode_total"]);
        (fixture.record.cancellations as unknown[]).push({
          iteration,
          clientId: active.id,
          recoveryMilliseconds,
          occupied,
          stopped,
          stable,
          remoteClientExited: true,
        });
        fixture.passed.add("cancellation-" + iteration);
      },
      20_000,
    );

    it("stops native work after the remote client deadline and recovers normal latency", async () => {
      const deadlineRequest = await fixture.stream(0.5);
      await fixture.finished(deadlineRequest, 28);
      const stopped = await fixture.idle();
      const afterDeadlineMilliseconds = await fixture.complete();
      expect(afterDeadlineMilliseconds).toBeLessThan(fixture.normalLatencyBound);
      fixture.record.deadline = {
        stopped,
        nextCompletionMilliseconds: afterDeadlineMilliseconds,
        remoteClientExited: true,
      };
      fixture.passed.add("deadline");
    }, 20_000);

    it("terminates the exact native server and active client on Docker shutdown", async () => {
      const shutdownRequest = await fixture.stream();
      fixture.owned(fixture.server);
      const shutdownAt = performance.now();
      fixture.capture(["stop", "--time", "5", fixture.server]);
      const state = fixture.owned(fixture.server).State;
      expect(state.Running).toBe(false);
      expect(state.Pid).toBe(0);
      await expect
        .poll(() => fixture.owned(shutdownRequest.id).State.Running, { timeout: 5_000 })
        .toBe(false);
      const clientState = fixture.owned(shutdownRequest.id).State;
      expect(clientState.Running).toBe(false);
      expect(clientState.Pid).toBe(0);
      fixture.record.shutdown = { milliseconds: performance.now() - shutdownAt, state };
      fixture.passed.add("shutdown");
    }, 20_000);
  });
