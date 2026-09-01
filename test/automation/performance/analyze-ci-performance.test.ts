// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { reportCleanupFailure } from "../../../.agents/skills/nemoclaw-maintainer-analyze-ci-performance/scripts/analyze-recent-cli-timings.mts";
import { readBoundedJsonFile } from "../../../.agents/skills/nemoclaw-maintainer-analyze-ci-performance/scripts/runtime.mts";
import { quantile } from "../../../.agents/skills/nemoclaw-maintainer-analyze-ci-performance/scripts/statistics.mts";

const execFileAsync = promisify(execFile);
const skillRoot = ".agents/skills/nemoclaw-maintainer-analyze-ci-performance";
const temporary: string[] = [];

afterEach(async () =>
  Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ci-performance-"));
  temporary.push(directory);
  return directory;
}

async function installMockGh(directory: string, source: string): Promise<string> {
  const bin = path.join(directory, "bin");
  await execFileAsync("mkdir", ["-p", bin]);
  const gh = path.join(bin, "gh");
  await writeFile(gh, "#!/usr/bin/env node\n" + source);
  await chmod(gh, 0o700);
  return bin;
}

async function runAnalyzer(
  script: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", script, ...args],
    { cwd: process.cwd(), env: environment, maxBuffer: 10_000_000 },
  );
}

function vitestReport(duration: number, wall: number): object {
  return {
    numTotalTests: 1,
    testResults: [
      {
        name: "/home/runner/work/NemoClaw/NemoClaw/src/example.test.ts",
        startTime: 1_000,
        endTime: 1_000 + wall,
        assertionResults: [{ fullName: "aggregates timing", duration }],
      },
    ],
  };
}

describe("CI performance analysis", () => {
  test("aggregates retained CLI reports through mocked gh and process boundaries", async () => {
    const directory = await fixtureDirectory();
    const archives = path.join(directory, "archives");
    await execFileAsync("mkdir", ["-p", archives]);
    const createArtifact = async (id: number, duration: number, wall: number) => {
      const source = path.join(directory, String(id));
      await execFileAsync("mkdir", ["-p", source]);
      await writeFile(
        path.join(source, "vitest-results.json"),
        JSON.stringify(vitestReport(duration, wall)),
      );
      const archive = path.join(archives, String(id) + ".zip");
      await execFileAsync("zip", ["-q", archive, "vitest-results.json"], { cwd: source });
      return {
        id,
        createdAt: `2026-01-0${id - 100}T00:00:00Z`,
        expired: false,
        size: (await stat(archive)).size,
        runId: id,
        headSha: id === 101 ? "1".repeat(40) : "2".repeat(40),
      };
    };
    const artifacts = [await createArtifact(101, 100, 200), await createArtifact(102, 300, 400)];
    const trustedRuns = artifacts.map(({ runId, headSha, createdAt }) => ({
      runId,
      headSha,
      createdAt,
    }));
    const listing = path.join(directory, "artifacts.json");
    await writeFile(listing, JSON.stringify({ artifacts }));
    const trustedListing = path.join(directory, "trusted-runs.json");
    await writeFile(trustedListing, JSON.stringify(trustedRuns));
    const bin = await installMockGh(
      directory,
      `const fs=require("node:fs"); const args=process.argv.slice(2); if(args[0]==="run"){process.stdout.write(fs.readFileSync(process.env.TRUSTED));}else if(args.includes("--jq")){process.stdout.write(fs.readFileSync(process.env.LISTING));}else{const endpoint=args.join(" "); const id=endpoint.split("/artifacts/")[1].split("/zip")[0];process.stdout.write(fs.readFileSync(process.env.ARCHIVES+"/"+id+".zip"));}`,
    );
    const result = await runAnalyzer(
      `${skillRoot}/scripts/analyze-recent-cli-timings.mts`,
      ["--workdir", process.cwd(), "--limit", "2"],
      {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        LISTING: listing,
        TRUSTED: trustedListing,
        ARCHIVES: archives,
      },
    );
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ reportsFound: 2, reportsAnalyzed: 2, minSamples: 2 });
    expect(output.slowTests[0]).toMatchObject({
      file: "src/example.test.ts",
      name: "aggregates timing",
      samples: 2,
      medianMs: 200,
      p90Ms: 280,
    });
    expect(output.slowFiles[0]).toMatchObject({ samples: 2, medianWallMs: 300 });
  });

  test("classifies base-image publication strata through mocked gh", async () => {
    const directory = await fixtureDirectory();
    const bin = await installMockGh(
      directory,
      `const a=process.argv.slice(2); const joined=a.join(" "); if(joined.includes("e2e.yaml")) process.stdout.write(JSON.stringify([{id:1,sha:"same",createdAt:"2026-01-02T00:00:00Z"},{id:2,sha:"reuse",createdAt:"2026-01-01T00:00:00Z"}])); else if(joined.includes("base-image.yaml")) process.stdout.write(JSON.stringify(["same"])); else {const id=joined.split("/runs/")[1].split("/jobs")[0]; const start=id==="1"?"00:00:10":"00:00:20"; if(!joined.includes("page=1")){process.stdout.write(JSON.stringify({totalCount:2,pageJobs:0,jobs:[]}));return;} process.stdout.write(JSON.stringify({totalCount:2,pageJobs:2,jobs:[{name:"base-image-publication",status:"completed",conclusion:"success",startedAt:"2026-01-02T"+start+"Z",completedAt:"2026-01-02T00:01:00Z",steps:[{name:"Verify applicable base-image publication",startedAt:"2026-01-02T00:00:30Z",completedAt:"2026-01-02T00:00:40Z"}]},{name:"generate-matrix",status:"completed",conclusion:"success",startedAt:"2026-01-02T00:01:05Z",completedAt:"2026-01-02T00:01:10Z",steps:[]}]}));}`,
    );
    const result = await runAnalyzer(
      `${skillRoot}/scripts/analyze-base-image-publication-timings.mts`,
      ["--workdir", process.cwd(), "--max-per-stratum", "30"],
      { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
    );
    const output = JSON.parse(result.stdout);
    expect(output.population.classified).toEqual({
      "same-commit-publication": 1,
      "reuse-prior-publication": 1,
    });
    expect(output.sameCommitPublication).toMatchObject({ selectedRuns: 1, successfulJobs: 1 });
    expect(output.reusePriorPublication).toMatchObject({ selectedRuns: 1, successfulJobs: 1 });
    expect(output.combined.jobExecution.n).toBe(2);
  });

  test("reads workflow jobs after the first 100 through bounded pagination", async () => {
    const directory = await fixtureDirectory();
    const secondPage = path.join(directory, "second-page");
    const bin = await installMockGh(
      directory,
      `const fs=require("node:fs"); const a=process.argv.slice(2); const joined=a.join(" "); if(joined.includes("e2e.yaml")) process.stdout.write(JSON.stringify([{id:1,sha:"same",createdAt:"2026-01-02T00:00:00Z"}])); else if(joined.includes("base-image.yaml")) process.stdout.write(JSON.stringify(["same"])); else {if(joined.includes("&page=1")) process.stdout.write(JSON.stringify({totalCount:102,pageJobs:100,jobs:[]})); else if(joined.includes("page=2")){fs.writeFileSync(process.env.SECOND_PAGE,"requested");process.stdout.write(JSON.stringify({totalCount:102,pageJobs:2,jobs:[{name:"base-image-publication",status:"completed",conclusion:"success",startedAt:"2026-01-02T00:00:10Z",completedAt:"2026-01-02T00:01:00Z",steps:[]},{name:"generate-matrix",status:"completed",conclusion:"success",startedAt:"2026-01-02T00:01:05Z",completedAt:"2026-01-02T00:01:10Z",steps:[]}]}));} else {process.stderr.write("unexpected page");process.exit(1);}}`,
    );
    const result = await runAnalyzer(
      `${skillRoot}/scripts/analyze-base-image-publication-timings.mts`,
      ["--workdir", process.cwd(), "--max-per-stratum", "30"],
      {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        SECOND_PAGE: secondPage,
      },
    );
    expect(JSON.parse(result.stdout).sameCommitPublication).toMatchObject({
      selectedRuns: 1,
      successfulJobs: 1,
      jobExecution: { n: 1 },
      boundaryToMatrixStart: { n: 1 },
    });
    await expect(stat(secondPage)).resolves.toMatchObject({ size: 9 });
  });

  test("preserves analysis failure when cleanup also fails", () => {
    expect(() =>
      reportCleanupFailure(new Error("analysis failed"), new Error("cleanup failed")),
    ).not.toThrow();
  });

  test("reports cleanup failure after successful analysis", () => {
    expect(() => reportCleanupFailure(undefined, new Error("cleanup failed"))).toThrow(
      "cleanup failed",
    );
  });

  test("rejects invalid input before invoking gh", async () => {
    const directory = await fixtureDirectory();
    const marker = path.join(directory, "called");
    const bin = await installMockGh(
      directory,
      `require("node:fs").writeFileSync(process.env.MARKER,"called");`,
    );
    await expect(
      runAnalyzer(`${skillRoot}/scripts/analyze-recent-cli-timings.mts`, ["--repo", "invalid"], {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        MARKER: marker,
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("repo must be owner/name") });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("redacts and bounds gh failure diagnostics", async () => {
    const directory = await fixtureDirectory();
    const bin = await installMockGh(
      directory,
      `process.stderr.write("authorization: Bearer ghp_SUPERSECRET "+"x".repeat(12000)); process.exit(1);`,
    );
    try {
      await runAnalyzer(
        `${skillRoot}/scripts/analyze-base-image-publication-timings.mts`,
        ["--workdir", process.cwd()],
        { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
      );
      throw new Error("expected analyzer failure");
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? error);
      expect(stderr).toContain("[REDACTED]");
      expect(stderr).not.toContain("ghp_SUPERSECRET");
      expect(stderr.length).toBeLessThan(5_000);
    }
  });

  test("reads complete bounded JSON beyond 2,000 lines", async () => {
    const directory = await fixtureDirectory();
    const file = path.join(directory, "report.json");
    const value = { rows: Array.from({ length: 2_100 }, (_, index) => ({ index })) };
    await writeFile(file, JSON.stringify(value, null, 2));
    await expect(readBoundedJsonFile(file, (await stat(file)).size)).resolves.toEqual(value);
  });

  test("rejects JSON whose file exceeds the byte bound", async () => {
    const directory = await fixtureDirectory();
    const file = path.join(directory, "report.json");
    await writeFile(file, JSON.stringify({ value: "large" }));
    await expect(readBoundedJsonFile(file, 2)).rejects.toThrow("byte limit");
  });

  test("preserves deterministic interpolated quantiles", () => {
    expect(quantile([40, 10, 30, 20], 0.9)).toBe(37);
  });
});
