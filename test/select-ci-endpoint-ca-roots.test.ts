// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CI_CA_ENDPOINTS,
  CI_CA_SYSTEM_BUNDLE,
  MAX_CI_CA_CERTIFICATES,
  MAX_CI_CA_ENCODED_BYTES,
  normalizeCompactRootBundle,
  type OpenSslRunner,
  selectCiEndpointCaRoots,
} from "../scripts/checks/select-ci-endpoint-ca-roots.mts";
import { LEAF_PEM, PEM, tmpDir } from "../src/lib/onboard/__test-helpers__/corporate-ca-fixtures";

const hasOpenSsl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

function openssl(args: readonly string[], cwd: string): void {
  const result = spawnSync("openssl", [...args], {
    cwd,
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: 10_000,
  });
  expect(result.status, `OpenSSL fixture command failed: ${args[0]}`).toBe(0);
}

function createEndpointCertificate(directory: string): { leaf: string; root: string } {
  fs.writeFileSync(
    path.join(directory, "leaf.ext"),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${CI_CA_ENDPOINTS.map((endpoint) => `DNS:${endpoint}`).join(",")}`,
      "",
    ].join("\n"),
  );
  openssl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=NemoClaw CI Root",
      "-keyout",
      "root.key",
      "-out",
      "root.pem",
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    directory,
  );
  openssl(
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${CI_CA_ENDPOINTS[0]}`,
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
    ],
    directory,
  );
  openssl(
    [
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "root.pem",
      "-CAkey",
      "root.key",
      "-CAcreateserial",
      "-out",
      "leaf.pem",
      "-days",
      "2",
      "-extfile",
      "leaf.ext",
    ],
    directory,
  );
  return {
    leaf: fs.readFileSync(path.join(directory, "leaf.pem"), "utf8"),
    root: fs.readFileSync(path.join(directory, "root.pem"), "utf8"),
  };
}

describe("CI endpoint CA root selection", () => {
  it("keeps the endpoint set and build-argument limits fixed", () => {
    expect(CI_CA_SYSTEM_BUNDLE).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(CI_CA_ENDPOINTS).toEqual(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
    expect(MAX_CI_CA_CERTIFICATES).toBe(24);
    expect(MAX_CI_CA_ENCODED_BYTES).toBe(65_536);
  });

  it("deduplicates CA roots and rejects leaf certificates or oversized output", () => {
    expect(normalizeCompactRootBundle([PEM, PEM])).toBe(PEM);
    expect(() => normalizeCompactRootBundle([LEAF_PEM])).toThrow(/CA:TRUE root/u);
    expect(() =>
      normalizeCompactRootBundle([PEM], { certificates: 0, encodedBytes: 65_536 }),
    ).toThrow(/exceeds 0 certificates/u);
    expect(() => normalizeCompactRootBundle([PEM], { certificates: 24, encodedBytes: 1 })).toThrow(
      /exceeds 1 encoded bytes/u,
    );
  });

  it.skipIf(!hasOpenSsl)(
    "selects one system root after offline hostname verification for every endpoint",
    () => {
      const directory = tmpDir();
      const output = path.join(directory, "compact.pem");
      fs.writeFileSync(output, "", { mode: 0o600 });
      const fixture = createEndpointCertificate(directory);
      const realReadFile = fs.readFileSync.bind(fs);
      vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) =>
        file === CI_CA_SYSTEM_BUNDLE
          ? fixture.root
          : realReadFile(file, ...args)) as typeof fs.readFileSync);

      const connections: string[][] = [];
      const runConnection: OpenSslRunner = (args) => {
        connections.push([...args]);
        return {
          status: 0,
          stderr: "",
          stdout: `${fixture.leaf}\nVerify return code: 0 (ok)\n`,
        };
      };
      const runActualOpenSsl: OpenSslRunner = (args) => {
        const result = spawnSync("openssl", [...args], {
          encoding: "utf8",
          killSignal: "SIGKILL",
          timeout: 10_000,
        });
        return {
          error: result.error,
          status: result.status,
          stderr: result.stderr ?? "",
          stdout: result.stdout ?? "",
        };
      };
      const runner: OpenSslRunner = (args) =>
        args[0] === "s_client" ? runConnection(args) : runActualOpenSsl(args);

      expect(selectCiEndpointCaRoots(output, runner)).toEqual({
        certificates: 1,
        encodedBytes: Buffer.from(fixture.root).toString("base64").length,
      });
      expect(fs.readFileSync(output, "utf8")).toBe(fixture.root);
      expect(connections).toHaveLength(CI_CA_ENDPOINTS.length * 2);
      for (const endpoint of CI_CA_ENDPOINTS) {
        const endpointConnections = connections.filter((args) => args.includes(`${endpoint}:443`));
        expect(endpointConnections).toEqual([
          [
            "s_client",
            "-connect",
            `${endpoint}:443`,
            "-servername",
            endpoint,
            "-verify_hostname",
            endpoint,
            "-verify_return_error",
            "-CAfile",
            CI_CA_SYSTEM_BUNDLE,
            "-no-CApath",
            "-no-CAstore",
            "-showcerts",
          ],
          [
            "s_client",
            "-connect",
            `${endpoint}:443`,
            "-servername",
            endpoint,
            "-verify_hostname",
            endpoint,
            "-verify_return_error",
            "-CAfile",
            expect.stringMatching(/\/compact\.pem$/u),
            "-no-CApath",
            "-no-CAstore",
          ],
        ]);
      }

      fs.writeFileSync(output, "unchanged", { mode: 0o600 });
      const rejectCompactVerification: OpenSslRunner = (args) =>
        args[0] === "s_client" && !args.includes("-showcerts")
          ? { status: 1, stderr: "verification failed", stdout: "" }
          : runner(args);
      expect(() => selectCiEndpointCaRoots(output, rejectCompactVerification)).toThrow(
        /compact CA verification for registry\.npmjs\.org failed/u,
      );
      expect(fs.readFileSync(output, "utf8")).toBe("unchanged");
    },
  );
});
