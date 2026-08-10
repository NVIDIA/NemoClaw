// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Single-entry contract for the fixture redactor.
 *
 * Both per-test explicit secret values and canonical secret-shape
 * matches must flow through `redactString` so the fixture layer has one
 * redaction entry point. This file asserts the contract so any future
 * helper that wants to add an explicit-value path stays inside the
 * canonical entry rather than introducing a parallel one.
 *
 * Canonical secret-shape coverage (regex parity with the product
 * source-of-truth) lives in e2e-redaction-parity.test.ts; this file
 * focuses on the entry-point behaviour and SecretStore delegation.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import { buildChildEnv, isValidSecretEnvKey, redactString } from "../fixtures/redaction.ts";
import { SecretStore } from "../fixtures/secrets.ts";
import { ShellProbe, trustedShellCommand } from "../fixtures/shell-probe.ts";

function supportProgress() {
  return startTestProgress(
    "ShellProbe redaction support",
    ["run redaction probe", "verify redacted evidence"],
    { logLine: () => undefined },
  );
}

describe("fixture redaction entry point", () => {
  it("recognizes pass env names only at exact or underscore-delimited boundaries", () => {
    for (const key of ["PASS", "PASSWD", "CUSTOM_PASS", "CUSTOM_PASSWD"]) {
      expect(isValidSecretEnvKey(key), key).toBe(true);
    }
    for (const key of ["COMPASS", "BYPASS", "PASSENGER_COUNT", "PASSED"]) {
      expect(isValidSecretEnvKey(key), key).toBe(false);
    }

    expect(
      buildChildEnv(
        { COMPASS: "north", BYPASS: "allowed" },
        { fixtureOverlay: {}, additionalAllowedEnv: ["COMPASS", "BYPASS"] },
      ),
    ).toMatchObject({ COMPASS: "north", BYPASS: "allowed" });
  });

  it("passes only the workflow-owned trace directory through child env", () => {
    const childEnv = buildChildEnv(
      {
        PATH: "/usr/bin",
        NEMOCLAW_TRACE_DIR: "/tmp/nemoclaw-traces",
        NEMOCLAW_TRACE_FILE: "/tmp/nemoclaw-trace.json",
        NEMOCLAW_TRACE_EXPORTER: "debug",
        NEMOCLAW_LOG_LEVEL: "debug",
      },
      { fixtureOverlay: {} },
    );

    expect(childEnv.NEMOCLAW_TRACE_DIR).toBe("/tmp/nemoclaw-traces");
    expect(childEnv.NEMOCLAW_TRACE_FILE).toBeUndefined();
    expect(childEnv.NEMOCLAW_TRACE_EXPORTER).toBeUndefined();
    expect(childEnv.NEMOCLAW_LOG_LEVEL).toBe("debug");
  });

  it("preserves the trace directory when fixture overlay values are layered", () => {
    const childEnv = buildChildEnv(
      {
        PATH: "/usr/bin",
        E2E_ARTIFACT_DIR: "/tmp/e2e-artifacts/live/target",
        NEMOCLAW_TRACE_DIR: "/tmp/nemoclaw-e2e-traces/target",
        NEMOCLAW_TRACE_FILE: "/tmp/raw-trace.json",
        NVIDIA_INFERENCE_API_KEY: "nvapi-test-secret",
      },
      {
        fixtureOverlay: {
          E2E_CONTEXT_DIR: "/tmp/e2e-context",
          E2E_PHASE: "onboard",
          E2E_TARGET_ID: "ubuntu-repo-cloud-openclaw",
        },
        secretEnv: ["NVIDIA_INFERENCE_API_KEY"],
      },
    );

    expect(childEnv).toMatchObject({
      E2E_ARTIFACT_DIR: "/tmp/e2e-artifacts/live/target",
      E2E_CONTEXT_DIR: "/tmp/e2e-context",
      E2E_PHASE: "onboard",
      E2E_TARGET_ID: "ubuntu-repo-cloud-openclaw",
      NEMOCLAW_TRACE_DIR: "/tmp/nemoclaw-e2e-traces/target",
      NVIDIA_INFERENCE_API_KEY: "nvapi-test-secret",
    });
    expect(childEnv.NEMOCLAW_TRACE_FILE).toBeUndefined();
  });

  it("redacts explicit values with [REDACTED] and canonical shapes with <REDACTED>", () => {
    const explicit = "test-secret-aBcD";
    const canonical = `nvapi-${"x".repeat(24)}`;
    const text = `explicit=${explicit} canonical=${canonical}`;

    const out = redactString(text, [explicit]);

    expect(out).toContain("[REDACTED]");
    expect(out).toContain("<REDACTED>");
    expect(out).not.toContain(explicit);
    expect(out).not.toContain(canonical);
  });

  it("keeps explicit sentinels stable without masking adjacent credential text", () => {
    const explicit = "test-secret-aBcD";
    const once = redactString(`TOKEN=${explicit}`, [explicit]);

    expect(once).toBe("TOKEN=[REDACTED]");
    expect(redactString(once)).toBe(once);
    expect(redactString("TOKEN=prefix[REDACTED]suffix")).toBe("TOKEN=<REDACTED>");
  });

  it("redacts a complete multi-segment LangSmith key without exposing its tail", () => {
    const canonical = `lsv2_sk_${"a".repeat(36)}_${"tail".repeat(3)}`;

    const out = redactString(`canonical=${canonical}`);

    expect(out).toBe("canonical=<REDACTED>");
    expect(out).not.toContain("_tailtailtail");
  });

  it("applies explicit values longest first so a shorter substring cannot expose a longer one", () => {
    const longer = "alpha-beta-gamma";
    const shorter = "alpha";
    const text = `value=${longer}`;

    const out = redactString(text, [shorter, longer]);

    expect(out).toBe("value=[REDACTED]");
    expect(out).not.toContain("-beta-gamma");
    expect(out).not.toContain(shorter);
  });

  it("ignores empty explicit values without throwing", () => {
    const out = redactString("plain text", ["", "  "]);
    expect(out).toBe("plain text");
  });

  it("returns the input unchanged when no explicit values are supplied and no shape matches", () => {
    expect(redactString("nothing sensitive here")).toBe("nothing sensitive here");
    expect(redactString("nothing sensitive here", [])).toBe("nothing sensitive here");
  });

  it("preserves managed credential references and non-credential JSON identifiers", () => {
    const discordReference = "openshell:resolve:env:DISCORD_BOT_TOKEN";
    const versionedReference = "openshell:resolve:env:v2237303833964223913_WECHAT_BOT_TOKEN";
    const slackReference = "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN";
    const discordAssignment = `DISCORD_BOT_TOKEN=${discordReference}`;
    const text = JSON.stringify({
      key: "agent:main:main",
      replyMarker: "A2603-REPLY",
      token: discordReference,
      versionedToken: versionedReference,
      botToken: slackReference,
    });

    expect(redactString(text)).toBe(text);
    expect(redactString(discordAssignment)).toBe(discordAssignment);
    const collision = `\uE000 NEMOCLAW_SAFE_CREDENTIAL_REFERENCE_0 \uE001 ${text}`;
    expect(redactString(collision)).toBe(collision);
    expect(redactString(text, [discordReference])).not.toContain(discordReference);
    expect(redactString('{"replyToken":"opaqueCredentialPayloadZ1234567890"}')).toBe(
      '{"replyToken":"<REDACTED>"}',
    );

    const privateKey = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      `opaquePrivateMaterial123 ${discordReference} morePrivateMaterial456`,
      ["-----END", "PRIVATE KEY-----"].join(" "),
    ].join("\n");
    expect(redactString(privateKey)).toBe("<REDACTED>");
  });

  it.each([
    ["attached suffix", "TOKEN=openshell:resolve:env:FOO-opaqueCredentialPayloadZ1234567890"],
    ["dot suffix", "TOKEN=openshell:resolve:env:FOO.opaqueCredentialPayloadZ1234567890"],
    ["slash suffix", "TOKEN=openshell:resolve:env:FOO/opaqueCredentialPayloadZ1234567890"],
    ["colon suffix", "TOKEN=openshell:resolve:env:FOO:opaqueCredentialPayloadZ1234567890"],
    ["semicolon suffix", "TOKEN=openshell:resolve:env:FOO;opaqueCredentialPayloadZ1234567890"],
    ["hash suffix", "TOKEN=openshell:resolve:env:FOO#opaqueCredentialPayloadZ1234567890"],
    ["comma suffix", "TOKEN=openshell:resolve:env:FOO,opaqueCredentialPayloadZ1234567890"],
    ["brace suffix", "TOKEN=openshell:resolve:env:FOO}opaqueCredentialPayloadZ1234567890"],
    ["bracket suffix", "TOKEN=openshell:resolve:env:FOO]opaqueCredentialPayloadZ1234567890"],
    ["nested assignment", "TOKEN=foo=openshell:resolve:env:FOO"],
    ["short prefix", "TOKEN=short:openshell:resolve:env:FOO"],
    ["oversized revision", `TOKEN=openshell:resolve:env:v${"1".repeat(21)}_FOO`],
    ["oversized identifier", `TOKEN=openshell:resolve:env:${"A".repeat(129)}`],
    ["mixed case", "TOKEN=OpenShell:Resolve:Env:FOO"],
    ["lowercase Slack", "TOKEN=xoxb-openshell-resolve-env-SLACK_BOT_TOKEN"],
  ])("redacts a managed-reference lookalike with $label", (_label, value) => {
    const out = redactString(value);
    expect(out).toContain("<REDACTED>");
    expect(out).not.toContain(value.slice("TOKEN=".length));
  });

  it("returns empty input verbatim", () => {
    expect(redactString("")).toBe("");
    expect(redactString("", ["anything"])).toBe("");
  });

  it("redacts generated private-key blocks without preregistration", () => {
    const privateKey = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      "unknown-generated-private-key-material",
      ["-----END", "PRIVATE KEY-----"].join(" "),
    ].join("\\n");

    const out = redactString(JSON.stringify({ privateKey }));

    expect(out).toContain("<REDACTED>");
    expect(out).not.toContain("unknown-generated-private-key-material");
    expect(out).not.toContain("PRIVATE KEY");
  });

  it("SecretStore.redact routes through the same entry and unions env-derived and caller-supplied values", () => {
    const envSecret = "env-secret-value";
    const extraSecret = "extra-secret-value";
    const canonical = `ghp_${"y".repeat(36)}`;
    const store = new SecretStore(
      {
        MY_API_KEY: envSecret,
        UNRELATED_VAR: "kept-visible",
      },
      (note?: string): never => {
        throw new Error(note ?? "skipped");
      },
    );

    const text = `env=${envSecret} extra=${extraSecret} canonical=${canonical} keep=kept-visible`;
    const out = store.redact(text, [extraSecret]);

    expect(out).toContain("env=[REDACTED]");
    expect(out).toContain("extra=[REDACTED]");
    expect(out).toContain("canonical=<REDACTED>");
    expect(out).toContain("keep=kept-visible");
    expect(out).not.toContain(envSecret);
    expect(out).not.toContain(extraSecret);
    expect(out).not.toContain(canonical);
  });

  it("redacts raw secrets at the uploaded artifact sink", async () => {
    const fakeHostedKey = "fake-hosted-inference-key-for-artifact-scan";
    const fakeDockerToken = "fake-docker-token-for-artifact-scan";
    const generatedGatewayToken = "generated-gateway-token-for-artifact-scan";
    const fakeGitHubToken = `ghp_${"g".repeat(36)}`;
    const fakeMessagingToken = ["xox", "b-1234567890-abcdefghij"].join("");
    const generatedPrivateKey = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      "unknown-generated-artifact-private-key-material",
      ["-----END", "PRIVATE KEY-----"].join(" "),
    ].join("\\n");
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-e2e-artifact-redaction-"));
    const artifacts = new ArtifactSink(path.join(rootDir, "e2e-artifacts/live/redaction-smoke"), [
      fakeHostedKey,
      fakeDockerToken,
    ]);
    artifacts.addRedactionValues([generatedGatewayToken]);
    await artifacts.ensureRoot();
    const secrets = new SecretStore(
      { NVIDIA_INFERENCE_API_KEY: fakeHostedKey },
      (note?: string): never => {
        throw new Error(note ?? "skipped");
      },
    );
    const probe = new ShellProbe({
      artifacts,
      progress: supportProgress(),
      redact: (text, extra) => secrets.redact(text, extra),
      signal: new AbortController().signal,
    });

    const directArtifactPaths = await Promise.all([
      artifacts.writeJson("run-plan.json", {
        targetId: "redaction-smoke",
        note: `plan saw ${fakeHostedKey}`,
        githubToken: fakeGitHubToken,
      }),
      artifacts.writeJson("target-result.json", {
        id: "redaction-smoke",
        output: `result saw ${fakeDockerToken}`,
        messagingToken: fakeMessagingToken,
        generatedPrivateKey,
      }),
      artifacts.writeText("actions/redacted-action.log", `action saw ${fakeHostedKey}`),
      artifacts.writeText("logs/redacted-live.log", `log saw ${generatedGatewayToken}`),
    ]);
    const result = await probe.run(
      trustedShellCommand({
        command: "bash",
        args: [
          "-lc",
          "printf 'stdout:%s\\n' \"$NVIDIA_INFERENCE_API_KEY\"; printf 'stderr:%s\\n' \"$NVIDIA_INFERENCE_API_KEY\" >&2",
        ],
        reason: "exercise hosted inference secret redaction in uploaded shell-probe artifacts",
      }),
      {
        artifactName: "hosted-inference-secret-smoke",
        env: { NVIDIA_INFERENCE_API_KEY: fakeHostedKey },
        redactionValues: [fakeHostedKey],
      },
    );
    const uploadedPaths = [...directArtifactPaths, ...Object.values(result.artifacts)];
    const uploadedTexts = await Promise.all(
      uploadedPaths.map((artifactPath) => fs.readFile(artifactPath, "utf8")),
    );

    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stderr).toContain("[REDACTED]");
    const uploadedText = uploadedTexts.join("\n");
    for (const secret of [
      fakeHostedKey,
      fakeDockerToken,
      generatedGatewayToken,
      fakeGitHubToken,
      fakeMessagingToken,
      generatedPrivateKey,
    ]) {
      expect(uploadedText).not.toContain(secret);
    }
    expect(uploadedText).toContain("[REDACTED]");
    expect(uploadedText).toContain("<REDACTED>");
    expect(uploadedText).not.toContain("PRIVATE KEY");
    expect(
      uploadedPaths.map((artifactPath) => path.relative(artifacts.rootDir, artifactPath)),
    ).toEqual(
      expect.arrayContaining([
        "run-plan.json",
        "target-result.json",
        "actions/redacted-action.log",
        "logs/redacted-live.log",
        "shell/hosted-inference-secret-smoke.stdout.txt",
        "shell/hosted-inference-secret-smoke.stderr.txt",
        "shell/hosted-inference-secret-smoke.result.json",
      ]),
    );

    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("bounds high-volume shell output while preserving a redacted diagnostic tail", async () => {
    const secret = "fake-rebuild-output-secret-value";
    const boundarySecret = "fake-secret-that-crosses-the-capture-boundary";
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-e2e-bounded-output-"));
    try {
      const artifacts = new ArtifactSink(path.join(rootDir, "e2e-artifacts/live/bounded-output"));
      await artifacts.ensureRoot();
      const probe = new ShellProbe({
        artifacts,
        progress: supportProgress(),
        redact: (text, extra) => redactString(text, extra),
        signal: new AbortController().signal,
      });
      const stdoutSuffix = `${secret}-stdout-tail`;
      const stdoutTail = `${"t".repeat(84 - stdoutSuffix.length)}${stdoutSuffix}`;
      const stdoutPayload = `${"o".repeat(64)}${boundarySecret}${stdoutTail}`;
      const stderrSuffix = `${secret}-stderr-tail`;
      const stderrTail = `${"t".repeat(94 - stderrSuffix.length)}${stderrSuffix}`;
      const stderrPayload = `${"e".repeat(64)}🦀${stderrTail}`;

      const result = await probe.run(
        trustedShellCommand({
          command: "bash",
          args: ["-lc", 'printf "%s" "$STDOUT_PAYLOAD"; printf "%s" "$STDERR_PAYLOAD" >&2'],
          reason: "exercise bounded output capture for long E2E commands",
        }),
        {
          artifactName: "bounded-output",
          captureLimitBytes: 96,
          env: { STDOUT_PAYLOAD: stdoutPayload, STDERR_PAYLOAD: stderrPayload },
          redactionValues: [secret, boundarySecret],
        },
      );

      expect(result.stdout).toContain("[shell-probe omitted ");
      expect(result.stdout).toContain("[REDACTED]-stdout-tail");
      expect(result.stdout).not.toContain(boundarySecret.slice(-12));
      expect(result.stderr).toContain("[shell-probe omitted ");
      expect(result.stderr).toContain("[REDACTED]-stderr-tail");
      expect(result.stderr).not.toContain("�");
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      await expect(fs.readFile(result.artifacts.stdout, "utf8")).resolves.toBe(result.stdout);
      await expect(fs.readFile(result.artifacts.stderr, "utf8")).resolves.toBe(result.stderr);
      await expect(fs.readFile(result.artifacts.result, "utf8")).resolves.not.toContain(secret);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid capture limit %s before spawning a child or writing artifacts", async (captureLimitBytes) => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-e2e-invalid-capture-"));
    try {
      const artifactRoot = path.join(rootDir, "e2e-artifacts/live/invalid-capture");
      const spawnMarker = path.join(rootDir, "spawned.txt");
      const artifacts = new ArtifactSink(artifactRoot);
      await artifacts.ensureRoot();
      const probe = new ShellProbe({
        artifacts,
        progress: supportProgress(),
        redact: (text, extra) => redactString(text, extra),
        signal: new AbortController().signal,
      });

      await expect(
        probe.run(
          trustedShellCommand({
            command: "bash",
            args: ["-lc", 'printf spawned >"$SPAWN_MARKER"'],
            reason: "prove invalid output limits fail before child execution",
          }),
          { captureLimitBytes, env: { SPAWN_MARKER: spawnMarker } },
        ),
      ).rejects.toThrow("captureLimitBytes must be a positive safe integer");
      await expect(fs.access(spawnMarker)).rejects.toThrow();
      await expect(fs.readdir(artifactRoot)).resolves.toEqual([]);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
