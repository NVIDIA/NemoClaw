// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTED_NATIVE_PROVIDERS } from "../../../../src/lib/inference/native-provider/hosted.ts";
import {
  CANDIDATE_MANAGED_IMAGE_AGENTS,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../../../src/lib/onboard/managed-image/contract.ts";
import { validateCandidateContract } from "../../../../tools/managed-images/validate-candidate-contract.mts";
import {
  readWorkflow,
  required,
  step,
} from "../../../helpers/managed-image-publication-workflow.ts";

const root = path.resolve(import.meta.dirname, "../../../..");

const DIGEST = `sha256:${"a".repeat(64)}`;

function candidateContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    agent: "pi",
    platform: "linux/amd64",
    image: "ghcr.io/nvidia/nemoclaw/pi-sandbox",
    digest: DIGEST,
    reference: `ghcr.io/nvidia/nemoclaw/pi-sandbox@${DIGEST}`,
    source: {
      repository: "NVIDIA/NemoClaw",
      revision: "b".repeat(40),
      release: "v0.0.104",
      cohort: "ghrun-12345-1",
    },
    startupProfileContractVersion: 1,
    capabilityContractVersion: 1,
    ...overrides,
  };
}

describe("Pi release cohort separation", () => {
  it("keeps pi a candidate agent and out of the shipped cohort", () => {
    expect(CANDIDATE_MANAGED_IMAGE_AGENTS).toContain("pi");
    expect(SHIPPED_MANAGED_IMAGE_AGENTS).not.toContain("pi");
  });
});

describe("Pi candidate contract validation", () => {
  it.each([
    "Validate the Pi candidate runtime contract",
    "Validate the published Pi candidate digest",
  ])("%s requires the direct startup runtime", (stepName) => {
    const workflow = readWorkflow("managed-images.yaml");
    const piCandidate = required(
      workflow.jobs?.["pi-candidate"],
      "managed-image workflow is missing its Pi candidate job",
    );
    const validation = step(piCandidate, stepName).run ?? "";

    expect(validation).toContain("managed-startup-image-runtime.cjs");
    expect(validation).toContain("nemoclaw-managed-startup-hold");
    expect(validation).toContain("test ! -e /usr/local/bin/nemoclaw-managed-bootstrap");
    expect(validation).toContain(
      "test ! -e /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh",
    );
    expect(validation).not.toContain("test -x /usr/local/bin/nemoclaw-managed-bootstrap");
  });

  it("accepts an exact candidate contract", () => {
    const contract = validateCandidateContract(candidateContract(), "linux/amd64");
    expect(contract.agent).toBe("pi");
    expect(contract.platform).toBe("linux/amd64");
    expect(contract.source.repository).toBe("NVIDIA/NemoClaw");
    expect(contract.reference).toBe(`ghcr.io/nvidia/nemoclaw/pi-sandbox@${DIGEST}`);
  });

  it("validates a published candidate contract with plain Node", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-contract-"));
    try {
      const contractPath = path.join(directory, "contract.json");
      fs.writeFileSync(
        contractPath,
        JSON.stringify(candidateContract({ platform: "linux/arm64" })),
      );
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, "tools/managed-images/validate-candidate-contract.mts"),
          "--contract",
          contractPath,
          "--platform",
          "linux/arm64",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "" },
          timeout: 5_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Validated candidate contract for pi on linux/arm64");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a contract whose agent is not a candidate managed-image agent", () => {
    expect(() =>
      validateCandidateContract(
        candidateContract({
          agent: "hermes",
          image: "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
          reference: `ghcr.io/nvidia/nemoclaw/hermes-sandbox@${DIGEST}`,
        }),
        "linux/amd64",
      ),
    ).toThrow(/not a candidate managed-image agent/u);
  });

  it("rejects a candidate contract published for another platform", () => {
    expect(() => validateCandidateContract(candidateContract(), "linux/arm64")).toThrow(
      /contract.platform must be/u,
    );
  });
});

describe("Pi managed model catalog generation", () => {
  function generate(
    env: Record<string, string>,
    initialize: (home: string) => void = () => undefined,
  ): {
    home: string;
    status: number | null;
    stderr: string;
  } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-config-"));
    initialize(home);
    const result = spawnSync(process.execPath, [path.join(root, "agents/pi/generate-config.ts")], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
    });
    return { home, status: result.status, stderr: result.stderr };
  }

  function nativeCatalog() {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "selected-local-model",
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
      NEMOCLAW_LOCAL_INFERENCE_TOKEN: "raw-build-secret-must-not-be-serialized",
    });
    try {
      expect(status, stderr).toBe(0);
      const text = fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8");
      expect(text).not.toContain("raw-build-secret-must-not-be-serialized");
      return JSON.parse(text).providers.openshell as {
        apiKey: string;
        headers: { Authorization: string };
      };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  function resolveCommand(value: string, token: string) {
    expect(value.startsWith("!")).toBe(true);
    return spawnSync("/bin/sh", ["-c", value.slice(1)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NEMOCLAW_LOCAL_INFERENCE_TOKEN: token },
    });
  }

  it.each(["v2", `s${"a".repeat(64)}`])(
    "resolves a Pi native-local request with the issued %s credential",
    (identity) => {
      const provider = nativeCatalog();
      const token = `openshell:resolve:env:${identity}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
      expect(resolveCommand(provider.apiKey, token).stdout).toBe(token);
      // A stored Pi key can override apiKey; pin the actual request header.
      const header = resolveCommand(provider.headers.Authorization, token);
      expect(header.status, header.stderr).toBe(0);
      expect(header.stdout).toBe(`Bearer ${token}`);
    },
  );

  it.each([
    "",
    "raw-host-secret",
    "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    "openshell:resolve:env:v2_OTHER_TOKEN",
    "openshell:resolve:env:v2_NEMOCLAW_LOCAL_INFERENCE_TOKEN\n",
  ])("refuses invalid Pi native-local credential %j", (token) => {
    const provider = nativeCatalog();
    const key = resolveCommand(provider.apiKey, token);
    expect(key.status).not.toBe(0);
    expect(key.stdout).toBe("");
    expect(key.stderr).toBe("");
    const header = resolveCommand(provider.headers.Authorization, token);
    expect(header.status).not.toBe(0);
    expect(header.stdout).toBe("");
    expect(header.stderr).toBe("");
  });

  it.each(["http://host.openshell.internal:11434/v1", "https://inference.local/v1"])(
    "initializes managed defaults from empty Pi settings at %s",
    (endpoint) => {
      const { home, status, stderr } = generate(
        {
          NEMOCLAW_MODEL: "selected-model",
          NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
          NEMOCLAW_INFERENCE_BASE_URL: endpoint,
        },
        (home) => {
          const configDir = path.join(home, ".pi/agent");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "settings.json"), "");
        },
      );
      try {
        expect(status, stderr).toBe(0);
        const settingsPath = path.join(home, ".pi/agent/settings.json");
        expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
          defaultProvider: "openshell",
          defaultModel: "selected-model",
        });
        expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.each([" ", "{broken", "null", "[]", "42"])(
    "rejects invalid nonempty Pi settings %j without overwriting them",
    (settings) => {
      const { home, status } = generate(
        {
          NEMOCLAW_MODEL: "selected-model",
          NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
          NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
        },
        (home) => {
          const configDir = path.join(home, ".pi/agent");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "settings.json"), settings);
        },
      );
      try {
        expect(status).not.toBe(0);
        expect(fs.readFileSync(path.join(home, ".pi/agent/settings.json"), "utf8")).toBe(settings);
        expect(fs.existsSync(path.join(home, ".pi/agent/models.json"))).toBe(false);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("preserves the previous Pi catalog when settings sync fails (#13362)", () => {
    const selected = {
      NEMOCLAW_MODEL: "previous-model",
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
    };
    const { home, status, stderr } = generate(selected);
    try {
      expect(status, stderr).toBe(0);
      const configDir = path.join(home, ".pi/agent");
      const modelsPath = path.join(configDir, "models.json");
      const settingsPath = path.join(configDir, "settings.json");
      const previousCatalog = fs.readFileSync(modelsPath);
      fs.writeFileSync(settingsPath, "{invalid json");

      const failed = spawnSync(
        process.execPath,
        [path.join(root, "agents/pi/generate-config.ts")],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            ...selected,
            NEMOCLAW_MODEL: "next-model",
          },
        },
      );
      expect(failed.status).not.toBe(0);
      expect(fs.readFileSync(modelsPath)).toEqual(previousCatalog);
      expect(fs.statSync(modelsPath).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(settingsPath, "utf8")).toBe("{invalid json");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves both Pi files when settings permission update fails (#13362)", () => {
    const selected = {
      NEMOCLAW_MODEL: "previous-model",
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
    };
    const { home, status, stderr } = generate(selected);
    try {
      expect(status, stderr).toBe(0);
      const configDir = path.join(home, ".pi/agent");
      const modelsPath = path.join(configDir, "models.json");
      const settingsPath = path.join(configDir, "settings.json");
      const previousCatalog = fs.readFileSync(modelsPath);
      const previousSettings = fs.readFileSync(settingsPath);
      const shimPath = path.join(home, "fail-settings-permissions.cjs");
      fs.writeFileSync(
        shimPath,
        `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const chmodSync = fs.chmodSync;
fs.chmodSync = (target, mode) => {
  if (String(target).includes("settings.json")) throw new Error("simulated settings chmod failure");
  return chmodSync(target, mode);
};
fs.fchmodSync = () => { throw new Error("simulated settings chmod failure"); };
syncBuiltinESMExports();\n`,
      );

      const failed = spawnSync(
        process.execPath,
        ["--require", shimPath, path.join(root, "agents/pi/generate-config.ts")],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            ...selected,
            NEMOCLAW_MODEL: "next-model",
          },
        },
      );
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain("simulated settings chmod failure");
      expect(fs.readFileSync(modelsPath)).toEqual(previousCatalog);
      expect(fs.readFileSync(settingsPath)).toEqual(previousSettings);
      expect(fs.readdirSync(configDir).sort()).toEqual(["models.json", "settings.json"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["close", "remove"])(
    "retains the staging failure when %s cleanup fails (#13362)",
    (failedCleanup) => {
      const selected = {
        NEMOCLAW_MODEL: "previous-model",
        NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
        NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
      };
      const { home, status, stderr } = generate(selected);
      try {
        expect(status, stderr).toBe(0);
        const configDir = path.join(home, ".pi/agent");
        const modelsPath = path.join(configDir, "models.json");
        const settingsPath = path.join(configDir, "settings.json");
        const previousCatalog = fs.readFileSync(modelsPath);
        const previousSettings = fs.readFileSync(settingsPath);
        const removalMarker = path.join(home, "staged-removal-attempt.txt");
        const shimPath = path.join(home, "fail-staged-cleanup.cjs");
        fs.writeFileSync(
          shimPath,
          `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalOpen = fs.openSync;
const originalClose = fs.closeSync;
const originalRemove = fs.rmSync;
let stagedDescriptor;
fs.openSync = (target, ...args) => {
  const descriptor = originalOpen(target, ...args);
  if (String(target).includes(".settings.json.")) stagedDescriptor = descriptor;
  return descriptor;
};
fs.fchmodSync = () => { throw new Error("simulated staging failure"); };
fs.closeSync = (descriptor) => {
  if (${JSON.stringify(failedCleanup)} === "close" && descriptor === stagedDescriptor) {
    throw new Error("simulated close failure");
  }
  return originalClose(descriptor);
};
fs.rmSync = (target, options) => {
  if (String(target).includes(".settings.json.")) {
    fs.writeFileSync(${JSON.stringify(removalMarker)}, String(target));
    if (${JSON.stringify(failedCleanup)} === "remove") {
      throw new Error("simulated remove failure");
    }
  }
  return originalRemove(target, options);
};
syncBuiltinESMExports();\n`,
        );

        const failed = spawnSync(
          process.execPath,
          ["--require", shimPath, path.join(root, "agents/pi/generate-config.ts")],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              PATH: process.env.PATH ?? "",
              HOME: home,
              ...selected,
              NEMOCLAW_MODEL: "next-model",
            },
          },
        );
        expect(failed.status).not.toBe(0);
        expect(failed.stderr).toContain("simulated staging failure");
        expect(failed.stderr).toContain(`simulated ${failedCleanup} failure`);
        expect(fs.readFileSync(modelsPath)).toEqual(previousCatalog);
        expect(fs.readFileSync(settingsPath)).toEqual(previousSettings);
        const stagedPath = fs.readFileSync(removalMarker, "utf8");
        expect(stagedPath).toContain(".settings.json.");
        expect(failed.stderr).toContain(stagedPath);
        expect(fs.existsSync(stagedPath)).toBe(failedCleanup === "remove");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("updates the target of an existing Pi settings symlink (#13362)", () => {
    const { home, status, stderr } = generate(
      {
        NEMOCLAW_MODEL: "selected-model",
        NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
        NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
      },
      (home) => {
        const configDir = path.join(home, ".pi/agent");
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(home, "user-settings.json"), '{"theme":"dark"}\n');
        fs.symlinkSync(
          path.join(home, "user-settings.json"),
          path.join(configDir, "settings.json"),
        );
      },
    );
    try {
      expect(status, stderr).toBe(0);
      const settingsPath = path.join(home, ".pi/agent/settings.json");
      expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(home, "user-settings.json"), "utf8"))).toEqual({
        theme: "dark",
        defaultProvider: "openshell",
        defaultModel: "selected-model",
      });
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "absolute",
      prepare: (home: string, configDir: string) => {
        const target = path.join(home, "user-settings.json");
        fs.symlinkSync(target, path.join(configDir, "settings.json"));
        return target;
      },
    },
    {
      name: "relative",
      prepare: (home: string, configDir: string) => {
        fs.symlinkSync("../../user-settings.json", path.join(configDir, "settings.json"));
        return path.join(home, "user-settings.json");
      },
    },
    {
      name: "chained",
      prepare: (home: string, configDir: string) => {
        const intermediate = path.join(home, "settings-link.json");
        fs.symlinkSync("user-settings.json", intermediate);
        fs.symlinkSync(intermediate, path.join(configDir, "settings.json"));
        return path.join(home, "user-settings.json");
      },
    },
    {
      name: "symlinked-parent",
      prepare: (home: string, configDir: string) => {
        const targetDir = path.join(home, "config");
        fs.mkdirSync(targetDir);
        fs.rmdirSync(configDir);
        fs.symlinkSync(targetDir, configDir);
        fs.symlinkSync("../user-settings.json", path.join(configDir, "settings.json"));
        return path.join(home, "user-settings.json");
      },
    },
    {
      name: "target-parent-link",
      prepare: (home: string, configDir: string) => {
        fs.mkdirSync(path.join(home, "nested/directory"), { recursive: true });
        fs.symlinkSync(path.join(home, "nested/directory"), path.join(home, "directory-link"));
        fs.symlinkSync(
          `${home}/directory-link/../user-settings.json`,
          path.join(configDir, "settings.json"),
        );
        return path.join(home, "nested/user-settings.json");
      },
    },
  ])("creates the missing target of a $name Pi settings symlink (#13362)", ({ prepare }) => {
    let target = "";
    const { home, status, stderr } = generate(
      {
        NEMOCLAW_MODEL: "selected-model",
        NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
        NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
      },
      (home) => {
        const configDir = path.join(home, ".pi/agent");
        fs.mkdirSync(configDir, { recursive: true });
        target = prepare(home, configDir);
      },
    );
    try {
      expect(status, stderr).toBe(0);
      const settingsPath = path.join(home, ".pi/agent/settings.json");
      expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({
        defaultProvider: "openshell",
        defaultModel: "selected-model",
      });
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(settingsPath)).toEqual(fs.readFileSync(target));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves the settings symlink and removes the catalog when the target directory is missing (#13362)", () => {
    const { home, status, stderr } = generate(
      {
        NEMOCLAW_MODEL: "selected-model",
        NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
        NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
      },
      (home) => {
        const configDir = path.join(home, ".pi/agent");
        fs.mkdirSync(configDir, { recursive: true });
        fs.symlinkSync(
          path.join(home, "missing-directory/user-settings.json"),
          path.join(configDir, "settings.json"),
        );
      },
    );
    try {
      expect(status).not.toBe(0);
      expect(stderr).toContain("ENOENT");
      const configDir = path.join(home, ".pi/agent");
      expect(fs.lstatSync(path.join(configDir, "settings.json")).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(configDir)).toEqual(["settings.json"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("updates Pi's managed defaults when the native-local model changes and preserves other settings", () => {
    const selected = {
      NEMOCLAW_MODEL: "selected-local-model",
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
    };
    const { home, status, stderr } = generate(selected);
    try {
      expect(status, stderr).toBe(0);
      const settingsPath = path.join(home, ".pi/agent/settings.json");
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
        defaultProvider: "openshell",
        defaultModel: "selected-local-model",
      });
      const userSettings =
        '{"defaultProvider":"other","defaultModel":"old-model","futurePiSetting":true}\n';
      fs.writeFileSync(settingsPath, userSettings);
      const rerun = spawnSync(process.execPath, [path.join(root, "agents/pi/generate-config.ts")], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          ...selected,
          NEMOCLAW_MODEL: "next-local-model",
        },
      });
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
        defaultProvider: "openshell",
        defaultModel: "next-local-model",
        futurePiSetting: true,
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(home, ".pi/agent/models.json"), "utf8")).defaultModel,
      ).toBe("next-local-model");
      const hosted = spawnSync(
        process.execPath,
        [path.join(root, "agents/pi/generate-config.ts")],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            ...selected,
            NEMOCLAW_MODEL: "next-hosted-model",
            NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
          },
        },
      );
      expect(hosted.status, hosted.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
        defaultProvider: "openshell",
        defaultModel: "next-hosted-model",
        futurePiSetting: true,
      });
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["ollama-local", "http://host.openshell.internal:11434/v1", true],
    ["vllm-local", "http://host.docker.internal:8000/v1", true],
    ["llama-cpp-local", "http://192.168.1.2:8080/v1", true],
    ["compatible-endpoint", "http://10.0.0.2:11434/v1", true],
    ["compatible-endpoint", "http://192.168.1.20:9001/v1", true],
    ["compatible-endpoint", "https://inference.local/v1", false],
    ["compatible-endpoint", "https://api.example.com/v1", false],
    ["nvidia", "http://host.openshell.internal:8000/v1", false],
  ])("keeps Pi %s at %s on the selected credential route", (provider, endpoint, native) => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "selected-model",
      NEMOCLAW_UPSTREAM_PROVIDER: provider,
      NEMOCLAW_INFERENCE_BASE_URL: endpoint,
    });
    try {
      expect(status, stderr).toBe(0);
      const config = JSON.parse(fs.readFileSync(path.join(home, ".pi/agent/models.json"), "utf8"));
      expect(config.providers.openshell.baseUrl).toBe(endpoint);
      expect(config.providers.openshell.models[0].id).toBe("selected-model");
      expect(config.providers.openshell.apiKey.startsWith("!")).toBe(native);
      expect(config.providers.openshell.headers !== undefined).toBe(native);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes an owner-only catalog that routes the managed model", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });
    expect(status, stderr).toBe(0);
    const configPath = path.join(home, ".pi", "agent", "models.json");
    const configFd = fs.openSync(configPath, "r");
    let config: {
      defaultModel: string;
      providers: Record<string, { baseUrl: string; api: string; apiKey: string }>;
    };
    try {
      expect(fs.fstatSync(configFd).mode & 0o777).toBe(0o600);
      config = JSON.parse(fs.readFileSync(configFd, "utf8"));
    } finally {
      fs.closeSync(configFd);
    }
    expect(config.defaultModel).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(config.providers.openshell.baseUrl).toBe("https://inference.local/v1");
    expect(config.providers.openshell.api).toBe("openai-completions");
    expect(config.providers.openshell.apiKey).toBe("nemoclaw-managed-inference");
    expect(fs.existsSync(path.join(home, ".pi/agent/settings.json"))).toBe(false);
  });

  it("rejects a model name that is empty after trimming", () => {
    const { status, stderr } = generate({
      NEMOCLAW_MODEL: "   ",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("NEMOCLAW_MODEL must not be empty.");
  });

  it.each([
    ...HOSTED_NATIVE_PROVIDERS.filter((provider) => provider.api === "openai-completions"),
    {
      label: "NVIDIA",
      logicalProvider: "nvidia-prod",
      endpoint: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    },
  ])("generates native $label routing without writing the host credential (#12589)", (provider) => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "selected-model",
      NEMOCLAW_UPSTREAM_PROVIDER: provider.logicalProvider,
      NEMOCLAW_INFERENCE_BASE_URL: provider.endpoint,
      [provider.credentialEnv]: "host-credential-must-not-be-written",
    });
    try {
      expect(status, stderr).toBe(0);
      const text = fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8");
      expect(JSON.parse(text).providers.openshell).toEqual({
        api: "openai-completions",
        apiKey: `\${${provider.credentialEnv}}`,
        baseUrl: provider.endpoint,
        models: [{ id: "selected-model" }],
        ...(provider.logicalProvider === "openrouter-api"
          ? {
              headers: {
                "HTTP-Referer": "https://www.nvidia.com/nemoclaw/",
                "X-OpenRouter-Title": "NVIDIA NemoClaw",
              },
            }
          : {}),
      });
      expect(text).not.toContain("host-credential-must-not-be-written");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps every provider credential out of the generated catalog", () => {
    const { home } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NVIDIA_API_KEY: "nvapi-should-never-be-written",
      OPENAI_API_KEY: "sk-proj-should-never-be-written",
    });
    const config = fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8");
    expect(config).not.toContain("nvapi-");
    expect(config).not.toContain("sk-proj-");
  });

  it("rejects an inference API family other than openai-completions", () => {
    const { status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_API: "openai-responses",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("NEMOCLAW_INFERENCE_API must be openai-completions for Pi.");
  });

  it("rejects an inference base URL that carries credentials", () => {
    const { status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://user:secret@inference.local/v1",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("NEMOCLAW_INFERENCE_BASE_URL must not include credentials.");
  });

  function readManagedModel(home: string): Record<string, unknown> {
    const config = JSON.parse(
      fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8"),
    ) as { providers: Record<string, { models: Record<string, unknown>[] }> };
    return config.providers.openshell.models[0] as Record<string, unknown>;
  }

  it("writes the context window, output limit, and reasoning support Pi documents (#7930)", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_CONTEXT_WINDOW: "262144",
      NEMOCLAW_MAX_TOKENS: "32000",
      NEMOCLAW_REASONING: "true",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({
      id: "nvidia/nemotron-3-super-120b-a12b",
      contextWindow: 262_144,
      maxTokens: 32_000,
      reasoning: true,
    });
  });

  it("omits unset model tuning so Pi keeps its own defaults (#7930)", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_CONTEXT_WINDOW: "",
      NEMOCLAW_MAX_TOKENS: "",
      NEMOCLAW_REASONING: "",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({ id: "nvidia/nemotron-3-super-120b-a12b" });
  });

  it("records a disabled reasoning decision instead of dropping it (#7930)", () => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_REASONING: "false",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({
      id: "nvidia/nemotron-3-super-120b-a12b",
      reasoning: false,
    });
  });

  it.each([
    ["NEMOCLAW_CONTEXT_WINDOW", "128k", "NEMOCLAW_CONTEXT_WINDOW must be a positive integer."],
    ["NEMOCLAW_MAX_TOKENS", "0", "NEMOCLAW_MAX_TOKENS must be a positive integer."],
    ["NEMOCLAW_REASONING", "yes", 'NEMOCLAW_REASONING must be "true" or "false".'],
  ])("rejects %s=%s before writing a catalog (#7930)", (name, value, message) => {
    const { home, status, stderr } = generate({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      [name]: value,
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain(message);
    expect(fs.existsSync(path.join(home, ".pi", "agent", "models.json"))).toBe(false);
  });
});
