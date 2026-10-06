// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runAsync } from "./helpers";

vi.setConfig({ maxConcurrency: 4 });

describe.concurrent("tunnel CLI dispatch", () => {
  it("tunnel --help exits 0 and shows tunnel subcommands", async () => {
    const r = await runAsync("tunnel --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel <start|stop|status>");
    expect(r.out).toContain("tunnel start");
    expect(r.out).toContain("tunnel stop");
    expect(r.out).toContain("tunnel status");
  });

  it("root help shows tunnel status with tunnel start and stop", async () => {
    const r = await runAsync("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("nemoclaw tunnel start");
    expect(r.out).toContain("nemoclaw tunnel stop");
    expect(r.out).toContain("nemoclaw tunnel status");
  });

  it("tunnel start --help exits 0 and shows tunnel usage", async () => {
    const r = await runAsync("tunnel start --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel start");
    expect(r.out).toContain("Start the cloudflared public-URL tunnel");
  });

  it("deprecated start --help exits 0 and describes migration-only behavior", async () => {
    const r = await runAsync("start --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("this command does not");
    expect(r.out).toContain("start a sandbox or public-URL tunnel");
    expect(r.out).toContain("nemoclaw <name> start");
    expect(r.out).toContain("nemoclaw tunnel start");
  });

  it("deprecated start exits 0 with sandbox-scoped migration guidance (#9303)", async () => {
    const r = await runAsync("start 2>&1");
    expect(r.code).toBe(0);
    expect(r.out).toContain("nemoclaw <name> start");
    expect(r.out).toContain("nemoclaw tunnel start");
  });

  it("tunnel stop --help exits 0 and shows tunnel usage", async () => {
    const r = await runAsync("tunnel stop --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel stop");
    expect(r.out).toContain("Stop the cloudflared public-URL tunnel");
  });

  it("tunnel status --help exits 0 and shows tunnel status usage", async () => {
    const r = await runAsync("tunnel status --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel status");
    expect(r.out).toContain("Show cloudflared public-URL tunnel status");
  });

  it("tunnel status exits 0 and prints cloudflared status", async () => {
    const r = await runAsync("tunnel status");
    expect(r.code).toBe(0);
    expect(r.out).toContain("cloudflared");
  });

  it("bare tunnel exits 0 and shows tunnel subcommands", async () => {
    const r = await runAsync("tunnel");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel <start|stop|status>");
    expect(r.out).toContain("tunnel start");
    expect(r.out).toContain("tunnel stop");
    expect(r.out).toContain("tunnel status");
  });

  it("deprecated stop --help exits 0 and explains legacy full-stop behavior", async () => {
    const r = await runAsync("stop --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("stop");
    expect(r.out).toContain("Deprecated full stop");
    expect(r.out).toContain("releases the managed host gateway port");
  });
});
