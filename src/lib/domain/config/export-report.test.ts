// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { renderCanonicalNemoClawConfig } from "../../config/canonical";
import { renderExportReportHeader } from "./export-report";
import {
  braveSnapshot,
  dcodeSnapshot,
  entry,
  hermesManagedAuthSnapshot,
  hermesSnapshot,
  managedWorkload,
  policy,
  profileInput,
  proxySnapshot,
  snapshot,
  tavilySnapshot,
  tunedSnapshot,
} from "./export-source-test-fixture";

const otlpSnapshot = () =>
  snapshot({
    registry: entry({
      workload: managedWorkload(
        profileInput({
          environment: {
            NEMOCLAW_OPENCLAW_OTEL: "1",
            NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
            NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "research-assistant",
            NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "0.5",
          },
        }),
      ),
    }),
  });

async function exported(source: Parameters<typeof exportSnapshots>[0][number]) {
  const result = await exportSnapshots([source]);
  expect(result.outcome.ok).toBe(true);
  return result.writeStdout.mock.calls[0]![0];
}

const headerOf = (yaml: string) =>
  yaml
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .join("\n");

describe("export report header (#14580)", () => {
  it("starts the file with a versioned marker", async () => {
    const yaml = await exported(snapshot());
    expect(yaml.split("\n")[0]).toBe("# nemoclaw-export-report: 1");
  });

  it("carries one line per omission with its field, kind and V0 value", async () => {
    const header = headerOf(await exported(tunedSnapshot()));
    expect(header).toMatch(/^# omitted inference\.contextWindow value=\d+: /m);
    expect(header).toMatch(/^# omitted inference\.reasoning value=(true|false): /m);
    expect(header).toMatch(/^# omitted inference\.reasoningEffort value="[a-z]+": /m);
    expect(header).toMatch(/^# omitted execution\.heartbeatEvery value="[^"]+": /m);
    expect(header).toMatch(/^# omitted tools\.disclosure value="(progressive|direct)": /m);
    expect(header).toMatch(/^# placeholder image\.ref: /m);
  });

  it("reports the managed proxy host and port", async () => {
    const header = headerOf(await exported(proxySnapshot()));
    expect(header).toContain('# omitted proxy value={"host":"proxy.internal","port":3129}: ');
  });

  it("reports before and after for a changed value", async () => {
    const baseline = snapshot();
    const sourcePolicy = YAML.parse(policy);
    sourcePolicy.network_policies.api.endpoints = [
      { host: "tunnel.example.com", port: 443, tls: "passthrough" },
      {
        host: "custom.example.com",
        port: 443,
        protocol: "rest",
        tls: "terminate",
        enforcement: "enforce",
        rules: [{ allow: { method: "POST", path: "/v1/chat/completions" } }],
      },
    ];
    sourcePolicy.network_policies.api.binaries = [{ path: "/usr/bin/curl" }];
    const document = YAML.stringify(sourcePolicy);
    const header = headerOf(
      await exported({ ...baseline, policy: { ...baseline.policy, document } }),
    );
    expect(header).toContain(
      '# changed network_policies[].endpoints[].tls before="passthrough" after="skip": ',
    );
    expect(header).toContain(
      '# changed network_policies[].endpoints[].tls before="terminate" after=omitted: ',
    );
  });

  it("reports the reused gateway port without changing it", async () => {
    const yaml = await exported(snapshot());
    const header = headerOf(yaml);
    const port = YAML.parse(yaml).spec.gateway.target.docker.port;
    expect(port).toBe(8080);
    expect(header).toContain(`\n# gateway endpoint="http://127.0.0.1:${port}" port=${port}: `);
    expect(header).toMatch(/free port/);
  });

  it("keeps every header line a comment so the YAML document is unchanged", async () => {
    const yaml = await exported(hermesSnapshot());
    const body = yaml
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");
    expect(YAML.parse(yaml)).toEqual(YAML.parse(body));
    expect(yaml.startsWith("# nemoclaw-export-report: 1\n")).toBe(true);
  });

  it("reports the OTLP settings v1 has no confirmed mapping for", async () => {
    const header = headerOf(await exported(otlpSnapshot()));
    expect(header).toContain(
      '# omitted observability value={"otlp":{"enabled":true,"endpoint":"http://host.openshell.internal:4318","serviceName":"research-assistant","sampleRate":0.5}}: ',
    );
  });

  it("reports the V0 interface settings when the source has them", async () => {
    const header = headerOf(await exported(hermesSnapshot()));
    expect(header).toMatch(/^# omitted interfaces value=\{"[a-z]+":/m);
  });

  it("strips userinfo, query and fragment from URL values", () => {
    const header = renderExportReportHeader(
      [
        {
          field: "observability",
          kind: "omitted",
          message: "test",
          value: { otlp: { endpoint: "http://user:pw@collector.example:4318/v1?token=abc#frag" } },
        },
      ],
      18080,
    );
    expect(header).toContain('"endpoint":"http://collector.example:4318/v1"');
    expect(header).not.toMatch(/user|pw|token|abc|frag/);
  });

  it("digests the written file, including the header, and keeps specDigest", async () => {
    const result = await exportSnapshots([snapshot()], {
      kind: "file",
      outputPath: "/tmp/alpha.yaml",
      force: false,
    });
    const written = result.publish.mock.calls[0]![1];
    const body = written
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");
    const rendered = renderCanonicalNemoClawConfig(YAML.parse(body));
    const fileDigest = "sha256:" + createHash("sha256").update(written, "utf8").digest("hex");
    expect(fileDigest).not.toBe(rendered.documentDigest);
    expect(result.outcome).toMatchObject({
      ok: true,
      completion: {
        kind: "file",
        result: { specDigest: rendered.specDigest, documentDigest: fileDigest },
      },
    });
  });

  it.each([
    ["tuned", tunedSnapshot],
    ["proxy", proxySnapshot],
    ["otlp", otlpSnapshot],
    ["brave", braveSnapshot],
    ["tavily", () => tavilySnapshot()],
    ["hermes", () => hermesSnapshot()],
    ["hermes managed auth", () => hermesManagedAuthSnapshot()],
    ["deep agents", () => dcodeSnapshot()],
  ] as const)("never prints credentials or credential variable names (%s)", async (_, source) => {
    const header = headerOf(await exported(source()));
    // Fixture credential references are OPENAI_, GEMINI_, NOUS_, BRAVE_ and TAVILY_API_KEY.
    expect(header).not.toMatch(
      /API_KEY|TOKEN|SECRET|password|canary|credentialEnv|:\/\/[^/\s"]*@|\?/i,
    );
  });

  it("puts the whole report before the first YAML line", async () => {
    const lines = (await exported(tunedSnapshot())).split("\n");
    const firstBody = lines.findIndex((line) => !line.startsWith("#"));
    expect(firstBody).toBeGreaterThan(5);
    expect(lines.slice(firstBody).some((line) => line.startsWith("# "))).toBe(false);
  });
});
