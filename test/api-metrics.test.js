// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { parseDockerStats, parsePodmanStats, parsePercent } from "../dist/lib/api-metrics.js";

describe("parsePercent", () => {
  it("parses '1.23%' to 1.23", () => {
    expect(parsePercent("1.23%")).toBe(1.23);
  });

  it("returns 0 for undefined", () => {
    expect(parsePercent(undefined)).toBe(0);
  });

  it("returns 0 for non-numeric string", () => {
    expect(parsePercent("N/A")).toBe(0);
  });
});

describe("parseDockerStats", () => {
  it("parses NDJSON lines into normalized objects", () => {
    const ndjson = [
      JSON.stringify({
        ID: "abc123",
        Name: "my-sandbox",
        CPUPerc: "1.50%",
        MemUsage: "100MiB / 8GiB",
        MemPerc: "1.22%",
        NetIO: "1kB / 500B",
        BlockIO: "0B / 0B",
      }),
    ].join("\n");

    const result = parseDockerStats(ndjson);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "abc123",
      name: "my-sandbox",
      cpuPercent: 1.5,
      memPercent: 1.22,
      memUsage: "100MiB / 8GiB",
      netIO: "1kB / 500B",
      blockIO: "0B / 0B",
    });
  });

  it("skips malformed lines", () => {
    const result = parseDockerStats("not-json\n" + JSON.stringify({ Name: "ok", CPUPerc: "0%" }));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("ok");
  });

  it("returns empty array for empty input", () => {
    expect(parseDockerStats("")).toEqual([]);
  });
});

describe("parsePodmanStats", () => {
  it("parses JSON array into normalized objects", () => {
    const json = JSON.stringify([
      {
        id: "def456",
        name: "my-sandbox",
        cpu_percent: "2.10%",
        mem_usage: "200MiB / 16GiB",
        mem_percent: "1.22%",
        net_io: "2kB / 1kB",
        block_io: "0B / 0B",
      },
    ]);

    const result = parsePodmanStats(json);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "def456",
      name: "my-sandbox",
      cpuPercent: 2.1,
      memUsage: "200MiB / 16GiB",
      memPercent: 1.22,
      netIO: "2kB / 1kB",
    });
  });

  it("returns empty array for malformed JSON", () => {
    expect(parsePodmanStats("not-json")).toEqual([]);
  });

  it("returns empty array for empty array input", () => {
    expect(parsePodmanStats("[]")).toEqual([]);
  });
});
