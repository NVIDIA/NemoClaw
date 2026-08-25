// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security regression test: credential values must never appear in --credential
// CLI arguments. OpenShell reads credential values from the environment when
// only the env-var name is passed (e.g. --credential "NVIDIA_INFERENCE_API_KEY"), so
// there is no reason to pass the secret itself on the command line where it
// would be visible in `ps aux` output.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  buildSubprocessEnv as buildPluginSubprocessEnv,
  withLocalNoProxy as withPluginLocalNoProxy,
} from "../../nemoclaw/src/lib/subprocess-env";
import {
  buildSubprocessEnv as buildCliSubprocessEnv,
  withLocalNoProxy as withCliLocalNoProxy,
} from "../../src/lib/subprocess-env";

const require = createRequire(import.meta.url);
const { buildProviderArgs } = require("../../src/lib/onboard/providers.js") as {
  buildProviderArgs: (
    action: "create" | "update",
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
  ) => string[];
};

describe("credential exposure in process arguments", () => {
  it("onboard.js --credential flags pass env var names only", () => {
    const args = buildProviderArgs(
      "create",
      "inference",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      "https://api.example.test/v1",
    );

    expect(args).toContain("--credential");
    expect(args).toContain("NVIDIA_INFERENCE_API_KEY");
    expect(args.join(" ")).not.toContain("NVIDIA_INFERENCE_API_KEY=");
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
      [buildCliSubprocessEnv, buildPluginSubprocessEnv].forEach((buildSubprocessEnv) => {
        const env = buildSubprocessEnv();
        expect(Object.fromEntries(Object.keys(tlsEnv).map((key) => [key, env[key]]))).toEqual(
          tlsEnv,
        );
      });
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
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
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    }
  });

  it.each([withCliLocalNoProxy, withPluginLocalNoProxy])(
    "subprocess-env NO_PROXY local hosts are in sync for CLI and plugin [case %#]",
    (withLocalNoProxy) => {
      const env: Record<string, string> = {
        HTTP_PROXY: "http://proxy.example.com:8888",
        NO_PROXY: "corp.internal,localhost",
        no_proxy: "corp.internal,localhost",
      };

      withLocalNoProxy(env);

      expect(env.NO_PROXY).toBe(
        "corp.internal,localhost,127.0.0.1,host.docker.internal,host.containers.internal,::1,0.0.0.0,inference.local",
      );
      expect(env.no_proxy).toBe(
        "corp.internal,localhost,127.0.0.1,host.docker.internal,host.containers.internal,::1,0.0.0.0,inference.local",
      );
    },
  );

  it.each([withCliLocalNoProxy, withPluginLocalNoProxy])(
    "subprocess-env keeps a lowercase-only no_proxy exclusion in both spellings [case %#]",
    (withLocalNoProxy) => {
      const env: Record<string, string> = {
        HTTP_PROXY: "http://proxy.example.com:8888",
        no_proxy: "corp.internal",
      };

      withLocalNoProxy(env);

      expect(env.NO_PROXY).toBe(
        "corp.internal,localhost,127.0.0.1,host.docker.internal,host.containers.internal,::1,0.0.0.0,inference.local",
      );
      expect(env.no_proxy).toBe(env.NO_PROXY);
    },
  );

  it.each([withCliLocalNoProxy, withPluginLocalNoProxy])(
    "subprocess-env preserves distinct proxy exclusions in both spellings [case %#]",
    (withLocalNoProxy) => {
      const env: Record<string, string> = {
        HTTP_PROXY: "http://proxy.example.com:8888",
        NO_PROXY: "upper.internal",
        no_proxy: "lower.internal",
      };

      withLocalNoProxy(env);

      const expectedExclusions = new Set([
        "upper.internal",
        "lower.internal",
        "localhost",
        "127.0.0.1",
        "host.docker.internal",
        "host.containers.internal",
        "::1",
        "0.0.0.0",
        "inference.local",
      ]);
      const actualExclusions = env.NO_PROXY.split(",");
      expect(new Set(actualExclusions)).toEqual(expectedExclusions);
      expect(actualExclusions).toHaveLength(expectedExclusions.size);
      expect(env.no_proxy).toBe(env.NO_PROXY);
    },
  );

  it("subprocess env builder does not spread full process.env into subprocesses", () => {
    const previous = {
      NVIDIA_INFERENCE_API_KEY: process.env.NVIDIA_INFERENCE_API_KEY,
      PATH: process.env.PATH,
    };
    try {
      process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-secret-should-not-leak";
      process.env.PATH = `/tmp/nemoclaw-fake-bin:${process.env.PATH || ""}`;
      const env = buildCliSubprocessEnv();
      expect(env.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
      expect(env.PATH).toContain("/tmp/nemoclaw-fake-bin");
    } finally {
      if (previous.NVIDIA_INFERENCE_API_KEY === undefined) {
        delete process.env.NVIDIA_INFERENCE_API_KEY;
      } else {
        process.env.NVIDIA_INFERENCE_API_KEY = previous.NVIDIA_INFERENCE_API_KEY;
      }
      if (previous.PATH === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previous.PATH;
      }
    }
  });

});
