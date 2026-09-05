// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { REVIEWED_NPM_VERSION as BRACE_NPM_VERSION } from "../../scripts/patch-bundled-npm-brace-expansion.mts";
import { REVIEWED_NPM_VERSION as IP_ADDRESS_NPM_VERSION } from "../../scripts/lib/patch-bundled-npm-ip-address.mts";
import {
  REVIEWED_NPM_ARCHIVE_SHA256,
  REVIEWED_NPM_INTEGRITY,
  REVIEWED_NPM_VERSION as BUNDLED_NPM_VERSION,
} from "../../scripts/upgrade-bundled-npm.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const GITHUB_ROOT = path.join(REPO_ROOT, ".github");
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const REVIEWED_NPM_ACTION = "setup-reviewed-npm";
const IMMUTABLE_REVIEWED_NPM_ACTION =
  "NVIDIA/NemoClaw/.github/actions/setup-reviewed-npm@7363df49a5f25b0dd1c20c80905917c31760a27e";
const IMMUTABLE_PREPARE_E2E_NPM_ACTION =
  "NVIDIA/NemoClaw/.github/actions/setup-reviewed-npm@470a5417558c65260d59cdb5eabb01d35834535e";

type Step = {
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type ActionDocument = { runs?: { steps?: Step[] } };
type WorkflowDocument = { jobs?: Record<string, { steps?: Step[] }> };
type StepGroup = { file: string; label: string; steps: Step[] };

function yamlFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory()
      ? yamlFiles(candidate)
      : /\.ya?ml$/u.test(entry.name)
        ? [candidate]
        : [];
  });
}

function stepGroups(file: string): StepGroup[] {
  const document = YAML.parse(fs.readFileSync(file, "utf8")) as ActionDocument & WorkflowDocument;
  return [
    ...Object.entries(document.jobs ?? {}).flatMap(([label, definition]) =>
      definition.steps ? [{ file, label, steps: definition.steps }] : [],
    ),
    ...(document.runs?.steps ? [{ file, label: "runs", steps: document.runs.steps }] : []),
  ];
}

const identity = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
) as {
  nodeVersion: string;
  npmArchiveSha256: string;
  npmIntegrity: string;
  npmVersion: string;
};
const groups = yamlFiles(GITHUB_ROOT).flatMap(stepGroups);
const setupNodeSteps = groups.flatMap(({ file, label, steps }) =>
  steps.flatMap((step, index) =>
    step.uses?.startsWith("actions/setup-node@") ? [{ file, label, steps, step, index }] : [],
  ),
);

function installsReviewedNpm(step: Step): boolean {
  return Boolean(
    step.uses?.includes(REVIEWED_NPM_ACTION) ||
    step.uses?.includes("/.github/actions/prepare-e2e@") ||
    step.run?.includes("Install-WslNode") ||
    step.run?.includes("setup-reviewed-npm/verify-and-install-npm.sh"),
  );
}

function installsReviewedNode(step: Step): boolean {
  return Boolean(
    step.uses?.startsWith("actions/setup-node@") ||
    step.uses?.includes("/.github/actions/prepare-e2e@") ||
    step.run?.includes("Install-WslNode"),
  );
}

function runsNpm(step: Step): boolean {
  return /(?:^|[\n;&|({])\s*(?:npm|npx)(?:\s|$)/mu.test(step.run ?? "");
}

describe("controlled setup-node environments", () => {
  // source-shape-contract: security -- Every controlled setup-node environment must install the integrity-bound npm release before an npm command executes.
  it("selects the reviewed Node and npm identities before further steps", () => {
    const setupIdentities = setupNodeSteps.map(({ step }) => [
      step.uses,
      String(step.with?.["node-version"]),
    ]);

    expect(identity).toMatchObject({ nodeVersion: "24.18.1", npmVersion: "12.0.2" });
    expect(setupNodeSteps.length).toBeGreaterThan(0);
    expect(
      setupIdentities.every(
        ([action, node]) => action === SETUP_NODE && node === identity.nodeVersion,
      ),
    ).toBe(true);
    const invalidOrder = setupNodeSteps
      .map(({ file, label, steps, step, index }) => {
        const laterSteps = steps.slice(index + 1);
        const reviewedIndex = laterSteps.findIndex(installsReviewedNpm);
        const npmConsumerIndex = laterSteps.findIndex(runsNpm);
        const matchingCondition =
          step.if === undefined ||
          laterSteps.some(
            (candidate) => installsReviewedNpm(candidate) && candidate.if === step.if,
          );
        return {
          label: `${path.relative(REPO_ROOT, file)}:${label}`,
          valid:
            reviewedIndex >= 0 &&
            (npmConsumerIndex < 0 || reviewedIndex < npmConsumerIndex) &&
            matchingCondition,
        };
      })
      .filter(({ valid }) => !valid)
      .map(({ label }) => label);
    expect(invalidOrder).toEqual([]);

    const invalidWorkflowConsumers = groups
      .filter(({ file }) => path.relative(GITHUB_ROOT, file).startsWith(`workflows${path.sep}`))
      .flatMap(({ file, label, steps }) =>
        steps
          .map((step, index) => ({ index, step }))
          .filter(({ step }) => runsNpm(step))
          .flatMap(({ index, step }) => {
            const priorSteps = steps.slice(0, index);
            const setupIndex = priorSteps.map(installsReviewedNode).lastIndexOf(true);
            const reviewedIndex = priorSteps.map(installsReviewedNpm).lastIndexOf(true);
            const setup = priorSteps[setupIndex];
            const reviewed = priorSteps[reviewedIndex];
            const matchingSetupCondition = setup?.if === undefined || setup.if === step.if;
            const matchingReviewedCondition = reviewed?.if === undefined || reviewed.if === step.if;
            return setupIndex >= 0 &&
              reviewedIndex >= setupIndex &&
              matchingSetupCondition &&
              matchingReviewedCondition
              ? []
              : [`${path.relative(REPO_ROOT, file)}:${label}:${step.name ?? index}`];
          }),
      );
    expect(invalidWorkflowConsumers).toEqual([]);
  });

  it("keeps every workflow-local reviewed npm action behind its matching checkout", () => {
    const workflowGroups = groups.filter(({ file }) =>
      path.relative(GITHUB_ROOT, file).startsWith(`workflows${path.sep}`),
    );

    const actionSteps = workflowGroups.flatMap(({ file, label, steps }) =>
      steps.flatMap((step, index) =>
        step.uses?.startsWith("./") && step.uses.includes(REVIEWED_NPM_ACTION)
          ? [{ file, label, step, steps, index }]
          : [],
      ),
    );
    const invalidCheckouts = actionSteps
      .map(({ file, label, step, steps, index }) => {
        const match = /^\.\/(.*?)\.github\/actions\/setup-reviewed-npm$/u.exec(step.uses ?? "");
        const checkoutPath = match?.[1].replace(/\/$/u, "") ?? "";
        const matchingCheckout = steps
          .slice(0, index)
          .filter((candidate) => candidate.uses?.startsWith("actions/checkout@"))
          .reverse()
          .find(({ with: inputs }) =>
            checkoutPath === ""
              ? inputs?.path === undefined
              : String(inputs?.path) === checkoutPath,
          );
        const sparsePaths = String(matchingCheckout?.with?.["sparse-checkout"] ?? "")
          .split("\n")
          .map((entry) => entry.trim());
        const completeSparseCheckout =
          sparsePaths.length === 1 ||
          (sparsePaths.includes(".github/actions/setup-reviewed-npm") &&
            sparsePaths.includes("ci/reviewed-npm-audit.json"));
        return {
          label: `${path.relative(REPO_ROOT, file)}:${label}:${step.uses}`,
          valid: match !== null && matchingCheckout !== undefined && completeSparseCheckout,
        };
      })
      .filter(({ valid }) => !valid)
      .map(({ label }) => label);
    expect(invalidCheckouts).toEqual([]);
  });

  // source-shape-contract: security -- Sparse trusted-action checkouts must include the canonical installer and identity required by reviewed npm composite actions.
  it("keeps composite npm setup dependencies in matching workflow checkouts", () => {
    const workflowGroups = groups.filter(({ file }) =>
      path.relative(GITHUB_ROOT, file).startsWith(`workflows${path.sep}`),
    );
    const requiredSparsePaths = [
      ".github/actions/setup-reviewed-npm",
      "ci/reviewed-npm-audit.json",
    ];

    const invalidCheckouts = workflowGroups
      .flatMap(({ file, label, steps }) =>
        steps.flatMap((step, index) => {
          const localPath = step.uses?.startsWith("./") ? step.uses.slice(2) : "";
          const actionMarker = localPath.indexOf(".github/actions/");
          const actionPath = actionMarker < 0 ? "" : localPath.slice(actionMarker);
          const actionFile = path.join(REPO_ROOT, actionPath, "action.yaml");
          const actionSource =
            actionPath !== "" && fs.existsSync(actionFile)
              ? fs.readFileSync(actionFile, "utf8")
              : "";
          const requiresReviewedNpm = actionSource.includes(
            "$GITHUB_ACTION_PATH/../setup-reviewed-npm/verify-and-install-npm.sh",
          );
          const checkoutPath =
            actionMarker < 0 ? "" : localPath.slice(0, actionMarker).replace(/\/$/u, "");
          return requiresReviewedNpm
            ? [{ actionPath, checkoutPath, file, index, label, steps }]
            : [];
        }),
      )
      .map(({ actionPath, checkoutPath, file, index, label, steps }) => {
        const matchingCheckout = steps
          .slice(0, index)
          .filter((candidate) => candidate.uses?.startsWith("actions/checkout@"))
          .reverse()
          .find(({ with: inputs }) =>
            checkoutPath === ""
              ? inputs?.path === undefined
              : String(inputs?.path) === checkoutPath,
          );
        const sparseCheckout = matchingCheckout?.with?.["sparse-checkout"];
        const sparsePaths = String(sparseCheckout ?? "")
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean);
        const completeSparseCheckout =
          sparseCheckout === undefined ||
          requiredSparsePaths.every(
            (requiredPath) => sparsePaths.filter((entry) => entry === requiredPath).length === 1,
          );
        return {
          label: `${path.relative(REPO_ROOT, file)}:${label}:${actionPath}`,
          valid: matchingCheckout !== undefined && completeSparseCheckout,
        };
      })
      .filter(({ valid }) => !valid)
      .map(({ label }) => label);

    expect(invalidCheckouts).toEqual([]);
  });

  it.each([
    ".github/workflows/managed-images.yaml:pr-staging-qa-deep-code",
    ".github/workflows/managed-images.yaml:pr-build-and-entrypoint",
    ".github/workflows/managed-images.yaml:pr-managed-activation",
    ".github/workflows/managed-images.yaml:pr-openclaw-mcp-discovery",
    ".github/workflows/managed-images.yaml:pi-candidate",
    ".github/workflows/pr.yaml:build-typecheck",
    ".github/workflows/docs-preview-pr.yaml:preview",
  ])("uses immutable npm setup in protected pull request job %s", (owner) => {
    const group = groups.find(
      ({ file, label }) => `${path.relative(REPO_ROOT, file)}:${label}` === owner,
    );
    expect(group, owner).toBeDefined();
    const action = group?.steps.find((step) => step.uses === IMMUTABLE_REVIEWED_NPM_ACTION);
    expect(action, owner).toBeDefined();
  });

  it("keeps composite npm setup rooted in the trusted action checkout", () => {
    const invalidActions = setupNodeSteps
      .filter(({ file }) => path.relative(GITHUB_ROOT, file).startsWith(`actions${path.sep}`))
      .filter(({ file, steps, index }) => {
        const reviewed = steps.slice(index + 1).find(installsReviewedNpm);
        return path.relative(REPO_ROOT, file) === ".github/actions/prepare-e2e/action.yaml"
          ? reviewed?.uses !== IMMUTABLE_PREPARE_E2E_NPM_ACTION
          : reviewed?.uses !== undefined ||
              !reviewed?.run?.includes(
                "$GITHUB_ACTION_PATH/../setup-reviewed-npm/verify-and-install-npm.sh",
              ) ||
              !reviewed?.run?.includes("$GITHUB_ACTION_PATH/../../../ci/reviewed-npm-audit.json");
      })
      .map(({ file }) => path.relative(REPO_ROOT, file));
    expect(invalidActions).toEqual([]);
  });

  // source-shape-contract: security -- Cross-consumer version and digest equality prevents CI, image, and private-patch paths from authorizing different npm archives
  it("uses one reviewed npm identity across audit, image, and private-patch consumers", () => {
    expect(
      new Set([
        identity.npmVersion,
        BUNDLED_NPM_VERSION,
        BRACE_NPM_VERSION,
        IP_ADDRESS_NPM_VERSION,
      ]),
    ).toEqual(new Set(["12.0.2"]));
    expect(identity.npmIntegrity).toBe(REVIEWED_NPM_INTEGRITY);
    expect(identity.npmArchiveSha256).toBe(REVIEWED_NPM_ARCHIVE_SHA256);

    const actionRoot = path.join(GITHUB_ROOT, "actions/setup-reviewed-npm");
    const action = fs.readFileSync(path.join(actionRoot, "action.yaml"), "utf8");
    expect(fs.existsSync(path.join(actionRoot, "verify-and-install-npm.sh"))).toBe(true);
    expect(action).toContain("$GITHUB_ACTION_PATH/verify-and-install-npm.sh");
    expect(action).toContain("$GITHUB_ACTION_PATH/../../../ci/reviewed-npm-audit.json");
    expect(action).not.toContain("../ci-reviewed-npm-audit/");
  });

  // source-shape-contract: security -- Every npm-mutating script must import the canonical reviewed identity so independent version or digest pins cannot drift
  it.each([
    "scripts/upgrade-bundled-npm.mts",
    "scripts/patch-bundled-npm-brace-expansion.mts",
    "scripts/lib/patch-bundled-npm-ip-address.mts",
    "scripts/lib/seed-reviewed-npm-cache.mts",
  ])("imports the reviewed npm identity from %s", (source) => {
    expect(fs.readFileSync(path.join(REPO_ROOT, source), "utf8"), source).toContain(
      "reviewed-npm-identity.mts",
    );
  });
});
