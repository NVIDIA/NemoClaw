// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  livePolicyMetadata,
  managedRegistrationSource,
  SANDBOX_ID,
} from "../../helpers/live-policy-fixture";

const repoRoot = path.join(import.meta.dirname, "../../..");
const policyModulePath = path.join(repoRoot, "src", "lib", "policy", "index.ts");
const registryModulePath = path.join(repoRoot, "src", "lib", "state", "registry.ts");

/**
 * Distinctive network policy key carried by the stubbed `openshell policy get
 * --base` output. It survives the preset merge, so finding it on disk after the
 * child exits proves the composed sandbox policy itself leaked.
 */
const CANARY_POLICY_NAME = "leak-canary-9206";
const CANARY_HOST = "canary-9206.invalid";
const SANDBOX_NAME = "policy-final-9206";
const PRESET_NAME = "weather";

/** Marks a driver call that returned instead of exiting. */
const RETURN_MARKER = "__POLICY_MUTATION_RETURNED__";

/** The canary entry every stubbed base policy carries. */
const CANARY_ENTRY = `  ${CANARY_POLICY_NAME}:
    name: ${CANARY_POLICY_NAME}
    endpoints:
      - host: ${CANARY_HOST}
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }`;

/** A base policy the weather preset has not been applied to yet. */
const BASE_POLICY_WITHOUT_PRESET = `version: 1
network_policies:
${CANARY_ENTRY}`;

/**
 * A base policy that already carries the weather key, so `removePreset` finds
 * something to delete and reaches its gateway submission.
 */
const BASE_POLICY_WITH_PRESET = `${BASE_POLICY_WITHOUT_PRESET}
  ${PRESET_NAME}:
    name: ${PRESET_NAME}
    endpoints:
      - host: wttr.in
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }`;

/**
 * A synthetic `policy set` failure without an authoritative `message:` field,
 * so it classifies as `ambiguous`. The nonzero status is deliberately not 1:
 * the process must still exit with the status the child reported.
 */
const UNPARSEABLE_FAILURE_STDERR = "openshell: policy set: unexpected end of stream";
const UNPARSEABLE_FAILURE_EXIT_CODE = 3;

/**
 * The synthetic refusal fixture puts the status and message together on the
 * first diagnostic line. That shape is necessary but not sufficient: the same
 * text appearing anywhere later in the output is treated as quoted policy
 * content and stays `ambiguous`, so a document echoed back cannot speak for the
 * gateway (#9206).
 */
const AUTHORITATIVE_REJECTION_MESSAGE = "unsupported field in network_policies.weather";
const AUTHORITATIVE_REJECTION_STDERR = `Error: code: 'Failed precondition', message: '${AUTHORITATIVE_REJECTION_MESSAGE}'`;

/** The torn gateway stream observed in issue #8991, verbatim. */
const TRANSPORT_RESET_STDERR =
  "Error: code: 'Internal error', message: 'h2 protocol error: http2 error', " +
  "source: tonic::transport::Error(Transport, hyper::Error(Http2, " +
  "Error { kind: Reset(StreamId(3), PROTOCOL_ERROR, Library) }))";

/**
 * The generic runner diagnostic. `policy set` runs with `ignoreError`, so this
 * text appearing would mean the submission took the runner's `process.exit`
 * path again — the path that skips the cleanup `finally` (#9206).
 */
const GENERIC_RUNNER_FAILURE_TEXT = "Command failed (exit 1)";

interface PolicySetBehavior {
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * Stands in for the OpenShell CLI. `policy get --base` always succeeds with a
 * round-trippable base policy so the driven mutation reaches its submission;
 * the `policy set --wait` result is what each scenario varies.
 */
function buildOpenshellStub(
  policySet: PolicySetBehavior,
  basePolicy: string,
  appliedPolicyPath: string,
): string {
  const policyMetadata = {
    ...JSON.parse(livePolicyMetadata(SANDBOX_NAME)),
    policy: YAML.parse(basePolicy),
  };
  return `#!/bin/sh
if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then
  printf 'Name: ${SANDBOX_NAME}\nId: ${SANDBOX_ID}\nPhase: Ready\n'
  exit 0
fi
if [ "$1" = "policy" ] && [ "$2" = "get" ]; then
  case " $* " in
    *" --output json "*)
      cat <<'JSON'
${JSON.stringify(policyMetadata)}
JSON
      exit 0
      ;;
  esac
  if [ -f ${JSON.stringify(appliedPolicyPath)} ]; then
    cat ${JSON.stringify(appliedPolicyPath)}
    exit 0
  fi
  cat <<'YAML'
${basePolicy}
YAML
  exit 0
fi
if [ "$1" = "policy" ] && [ "$2" = "set" ]; then
  ${
    policySet.exitCode === 0
      ? `while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      cp "$2" ${JSON.stringify(appliedPolicyPath)}
      break
    fi
    shift
  done`
      : ":"
  }
  cat >&2 <<'POLICY_SET_STDERR'
${policySet.stderr}
POLICY_SET_STDERR
  exit ${policySet.exitCode}
fi
echo "unexpected openshell argv: $*" >&2
exit 2
`;
}

/**
 * Drives one real exported policy mutation in a child process. Stubbing
 * `process.exit` in-process would let execution fall through to the `finally`
 * block and hide the leak, so the child must take a real `process.exit`.
 */
function buildDriver(call: string): string {
  return `const policy = require(${JSON.stringify(policyModulePath)});
const returned = policy.${call};
console.log(${JSON.stringify(RETURN_MARKER)} + String(returned));
`;
}

const APPLY_PRESETS_DRIVER =
  `const registry = require(${JSON.stringify(registryModulePath)});\n` +
  `${managedRegistrationSource(SANDBOX_NAME)}\n` +
  buildDriver(`applyPresets(${JSON.stringify(SANDBOX_NAME)}, [${JSON.stringify(PRESET_NAME)}])`);

/**
 * `removePreset` and `applyPreset` bypass the batch path that `applyPresets`
 * takes, and each composes its own policy document through its own temp file.
 */
const REMOVE_PRESET_DRIVER =
  `const registry = require(${JSON.stringify(registryModulePath)});\n` +
  `${managedRegistrationSource(SANDBOX_NAME)}\n` +
  `registry.updateSandbox(${JSON.stringify(SANDBOX_NAME)}, { policies: [${JSON.stringify(PRESET_NAME)}] });\n` +
  buildDriver(`removePreset(${JSON.stringify(SANDBOX_NAME)}, ${JSON.stringify(PRESET_NAME)})`);
const APPLY_PRESET_DRIVER =
  `const registry = require(${JSON.stringify(registryModulePath)});\n` +
  `${managedRegistrationSource(SANDBOX_NAME)}\n` +
  buildDriver(`applyPreset(${JSON.stringify(SANDBOX_NAME)}, ${JSON.stringify(PRESET_NAME)})`);

interface ChildRun {
  readonly result: SpawnSyncReturns<string>;
  readonly homeDir: string;
  readonly tmpDir: string;
}

function listNemoclawPolicyDirs(tmpDir: string): string[] {
  return fs
    .readdirSync(tmpDir)
    .filter((entry) => entry.startsWith("nemoclaw-policy-"))
    .map((entry) => path.join(tmpDir, entry))
    .sort();
}

function listFilesRecursively(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("tsx-"))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFilesRecursively(full) : [full];
    });
}

function readableFilesContaining(dir: string, needle: string): string[] {
  return listFilesRecursively(dir).filter((file) =>
    fs.readFileSync(file, "utf-8").includes(needle),
  );
}

/**
 * Vitest source-maps every stack frame it finds in an assertion message, so
 * quoting a child stack trace verbatim replaces the real failure with a
 * source-map parse error. Keep child output frame-free in test messages.
 */
function withoutStackFrames(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line))
    .join("\n");
}

interface PolicyMutationRun {
  readonly driver: string;
  readonly policySet: PolicySetBehavior;
  readonly basePolicy: string;
}

function runPolicyMutation({ driver, policySet, basePolicy }: PolicyMutationRun): ChildRun {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-9206-fixture-"));
  const tmpDir = path.join(scratchDir, "child-tmp");
  const homeDir = path.join(scratchDir, "home");
  fs.mkdirSync(tmpDir);
  fs.mkdirSync(homeDir);

  const openshellStubPath = path.join(scratchDir, "openshell");
  const appliedPolicyPath = path.join(scratchDir, "applied-policy.yaml");
  fs.writeFileSync(
    openshellStubPath,
    buildOpenshellStub(policySet, basePolicy, appliedPolicyPath),
    {
      encoding: "utf-8",
      mode: 0o755,
    },
  );

  const driverPath = path.join(scratchDir, "driver.js");
  fs.writeFileSync(driverPath, driver, "utf-8");

  const result = spawnSync(process.execPath, ["--import", "tsx", driverPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: homeDir,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_OPENSHELL_BIN: openshellStubPath,
      TMPDIR: tmpDir,
    },
    timeout: 120000,
  });

  return { homeDir, result, tmpDir };
}

function runApplyPresets(policySet: PolicySetBehavior): ChildRun {
  return runPolicyMutation({
    basePolicy: BASE_POLICY_WITHOUT_PRESET,
    driver: APPLY_PRESETS_DRIVER,
    policySet,
  });
}

function describeChildRun(run: ChildRun): string {
  return `exit=${run.result.status}\n--stderr--\n${withoutStackFrames(run.result.stderr)}`;
}

interface PolicySetFailureScenario {
  /** Names the scenario in the `describe.each` title. */
  readonly summary: string;
  readonly policySetExitCode: number;
  readonly policySetStderr: string;
  /** Text only `policySetFailure` can produce, never the stub's own stderr. */
  readonly expectedOperatorMessage: string;
  /** The recovery instruction the classification obliges the operator to follow. */
  readonly expectedGuidance: string;
}

const POLICY_SET_FAILURES: ReadonlyArray<PolicySetFailureScenario> = [
  {
    summary: "an authoritative semantic rejection",
    policySetExitCode: 1,
    policySetStderr: AUTHORITATIVE_REJECTION_STDERR,
    expectedOperatorMessage:
      `OpenShell rejected the policy for sandbox '${SANDBOX_NAME}' (exit 1): ` +
      AUTHORITATIVE_REJECTION_MESSAGE,
    expectedGuidance: "change the preset selection instead",
  },
  {
    summary: "a torn transport stream",
    policySetExitCode: UNPARSEABLE_FAILURE_EXIT_CODE,
    policySetStderr: TRANSPORT_RESET_STDERR,
    expectedOperatorMessage: `Could not confirm the policy update for sandbox '${SANDBOX_NAME}'`,
    expectedGuidance: "The current live policy differs from the requested document",
  },
];

describe.each(POLICY_SET_FAILURES)(
  "applyPresets when openshell policy set fails with $summary",
  (scenario) => {
    let run: ChildRun;

    beforeAll(() => {
      run = runApplyPresets({
        exitCode: scenario.policySetExitCode,
        stderr: scenario.policySetStderr,
      });
    }, 180000);

    afterAll(() => {
      fs.rmSync(path.dirname(run.tmpDir), { force: true, recursive: true });
    });

    it("reports the OpenShell status and message and exits nonzero without returning to its caller (#9206)", () => {
      const diagnostics = describeChildRun(run);
      const stderr = withoutStackFrames(run.result.stderr);
      expect(stderr, diagnostics).toContain(scenario.expectedOperatorMessage);
      expect(stderr, diagnostics).toContain(scenario.expectedGuidance);
      expect(stderr, diagnostics).not.toContain(GENERIC_RUNNER_FAILURE_TEXT);
      expect(run.result.status, diagnostics).toBe(scenario.policySetExitCode);
      expect(run.result.stdout, diagnostics).not.toContain(RETURN_MARKER);
    });

    it("removes the temporary policy directory it created (#9206)", () => {
      expect(listNemoclawPolicyDirs(run.tmpDir), describeChildRun(run)).toEqual([]);
    });

    it("leaves no composed sandbox policy content on disk (#9206)", () => {
      expect(readableFilesContaining(run.tmpDir, CANARY_HOST), describeChildRun(run)).toEqual([]);
      expect(readableFilesContaining(run.tmpDir, "wttr.in"), describeChildRun(run)).toEqual([]);
    });

    it("leaves local preset attribution unwritten (#9206)", () => {
      const registry = JSON.parse(
        fs.readFileSync(path.join(run.homeDir, ".nemoclaw", "sandboxes.json"), "utf-8"),
      ) as { sandboxes: Record<string, { policies?: string[] }> };
      expect(registry.sandboxes[SANDBOX_NAME]).not.toHaveProperty("policies");
    });
  },
);

describe("applyPresets when OpenShell policy set succeeds", () => {
  let run: ChildRun;

  beforeAll(() => {
    run = runApplyPresets({ exitCode: 0, stderr: "" });
  }, 180000);

  afterAll(() => {
    fs.rmSync(path.dirname(run.tmpDir), { force: true, recursive: true });
  });

  it("returns to its caller and exits zero (#9206)", () => {
    const diagnostics = describeChildRun(run);
    expect(run.result.stdout, diagnostics).toContain(`${RETURN_MARKER}true`);
    expect(run.result.status, diagnostics).toBe(0);
  });

  it("removes the temporary policy directory it created (#9206)", () => {
    expect(listNemoclawPolicyDirs(run.tmpDir), describeChildRun(run)).toEqual([]);
  });

  it("leaves no composed sandbox policy content on disk (#9206)", () => {
    expect(readableFilesContaining(run.tmpDir, CANARY_HOST), describeChildRun(run)).toEqual([]);
    expect(readableFilesContaining(run.tmpDir, "wttr.in"), describeChildRun(run)).toEqual([]);
  });
});

/**
 * The single-preset mutations onboarding reaches for a deselected preset and
 * for a preset the batch path does not cover. Neither goes through
 * `applyPresets`, so each needs its own proof that a failed submission takes
 * the composed policy with it.
 */
interface SinglePresetMutationScenario {
  /** Names the scenario in the `describe.each` title. */
  readonly summary: string;
  readonly driver: string;
  readonly basePolicy: string;
  readonly policySet: PolicySetBehavior;
  /** Text only the policy-set failure reporting can produce. */
  readonly expectedOperatorMessage: string;
  readonly expectedGuidance: string;
  /** The status the child must exit with, matching what OpenShell reported. */
  readonly expectedExitCode: number;
}

const SINGLE_PRESET_MUTATIONS: ReadonlyArray<SinglePresetMutationScenario> = [
  {
    summary: "removePreset and openshell rejects the narrowed policy",
    driver: REMOVE_PRESET_DRIVER,
    basePolicy: BASE_POLICY_WITH_PRESET,
    policySet: { exitCode: 1, stderr: AUTHORITATIVE_REJECTION_STDERR },
    expectedOperatorMessage:
      `OpenShell rejected the policy for sandbox '${SANDBOX_NAME}' (exit 1): ` +
      AUTHORITATIVE_REJECTION_MESSAGE,
    expectedGuidance: "change the preset selection instead",
    expectedExitCode: 1,
  },
  {
    summary: "applyPreset and the widened policy submission is unconfirmed",
    driver: APPLY_PRESET_DRIVER,
    basePolicy: BASE_POLICY_WITHOUT_PRESET,
    policySet: { exitCode: UNPARSEABLE_FAILURE_EXIT_CODE, stderr: UNPARSEABLE_FAILURE_STDERR },
    expectedOperatorMessage: `Could not confirm the policy update for sandbox '${SANDBOX_NAME}'`,
    expectedGuidance: "The current live policy differs from the requested document",
    expectedExitCode: UNPARSEABLE_FAILURE_EXIT_CODE,
  },
];

describe.each(SINGLE_PRESET_MUTATIONS)("$summary", (scenario) => {
  let run: ChildRun;

  beforeAll(() => {
    run = runPolicyMutation({
      basePolicy: scenario.basePolicy,
      driver: scenario.driver,
      policySet: scenario.policySet,
    });
  }, 180000);

  afterAll(() => {
    fs.rmSync(path.dirname(run.tmpDir), { force: true, recursive: true });
  });

  it("reports the OpenShell result and exits with its status without returning to its caller (#9206)", () => {
    const diagnostics = describeChildRun(run);
    const stderr = withoutStackFrames(run.result.stderr);
    expect(stderr, diagnostics).toContain(scenario.expectedOperatorMessage);
    expect(stderr, diagnostics).toContain(scenario.expectedGuidance);
    expect(run.result.status, diagnostics).toBe(scenario.expectedExitCode);
    expect(run.result.stdout, diagnostics).not.toContain(RETURN_MARKER);
  });

  it("removes the temporary policy directory it created (#9206)", () => {
    expect(listNemoclawPolicyDirs(run.tmpDir), describeChildRun(run)).toEqual([]);
  });

  it("leaves no composed sandbox policy content on disk (#9206)", () => {
    expect(readableFilesContaining(run.tmpDir, CANARY_HOST), describeChildRun(run)).toEqual([]);
  });
});
