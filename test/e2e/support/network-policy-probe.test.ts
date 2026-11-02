// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import {
  buildNetworkPolicyRequest,
  isNetworkPolicyDenial,
  NETWORK_POLICY_RESULT_PREFIX,
} from "./network-policy-probe.ts";

function executeProbe(url = "https://example.com/") {
  const request = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  request.destroy = vi.fn((error: Error) => request.emit("error", error));
  const output: string[] = [];
  const get = vi.fn(
    (
      _url: URL,
      _options: object,
      _callback: (
        response: EventEmitter & { statusCode: number; setEncoding: (encoding: string) => void },
      ) => void,
    ) => request,
  );
  const deadline = vi.fn((_callback: () => void, _delay: number) => undefined);
  vm.runInNewContext(buildNetworkPolicyRequest(url)[2]!, {
    URL,
    require: vi.fn(() => ({ get })),
    console: { log: (line: string) => output.push(line) },
    setTimeout: deadline,
    clearTimeout: vi.fn(),
  });
  return { request, output, get, deadline };
}

const denialResult = (record: unknown) => ({
  exitCode: 0,
  stdout: NETWORK_POLICY_RESULT_PREFIX + JSON.stringify(record),
});

describe("native network policy probe", () => {
  it("executes one URL argument without shell interpretation and preserves connect EACCES", () => {
    const url = "http://host.openshell.internal:1234/'; echo UNSAFE";
    const probe = executeProbe(url);
    probe.request.emit("error", { code: "EACCES", syscall: "connect" });
    expect(buildNetworkPolicyRequest(url).slice(0, 2)).toEqual(["/usr/local/bin/node", "-e"]);
    expect(probe.get.mock.calls[0]?.[0].href).toBe(new URL(url).href);
    expect(probe.get.mock.calls[0]?.[1]).toEqual({ autoSelectFamily: false });
    expect(isNetworkPolicyDenial({ exitCode: 0, stdout: probe.output.join("\n") })).toBe(true);
  });

  it.each([
    [200, "allowed marker", false],
    [403, "policy_denied", true],
  ])("retains HTTP status %s and response body", (status, body, denied) => {
    const probe = executeProbe();
    const response = Object.assign(new EventEmitter(), {
      statusCode: status,
      setEncoding: vi.fn(),
    });
    probe.get.mock.calls[0]![2](response);
    response.emit("data", body);
    response.emit("end");
    expect(probe.output.join("\n")).toContain(body);
    expect(isNetworkPolicyDenial({ exitCode: 0, stdout: probe.output.join("\n") })).toBe(denied);
  });

  it("rejects an oversized response without treating truncation as policy denial", () => {
    const probe = executeProbe();
    const response = Object.assign(new EventEmitter(), { statusCode: 403, setEncoding: vi.fn() });
    probe.get.mock.calls[0]![2](response);
    response.emit("data", "x".repeat(65537));
    expect(probe.request.destroy).toHaveBeenCalledOnce();
    expect(isNetworkPolicyDenial({ exitCode: 0, stdout: probe.output.join("\n") })).toBe(false);
  });

  it.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAGAIN", "ECANCELED"])(
    "rejects %s as denial evidence",
    (code) => {
      const probe = executeProbe();
      probe.request.emit("error", { code, syscall: "connect" });
      expect(isNetworkPolicyDenial({ exitCode: 0, stdout: probe.output.join("\n") })).toBe(false);
    },
  );

  it("fails a bounded deadline without manufacturing policy evidence", () => {
    const probe = executeProbe();
    probe.deadline.mock.calls[0]![0]();
    expect(probe.deadline.mock.calls[0]?.[1]).toBe(20_000);
    expect(isNetworkPolicyDenial({ exitCode: 0, stdout: probe.output.join("\n") })).toBe(false);
  });

  it.each([
    [{ errorCode: "EACCES", syscall: "connect" }, true],
    [{ errorCode: "EACCES", syscall: "open" }, false],
    [{ status: 403, response: '{"detail":"policy_denied"}' }, true],
    [{ status: 403, response: "origin authentication refused" }, false],
    [{ status: 200, response: "policy_denied" }, false],
    [{ status: 0, response: "curl: (7) Failed to connect" }, false],
    [null, false],
  ])("classifies structured network result %j", (record, expected) => {
    expect(isNetworkPolicyDenial(denialResult(record))).toBe(expected);
  });

  it.each([
    { exitCode: 1 },
    { timedOut: true },
    { signal: "SIGTERM" },
    { stdout: NETWORK_POLICY_RESULT_PREFIX + "invalid JSON" },
    { stdout: "error connect EACCES" },
    {
      stdout: `${denialResult({ errorCode: "EACCES", syscall: "connect" }).stdout}\n${denialResult({ errorCode: "EACCES", syscall: "connect" }).stdout}`,
    },
  ])("rejects incomplete or ambiguous command evidence %j", (override) => {
    expect(
      isNetworkPolicyDenial({
        ...denialResult({ errorCode: "EACCES", syscall: "connect" }),
        ...override,
      }),
    ).toBe(false);
  });
});

describe("installed web_fetch error evidence", () => {
  const source = fs.readFileSync(
    new URL("../live/network-policy.test.ts", import.meta.url),
    "utf8",
  );
  const classifier = source.slice(
    source.indexOf("function errorChainDetail(error) {"),
    source.indexOf("\nconst approved = await webFetch.execute"),
  );

  it.each([
    [{ code: "EACCES", syscall: "connect" }, true],
    [{ cause: { code: "EACCES", syscall: "connect" } }, true],
    [
      {
        errors: [
          { code: "EACCES", syscall: "connect" },
          { code: "EACCES", syscall: "connect" },
        ],
      },
      true,
    ],
    [
      {
        errors: [
          { code: "EACCES", syscall: "connect" },
          { code: "ETIMEDOUT", syscall: "connect" },
        ],
      },
      false,
    ],
    [{ code: "EACCES", syscall: "open" }, false],
    [{ message: "E2E_NATIVE_CONNECT_EACCES" }, false],
    [{ name: "SsrFBlockedError", message: "Blocked hostname" }, false],
  ])("classifies actual web_fetch probe error chain %j", (error, expected) => {
    const result = vm.runInNewContext(`${classifier}\nerrorChainDetail(input);`, { input: error });
    expect(result.nativeDenied).toBe(expected);
  });
});
