// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertDeepAgentsTraceContract,
  assertObservabilityThreadDeleted,
  hasConfirmedOpenShellPolicyDenial,
  observabilityPresetState,
  observabilityThreadForPrompt,
  validateCaptureDirectory,
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

describe("observability conversation cleanup", () => {
  const threadId = "01a10459-84ba-7651-9938-7386f41cdbfe";
  it("requires native deletion confirmation for the exact owned conversation", () => {
    const deletion = {
      schema_version: 1,
      command: "threads delete",
      data: { thread_id: threadId, deleted: true },
    };
    expect(() =>
      assertObservabilityThreadDeleted(JSON.stringify(deletion), threadId),
    ).not.toThrow();
    expect(() =>
      assertObservabilityThreadDeleted(JSON.stringify(deletion), "an-unrelated-thread"),
    ).toThrow();
    expect(() =>
      assertObservabilityThreadDeleted(
        JSON.stringify({ ...deletion, data: { ...deletion.data, deleted: false } }),
        threadId,
      ),
    ).toThrow();
  });

  const prompt = "[random-test-identity:direct] private test prompt";
  const owned = { thread_id: threadId, initial_prompt: prompt };
  const unrelated = { thread_id: "unrelated", initial_prompt: `${prompt} other` };
  const listing = { schema_version: 1, command: "threads list", data: [unrelated, owned] };

  it("recovers only one exact owned prompt", () => {
    expect(observabilityThreadForPrompt(JSON.stringify(listing), prompt)).toBe(threadId);
  });

  it.each([0, 1])("bounds native listing bytes before parsing (+%i byte)", (extra) => {
    const encoded = JSON.stringify(listing);
    const input = encoded + " ".repeat(1_048_576 - Buffer.byteLength(encoded) + extra);
    const result = spawnSync(
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      ["test/e2e/live/deepagents-observability-contract.ts", "thread-for-prompt", prompt],
      { input, encoding: "utf8", timeout: 3000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(extra);
    expect(result.stdout).toBe(extra === 0 ? `${threadId}\n` : "");
    expect(result.stderr.includes("1048576-byte cleanup limit")).toBe(extra === 1);
    expect(result.stderr).not.toContain(prompt);
  });

  it("closes an oversized streaming listing without waiting for EOF", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-otlp-stream-"));
    try {
      const producer = path.join(root, "producer.cjs");
      const stopped = path.join(root, "stopped");
      fs.writeFileSync(
        producer,
        `const fs = require("node:fs");
try { for (;;) fs.writeSync(1, Buffer.alloc(65536, "x")); }
catch (error) { fs.writeFileSync(process.argv[2], error.code); }
`,
      );
      const result = spawnSync(
        "bash",
        [
          "-o",
          "pipefail",
          "-c",
          '"$1" "$2" "$3" | "$4" "$5" thread-for-prompt "$6"',
          "--",
          process.execPath,
          producer,
          stopped,
          path.join(process.cwd(), "node_modules/.bin/tsx"),
          "test/e2e/live/deepagents-observability-contract.ts",
          prompt,
        ],
        { encoding: "utf8", timeout: 3000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("1048576-byte cleanup limit");
      expect(fs.readFileSync(stopped, "utf8")).toBe("EPIPE");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { ...listing, schema_version: 2 },
    { ...listing, command: "non-interactive" },
    { ...listing, data: {} },
    { ...listing, data: [unrelated] },
    { ...listing, data: [owned, owned] },
    { ...listing, data: [{ ...owned, thread_id: "--all" }] },
    { ...listing, data: [null] },
  ])("rejects ambiguous or malformed native listings", (invalid) => {
    expect(() => observabilityThreadForPrompt(JSON.stringify(invalid), prompt)).toThrow();
  });

  it.each([
    ["direct", 0],
    ["login", 0],
    ["command-failure", 0],
    ["older-owned", 25],
    ["oversized", 0],
    ["list-timeout", 0],
    ["delete-timeout", 0],
    ["not-started", 0],
    ["missing-required", 0],
    ["duplicate", 0],
    ["delete-failure", 0],
    ["still-present", 0],
  ] as const)("preserves unrelated conversations during %s cleanup", (failure, newerCount) => {
    const cleanupRejected =
      failure.endsWith("-timeout") ||
      ["oversized", "missing-required", "duplicate", "delete-failure", "still-present"].includes(
        failure,
      );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-otlp-cleanup-"));
    const benign = {
      thread_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      initial_prompt: "unrelated",
    };
    try {
      const statePath = path.join(root, "threads.json");
      fs.writeFileSync(statePath, JSON.stringify([benign]));
      fs.writeFileSync(path.join(root, "deleted"), "");
      // Exercise the host process boundary with a short fixture clock, without
      // requiring GNU coreutils on hosts that only run deterministic tests.
      fs.writeFileSync(
        path.join(root, "timeout"),
        `#!${process.execPath}
const cp = require("node:child_process");
const [signal, grace, duration, command, ...args] = process.argv.slice(2);
if (signal !== "--signal=TERM" || grace !== "--kill-after=5s" || duration !== "45s") process.exit(9);
const result = cp.spawnSync(command, args, { stdio: "inherit", timeout: 200, killSignal: "SIGKILL" });
process.exit(result.error?.code === "ETIMEDOUT" ? 124 : result.status ?? 1);
`,
        { mode: 0o755 },
      );
      const stub = `#!${process.execPath}
const fs = require("node:fs"), cp = require("node:child_process");
let args = process.argv.slice(2);
if (args[0] === "sandbox" && args.includes("threads") && args.includes("--timeout") && args[args.indexOf("--timeout") + 1] !== "45") process.exit(9);
if (args[0] === "sandbox") args = args.slice(args.indexOf("--") + 1);
if (args[0] === "bash") {
  const r = cp.spawnSync("bash", ["--noprofile", "--norc", "-c", args.at(-1)], { env: process.env, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
if (args[0] === "env") args = args.slice(args.indexOf("dcode"));
if (args[0] === "dcode") args.shift();
let threads = JSON.parse(fs.readFileSync(process.env.THREADS_FILE, "utf8"));
const emit = (command, data) => console.log(JSON.stringify({ schema_version: 1, command, data, padding: process.env.FAILURE === "oversized" ? "x".repeat(1_048_576) : "" }));
if (args[0] === "threads" && process.env.FAILURE === args[1] + "-timeout") {
  setTimeout(() => process.exit(124), 1500);
  return;
}
if (args[0] === "threads" && args[1] === "list") {
  const limit = Number(args[args.indexOf("--limit") + 1]);
  emit("threads list", threads.slice().reverse().slice(0, Math.max(1, limit)));
}
else if (args[0] === "threads" && args[1] === "delete") {
  const found = threads.some(t => t.thread_id === args[2]);
  if (args.includes("--dry-run")) {
    emit("threads delete", { thread_id: args[2], exists: found, dry_run: true });
    return;
  }
  if (process.env.FAILURE === "delete-failure") {
    emit("threads delete", { thread_id: args[2], deleted: false });
    return;
  }
  if (process.env.FAILURE !== "still-present") {
    threads = threads.filter(t => t.thread_id !== args[2]);
  }
  fs.writeFileSync(process.env.THREADS_FILE, JSON.stringify(threads));
  fs.appendFileSync(process.env.DELETED_FILE, args[2] + "\\n");
  emit("threads delete", { thread_id: args[2], deleted: found });
} else if (args.includes("-n")) {
  const prompt = args[args.indexOf("-n") + 1], direct = prompt.includes("DIRECT_RESPONSE");
  const thread_id = direct ? "11111111-1111-1111-1111-111111111111" : "22222222-2222-2222-2222-222222222222";
  if (process.env.FAILURE !== "missing-required") threads.push({ thread_id, initial_prompt: prompt });
  if (process.env.FAILURE === "duplicate") threads.push({ thread_id: "33333333-3333-3333-3333-333333333333", initial_prompt: prompt });
  for (let i = 0; i < Number(process.env.NEWER_THREADS); i++) threads.push({ thread_id: "newer-" + i, initial_prompt: "newer unrelated " + i });
  fs.writeFileSync(process.env.THREADS_FILE, JSON.stringify(threads));
  if (process.env.FAILURE === "command-failure") process.exit(1);
  if (process.env.FAILURE.endsWith("-timeout") || ["older-owned", "oversized", "missing-required", "duplicate", "delete-failure", "still-present"].includes(process.env.FAILURE) || process.env.FAILURE === (direct ? "direct" : "login")) console.log("malformed turn JSON");
  else emit("non-interactive", { status: "success", exit_code: 0, completion: { thread_id }, response: direct ? "NEMOCLAW_OTLP_DIRECT_RESPONSE_SENTINEL" : "NEMOCLAW_OTLP_LOGIN_RESPONSE_SENTINEL" });
} else process.exit(9);
`;
      fs.writeFileSync(path.join(root, "openshell"), stub, { mode: 0o755 });
      fs.writeFileSync(path.join(root, "dcode"), stub, { mode: 0o755 });
      const script = fs.readFileSync(
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
        ),
        "utf8",
      );
      // Execute the actual ownership, turn and EXIT-cleanup paths with only
      // the unrelated network/policy setup omitted from this shell fixture.
      const ready = 'pass "host observability policy is restored before positive trace checks"';
      const activeDriver =
        script.slice(0, script.indexOf('[ -n "$SANDBOX_NAME" ]')) +
        script.slice(script.indexOf("run_dcode_direct()"), script.indexOf("tool_trace_source()")) +
        script.slice(
          script.indexOf(ready) + ready.length,
          script.indexOf('tool_trace_output="$(run_deterministic_tool_trace)"'),
        );
      const driver =
        failure === "not-started"
          ? script.slice(0, script.indexOf('[ -n "$SANDBOX_NAME" ]'))
          : activeDriver;
      const started = performance.now();
      const result = spawnSync("bash", ["-c", driver], {
        encoding: "utf8",
        timeout: 3000,
        env: {
          PATH: `${root}:${process.env.PATH}`,
          REPO: process.cwd(),
          SANDBOX_NAME: "owned-test-sandbox",
          THREADS_FILE: statePath,
          DELETED_FILE: path.join(root, "deleted"),
          FAILURE: failure,
          NEWER_THREADS: String(newerCount),
        },
      });
      expect(result.error).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(failure.endsWith("-timeout") ? 1200 : 3000);
      expect(result.status, result.stdout + result.stderr).toBe(failure === "not-started" ? 0 : 1);
      const remaining = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(
        remaining.filter(
          (thread: { initial_prompt: string }) => thread.initial_prompt === "unrelated",
        ),
      ).toEqual([benign]);
      expect(remaining.length).toBe(
        failure === "duplicate"
          ? 3
          : failure === "missing-required"
            ? 1
            : cleanupRejected
              ? 2
              : 1 + newerCount,
      );
      expect(
        remaining.filter((thread: { thread_id: string }) => thread.thread_id.startsWith("newer-")),
      ).toEqual(
        Array.from({ length: newerCount }, (_, i) => ({
          thread_id: `newer-${i}`,
          initial_prompt: `newer unrelated ${i}`,
        })),
      );
      expect(
        result.stderr.includes("could not remove an observability test conversation"),
        result.stdout + result.stderr,
      ).toBe(cleanupRejected);
      expect(
        fs.readFileSync(path.join(root, "deleted"), "utf8").trim().split("\n").filter(Boolean),
      ).toEqual(
        (cleanupRejected && failure !== "still-present") || failure === "not-started"
          ? []
          : failure === "login"
            ? ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]
            : ["11111111-1111-1111-1111-111111111111"],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

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
  redaction: { rawCredential: RAW_CREDENTIAL },
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
    expect(() => assertDeepAgentsTraceContract([], expectations)).toThrow();
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
    ).toThrow(/direct prompt and response markers were not associated/);
  });

  it("fails closed on malformed requests, wrong service identity, and ambient canaries", () => {
    expect(() =>
      assertDeepAgentsTraceContract([Buffer.from([0x0a, 0x05, 0x01])], expectations),
    ).toThrow(/truncated protobuf length-delimited field/);
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
      observabilityPresetState("  ○ observability-otlp-local — host-local OTLP export\n"),
    ).toBe("inactive");
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

describe("captured OTLP request validation", () => {
  let captureDir: string;
  beforeEach(() => {
    captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-otlp-metadata-test-"));
    const metadata = {
      accepted: true,
      port: 4318,
      method: "POST",
      path: "/v1/traces",
      contentType: "application/x-protobuf",
    };
    fs.writeFileSync(path.join(captureDir, "probe.json"), JSON.stringify(metadata));
    fs.writeFileSync(path.join(captureDir, "probe.body"), "allow probe");
    fs.writeFileSync(path.join(captureDir, "trace.body"), traceRequest(validSpans()));
    fs.writeFileSync(path.join(captureDir, "trace.json"), JSON.stringify(metadata));
  });
  afterEach(() => fs.rmSync(captureDir, { recursive: true, force: true }));

  it("accepts complete probe and trace captures", () => {
    expect(validateCaptureDirectory(captureDir, 4318, "allow probe", expectations)).toEqual({
      requestCount: 1,
      spanCount: 3,
    });
  });

  it.each([null, [], "text", 1, true, {}, { accepted: true }])(
    "rejects malformed metadata through the required accepted-request and route fields: %j",
    (invalid) => {
      fs.writeFileSync(path.join(captureDir, "trace.json"), JSON.stringify(invalid));
      expect(() =>
        validateCaptureDirectory(captureDir, 4318, "allow probe", expectations),
      ).toThrow();
    },
  );
});

describe("bounded private OTLP capture server", () => {
  it("accepts only approved host bridge addresses unless a hermetic test opts into loopback", () => {
    expect(isPrivateBridgeIpv4("10.1.2.3")).toBe(true);
    expect(isPrivateBridgeIpv4("172.31.0.1")).toBe(true);
    expect(isPrivateBridgeIpv4("192.168.1.1")).toBe(true);
    expect(isPrivateBridgeIpv4("169.254.2.2")).toBe(true);
    expect(isPrivateBridgeIpv4("169.254.2.3")).toBe(false);
    expect(isPrivateBridgeIpv4("169.254.169.254")).toBe(false);
    expect(isPrivateBridgeIpv4("127.0.0.1")).toBe(false);
    expect(isPrivateBridgeIpv4("127.0.0.1", true)).toBe(true);
    expect(isPrivateBridgeIpv4("0.0.0.0", true)).toBe(false);
    expect(isPrivateBridgeIpv4("8.8.8.8", true)).toBe(false);
  });

  it("rejects a non-protobuf request before persisting an accepted capture", async () => {
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-otlp-type-"));
    const started = await startOtlpCaptureServers({
      allowLoopback: true,
      bindIp: "127.0.0.1",
      captureDir,
      collectorPort: 0,
      decoyPort: 0,
    });
    try {
      const status = await request(
        started.collectorPort,
        { "content-length": "4", "content-type": "application/json" },
        "test",
      );
      expect([415, null]).toContain(status);
      await waitForMetadata(captureDir, 1);
      const file = fs.readdirSync(captureDir).find((name) => name.endsWith(".json"))!;
      const metadata = JSON.parse(fs.readFileSync(path.join(captureDir, file), "utf8"));
      expect(metadata).toMatchObject({
        accepted: false,
        contentType: null,
        rejection: "unexpected content type",
      });
      expect(() =>
        validateCaptureDirectory(captureDir, started.collectorPort, "allow probe", expectations),
      ).toThrow("records a rejected request");
      expect(started.snapshot().capturedBytes).toBe(0);
    } finally {
      await started.close();
      fs.rmSync(captureDir, { recursive: true, force: true });
    }
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
