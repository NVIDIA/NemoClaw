// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  installPrependedExitAndSignalRecovery,
  installRetainedResourceSignalCleanup,
  type RebuildProcessEvents,
} from "./rebuild-signal-cleanup";

function fakeProcessEvents(): EventEmitter & RebuildProcessEvents {
  return new EventEmitter() as EventEmitter & RebuildProcessEvents;
}

describe("rebuild signal cleanup", () => {
  it("re-raises the signal even when retained-resource cleanup throws (#6195)", () => {
    const events = fakeProcessEvents();
    const kill = vi.fn();
    const reportError = vi.fn();
    installRetainedResourceSignalCleanup(
      () => {
        throw new Error("secret-looking cleanup failure");
      },
      { events, kill, pid: 42, reportError },
    );

    events.emit("SIGINT");

    expect(reportError).toHaveBeenCalledWith("secret-looking cleanup failure");
    expect(kill).toHaveBeenCalledWith(42, "SIGINT");
    expect(events.listenerCount("SIGINT")).toBe(0);
    expect(events.listenerCount("SIGTERM")).toBe(0);
  });

  it("allows later signal handlers to run when prepended recovery throws (#6195)", () => {
    const events = fakeProcessEvents();
    const laterHandler = vi.fn();
    const reportError = vi.fn();
    installPrependedExitAndSignalRecovery(
      () => {
        throw new Error("relock failed");
      },
      { events, reportError },
    );
    events.once("SIGTERM", laterHandler);

    events.emit("SIGTERM");

    expect(reportError).toHaveBeenCalledWith("relock failed");
    expect(laterHandler).toHaveBeenCalledOnce();
    expect(events.listenerCount("exit")).toBe(0);
  });

  it("disarms every registered listener idempotently (#6195)", () => {
    const events = fakeProcessEvents();
    const recover = vi.fn();
    const remove = installPrependedExitAndSignalRecovery(recover, { events });

    remove();
    remove();
    events.emit("exit");

    expect(recover).not.toHaveBeenCalled();
    expect(events.listenerCount("SIGINT")).toBe(0);
    expect(events.listenerCount("SIGTERM")).toBe(0);
  });
});
