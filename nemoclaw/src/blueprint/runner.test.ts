// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type fs from "node:fs";
import YAML from "yaml";

// ── In-memory filesystem ────────────────────────────────────────

interface FsEntry {
  type: "file" | "dir";
  content?: string;
}

const store = new Map<string, FsEntry>();

function addFile(p: string, content: string): void {
  store.set(p, { type: "file", content });
}

function addDir(p: string): void {
  store.set(p, { type: "dir" });
}

const FAKE_HOME = "/fakehome";

vi.mock("node:os", () => ({
  homedir: () => FAKE_HOME,
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
    mkdirSync: vi.fn((p: string) => {
      addDir(p);
    }),
    readFileSync: (p: string) => {
      const entry = store.get(p);
      if (entry?.type !== "file") throw new Error(`ENOENT: ${p}`);
      return entry.content ?? "";
    },
    writeFileSync: vi.fn((p: string, data: string) => {
      store.set(p, { type: "file", content: data });
    }),
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const entries = new Set<string>();
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const first = rest.split("/")[0];
          if (first) entries.add(first);
        }
      }
      if (entries.size === 0 && !store.has(p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return [...entries].sort();
    },
  };
});

const mockExeca = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

vi.mock("./ssrf.js", () => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  validateEndpointUrl: vi.fn(async (url: string) => url),
}));

const { validateEndpointUrl } = await import("./ssrf.js");
const mockedValidateEndpoint = vi.mocked(validateEndpointUrl);

const { emitRunId, loadBlueprint, actionPlan, actionApply, actionStatus, actionRollback, main } =
  await import("./runner.js");

// ── Helpers ─────────────────────────────────────────────────────

const stdoutChunks: string[] = [];

function captureStdout(): void {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
}

function stdoutText(): string {
  return stdoutChunks.join("");
}

function minimalBlueprint(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          default: {
            provider_type: "openai",
            provider_name: "my-provider",
            endpoint: "https://api.example.com/v1",
            model: "gpt-4",
            credential_env: "MY_API_KEY",
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      policy: { additions: {} },
    },
    ...overrides,
  };
}

function seedBlueprintFile(bp?: Record<string, unknown>): void {
  addFile("blueprint.yaml", YAML.stringify(bp ?? minimalBlueprint()));
}

// ── Tests ───────────────────────────────────────────────────────

describe("runner", () => {
  beforeEach(() => {
    store.clear();
    stdoutChunks.length = 0;
    vi.clearAllMocks();
    delete process.env.NEMOCLAW_BLUEPRINT_PATH;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("emitRunId", () => {
    it("returns an ID matching nc-YYYYMMDD-HHMMSS-<hex8> pattern", () => {
      captureStdout();
      const rid = emitRunId();
      expect(rid).toMatch(/^nc-\d{8}-\d{6}-[a-f0-9]{8}$/);
    });

    it("writes RUN_ID line to stdout", () => {
      captureStdout();
      const rid = emitRunId();
      expect(stdoutText()).toContain(`RUN_ID:${rid}`);
    });
  });

  describe("loadBlueprint", () => {
    it("throws when blueprint.yaml is missing", () => {
      expect(() => loadBlueprint()).toThrow(/blueprint\.yaml not found/);
    });

    it("parses blueprint.yaml from current directory", () => {
      addFile("blueprint.yaml", YAML.stringify({ version: "2.0" }));
      expect(loadBlueprint()).toEqual({ version: "2.0" });
    });

    it("respects NEMOCLAW_BLUEPRINT_PATH env var", () => {
      process.env.NEMOCLAW_BLUEPRINT_PATH = "/custom/path";
      addFile("/custom/path/blueprint.yaml", YAML.stringify({ version: "3.0" }));
      expect(loadBlueprint()).toEqual({ version: "3.0" });
    });
  });

  describe("actionPlan", () => {
    it("throws when profile is not found", async () => {
      captureStdout();
      const bp = minimalBlueprint();
      await expect(actionPlan("nonexistent", bp)).rejects.toThrow(/not found.*Available: default/);
    });

    it("throws when openshell is not available", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 1 });
      await expect(actionPlan("default", minimalBlueprint())).rejects.toThrow(
        /openshell CLI not found/,
      );
    });

    it("returns a valid plan when openshell is available", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });

      const plan = await actionPlan("default", minimalBlueprint());

      expect(plan.profile).toBe("default");
      expect(plan.sandbox.name).toBe("test-sandbox");
      expect(plan.sandbox.image).toBe("openclaw");
      expect(plan.sandbox.forward_ports).toEqual([18789]);
      expect(plan.inference.model).toBe("gpt-4");
      expect(plan.inference.endpoint).toBe("https://api.example.com/v1");
      expect(plan.dry_run).toBe(false);
    });

    it("passes dryRun through to the plan", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });

      const plan = await actionPlan("default", minimalBlueprint(), { dryRun: true });
      expect(plan.dry_run).toBe(true);
    });

    it("validates and applies endpoint URL override", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });

      const plan = await actionPlan("default", minimalBlueprint(), {
        endpointUrl: "https://override.example.com/v1",
      });
      expect(plan.inference.endpoint).toBe("https://override.example.com/v1");
      expect(mockedValidateEndpoint).toHaveBeenCalledWith("https://override.example.com/v1");
    });

    it("SSRF-validates the blueprint-defined endpoint even without --endpoint-url override", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });
      mockedValidateEndpoint.mockRejectedValueOnce(new Error("SSRF blocked: private IP"));

      const bp = minimalBlueprint({
        components: {
          inference: {
            profiles: {
              malicious: {
                provider_type: "openai",
                endpoint: "http://169.254.169.254/latest/meta-data",
                model: "gpt-4",
                credential_env: "KEY",
              },
            },
          },
          sandbox: { name: "sb" },
        },
      });

      await expect(actionPlan("malicious", bp)).rejects.toThrow("SSRF blocked: private IP");
      expect(mockedValidateEndpoint).toHaveBeenCalledWith(
        "http://169.254.169.254/latest/meta-data",
      );
    });

    it("emits progress and RUN_ID lines", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });

      await actionPlan("default", minimalBlueprint());
      const out = stdoutText();
      expect(out).toContain("RUN_ID:");
      expect(out).toContain("PROGRESS:10:Validating blueprint");
      expect(out).toContain("PROGRESS:100:Plan complete");
    });
  });

  describe("actionApply", () => {
    beforeEach(() => {
      captureStdout();
      // Default: all subprocess calls succeed
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    });

    it("creates sandbox with correct arguments", async () => {
      await actionApply("default", minimalBlueprint());

      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "create", "--from", "openclaw", "--name", "test-sandbox", "--forward", "18789"],
        expect.objectContaining({ reject: false }),
      );
    });

    it("reuses sandbox when 'already exists' error", async () => {
      mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "already exists" });
      // Subsequent calls succeed
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      await actionApply("default", minimalBlueprint());
      expect(stdoutText()).toContain("already exists, reusing");
    });

    it("throws when sandbox creation fails with other error", async () => {
      mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "disk full" });

      await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
        /Failed to create sandbox.*disk full/,
      );
    });

    it("passes credential via subprocess env, not global env", async () => {
      process.env.MY_API_KEY = "secret-key-123";
      try {
        await actionApply("default", minimalBlueprint());

        // The provider create call should scope credentials to env
        const providerCall = mockExeca.mock.calls.find(
          (c) => Array.isArray(c[1]) && c[1].includes("provider"),
        );
        if (!providerCall) throw new Error("provider create call not found");
        expect(providerCall[2].env.OPENAI_API_KEY).toBe("secret-key-123");
        // Args pass the env var NAME, not the value
        expect(providerCall[1]).toContain("--credential");
        expect(providerCall[1]).toContain("OPENAI_API_KEY");
        expect(providerCall[1]).not.toContain("secret-key-123");
      } finally {
        delete process.env.MY_API_KEY;
      }
    });

    it("saves run state to disk", async () => {
      await actionApply("default", minimalBlueprint());

      const stateKeys = [...store.keys()].filter((k) => k.includes("/state/runs/"));
      const planKey = stateKeys.find((k) => k.endsWith("/plan.json"));
      if (!planKey) throw new Error("plan.json not written to state dir");
      const entry = store.get(planKey);
      if (!entry?.content) throw new Error("plan.json has no content");

      const plan = JSON.parse(entry.content);
      expect(plan.profile).toBe("default");
      expect(plan.sandbox_name).toBe("test-sandbox");
      expect(plan.timestamp).toBeDefined();
    });

    it("excludes secret fields from persisted plan.json", async () => {
      const bp = {
        components: {
          inference: {
            profiles: {
              secrets: {
                provider_type: "openai",
                endpoint: "https://api.example.com",
                model: "gpt-4",
                credential_env: "SECRET_KEY",
                credential_default: "default-secret-value",
              },
            },
          },
          sandbox: { name: "sb" },
        },
      };
      process.env.SECRET_KEY = "real-secret";
      try {
        await actionApply("secrets", bp);
      } finally {
        delete process.env.SECRET_KEY;
      }

      const planKey = [...store.keys()].find((k) => k.endsWith("/plan.json"));
      if (!planKey) throw new Error("plan.json not written to state dir");
      const entry = store.get(planKey);
      if (!entry?.content) throw new Error("plan.json has no content");
      const persisted = JSON.parse(entry.content);

      expect(persisted.inference).not.toHaveProperty("credential_env");
      expect(persisted.inference).not.toHaveProperty("credential_default");
      // Ensure non-secret fields are still present
      expect(persisted.inference.provider_type).toBe("openai");
      expect(persisted.inference.endpoint).toBe("https://api.example.com");
    });

    it("emits all progress milestones", async () => {
      await actionApply("default", minimalBlueprint());
      const out = stdoutText();
      expect(out).toContain("PROGRESS:20:Creating OpenClaw sandbox");
      expect(out).toContain("PROGRESS:50:Configuring inference provider");
      expect(out).toContain("PROGRESS:70:Setting inference route");
      expect(out).toContain("PROGRESS:85:Saving run state");
      expect(out).toContain("PROGRESS:100:Apply complete");
    });

    it("uses defaults when profile fields are missing", async () => {
      const sparseBlueprint = {
        components: {
          inference: { profiles: { bare: {} } },
          sandbox: {},
        },
      };

      await actionApply("bare", sparseBlueprint);

      // Provider create should use fallback defaults
      const providerCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("provider"),
      );
      if (!providerCall) throw new Error("provider create call not found");
      expect(providerCall[1]).toContain("default"); // provider_name fallback
      expect(providerCall[1]).toContain("openai"); // provider_type fallback

      // Sandbox create should use fallback defaults
      const sandboxCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("sandbox"),
      );
      if (!sandboxCall) throw new Error("sandbox create call not found");
      expect(sandboxCall[1]).toContain("openclaw"); // image & name fallback

      const out = stdoutText();
      expect(out).toContain("Apply complete");
    });

    it("skips credential when credential_env is not set", async () => {
      const noCredBlueprint = {
        components: {
          inference: {
            profiles: {
              nocred: {
                provider_type: "openai",
                endpoint: "https://api.example.com",
                model: "gpt-4",
              },
            },
          },
          sandbox: { name: "sb" },
        },
      };

      await actionApply("nocred", noCredBlueprint);

      const providerCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("provider"),
      );
      if (!providerCall) throw new Error("provider create call not found");
      expect(providerCall[1]).not.toContain("--credential");
    });

    it("falls back to credential_default when env var is unset", async () => {
      const bp = {
        components: {
          inference: {
            profiles: {
              withdefault: {
                credential_env: "UNSET_CRED_VAR",
                credential_default: "fallback-key",
              },
            },
          },
          sandbox: {},
        },
      };

      await actionApply("withdefault", bp);

      const providerCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("provider"),
      );
      if (!providerCall) throw new Error("provider create call not found");
      expect(providerCall[2].env.OPENAI_API_KEY).toBe("fallback-key");
    });

    it("validates and applies endpoint URL override", async () => {
      await actionApply("default", minimalBlueprint(), {
        endpointUrl: "https://override.example.com/v1",
      });
      expect(mockedValidateEndpoint).toHaveBeenCalledWith("https://override.example.com/v1");
    });

    it("passes --timeout when timeout_secs is set in profile", async () => {
      const bp = {
        components: {
          inference: {
            profiles: {
              local: {
                provider_type: "openai",
                provider_name: "ollama-local",
                endpoint: "http://localhost:11434/v1",
                model: "nemotron-3-super:120b",
                credential_env: "OPENAI_API_KEY",
                credential_default: "ollama",
                timeout_secs: 180,
              },
            },
          },
          sandbox: { name: "sb" },
        },
      };
      process.env.OPENAI_API_KEY = "ollama";
      try {
        await actionApply("local", bp);
      } finally {
        delete process.env.OPENAI_API_KEY;
      }

      const inferenceCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("inference") && c[1].includes("set"),
      );
      if (!inferenceCall) throw new Error("inference set call not found");
      expect(inferenceCall[1]).toContain("--timeout");
      expect(inferenceCall[1]).toContain("180");
    });

    it("omits --timeout when timeout_secs is not set in profile", async () => {
      await actionApply("default", minimalBlueprint());

      const inferenceCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("inference") && c[1].includes("set"),
      );
      if (!inferenceCall) throw new Error("inference set call not found");
      expect(inferenceCall[1]).not.toContain("--timeout");
    });
  });

  describe("actionStatus", () => {
    const RUNS_DIR = `${FAKE_HOME}/.nemoclaw/state/runs`;

    beforeEach(() => {
      captureStdout();
    });

    it("prints 'No runs found.' when runs dir does not exist", () => {
      actionStatus();
      expect(stdoutText()).toContain("No runs found.");
    });

    it("prints 'No runs found.' when runs dir is empty", () => {
      addDir(RUNS_DIR);
      actionStatus();
      expect(stdoutText()).toContain("No runs found.");
    });

    it("prints plan.json for most recent run", () => {
      const plan = { run_id: "nc-run-2", profile: "default" };
      addDir(`${RUNS_DIR}/nc-run-1`);
      addFile(`${RUNS_DIR}/nc-run-1/plan.json`, JSON.stringify({ run_id: "nc-run-1" }));
      addDir(`${RUNS_DIR}/nc-run-2`);
      addFile(`${RUNS_DIR}/nc-run-2/plan.json`, JSON.stringify(plan));

      actionStatus();
      // Should pick the latest (nc-run-2 sorts after nc-run-1)
      expect(stdoutText()).toContain('"nc-run-2"');
    });

    it("prints plan.json for a specific run ID", () => {
      addDir(`${RUNS_DIR}/nc-run-1`);
      addFile(`${RUNS_DIR}/nc-run-1/plan.json`, JSON.stringify({ run_id: "nc-run-1" }));

      actionStatus("nc-run-1");
      expect(stdoutText()).toContain('"nc-run-1"');
    });

    it("prints unknown status when plan.json is missing", () => {
      addDir(`${RUNS_DIR}/nc-run-1`);

      actionStatus("nc-run-1");
      expect(stdoutText()).toContain('"status":"unknown"');
    });
  });

  describe("actionRollback", () => {
    const RUNS_DIR = `${FAKE_HOME}/.nemoclaw/state/runs`;

    beforeEach(() => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    });

    it("throws when run ID is not found", async () => {
      await expect(actionRollback("nc-missing")).rejects.toThrow(/nc-missing not found/);
    });

    it("stops and removes sandbox from plan", async () => {
      const runDir = `${RUNS_DIR}/nc-run-1`;
      addDir(runDir);
      addFile(`${runDir}/plan.json`, JSON.stringify({ sandbox_name: "my-sandbox" }));

      await actionRollback("nc-run-1");

      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "stop", "my-sandbox"],
        expect.objectContaining({ reject: false }),
      );
      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "remove", "my-sandbox"],
        expect.objectContaining({ reject: false }),
      );
    });

    it("writes rolled_back marker file", async () => {
      const runDir = `${RUNS_DIR}/nc-run-1`;
      addDir(runDir);
      addFile(`${runDir}/plan.json`, JSON.stringify({ sandbox_name: "sb" }));

      await actionRollback("nc-run-1");

      expect(store.has(`${runDir}/rolled_back`)).toBe(true);
    });

    it("still writes marker when plan.json is missing", async () => {
      const runDir = `${RUNS_DIR}/nc-run-1`;
      addDir(runDir);
      // No plan.json — should skip sandbox stop/remove but still mark rolled_back

      await actionRollback("nc-run-1");

      expect(mockExeca).not.toHaveBeenCalled();
      expect(store.has(`${runDir}/rolled_back`)).toBe(true);
    });

    it("defaults sandbox_name to 'openclaw' when not in plan", async () => {
      const runDir = `${RUNS_DIR}/nc-run-1`;
      addDir(runDir);
      addFile(`${runDir}/plan.json`, JSON.stringify({}));

      await actionRollback("nc-run-1");

      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "stop", "openclaw"],
        expect.anything(),
      );
    });
  });

  describe("main (CLI)", () => {
    beforeEach(() => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      // main() calls loadBlueprint() before dispatching the action
      seedBlueprintFile();
    });

    it("throws on unknown action", async () => {
      await expect(main(["bogus"])).rejects.toThrow(/Unknown action/);
    });

    it("throws on missing action", async () => {
      await expect(main([])).rejects.toThrow(/Unknown action/);
    });

    it("parses plan with --profile and --dry-run", async () => {
      await main(["plan", "--profile", "default", "--dry-run"]);
      const out = stdoutText();
      expect(out).toContain('"dry_run": true');
    });

    it("parses rollback with --run-id", async () => {
      const runDir = `${FAKE_HOME}/.nemoclaw/state/runs/nc-run-1`;
      addDir(runDir);
      addFile(`${runDir}/plan.json`, JSON.stringify({ sandbox_name: "sb" }));

      await main(["rollback", "--run-id", "nc-run-1"]);
      expect(store.has(`${runDir}/rolled_back`)).toBe(true);
    });

    it("throws when rollback has no --run-id", async () => {
      await expect(main(["rollback"])).rejects.toThrow(/--run-id is required/);
    });

    it("parses status with --run-id", async () => {
      const runDir = `${FAKE_HOME}/.nemoclaw/state/runs/nc-run-1`;
      addDir(runDir);
      addFile(`${runDir}/plan.json`, JSON.stringify({ run_id: "nc-run-1" }));

      await main(["status", "--run-id", "nc-run-1"]);
      expect(stdoutText()).toContain("nc-run-1");
    });

    it("parses apply with --profile and --endpoint-url", async () => {
      await main(["apply", "--profile", "default", "--endpoint-url", "https://override.test/v1"]);
      expect(mockedValidateEndpoint).toHaveBeenCalledWith("https://override.test/v1");
      expect(stdoutText()).toContain("PROGRESS:100:Apply complete");
    });

    it("rejects --plan flag (not yet implemented)", async () => {
      await expect(
        main(["apply", "--profile", "default", "--plan", "/tmp/saved-plan.json"]),
      ).rejects.toThrow(/--plan is not yet implemented/);
    });

    it("parses --dry-run and --endpoint-url for plan", async () => {
      await main([
        "plan",
        "--profile",
        "default",
        "--dry-run",
        "--endpoint-url",
        "https://ep.test",
      ]);
      const out = stdoutText();
      expect(out).toContain('"dry_run": true');
      expect(out).toContain('"endpoint": "https://ep.test"');
      expect(mockedValidateEndpoint).toHaveBeenCalledWith("https://ep.test");
    });
  });
});
