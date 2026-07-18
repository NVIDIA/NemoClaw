// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  type CommandResult,
  collectBrevDebugBundle,
  type DeleteRunners,
  deleteBrevInstance,
  downloadBrevCliArchive,
  type InstallRunners,
  installBrevCli,
  type Logger,
  type ReportPrRunners,
  reportPr,
} from "../../../tools/e2e/brev-lifecycle.mts";
import {
  assertInstanceName,
  assertPrNumber,
  assertRelativeDirPath,
  assertRepository,
  assertRunIdentifier,
  assertTestedShaCurrent,
  BREV_CLI_SHA256,
  brevCliDownloadUrl,
  brevInstanceName,
  brevInstancePresence,
  classifyValidationResult,
  normalizeBrevList,
  renderBrevPrComment,
  resolveValidationJobUrl,
  selectBrevLogin,
} from "../../../tools/e2e/brev-lifecycle-core.mts";

function fakeLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (m) => lines.push(`log:${m}`),
    warn: (m) => lines.push(`warn:${m}`),
    error: (m) => lines.push(`error:${m}`),
    annotateWarning: (m) => lines.push(`::warning::${m}`),
    annotateError: (m) => lines.push(`::error::${m}`),
  };
}

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom", status = 1): CommandResult => ({ status, stdout: "", stderr });

describe("selectBrevLogin (install/auth branches) (#6962)", () => {
  it("prefers API-key/organization login when both are present", () => {
    expect(selectBrevLogin({ apiKey: "k", orgId: "o", apiToken: "legacy" })).toEqual({
      kind: "api-key",
      apiKey: "k",
      orgId: "o",
    });
  });

  it("falls back to the legacy refresh token when the API key or org is missing", () => {
    expect(selectBrevLogin({ apiKey: "k", apiToken: "legacy" })).toEqual({
      kind: "legacy-token",
      token: "legacy",
    });
    expect(selectBrevLogin({ orgId: "o", apiToken: "legacy" })).toEqual({
      kind: "legacy-token",
      token: "legacy",
    });
  });

  it("fails closed when no auth is provided", () => {
    expect(() => selectBrevLogin({})).toThrow(/Brev auth is empty/);
    expect(() => selectBrevLogin({ apiKey: "  ", orgId: "  ", apiToken: "  " })).toThrow(
      /Brev auth is empty/,
    );
  });
});

describe("installBrevCli (#6962)", () => {
  function installRunners(overrides: Partial<InstallRunners> = {}) {
    const calls: string[] = [];
    const tarball = Buffer.from("brev-cli-tarball");
    const runners: InstallRunners = {
      download: async (url) => {
        calls.push(`download:${url}`);
        return tarball;
      },
      extractBrevBinary: () => calls.push("extract"),
      brevLogin: (apiKey, orgId) => calls.push(`login:${apiKey}:${orgId}`),
      writeLegacyCredentials: (token) => calls.push(`legacy:${token}`),
      writeOnboardingSuppression: () => calls.push("onboarding"),
      brevReady: () => calls.push("ready"),
      logger: fakeLogger(),
      ...overrides,
    };
    const sha = createHash("sha256").update(tarball).digest("hex");
    return { runners, calls, sha };
  }

  it("verifies the checksum, logs in with the API key, and confirms readiness", async () => {
    const { runners, calls, sha } = installRunners();

    await installBrevCli({ apiKey: "k", orgId: "o" }, runners, sha);

    expect(calls).toEqual([
      `download:${brevCliDownloadUrl()}`,
      "extract",
      "login:k:o",
      "onboarding",
      "ready",
    ]);
  });

  it("bounds the archive download so teardown cannot wait indefinitely (#6962)", async () => {
    const fetcher: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    await expect(
      downloadBrevCliArchive("https://example.invalid/brev.tar.gz", fetcher, 1),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("uses the legacy credential path and never logs in with an API key", async () => {
    const { runners, calls, sha } = installRunners();

    await installBrevCli({ apiToken: "refresh" }, runners, sha);

    expect(calls).toContain("legacy:refresh");
    expect(calls.some((c) => c.startsWith("login:"))).toBe(false);
  });

  it("refuses to extract a tarball whose checksum does not match", async () => {
    const { runners, calls } = installRunners();

    await expect(installBrevCli({ apiKey: "k", orgId: "o" }, runners, "deadbeef")).rejects.toThrow(
      /checksum mismatch/,
    );
    expect(calls).not.toContain("extract");
  });

  it("pins a real 64-hex checksum for the release", () => {
    expect(BREV_CLI_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("normalizeBrevList / presence (brev ls --json variants) (#6962)", () => {
  it("accepts a bare array of instance objects", () => {
    expect(normalizeBrevList([{ name: "a" }, { name: "b" }])).toHaveLength(2);
  });

  it("accepts the { workspaces: [...] } envelope", () => {
    expect(normalizeBrevList({ workspaces: [{ workspaceName: "a" }] })).toHaveLength(1);
  });

  it("rejects malformed shapes rather than treating them as empty", () => {
    expect(normalizeBrevList([1, 2, 3])).toBeNull();
    expect(normalizeBrevList({ workspaces: "nope" })).toBeNull();
    expect(normalizeBrevList("garbage")).toBeNull();
    expect(normalizeBrevList(null)).toBeNull();
  });

  it("reads the instance name across the CLI's differing fields", () => {
    expect(brevInstanceName({ name: "a" })).toBe("a");
    expect(brevInstanceName({ workspaceName: "b" })).toBe("b");
    expect(brevInstanceName({ instanceName: "c" })).toBe("c");
    expect(brevInstanceName({ Name: "d" })).toBe("d");
    expect(brevInstanceName({})).toBe("");
  });

  it("classifies presence, absence, and unverifiable listings", () => {
    expect(brevInstancePresence([{ name: "keep" }], "keep")).toBe("present");
    expect(brevInstancePresence({ workspaces: [{ name: "other" }] }, "keep")).toBe("absent");
    expect(brevInstancePresence([], "keep")).toBe("absent");
    expect(brevInstancePresence("garbage", "keep")).toBe("unverifiable");
    expect(brevInstancePresence(null, "keep")).toBe("unverifiable");
  });
});

describe("deleteBrevInstance (deletion outcomes) (#6962)", () => {
  function deleteRunners(overrides: Partial<DeleteRunners> = {}): DeleteRunners & {
    logger: Logger & { lines: string[] };
  } {
    const logger = fakeLogger();
    return {
      hasBrevCli: () => true,
      brevDelete: () => ok("deleted"),
      brevListJson: () => [],
      brevRefresh: vi.fn(),
      sleep: async () => undefined,
      logger,
      ...overrides,
    } as DeleteRunners & { logger: Logger & { lines: string[] } };
  }

  it("skips when the Brev CLI is unavailable", async () => {
    const runners = deleteRunners({ hasBrevCli: () => false, brevDelete: () => fail() });

    const result = await deleteBrevInstance("inst", runners);

    expect(result).toEqual({ outcome: "skipped-no-cli", exitCode: 0 });
  });

  it("succeeds on a first-attempt deletion", async () => {
    const runners = deleteRunners();

    const result = await deleteBrevInstance("inst", runners);

    expect(result).toEqual({ outcome: "deleted", exitCode: 0 });
    expect(runners.logger.lines).toContain("log:Brev deletion requested for inst.");
  });

  it("treats a confirmed-absent instance as already deleted", async () => {
    const runners = deleteRunners({
      brevDelete: () => fail("not found"),
      brevListJson: () => [{ name: "someone-else" }],
    });

    const result = await deleteBrevInstance("inst", runners);

    expect(result).toEqual({ outcome: "already-absent", exitCode: 0 });
  });

  it("does not conclude absence from an unverifiable listing", async () => {
    const brevRefresh = vi.fn();
    const runners = deleteRunners({
      brevDelete: () => fail("transient", 7),
      brevListJson: () => "garbage",
      brevRefresh,
    });

    const result = await deleteBrevInstance("inst", runners, 3);

    // Never saw absence, so it retries to exhaustion and fails visibly.
    expect(result).toEqual({ outcome: "failed", exitCode: 7 });
    expect(brevRefresh).toHaveBeenCalledTimes(2);
    expect(runners.logger.lines).toContain(
      "::error::Failed to delete Brev instance inst after 3 attempts.",
    );
  });

  it("recovers when a retry deletion succeeds", async () => {
    let attempt = 0;
    const runners = deleteRunners({
      brevDelete: () => {
        attempt += 1;
        return attempt === 1 ? fail("locked") : ok("deleted on retry");
      },
      brevListJson: () => [{ name: "inst" }],
    });

    const result = await deleteBrevInstance("inst", runners);

    expect(result).toEqual({ outcome: "deleted", exitCode: 0 });
    expect(attempt).toBe(2);
  });

  it("fails after the final attempt when the instance is still present", async () => {
    const runners = deleteRunners({
      brevDelete: () => fail("still here", 3),
      brevListJson: () => [{ name: "inst" }],
    });

    const result = await deleteBrevInstance("inst", runners, 3);

    expect(result).toEqual({ outcome: "failed", exitCode: 3 });
  });
});

describe("classifyValidationResult (result mapping) (#6962)", () => {
  it("maps each job result to its conclusion, status, and emoji", () => {
    expect(classifyValidationResult("success")).toEqual({
      conclusion: "success",
      status: "PASSED",
      emoji: "✅",
    });
    expect(classifyValidationResult("cancelled")).toEqual({
      conclusion: "cancelled",
      status: "CANCELLED",
      emoji: "⚪",
    });
    expect(classifyValidationResult("skipped")).toEqual({
      conclusion: "skipped",
      status: "SKIPPED",
      emoji: "⚪",
    });
    for (const failure of ["failure", "", "timed_out", "unknown"]) {
      expect(classifyValidationResult(failure)).toEqual({
        conclusion: "failure",
        status: "FAILED",
        emoji: "❌",
      });
    }
  });
});

describe("renderBrevPrComment (#6962)", () => {
  const base = {
    outcome: classifyValidationResult("success"),
    testSuite: "full",
    branch: "feat/x",
    link: { url: "https://ci/run/1", linkText: "workflow run" },
    instanceName: "e2e-1-full",
  };

  it("renders a one-line comment without keep-alive guidance", () => {
    const body = renderBrevPrComment({ ...base, keepAlive: false });

    expect(body).toContain("✅ **Brev E2E** (full): **PASSED** on branch `feat/x`");
    expect(body).toContain("[See workflow run](https://ci/run/1)");
    expect(body).not.toContain("still running");
  });

  it("appends SSH guidance when the instance is kept alive", () => {
    const body = renderBrevPrComment({ ...base, keepAlive: true });

    expect(body).toContain("Instance `e2e-1-full` is still running");
    expect(body).toContain("brev refresh && ssh e2e-1-full");
    expect(body).toContain("brev delete e2e-1-full");
  });
});

describe("assertPrNumber / assertTestedShaCurrent (stale-head rejection) (#6962)", () => {
  it("accepts a positive integer PR number and rejects the rest", () => {
    expect(assertPrNumber("6842")).toBe("6842");
    for (const bad of [undefined, "", "0", "-3", "12a", "abc"]) {
      expect(() => assertPrNumber(bad)).toThrow(/positive integer/);
    }
  });

  it("passes when the tested SHA is still the PR head", () => {
    const sha = "a".repeat(40);
    expect(() => assertTestedShaCurrent(sha, sha)).not.toThrow();
  });

  it("refuses to report when the PR head moved", () => {
    expect(() => assertTestedShaCurrent("a".repeat(40), "b".repeat(40))).toThrow(
      /PR head moved after Brev validation/,
    );
  });

  it("refuses a non-commit SHA on either side", () => {
    expect(() => assertTestedShaCurrent("a".repeat(40), "not-a-sha")).toThrow(/tested SHA/);
    expect(() => assertTestedShaCurrent("short", "a".repeat(40))).toThrow(/PR head SHA/);
  });
});

describe("environment argv guards (option-injection rejection) (#6962)", () => {
  it("accepts the workflow-generated instance name shape", () => {
    expect(assertInstanceName("e2e-6983-full-29585396577-1")).toBe("e2e-6983-full-29585396577-1");
  });

  it("rejects instance names that could become ssh/scp/brev options", () => {
    for (const bad of [undefined, "", "-oProxyCommand=evil", "a b", "a;b", "a$(x)"]) {
      expect(() => assertInstanceName(bad)).toThrow(/instance name/);
    }
  });

  it("accepts an owner/name repository slug and rejects the rest", () => {
    expect(assertRepository("NVIDIA/NemoClaw")).toBe("NVIDIA/NemoClaw");
    for (const bad of [undefined, "", "NVIDIA", "a/b/c", "owner/repo?x=1"]) {
      expect(() => assertRepository(bad)).toThrow(/owner\/name/);
    }
  });

  it("rejects dot-only repository components that would traverse API paths", () => {
    for (const bad of ["../target", "owner/..", "./name", "owner/.", "../.."]) {
      expect(() => assertRepository(bad)).toThrow(/owner\/name/);
    }
  });

  it("accepts decimal or empty run identifiers and rejects the rest", () => {
    expect(assertRunIdentifier("29585396577", "RUN_ID")).toBe("29585396577");
    expect(assertRunIdentifier("", "RUN_ID")).toBe("");
    for (const bad of ["1e3", "-1", "12/attempts", "abc"]) {
      expect(() => assertRunIdentifier(bad, "RUN_ID")).toThrow(/RUN_ID/);
    }
  });

  it("accepts a plain relative destination directory and rejects the rest", () => {
    expect(assertRelativeDirPath("brev-debug-bundle")).toBe("brev-debug-bundle");
    for (const bad of ["-r", "/etc", "../escape", "a b"]) {
      expect(() => assertRelativeDirPath(bad)).toThrow(/destination directory/);
    }
  });
});

describe("reportPr (publication guard) (#6962)", () => {
  function reportRunners(headSha: string): ReportPrRunners & {
    checks: unknown[];
    comments: unknown[];
  } {
    const checks: unknown[] = [];
    const comments: unknown[] = [];
    return {
      checks,
      comments,
      getPrHead: () => ({ branch: "feat/x", headSha }),
      listRunJobs: () => null,
      createCheckRun: (input) => {
        checks.push(input);
      },
      postComment: (prNumber, body) => {
        comments.push({ prNumber, body });
      },
    };
  }

  const validInputs = {
    prNumber: "6842",
    testSuite: "full",
    validationResult: "success",
    testedSha: "c".repeat(40),
    keepAlive: false,
    instanceName: "e2e-6842-full",
    runUrl: "https://ci/run/9",
    runId: "9",
    runAttempt: "1",
  };

  it("publishes the check and comment against the tested SHA when it is current", () => {
    const runners = reportRunners("c".repeat(40));

    reportPr(validInputs, runners);

    expect(runners.checks).toEqual([
      {
        name: "Brev E2E (full)",
        headSha: "c".repeat(40),
        conclusion: "success",
        detailsUrl: "https://ci/run/9",
        title: "Brev E2E (full): success",
        summary: "[Open the workflow run](https://ci/run/9) for details.",
      },
    ]);
    expect(runners.comments).toHaveLength(1);
  });

  it("rejects an invalid PR number before any write", () => {
    const runners = reportRunners("c".repeat(40));

    expect(() => reportPr({ ...validInputs, prNumber: "0" }, runners)).toThrow(/positive integer/);
    expect(runners.checks).toHaveLength(0);
    expect(runners.comments).toHaveLength(0);
  });

  it("rejects a stale tested SHA before any write", () => {
    const runners = reportRunners("d".repeat(40));

    expect(() => reportPr(validInputs, runners)).toThrow(/PR head moved/);
    expect(runners.checks).toHaveLength(0);
    expect(runners.comments).toHaveLength(0);
  });
});

describe("resolveValidationJobUrl (behavior preserved) (#6978)", () => {
  const base = {
    runId: "123",
    runAttempt: "2",
    runUrl: "https://ci/run/123",
    testSuite: "full",
    validationResult: "failure",
  };
  const job = (overrides: Record<string, unknown> = {}) => ({
    id: 555,
    run_id: 123,
    run_attempt: 2,
    name: "e2e-branch-validation",
    status: "completed",
    conclusion: "failure",
    ...overrides,
  });

  it("deep-links the uniquely identified validation job", () => {
    expect(
      resolveValidationJobUrl({ ...base, jobsJson: { total_count: 1, jobs: [job()] } }),
    ).toEqual({ url: "https://ci/run/123/job/555", linkText: "validation job" });
  });

  it("accepts the reusable-caller job name", () => {
    expect(
      resolveValidationJobUrl({
        ...base,
        jobsJson: {
          total_count: 1,
          jobs: [job({ name: "brev-nightly-e2e (full) / e2e-branch-validation" })],
        },
      }),
    ).toMatchObject({ linkText: "validation job" });
  });

  it("accepts the dashboard-remote-bind caller only for that suite", () => {
    const jobs = {
      total_count: 1,
      jobs: [job({ name: "dashboard-remote-bind-e2e / e2e-branch-validation" })],
    };
    expect(
      resolveValidationJobUrl({ ...base, testSuite: "dashboard-remote-bind", jobsJson: jobs }),
    ).toMatchObject({ linkText: "validation job" });
    expect(resolveValidationJobUrl({ ...base, jobsJson: jobs })).toMatchObject({
      linkText: "workflow run",
    });
  });

  it("falls back to the run URL rather than linking somewhere misleading", () => {
    const fallback = { url: "https://ci/run/123", linkText: "workflow run" };
    // Inconsistent payload, foreign run/attempt, wrong status/conclusion,
    // ambiguous matches, and unreadable listings all fall back.
    expect(resolveValidationJobUrl({ ...base, jobsJson: null })).toEqual(fallback);
    expect(
      resolveValidationJobUrl({ ...base, jobsJson: { total_count: 5, jobs: [job()] } }),
    ).toEqual(fallback);
    expect(
      resolveValidationJobUrl({
        ...base,
        jobsJson: { total_count: 1, jobs: [job({ run_id: 999 })] },
      }),
    ).toEqual(fallback);
    expect(
      resolveValidationJobUrl({
        ...base,
        jobsJson: { total_count: 1, jobs: [job({ run_attempt: 1 })] },
      }),
    ).toEqual(fallback);
    expect(
      resolveValidationJobUrl({
        ...base,
        jobsJson: { total_count: 1, jobs: [job({ status: "in_progress" })] },
      }),
    ).toEqual(fallback);
    expect(
      resolveValidationJobUrl({
        ...base,
        jobsJson: { total_count: 1, jobs: [job({ conclusion: "success" })] },
      }),
    ).toEqual(fallback);
    expect(
      resolveValidationJobUrl({
        ...base,
        jobsJson: { total_count: 2, jobs: [job(), job({ id: 556 })] },
      }),
    ).toEqual(fallback);
    expect(resolveValidationJobUrl({ ...base, runId: "abc", jobsJson: null })).toEqual(fallback);
  });
});

describe("collectBrevDebugBundle (#6962)", () => {
  function debugRunners(ssh: CommandResult, scp: CommandResult) {
    const logger = fakeLogger();
    return {
      logger,
      runners: {
        brevRefresh: () => undefined,
        sshCollect: () => ssh,
        scpBundle: () => scp,
        logger,
      },
    };
  }

  it("stays quiet when collection succeeds", () => {
    const { runners, logger } = debugRunners(ok(), ok());

    collectBrevDebugBundle("inst", "dir", runners);

    expect(logger.lines.filter((l) => l.startsWith("warn:"))).toEqual([]);
  });

  it("surfaces an ssh failure instead of discarding it", () => {
    const { runners, logger } = debugRunners(fail("ssh down", 255), ok());

    collectBrevDebugBundle("inst", "dir", runners);

    expect(logger.lines.some((l) => l.includes("Debug collection on inst exited 255"))).toBe(true);
  });

  it("surfaces an scp failure instead of discarding it", () => {
    const { runners, logger } = debugRunners(ok(), fail("no such file", 1));

    collectBrevDebugBundle("inst", "dir", runners);

    expect(
      logger.lines.some((l) => l.includes("Copying the debug bundle from inst exited 1")),
    ).toBe(true);
  });
});
