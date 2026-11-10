// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { openOpenClawStopFixture } from "../support/windows-native-openclaw-stop-fixtures.js";

describe("native OpenClaw owned shutdown", () => {
  it("stops a live HTTP gateway despite its pending entry import", async () => {
    const fixture = await openOpenClawStopFixture();
    const url = `http://127.0.0.1:${fixture.endpoint.port}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      expect(await response.json()).toEqual({ pid: fixture.child.pid });
      fixture.command();
      expect(await fixture.closed).toBe(0);
      expect(fixture.child.signalCode).toBeNull();
      expect(fixture.stdout()).toContain("BROKER_CLOSED\nSIGNAL_HANDLED\nSERVER_CLOSED");
      await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });

  it.each(["absent", "ignore", "close-blocked"])(
    "fails closed for the %s shutdown path",
    async (mode) => {
      const fixture = await openOpenClawStopFixture(mode);
      try {
        fixture.command();
        expect(await fixture.closed).toBe(1);
        expect(fixture.child.signalCode).toBeNull();
        expect(fixture.stdout()).not.toContain("SERVER_CLOSED");
        await expect(
          fetch(`http://127.0.0.1:${fixture.endpoint.port}`, { signal: AbortSignal.timeout(1000) }),
        ).rejects.toThrow();
      } finally {
        await fixture.close();
      }
    },
  );

  it.each([
    { command: "startup-failure", marker: "OWNED_STARTUP_FAILED" },
    { command: "broker-failure", marker: "OWNED_BROKER_FAILED" },
  ])(
    "preserves $command as nonzero even when graceful shutdown exits zero",
    async ({ command, marker }) => {
      const fixture = await openOpenClawStopFixture();
      try {
        fixture.command(command);
        expect(await fixture.closed).toBe(1);
        expect(fixture.stderr()).toContain(marker);
        expect(fixture.stdout()).toContain("SIGNAL_HANDLED\nSERVER_CLOSED");
      } finally {
        await fixture.close();
      }
    },
  );

  it("keeps broker cleanup failure nonzero after graceful server closure", async () => {
    const fixture = await openOpenClawStopFixture("close-failed");
    try {
      fixture.command();
      expect(await fixture.closed).toBe(1);
      expect(fixture.stderr()).toContain("broker transport also failed to close");
      expect(fixture.stdout()).toContain("SERVER_CLOSED");
    } finally {
      await fixture.close();
    }
  });

  it("preserves a nonzero upstream exit code", async () => {
    const fixture = await openOpenClawStopFixture("nonzero");
    try {
      fixture.command();
      expect(await fixture.closed).toBe(23);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a premature clean exit before the host requested Stop", async () => {
    const fixture = await openOpenClawStopFixture("premature");
    try {
      expect(await fixture.closed).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});
