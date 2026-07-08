// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSandboxInferenceRouteProbeArgs,
  classifyInferenceRouteFailureLabel,
  INFERENCE_ROUTE_PROBE_SCRIPT,
  parseSandboxInferenceRouteProbeResult,
} from "./connect-inference-route-probe";

describe("sandbox connect inference route probe argv", () => {
  it("uses root-owned DCode proxy files without login-shell startup code (#6191)", () => {
    const args = buildSandboxInferenceRouteProbeArgs("deep-code", {
      name: "langchain-deepagents-code",
    });

    expect(args.slice(0, 7)).toEqual(["sandbox", "exec", "--name", "deep-code", "--", "sh", "-c"]);
    expect(args).toHaveLength(8);
    expect(args.at(-1)).toContain("/usr/local/share/nemoclaw/dcode-proxy-host");
    expect(args.at(-1)).toContain("/usr/local/share/nemoclaw/dcode-proxy-port");
    expect(args.at(-1)).toContain("0:444");
    expect(args.at(-1)).toContain('HTTPS_PROXY="$PROXY_URL"');
    expect(args.at(-1)).toContain("https://inference.local/v1/models");
    expect(args.at(-1)).not.toContain("bash -lc");
    expect(args.at(-1)).not.toContain("3>&1");
    expect(args.at(-1)).not.toContain("/tmp/nemoclaw-proxy-env.sh");
    expect(args.every((arg) => !/[\r\n]/.test(arg))).toBe(true);
  });

  it.each([
    null,
    { name: "openclaw" },
    { name: "hermes" },
  ])("preserves the plain sh probe for non-dcode agents (%j)", (agent) => {
    expect(buildSandboxInferenceRouteProbeArgs("alpha", agent)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "sh",
      "-c",
      INFERENCE_ROUTE_PROBE_SCRIPT,
    ]);
  });

  it("verifies the route with OpenShell's CA and discards the response (#6192)", () => {
    const args = buildSandboxInferenceRouteProbeArgs("alpha", { name: "openclaw" });
    const script = args.at(-1) ?? "";

    expect(script).toContain("/usr/bin/curl -q -s -o /dev/null");
    expect(script).toContain('CA_BUNDLE="${CURL_CA_BUNDLE:-${SSL_CERT_FILE:-}}"');
    expect(script).toContain('--cacert "$CA_BUNDLE"');
    expect(script).toContain("printf 'UNAVAILABLE OpenShell CA bundle missing or unreadable'");
    expect(script).not.toContain("/etc/openshell-tls");
    expect(script).not.toContain("curl -sk");
    expect(script).not.toContain("--insecure");
    expect(script).not.toContain("/tmp/");
    expect(script).not.toContain("head -c");
  });

  it("reports unavailable before curl when the injected CA bundle is missing (#6192)", () => {
    const result = spawnSync("sh", ["-c", INFERENCE_ROUTE_PROBE_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        CURL_CA_BUNDLE: "/definitely/missing/nemoclaw-ca.pem",
        SSL_CERT_FILE: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("UNAVAILABLE OpenShell CA bundle missing or unreadable");
    expect(
      parseSandboxInferenceRouteProbeResult({ status: result.status, output: result.stdout }),
    ).toMatchObject({ healthy: false, broken: false, httpStatus: 0 });
  });

  it.each([
    "OK 200",
    "BROKEN 503",
  ])("does not execute DCode login-shell startup code containing a %s spoof (#6192)", (spoof) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-probe-"));
    try {
      const caBundle = path.join(home, "openshell-ca.pem");
      const hostFile = path.join(home, "dcode-proxy-host");
      const portFile = path.join(home, "dcode-proxy-port");
      const profileMarker = path.join(home, "profile-ran");
      const curlConfigMarker = path.join(home, "curl-config-ran");
      fs.writeFileSync(caBundle, "test CA boundary", "utf8");
      fs.writeFileSync(hostFile, "127.0.0.1\n", { mode: 0o444 });
      fs.writeFileSync(portFile, "9\n", { mode: 0o444 });
      fs.chmodSync(hostFile, 0o444);
      fs.chmodSync(portFile, 0o444);
      fs.writeFileSync(
        path.join(home, ".bash_profile"),
        `printf '%s\\n' ${JSON.stringify(spoof)} >&3; printf ran > ${JSON.stringify(profileMarker)}`,
      );
      fs.writeFileSync(
        path.join(home, ".curlrc"),
        `trace-ascii = ${JSON.stringify(curlConfigMarker)}\n`,
      );
      const args = buildSandboxInferenceRouteProbeArgs("deep-code", {
        name: "langchain-deepagents-code",
      });
      const script = String(args.at(-1))
        .replace("/usr/local/share/nemoclaw/dcode-proxy-host", hostFile)
        .replace("/usr/local/share/nemoclaw/dcode-proxy-port", portFile)
        .replaceAll("0:444", `${process.getuid?.() ?? 0}:444`);

      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, CURL_CA_BUNDLE: caBundle, SSL_CERT_FILE: "" },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("BROKEN 000");
      expect(result.stdout).not.toContain(spoof);
      expect(fs.existsSync(profileMarker)).toBe(false);
      expect(fs.existsSync(curlConfigMarker)).toBe(false);
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });
});

describe("sandbox inference route probe result", () => {
  it.each([
    [0, "unreachable"],
    [100, "unreachable"],
    [199, "unreachable"],
    [500, "unhealthy"],
    [599, "unhealthy"],
    [600, "unreachable"],
  ] as const)("classifies HTTP %i route failures as %s (#6192)", (httpStatus, expected) => {
    expect(classifyInferenceRouteFailureLabel(httpStatus)).toBe(expected);
  });

  it.each([
    "200",
    "401",
    "403",
    "499",
  ])("accepts HTTP %s as a reachable route (#6192)", (httpStatus) => {
    expect(
      parseSandboxInferenceRouteProbeResult({ status: 0, output: `OK ${httpStatus}` }),
    ).toMatchObject({ healthy: true, broken: false, httpStatus: Number(httpStatus) });
  });

  it.each([
    "000",
    "100",
    "199",
    "500",
    "503",
    "599",
    "600",
  ])("rejects HTTP %s as a broken route (#6192)", (httpStatus) => {
    expect(
      parseSandboxInferenceRouteProbeResult({ status: 0, output: `BROKEN ${httpStatus}` }),
    ).toMatchObject({ healthy: false, broken: true, httpStatus: Number(httpStatus) });
  });

  it("does not classify an unavailable probe as healthy or broken (#6192)", () => {
    expect(
      parseSandboxInferenceRouteProbeResult({ status: 1, output: "transport unavailable" }),
    ).toMatchObject({ healthy: false, broken: false, httpStatus: 0 });
  });

  it("does not trust broken output from a failed exec boundary (#6192)", () => {
    expect(
      parseSandboxInferenceRouteProbeResult({ status: 1, output: "BROKEN 000" }),
    ).toMatchObject({ healthy: false, broken: false, httpStatus: 0 });
  });

  it.each([
    "OK 200\nBROKEN 000",
    "BROKEN 503\nOK 200",
    "[stdout] OK 200\nBROKEN 000",
    "[stdout] BROKEN 503\nOK 200",
  ])("does not trust login-shell preamble output (%s) (#6192)", (output) => {
    expect(parseSandboxInferenceRouteProbeResult({ status: 0, output })).toMatchObject({
      healthy: false,
      broken: false,
      httpStatus: 0,
    });
  });

  it("fails closed when malformed output claims an unhealthy status is OK (#6192)", () => {
    expect(parseSandboxInferenceRouteProbeResult({ status: 0, output: "OK 503" })).toMatchObject({
      healthy: false,
      broken: true,
      httpStatus: 503,
    });
  });

  it("fails closed when malformed output claims an interim status is OK (#6192)", () => {
    expect(parseSandboxInferenceRouteProbeResult({ status: 0, output: "OK 100" })).toMatchObject({
      healthy: false,
      broken: true,
      httpStatus: 100,
    });
  });

  it.each([
    "[stdout] OK 200",
    "stdout: OK 401",
  ])("accepts framed healthy output from OpenShell (%s) (#6192)", (output) => {
    expect(parseSandboxInferenceRouteProbeResult({ status: 0, output })).toMatchObject({
      healthy: true,
      broken: false,
    });
  });

  it.each([
    "[stdout] BROKEN 503 service unavailable",
    "stdout: BROKEN 000",
  ])("accepts framed broken output from OpenShell (%s) (#6192)", (output) => {
    expect(parseSandboxInferenceRouteProbeResult({ status: 0, output })).toMatchObject({
      healthy: false,
      broken: true,
    });
  });
});
