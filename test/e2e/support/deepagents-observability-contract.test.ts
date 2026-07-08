// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  assertDeepAgentsTraceContract,
  hasConfirmedOpenShellPolicyDenial,
  observabilityPresetState,
} from "../live/deepagents-observability-contract.ts";
import {
  isPrivateBridgeIpv4,
  startOtlpCaptureServers,
} from "../live/deepagents-otlp-capture-server.ts";
import {
  decodeExportTraceServiceRequest,
  type OtlpAttributeValue,
} from "../live/otlp-trace-decoder.ts";
import {
  pendingRequest,
  request,
  SERVICE_NAME,
  type TestSpan,
  traceRequest,
  waitForMetadata,
  waitForReservedBytes,
} from "./deepagents-observability-contract-fixtures.ts";

const DIRECT_PROMPT = "DIRECT_PROMPT";
const DIRECT_RESPONSE = "DIRECT_RESPONSE";
const LOGIN_PROMPT = "LOGIN_PROMPT";
const LOGIN_RESPONSE = "LOGIN_RESPONSE";
const TOOL_NAME = "nemoclaw_otlp_e2e_tool";
const TOOL_ARGUMENT = "TOOL_ARGUMENT";
const TOOL_RESULT = "TOOL_RESULT";
const AMBIENT_CANARY = "AMBIENT_CANARY";
const RAW_CREDENTIAL = "sk-EXAMPLE0000000000000000000000";
const REDACTION_MARKER = "<redacted-secret>";

function validSpans(): TestSpan[] {
  return [
    {
      name: "direct model",
      attributes: {
        "openinference.span.kind": "LLM",
        "input.value": JSON.stringify({
          prompt: DIRECT_PROMPT,
          redaction: REDACTION_MARKER,
          requested: DIRECT_RESPONSE,
        }),
        "output.value": JSON.stringify({ content: DIRECT_RESPONSE }),
      },
    },
    {
      name: "login model",
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.input_messages": JSON.stringify([{ content: LOGIN_PROMPT }]),
        "llm.output_messages": JSON.stringify([{ content: LOGIN_RESPONSE }]),
      },
    },
    {
      name: "deterministic tool",
      attributes: {
        "openinference.span.kind": "TOOL",
        "tool.name": TOOL_NAME,
        "tool.parameters": JSON.stringify({ command: TOOL_ARGUMENT }),
        "output.value": JSON.stringify({ stdout: TOOL_RESULT }),
      },
    },
  ];
}

const expectations = {
  ambientCanary: AMBIENT_CANARY,
  redaction: { marker: REDACTION_MARKER, rawCredential: RAW_CREDENTIAL },
  serviceName: SERVICE_NAME,
  llmExchanges: [
    {
      label: "direct",
      promptMarker: DIRECT_PROMPT,
      redactionMarker: REDACTION_MARKER,
      responseMarker: DIRECT_RESPONSE,
    },
    { label: "login", promptMarker: LOGIN_PROMPT, responseMarker: LOGIN_RESPONSE },
  ],
  tool: { argumentMarker: TOOL_ARGUMENT, name: TOOL_NAME, resultMarker: TOOL_RESULT },
} as const;

describe("Deep Agents OTLP trace contract", () => {
  it("decodes the stable OTLP trace fields and recursive AnyValue shapes", () => {
    const body = traceRequest([
      {
        name: "nested attributes",
        attributes: {
          "openinference.span.kind": "LLM",
          nested: { enabled: true, items: ["one", 2, { leaf: "three" }] },
        },
      },
    ]);

    expect(decodeExportTraceServiceRequest(body)).toEqual([
      {
        name: "nested attributes",
        resourceAttributes: { "service.name": SERVICE_NAME },
        attributes: {
          "openinference.span.kind": "LLM",
          nested: { enabled: true, items: ["one", 2, { leaf: "three" }] },
        },
      },
    ]);
  });

  it("requires input and output markers on the same managed LLM and TOOL spans", () => {
    expect(assertDeepAgentsTraceContract([traceRequest(validSpans())], expectations)).toEqual({
      requestCount: 1,
      spanCount: 3,
    });

    const misplacedResponse = validSpans();
    misplacedResponse[0] = {
      ...misplacedResponse[0],
      attributes: {
        ...misplacedResponse[0].attributes,
        "output.value": "unrelated output",
      },
    };
    expect(() =>
      assertDeepAgentsTraceContract([traceRequest(misplacedResponse)], expectations),
    ).toThrow(/direct prompt and response markers were not associated on one managed LLM span/);

    const misplacedToolArgument = validSpans();
    misplacedToolArgument[0].attributes["input.value"] = JSON.stringify({
      prompt: DIRECT_PROMPT,
      redaction: REDACTION_MARKER,
      requested: DIRECT_RESPONSE,
      unrelatedToolArgument: TOOL_ARGUMENT,
    });
    misplacedToolArgument[2] = {
      ...misplacedToolArgument[2],
      attributes: { ...misplacedToolArgument[2].attributes, "tool.parameters": "unrelated" },
    };
    expect(() =>
      assertDeepAgentsTraceContract([traceRequest(misplacedToolArgument)], expectations),
    ).toThrow(/not associated on one managed TOOL span/);
  });

  it("requires credential-shaped content to be replaced on the OTLP wire", () => {
    const rawCredential = validSpans();
    rawCredential[0].attributes["input.value"] = JSON.stringify({
      prompt: DIRECT_PROMPT,
      rawCredential: RAW_CREDENTIAL,
      requested: DIRECT_RESPONSE,
    });
    expect(() =>
      assertDeepAgentsTraceContract([traceRequest(rawCredential)], expectations),
    ).toThrow(/credential-shaped prompt content reached OTLP/);

    const missingMarker = validSpans();
    missingMarker[0].attributes["input.value"] = JSON.stringify({
      prompt: DIRECT_PROMPT,
      requested: DIRECT_RESPONSE,
    });
    expect(() =>
      assertDeepAgentsTraceContract([traceRequest(missingMarker)], expectations),
    ).toThrow(/credential-shaped OTLP content lacks the redaction marker/);
  });

  it("fails closed on malformed requests, wrong service identity, and ambient canaries", () => {
    expect(() =>
      assertDeepAgentsTraceContract([Buffer.from([0x0a, 0x05, 0x01])], expectations),
    ).toThrow(/not a valid ExportTraceServiceRequest/);
    expect(() =>
      assertDeepAgentsTraceContract(
        [traceRequest(validSpans(), "unmanaged-service")],
        expectations,
      ),
    ).toThrow(/not associated on one managed LLM span/);
    expect(() =>
      assertDeepAgentsTraceContract(
        [traceRequest([...validSpans(), { name: AMBIENT_CANARY, attributes: {} }])],
        expectations,
      ),
    ).toThrow(/ambient exporter configuration reached OTLP/);
  });

  it("rejects prototype-sensitive attribute keys and excessive AnyValue nesting", () => {
    const hostileAttributes = Object.fromEntries([["__proto__", "hostile"]]) as Record<
      string,
      OtlpAttributeValue
    >;
    expect(() =>
      decodeExportTraceServiceRequest(
        traceRequest([{ name: "hostile attribute", attributes: hostileAttributes }]),
      ),
    ).toThrow(/forbidden OTLP attribute key __proto__/);

    let nested: OtlpAttributeValue = "leaf";
    for (let depth = 0; depth < 18; depth += 1) nested = [nested];
    expect(() =>
      decodeExportTraceServiceRequest(
        traceRequest([{ name: "deep attribute", attributes: { nested } }]),
      ),
    ).toThrow(/AnyValue nesting exceeds 16 levels/);
  });
});

describe("Deep Agents observability policy proof", () => {
  it("accepts only the exact active policy-list state", () => {
    expect(
      observabilityPresetState(
        "  ● observability-otlp-local [from balanced tier] — host-local OTLP export\n",
      ),
    ).toBe("active");
    expect(
      observabilityPresetState(
        "  ○ observability-otlp-local — host-local OTLP export (recorded locally, not active on gateway)\n",
      ),
    ).toBe("drift");
    expect(observabilityPresetState("observability-otlp-local is documented here\n")).toBe(
      "missing",
    );
  });

  it("distinguishes confirmed OpenShell denials from DNS and transport failures", () => {
    expect(
      hasConfirmedOpenShellPolicyDenial(
        "[1783046573.602] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /usr/bin/curl(1) -> example.com:443 [reason:not allowed by any policy]",
      ),
    ).toBe(true);
    expect(
      hasConfirmedOpenShellPolicyDenial(
        'proxy: {"error":"policy_denied","detail":"CONNECT example.com:443 not allowed by any policy"}',
      ),
    ).toBe(true);
    expect(
      hasConfirmedOpenShellPolicyDenial(
        'curl: (22) Th{"detail":"POST host.openshell.internal:4318/v1/traces not permitted by policy","error":"policy_denied"}e requested URL returned error: 403',
      ),
    ).toBe(true);
    expect(
      hasConfirmedOpenShellPolicyDenial(
        "nemoclaw: recent network policy denial detected for example.com:443 inside sandbox 'dcode-test'.",
      ),
    ).toBe(true);
    expect(hasConfirmedOpenShellPolicyDenial("URLError: Name or service not known")).toBe(false);
    expect(hasConfirmedOpenShellPolicyDenial("curl: (7) Connection refused")).toBe(false);
    expect(hasConfirmedOpenShellPolicyDenial("curl: (28) Operation timed out")).toBe(false);
  });

  it("runs the policy parser and denial classifier through the live tsx command path", () => {
    const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const helper = path.join(
      process.cwd(),
      "test",
      "e2e",
      "live",
      "deepagents-observability-contract.ts",
    );
    const active = spawnSync(tsx, [helper, "policy-state"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      input: "  ● observability-otlp-local [from balanced tier] — local OTLP\n",
    });
    expect(active.status, active.stderr).toBe(0);
    expect(active.stdout.trim()).toBe("active");

    const denial = spawnSync(tsx, [helper, "denial-state"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      input:
        "[1.0] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /usr/bin/curl(1) -> example.com:443 [reason:not allowed by any policy]\n",
    });
    expect(denial.status, denial.stderr).toBe(0);
    expect(denial.stdout.trim()).toBe("policy-denied");

    const proxyDenial = spawnSync(tsx, [helper, "denial-state"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      input:
        'FAILED:HTTPError:HTTP Error 403: Forbidden:{"error":"policy_denied","detail":"POST example.com:4318/v1/traces not permitted by policy"}\n',
    });
    expect(proxyDenial.status, proxyDenial.stderr).toBe(0);
    expect(proxyDenial.stdout.trim()).toBe("policy-denied");

    const interleavedCurlDenial = spawnSync(tsx, [helper, "denial-state"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      input:
        'curl: (22) The reque{"detail":"POST host.openshell.internal:4318/v1/traces not permitted by policy","error":"policy_denied"}sted URL returned error: 403\n',
    });
    expect(interleavedCurlDenial.status, interleavedCurlDenial.stderr).toBe(0);
    expect(interleavedCurlDenial.stdout.trim()).toBe("policy-denied");
  });
});

describe("bounded private OTLP capture server", () => {
  it("accepts only private bridge addresses unless a hermetic test opts into loopback", () => {
    expect(isPrivateBridgeIpv4("10.1.2.3")).toBe(true);
    expect(isPrivateBridgeIpv4("172.31.0.1")).toBe(true);
    expect(isPrivateBridgeIpv4("192.168.1.1")).toBe(true);
    expect(isPrivateBridgeIpv4("127.0.0.1")).toBe(false);
    expect(isPrivateBridgeIpv4("127.0.0.1", true)).toBe(true);
    expect(isPrivateBridgeIpv4("0.0.0.0", true)).toBe(false);
    expect(isPrivateBridgeIpv4("8.8.8.8", true)).toBe(false);
  });

  it("bounds per-request, aggregate, and request-count capture volume", async () => {
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-otlp-capture-test-"));
    const started = await startOtlpCaptureServers({
      allowLoopback: true,
      bindIp: "127.0.0.1",
      captureDir,
      collectorPort: 0,
      decoyPort: 0,
      maxCaptureBytes: 16,
      maxCaptureRequests: 4,
      maxBodyBytes: 16,
    });
    try {
      expect(
        await request(
          started.collectorPort,
          { "content-length": "4", "content-type": "application/x-protobuf" },
          "test",
        ),
      ).toBe(200);
      const forbiddenHeaderStatus = await request(
        started.collectorPort,
        {
          authorization: "Bearer MUST_NOT_REACH_CAPTURE_METADATA",
          "content-length": "4",
          "content-type": "application/x-protobuf",
        },
        "test",
      );
      expect([400, null]).toContain(forbiddenHeaderStatus);
      const aggregateStatus = await request(
        started.collectorPort,
        { "content-length": "13", "content-type": "application/x-protobuf" },
        "1234567890123",
      );
      expect([507, null]).toContain(aggregateStatus);
      const oversizedStatus = await request(started.collectorPort, {
        "content-length": "17",
        "content-type": "application/x-protobuf",
      });
      expect([413, null]).toContain(oversizedStatus);
      const overCountStatus = await request(
        started.collectorPort,
        { "content-length": "4", "content-type": "application/x-protobuf" },
        "test",
      );
      expect([429, null]).toContain(overCountStatus);
      await waitForMetadata(captureDir, 5);

      const metadata = fs
        .readdirSync(captureDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => JSON.parse(fs.readFileSync(path.join(captureDir, name), "utf8")));
      expect(metadata).toMatchObject([
        {
          accepted: true,
          contentType: "application/x-protobuf",
          method: "POST",
          path: "/v1/traces",
          rejection: null,
        },
        {
          accepted: false,
          contentType: null,
          method: null,
          path: null,
          rejection: "forbidden exporter header",
        },
        {
          accepted: false,
          rejection: "aggregate captured bodies exceed bound",
        },
        {
          accepted: false,
          rejection: "declared body exceeds capture bound",
        },
        {
          accepted: false,
          rejection: "capture request count exceeds bound",
        },
      ]);
      expect(JSON.stringify(metadata)).not.toContain("MUST_NOT_REACH_CAPTURE_METADATA");
      const bodyFiles = fs
        .readdirSync(captureDir)
        .filter((name) => name.endsWith(".body"))
        .sort();
      expect(bodyFiles.map((name) => fs.statSync(path.join(captureDir, name)).size)).toEqual([
        4, 0, 0, 0, 0,
      ]);
    } finally {
      await started.close();
      fs.rmSync(captureDir, { force: true, recursive: true });
    }
  });

  it("reserves declared bytes before admitting concurrent request bodies", async () => {
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-otlp-reservation-test-"));
    const started = await startOtlpCaptureServers({
      allowLoopback: true,
      bindIp: "127.0.0.1",
      captureDir,
      collectorPort: 0,
      decoyPort: 0,
      maxBodyBytes: 16,
      maxCaptureBytes: 16,
      maxCaptureRequests: 10,
    });
    const first = pendingRequest(started.collectorPort, 12);
    try {
      await waitForReservedBytes(started, 12);
      expect(started.snapshot()).toMatchObject({ capturedBytes: 0, reservedBytes: 12 });

      const rejectedStatus = await request(
        started.collectorPort,
        { "content-length": "12", "content-type": "application/x-protobuf" },
        "abcdefghijkl",
      );
      expect([507, null]).toContain(rejectedStatus);
      expect(started.snapshot()).toMatchObject({ capturedBytes: 0, reservedBytes: 12 });

      first.complete("abcdefghijkl");
      expect(await first.status).toBe(200);
      await waitForMetadata(captureDir, 2);
      expect(started.snapshot()).toMatchObject({ capturedBytes: 12, reservedBytes: 0 });
    } finally {
      first.destroy();
      await started.close();
      fs.rmSync(captureDir, { force: true, recursive: true });
    }
  });

  it("releases reserved bytes when a client disconnects before its body completes (#3915)", async () => {
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-otlp-abort-test-"));
    const started = await startOtlpCaptureServers({
      allowLoopback: true,
      bindIp: "127.0.0.1",
      captureDir,
      collectorPort: 0,
      decoyPort: 0,
      maxBodyBytes: 16,
      maxCaptureBytes: 16,
      maxCaptureRequests: 10,
    });
    const partial = pendingRequest(started.collectorPort, 12);
    try {
      await waitForReservedBytes(started, 12);
      partial.destroy();
      await waitForMetadata(captureDir, 1);

      expect(started.snapshot()).toEqual({
        capturedBytes: 0,
        requestCount: 1,
        reservedBytes: 0,
      });
      const metadata = fs
        .readdirSync(captureDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(fs.readFileSync(path.join(captureDir, name), "utf8")));
      expect(metadata).toEqual([
        {
          accepted: false,
          contentType: null,
          method: null,
          path: null,
          port: started.collectorPort,
          rejection: "request body aborted",
        },
      ]);
      const bodyFiles = fs.readdirSync(captureDir).filter((name) => name.endsWith(".body"));
      expect(bodyFiles.map((name) => fs.statSync(path.join(captureDir, name)).size)).toEqual([0]);
    } finally {
      partial.destroy();
      await started.close();
      fs.rmSync(captureDir, { force: true, recursive: true });
    }
  });
});
