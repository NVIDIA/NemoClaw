// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { test } from "../../helpers/owned-test-resources";
import {
  closeServer,
  freePort,
  startBackend,
  startProxy,
  terminate,
} from "../../ollama-auth-proxy-handler-helpers";

const execFileAsync = promisify(execFile);

test.skipIf(process.platform !== "linux")(
  "observes existing proxy state without migration or credential exposure (#11435)",
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-proxy-export-"));
    const state = path.join(directory, ".nemoclaw");
    const token = "export-credential-canary";
    const digest = "a".repeat(64);
    const backend = await startBackend({ ok: true, models: [{ name: "qwen3.5:9b", digest }] });
    let proxy;
    try {
      const port = await freePort();
      proxy = await startProxy(port, backend.port, token);
      fs.mkdirSync(state);
      const retained = {
        "ollama-proxy-token": token,
        "ollama-auth-proxy.pid": String(proxy.pid),
        "ollama-proxy-port": String(port),
        "ollama-backend": `http://127.0.0.1:${backend.port}`,
        "ollama-backend.json": JSON.stringify({
          schemaVersion: 1,
          kind: "ollama",
          url: `http://127.0.0.1:${backend.port}`,
        }),
      };
      fs.writeFileSync(path.join(state, "ollama-proxy-token"), retained["ollama-proxy-token"], {
        mode: 0o600,
      });
      fs.writeFileSync(
        path.join(state, "ollama-auth-proxy.pid"),
        retained["ollama-auth-proxy.pid"],
        {
          mode: 0o600,
        },
      );
      fs.writeFileSync(path.join(state, "ollama-proxy-port"), retained["ollama-proxy-port"], {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(state, "ollama-backend"), retained["ollama-backend"], {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(state, "ollama-backend.json"), retained["ollama-backend.json"], {
        mode: 0o600,
      });
      const script = `
const fs = require("node:fs");
const {createOllamaExportProbe} = require(${JSON.stringify(path.resolve(import.meta.dirname, "../../../src/lib/inference/ollama/proxy.ts"))});
const {observeOllamaProxy} = require(${JSON.stringify(path.resolve(import.meta.dirname, "../../../src/lib/inference/ollama/proxy-observation.ts"))});
const originalOpen = fs.openSync;
let credentialReads = 0;
fs.openSync = (...args) => {
  credentialReads += Number(args[0] === ${JSON.stringify(path.join(state, "ollama-proxy-token"))});
  return originalOpen(...args);
};
const rejection = (input) => {
  try { observeOllamaProxy(input); return "unexpected success"; }
  catch (error) { return error.message; }
};
process.env.WSL_DISTRO_NAME = "unsupported-export-host";
const unsupportedHost = rejection({model: "qwen3.5:9b", ...createOllamaExportProbe()});
delete process.env.WSL_DISTRO_NAME;
const invalidMetadata = rejection({model: "qwen3.5:9b", ...createOllamaExportProbe(), proxyPort: "invalid"});
const credentialReadsBeforeValid = credentialReads;
const observed = observeOllamaProxy({model: "qwen3.5:9b", ...createOllamaExportProbe()});
process.stdout.write(JSON.stringify({observed, unsupportedHost, invalidMetadata, credentialReadsBeforeValid, credentialReads}));
`;
      const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", script], {
        env: {
          ...process.env,
          HOME: directory,
          NEMOCLAW_OLLAMA_PORT: "11434",
          NEMOCLAW_OLLAMA_PROXY_PORT: "11435",
          WSL_DISTRO_NAME: "",
          WSL_INTEROP: "",
          HTTP_PROXY: "http://127.0.0.1:1",
          http_proxy: "http://127.0.0.1:1",
          ALL_PROXY: "http://127.0.0.1:1",
          all_proxy: "http://127.0.0.1:1",
          NO_PROXY: "",
          no_proxy: "",
        },
        timeout: 30000,
      });
      expect(JSON.parse(stdout)).toMatchObject({
        observed: {
          pid: proxy.pid,
          serving: {
            daemon: { management: "external", hostPort: backend.port },
            proxy: { management: "nemoclaw", hostPort: port },
            model: { digest: `sha256:${digest}` },
          },
        },
        unsupportedHost: "Ollama export requires a native Linux host.",
        invalidMetadata:
          "The live Ollama daemon, proxy mapping, or model could not be verified for export.",
        credentialReadsBeforeValid: 0,
        credentialReads: 1,
      });
      expect(stdout + stderr).not.toContain(token);
      expect(
        Object.fromEntries(
          fs
            .readdirSync(state)
            .map((name) => [name, fs.readFileSync(path.join(state, name), "utf8")]),
        ),
      ).toEqual(retained);
      expect(backend.captured).toHaveLength(2);
      expect(backend.captured.every(({ headers }) => headers.authorization === undefined)).toBe(
        true,
      );
    } finally {
      await terminate(proxy);
      await closeServer(backend.server);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
