// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  bestEffortForwardStop,
  bestEffortForwardStopForSandbox,
} from "../../../dist/lib/onboard/forward-cleanup";

function forwardListWith(
  entries: Array<{ sandbox: string; port: number; status?: string }>,
): string {
  const header = "SANDBOX   BIND        PORT   PID    STATUS";
  const rows = entries.map(
    (e) => `${e.sandbox}  127.0.0.1   ${e.port}   1234   ${e.status ?? "running"}`,
  );
  return [header, ...rows].join("\n");
}

describe("bestEffortForwardStop", () => {
  it("invokes `forward stop` with the port and silently ignores errors", () => {
    const run = vi.fn();
    bestEffortForwardStop(run, 18789);
    expect(run).toHaveBeenCalledWith(["forward", "stop", "18789"], {
      ignoreError: true,
      suppressOutput: true,
    });
  });
});

describe("bestEffortForwardStopForSandbox", () => {
  it("returns owned-other and skips stop when the port belongs to a different sandbox", () => {
    const run = vi.fn();
    const fetch = vi
      .fn()
      .mockReturnValue(forwardListWith([{ sandbox: "other-sandbox", port: 18789 }]));

    const outcome = bestEffortForwardStopForSandbox(run, fetch, 18789, "my-sandbox");

    expect(outcome).toBe("owned-other");
    expect(run).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      ["forward", "list"],
      expect.objectContaining({ timeout: 15_000 }),
    );
    // Caller must NOT pass ignoreError; failures should throw so the catch
    // branch returns "list-failed" instead of running a stop with no owner data.
    expect(fetch).not.toHaveBeenCalledWith(
      ["forward", "list"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("returns stopped and uses the sandbox-scoped forward stop form when ownership matches", () => {
    const run = vi.fn();
    const fetch = vi
      .fn()
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));

    const outcome = bestEffortForwardStopForSandbox(run, fetch, 18789, "my-sandbox");

    expect(outcome).toBe("stopped");
    // Sandbox-scoped stop closes the TOCTOU window between list and stop:
    // even if another sandbox bound the port in the meantime, openshell
    // forward stop with both args will refuse to kill it.
    expect(run).toHaveBeenCalledWith(["forward", "stop", "18789", "my-sandbox"], {
      ignoreError: true,
      suppressOutput: true,
    });
  });

  it("returns no-entry and runs a sandbox-scoped stop when no live forward is on that port", () => {
    const run = vi.fn();
    const fetch = vi.fn().mockReturnValue(forwardListWith([]));

    const outcome = bestEffortForwardStopForSandbox(run, fetch, 18789, "my-sandbox");

    expect(outcome).toBe("no-entry");
    expect(run).toHaveBeenCalledWith(["forward", "stop", "18789", "my-sandbox"], {
      ignoreError: true,
      suppressOutput: true,
    });
  });

  it("skips the stop entirely when `forward list` itself throws (owner unknown)", () => {
    const run = vi.fn();
    const fetch = vi.fn().mockImplementation(() => {
      throw new Error("gateway timed out");
    });

    const outcome = bestEffortForwardStopForSandbox(run, fetch, 18789, "my-sandbox");

    expect(outcome).toBe("list-failed");
    // Without ownership data, a port-only stop could kill another
    // sandbox's forward — better to leave the port alone and let the
    // helper's retry / next poll observe the real state.
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores forwards with non-live status when deciding ownership", () => {
    // `getOccupiedPorts` filters by `isLiveForwardStatus`, so a "stopped"
    // entry on the requested port should be treated as no-entry (not as a
    // foreign owner).
    const run = vi.fn();
    const fetch = vi
      .fn()
      .mockReturnValue(
        forwardListWith([{ sandbox: "other-sandbox", port: 18789, status: "stopped" }]),
      );

    const outcome = bestEffortForwardStopForSandbox(run, fetch, 18789, "my-sandbox");

    expect(outcome).toBe("no-entry");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
