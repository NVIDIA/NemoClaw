// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security regression test: credential values must never appear in --credential
// CLI arguments. OpenShell reads credential values from the environment when
// only the env-var name is passed (e.g. --credential "NVIDIA_API_KEY"), so
// there is no reason to pass the secret itself on the command line where it
// would be visible in `ps aux` output.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import { buildSubprocessEnv as buildCliSubprocessEnv } from "../src/lib/subprocess-env";
import { buildSubprocessEnv as buildPluginSubprocessEnv } from "../nemoclaw/src/lib/subprocess-env";
import { getCurlTimingArgs } from "../src/lib/http-probe";

const require = createRequire(import.meta.url);
const { buildProviderArgs } = require("../dist/lib/onboard-providers.js") as {
  buildProviderArgs: (
    action: "create" | "update",
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
  ) => string[];
};

const ONBOARD_JS = path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts");
const ONBOARD_PROVIDERS_JS = path.join(import.meta.dirname, "..", "src", "lib", "onboard-providers.ts");
const RUNNER_TS = path.join(import.meta.dirname, "..", "nemoclaw", "src", "blueprint", "runner.ts");
const SERVICES_TS = path.join(import.meta.dirname, "..", "src", "lib", "services.ts");

// Matches --credential followed by a value containing "=" (i.e. KEY=VALUE).
// Catches quoted KEY=VALUE patterns in JS and Python f-string interpolation.
// Assumes credentials are always in quoted strings (which matches our codebase).
// NOTE: unquoted forms like `--credential KEY=VALUE` would not be detected.
const JS_EXPOSURE_RE = /--credential\s+[^"]*"[A-Z_]+=/;
const JS_CREDENTIAL_CONCAT_RE = /--credential.*=.*process\.env\./;
// TS pattern: --credential with template literal interpolation containing "="
const TS_EXPOSURE_RE = /--credential.*=.*\$\{/;

describe("credential exposure in process arguments", () => {
  it("onboard.js must not pass KEY=VALUE to --credential", () => {
    const src = fs.readFileSync(ONBOARD_JS, "utf-8");
    const lines = src.split("\n");

    const violations = lines.filter(
      (line) =>
        (JS_EXPOSURE_RE.test(line) || JS_CREDENTIAL_CONCAT_RE.test(line)) &&
        // Allow comments that describe the old pattern
        !line.trimStart().startsWith("//"),
    );

    expect(violations).toEqual([]);
  });

  it("runner.ts must not pass KEY=VALUE to --credential", () => {
    const src = fs.readFileSync(RUNNER_TS, "utf-8");
    const lines = src.split("\n");

    const violations = lines.filter(
      (line) =>
        TS_EXPOSURE_RE.test(line) &&
        line.includes("--credential") &&
        !line.trimStart().startsWith("//"),
    );

    expect(violations).toEqual([]);
  });

  it("onboard.js --credential flags pass env var names only", () => {
    const args = buildProviderArgs(
      "create",
      "inference",
      "openai",
      "NVIDIA_API_KEY",
      "https://api.example.test/v1",
    );

    expect(args).toContain("--credential");
    expect(args).toContain("NVIDIA_API_KEY");
    expect(args.join(" ")).not.toContain("NVIDIA_API_KEY=");
    expect(args.join(" ")).not.toContain("nvapi-");
  });

  it("subprocess-env TLS allowlist includes git, curl, and python CA vars (#2270)", () => {
    const tlsEnv = {
      GIT_SSL_CAINFO: "/tmp/git-ca.pem",
      GIT_SSL_CAPATH: "/tmp/git-ca-dir",
      CURL_CA_BUNDLE: "/tmp/curl-ca.pem",
      REQUESTS_CA_BUNDLE: "/tmp/requests-ca.pem",
    };
    const previous = Object.fromEntries(
      Object.keys(tlsEnv).map((key) => [key, process.env[key]] as const),
    );
    try {
      Object.assign(process.env, tlsEnv);
      for (const buildSubprocessEnv of [buildCliSubprocessEnv, buildPluginSubprocessEnv]) {
        const env = buildSubprocessEnv();
        expect(Object.fromEntries(Object.keys(tlsEnv).map((key) => [key, env[key]]))).toEqual(
          tlsEnv,
        );
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("subprocess-env TLS allowlists in CLI and plugin are in sync (#2270)", () => {
    const tlsEnv = {
      GIT_SSL_CAINFO: "/tmp/git-ca.pem",
      GIT_SSL_CAPATH: "/tmp/git-ca-dir",
      CURL_CA_BUNDLE: "/tmp/curl-ca.pem",
      REQUESTS_CA_BUNDLE: "/tmp/requests-ca.pem",
    };
    const previous = Object.fromEntries(
      Object.keys(tlsEnv).map((key) => [key, process.env[key]] as const),
    );
    try {
      Object.assign(process.env, tlsEnv);
      const tlsKeys = Object.keys(tlsEnv);
      const cliEnv = buildCliSubprocessEnv();
      const pluginEnv = buildPluginSubprocessEnv();
      expect(Object.fromEntries(tlsKeys.map((key) => [key, cliEnv[key]]))).toEqual(
        Object.fromEntries(tlsKeys.map((key) => [key, pluginEnv[key]])),
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("subprocess env builder does not spread full process.env into subprocesses", () => {
    const previous = {
      NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
      PATH: process.env.PATH,
    };
    try {
      process.env.NVIDIA_API_KEY = "nvapi-secret-should-not-leak";
      process.env.PATH = `/tmp/nemoclaw-fake-bin:${process.env.PATH || ""}`;
      const env = buildCliSubprocessEnv();
      expect(env.NVIDIA_API_KEY).toBeUndefined();
      expect(env.PATH).toContain("/tmp/nemoclaw-fake-bin");
    } finally {
      if (previous.NVIDIA_API_KEY === undefined) {
        delete process.env.NVIDIA_API_KEY;
      } else {
        process.env.NVIDIA_API_KEY = previous.NVIDIA_API_KEY;
      }
      if (previous.PATH === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previous.PATH;
      }
    }
  });

  it("onboard curl probes use explicit timeouts", () => {
    expect(getCurlTimingArgs()).toEqual(["--connect-timeout", "10", "--max-time", "60"]);
  });

});
