// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { run } from "./helpers";

describe("tunnel CLI dispatch", () => {
  it("tunnel --help exits 0 and shows tunnel subcommands", () => {
    const r = run("tunnel --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel <start|stop|status>");
    expect(r.out).toContain("tunnel start");
    expect(r.out).toContain("tunnel stop");
    expect(r.out).toContain("tunnel status");
  });

  it("root help shows tunnel status with tunnel start and stop", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("nemoclaw tunnel start");
    expect(r.out).toContain("nemoclaw tunnel stop");
    expect(r.out).toContain("nemoclaw tunnel status");
  });

  it("tunnel start --help exits 0 and shows tunnel usage", () => {
    const r = run("tunnel start --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel start");
    expect(r.out).toContain("Start the cloudflared public-URL tunnel");
  });

  it("deprecated start --help exits 0 and shows alias usage", () => {
    const r = run("start --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("start");
    expect(r.out).toContain("Deprecated alias");
  });

  it("tunnel stop --help exits 0 and shows tunnel usage", () => {
    const r = run("tunnel stop --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel stop");
    expect(r.out).toContain("Stop the cloudflared public-URL tunnel");
  });

  it("tunnel status --help exits 0 and shows tunnel status usage", () => {
    const r = run("tunnel status --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel status");
    expect(r.out).toContain("Show cloudflared public-URL tunnel status");
  });

  it("tunnel status exits 0 and prints cloudflared status", () => {
    const r = run("tunnel status");
    expect(r.code).toBe(0);
    expect(r.out).toContain("cloudflared");
  });

  it("bare tunnel exits 0 and shows tunnel subcommands", () => {
    const r = run("tunnel");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel <start|stop|status>");
    expect(r.out).toContain("tunnel start");
    expect(r.out).toContain("tunnel stop");
    expect(r.out).toContain("tunnel status");
  });

  it("deprecated stop --help exits 0 and shows alias usage", () => {
    const r = run("stop --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("stop");
    expect(r.out).toContain("Deprecated alias");
  });
});
