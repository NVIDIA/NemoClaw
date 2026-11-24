// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEATHER_RESPONSE_VALIDATION_PYTHON } from "../live/common-egress-agent-helpers.ts";

import {
  runOpenClawAgentAssertion,
  captureWeatherProofFailureProbe,
} from "../live/openclaw-agent-assertion.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";

describe("weather response proof", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "nemoclaw-weather-proof-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function validate(body: unknown): void {
    const path = join(directory, "response.json");
    writeFileSync(path, JSON.stringify(body));
    execFileSync("python3", ["-c", WEATHER_RESPONSE_VALIDATION_PYTHON, path], { stdio: "pipe" });
  }

  function response() {
    return {
      latitude: 37.7749,
      longitude: -122.4194,
      current: { temperature_2m: 12.3, time: "2026-11-02T12:00" },
      current_units: { temperature_2m: "°C" },
    };
  }

  it("accepts a finite Celsius temperature for the requested location", () => {
    expect(() => validate(response())).not.toThrow();
  });

  it.each([
    ["a reply token", "WEATHER_AGENT_OK"],
    ["an empty object", {}],
    ["another location", { ...response(), latitude: 40 }],
    ["another longitude", { ...response(), longitude: 122.4194 }],
    [
      "a string temperature",
      { ...response(), current: { ...response().current, temperature_2m: "12" } },
    ],
    [
      "a Boolean temperature",
      { ...response(), current: { ...response().current, temperature_2m: true } },
    ],
    ["a missing time", { ...response(), current: { temperature_2m: 12 } }],
    ["an empty time", { ...response(), current: { ...response().current, time: "" } }],
    ["a different unit", { ...response(), current_units: { temperature_2m: "°F" } }],
    ["a missing temperature", { ...response(), current: { time: response().current.time } }],
  ])("rejects %s", (_label, body) => {
    expect(() => validate(body)).toThrow();
  });

  async function diagnose(path: string) {
    const exec = vi.fn(async (_name: string, command: string[]) => {
      const child = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", timeout: 2_000 });
      return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr };
    });
    const writeJson = vi.fn().mockResolvedValue("");
    await captureWeatherProofFailureProbe(
      { exec } as unknown as SandboxClient,
      { writeJson } as unknown as ArtifactSink,
      "weather-sandbox",
      path,
    );
    expect(exec).toHaveBeenCalledWith(
      "weather-sandbox",
      expect.any(Array),
      expect.objectContaining({ persistArtifacts: false, timeoutMs: 10_000 }),
    );
    return writeJson.mock.calls[0]?.[1];
  }

  it("records a validated weather hash without publishing the response", async () => {
    const path = join(directory, "public-proof.json");
    const body = JSON.stringify({ ...response(), privateDetail: "weather-private-sentinel" });
    writeFileSync(path, body);
    const evidence = await diagnose(path);
    expect(evidence).toEqual({
      schemaVersion: 1,
      state: "valid",
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    expect(JSON.stringify(evidence)).not.toContain("weather-private-sentinel");
  });

  it("records a missing proof without creating it", async () => {
    expect(await diagnose(join(directory, "missing.json"))).toEqual({
      schemaVersion: 1,
      state: "absent",
      sha256: null,
    });
  });

  it.each([
    ["private malformed JSON", "weather-private-sentinel"],
    ["wrong coordinates", JSON.stringify({ ...response(), latitude: 40 })],
    [
      "string temperature",
      JSON.stringify({ ...response(), current: { ...response().current, temperature_2m: "12" } }),
    ],
    [
      "Boolean temperature",
      JSON.stringify({ ...response(), current: { ...response().current, temperature_2m: true } }),
    ],
  ])("keeps %s invalid and omits its body", async (_label, body) => {
    const path = join(directory, "invalid.json");
    writeFileSync(path, body!);
    expect(await diagnose(path)).toEqual({ schemaVersion: 1, state: "invalid", sha256: null });
  });

  it("does not follow a proof symlink", async () => {
    const target = join(directory, "target.json");
    const link = join(directory, "symlink.json");
    writeFileSync(target, JSON.stringify(response()));
    symlinkSync(target, link);
    expect(await diagnose(link)).toEqual({ schemaVersion: 1, state: "unreadable", sha256: null });
  });

  it("does not block on a proof FIFO", async () => {
    const path = join(directory, "fifo");
    execFileSync("mkfifo", [path]);
    expect(await diagnose(path)).toEqual({ schemaVersion: 1, state: "non-regular", sha256: null });
  });

  it("refuses an oversized proof without returning its hash", async () => {
    const path = join(directory, "oversized.json");
    writeFileSync(path, "x".repeat(65_537));
    expect(await diagnose(path)).toEqual({ schemaVersion: 1, state: "oversized", sha256: null });
  });

  it.each([
    { exitCode: 0, stdout: "weather-private-sentinel" },
    {
      exitCode: 1,
      stdout: '{"schemaVersion":1,"state":"valid","sha256":"weather-private-sentinel"}',
    },
    {
      exitCode: 0,
      stdout: '{"schemaVersion":1,"state":"valid","sha256":"weather-private-sentinel"}',
    },
    { exitCode: 0, stdout: '{"schemaVersion":1,"state":"weather-private-sentinel"}' },
  ])("discards invalid command output %#", async (result) => {
    const writeJson = vi.fn().mockResolvedValue("");
    await captureWeatherProofFailureProbe(
      { exec: vi.fn().mockResolvedValue(result) } as unknown as SandboxClient,
      { writeJson } as unknown as ArtifactSink,
      "weather-sandbox",
      "/tmp/public-proof.json",
    );
    expect(writeJson).toHaveBeenCalledWith("actions/c1-weather-failed-turn-proof.json", {
      schemaVersion: 1,
      state: "unavailable",
      sha256: null,
    });
  });

  it("does not throw when execution and artifact storage both fail", async () => {
    await expect(
      captureWeatherProofFailureProbe(
        {
          exec: vi.fn().mockRejectedValue(new Error("weather-private-sentinel")),
        } as unknown as SandboxClient,
        {
          writeJson: vi.fn().mockRejectedValue(new Error("weather-private-sentinel")),
        } as unknown as ArtifactSink,
        "weather-sandbox",
        "/tmp/public-proof.json",
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps the original failed weather verdict after collecting proof and a separate HTTP observation", async () => {
    const writeJson = vi.fn().mockResolvedValue("");
    const result = { exitCode: 1, stdout: "wrong reply", stderr: "", signal: null, timedOut: true };
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ schemaVersion: 1, state: "valid", sha256: "a".repeat(64) }),
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "200", signal: null, timedOut: false });
    const command = vi.fn().mockResolvedValue(result);
    await expect(
      runOpenClawAgentAssertion(
        { command } as unknown as HostCliClient,
        {
          exec,
          openshell: vi
            .fn()
            .mockResolvedValue({ exitCode: 0, stdout: "Host weather\n  HostName localhost\n" }),
        } as unknown as SandboxClient,
        { writeJson } as unknown as ArtifactSink,
        {
          apiKey: "weather-private-sentinel",
          expected: "WEATHER_AGENT_OK",
          failureWeatherProofPath: "/tmp/public-proof.json",
          label: "weather",
          prompt: "run the fixed weather command",
          sandboxName: "weather-sandbox",
        },
      ),
    ).rejects.toThrow(/weather: expected WEATHER_AGENT_OK/);
    expect(command).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(writeJson).toHaveBeenCalledWith("actions/c1-weather-failed-turn-proof.json", {
      schemaVersion: 1,
      state: "valid",
      sha256: "a".repeat(64),
    });
    expect(writeJson).toHaveBeenCalledWith(
      "actions/weather-separate-http-probe.json",
      expect.objectContaining({ source: "separate-sandbox-curl-request", httpStatus: 200 }),
    );
  });
});
