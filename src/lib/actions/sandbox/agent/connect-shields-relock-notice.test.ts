// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { ShieldsAutoRestoreReadResult } from "../../../shields/audit";
import {
  type ConnectShieldsRelockNoticeState,
  formatConnectShieldsRelockNotice,
  pollConnectShieldsRelockNotice,
  startConnectShieldsRelockWatcher,
} from "./connect-shields-relock-notice";

function state(startedAtMs: number): ConnectShieldsRelockNoticeState {
  return {
    lastNotifiedRestoreMs: startedAtMs - 1,
    sandboxName: "alpha beta",
    startedAtMs,
  };
}

describe("connected-session Shields auto-relock notice", () => {
  it("prints one actionable warning for a new auto-relock event (#9453)", () => {
    const startedAtMs = Date.parse("2026-08-18T17:00:00.000Z");
    const readRecent = vi.fn(() => ({
      kind: "event" as const,
      event: { timestamp: "2026-08-18T17:00:20.000Z", timeoutSeconds: 20 },
    }));
    const writeNotice = vi.fn();

    const afterFirstPoll = pollConnectShieldsRelockNotice(
      state(startedAtMs),
      readRecent,
      writeNotice,
    );
    const afterSecondPoll = pollConnectShieldsRelockNotice(afterFirstPoll, readRecent, writeNotice);

    expect(afterSecondPoll.lastNotifiedRestoreMs).toBe(Date.parse("2026-08-18T17:00:20.000Z"));
    expect(writeNotice).toHaveBeenCalledOnce();
    expect(writeNotice.mock.calls[0]?.[0]).toContain("Shields auto-relocked after 20s");
    expect(writeNotice.mock.calls[0]?.[0]).toContain("restricted operations may now fail");
    expect(writeNotice.mock.calls[0]?.[0]).toContain(
      "nemoclaw 'alpha beta' shields down --timeout 20s",
    );
  });

  it("ignores relock history from before this connected session (#9453)", () => {
    const startedAtMs = Date.parse("2026-08-18T17:00:00.000Z");
    const writeNotice = vi.fn();

    const result = pollConnectShieldsRelockNotice(
      state(startedAtMs),
      () => ({
        kind: "event",
        event: { timestamp: "2026-08-18T16:59:59.999Z", timeoutSeconds: 20 },
      }),
      writeNotice,
    );

    expect(result).toEqual(state(startedAtMs));
    expect(writeNotice).not.toHaveBeenCalled();
  });

  it("keeps the connected session available when audit visibility is degraded (#9453)", () => {
    const startedAtMs = Date.parse("2026-08-18T17:00:00.000Z");
    const writeNotice = vi.fn();

    expect(
      pollConnectShieldsRelockNotice(
        state(startedAtMs),
        () => ({ kind: "unreadable" }),
        writeNotice,
      ),
    ).toEqual(state(startedAtMs));
    expect(writeNotice).not.toHaveBeenCalled();
  });

  it("polls on the parent event loop and stops cleanly (#9453)", () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse("2026-08-18T17:00:00.000Z");
    vi.setSystemTime(startedAtMs);
    const readRecent = vi
      .fn<(sandboxName: string) => ShieldsAutoRestoreReadResult>()
      .mockReturnValueOnce({ kind: "none" })
      .mockReturnValue({
        kind: "event",
        event: { timestamp: "2026-08-18T17:00:00.500Z", timeoutSeconds: 20 },
      });
    const writeNotice = vi.fn();

    const watcher = startConnectShieldsRelockWatcher("alpha", readRecent, writeNotice);
    expect(readRecent).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    expect(writeNotice).toHaveBeenCalledOnce();

    watcher?.stop();
    vi.advanceTimersByTime(2_000);
    expect(readRecent).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("connected-session Shields auto-relock notice line endings", () => {
  it("ends every line with CRLF when the connect child owns the terminal (#9710)", () => {
    const notice = formatConnectShieldsRelockNotice("alpha beta", 20, true);

    expect(notice.split("\n").length - 1).toBe(3);
    expect(notice.match(/\r\n/g)).toHaveLength(3);
    expect(/[^\r]\n/.test(notice)).toBe(false);
  });

  it("ends every line with a bare LF when stderr is a file or pipe (#9710)", () => {
    const notice = formatConnectShieldsRelockNotice("alpha beta", 20, false);

    expect(notice.split("\n").length - 1).toBe(3);
    expect(notice).not.toContain("\r");
  });
});
