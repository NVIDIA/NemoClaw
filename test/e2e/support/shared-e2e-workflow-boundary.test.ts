// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  discoverCredentialFreeTests,
  stripCredentialFreeTestDeclarations,
} from "../../../tools/e2e/credential-free-tests.mts";
import {
  validateE2eWorkflowBoundary,
  validateNativePodmanStagingAction,
} from "../../../tools/e2e/workflow-boundary.mts";
import { validateE2eOperationsWorkflowBoundary } from "../../../tools/e2e/operations-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";
import { testTimeoutOptions } from "../../helpers/timeouts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

type Workflow = {
  env?: unknown;
  defaults?: unknown;
  jobs: Record<
    string,
    {
      env?: unknown;
      defaults?: unknown;
      if?: unknown;
      needs?: string[];
      "continue-on-error"?: unknown;
      steps?: Array<{
        env?: unknown;
        name?: string;
        uses?: string;
        run?: string;
        shell?: unknown;
        "working-directory"?: unknown;
        if?: unknown;
        "continue-on-error"?: unknown;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

function validateMutatedWorkflow(
  mutator: (workflow: Workflow) => void,
  validator = validateE2eWorkflowBoundary,
): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shared-e2e-workflow-"));
  const workflowPath = path.join(directory, "workflow.yaml");
  const workflow = readWorkflow() as Workflow;
  try {
    mutator(workflow);
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));
    return validator(workflowPath);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

type WorkflowSteps = NonNullable<Workflow["jobs"][string]["steps"]>;

function moveStagingAfter(steps: WorkflowSteps, index: number, boundary: string): void {
  const [step] = steps.splice(index, 1);
  steps.splice(steps.findIndex((candidate) => candidate.name === boundary) + 1, 0, step!);
}

const stagingMutations: Array<[string, (steps: WorkflowSteps, index: number) => void]> = [
  [
    "renamed",
    (steps, index) => {
      steps[index]!.name = "Different name";
    },
  ],
  ["duplicate-renamed", (steps, index) => steps.push({ ...steps[index]!, name: "Second staging" })],
  [
    "duplicate-unreviewed-renamed",
    (steps, index) =>
      steps.push({
        ...steps[index]!,
        name: "Second staging",
        uses: steps[index]!.uses!.split("@")[0] + "@" + "0".repeat(40),
      }),
  ],
  [
    "missing",
    (steps, index) => {
      steps.splice(index, 1);
    },
  ],
  [
    "reference",
    (steps, index) => {
      steps[index]!.uses =
        "NVIDIA/NemoClaw/.github/actions/stage-native-podman-e2e-toolchains@" + "0".repeat(40);
    },
  ],
  ["checkout-order", (steps, index) => moveStagingAfter(steps, index, "Check out E2E candidate")],
  ["prepare-order", (steps, index) => moveStagingAfter(steps, index, "Prepare E2E workspace")],
  [
    "disabled",
    (steps, index) => {
      steps[index]!.if = false;
    },
  ],
  [
    "ignore-errors",
    (steps, index) => {
      steps[index]!["continue-on-error"] = true;
    },
  ],
  [
    "enabled-input",
    (steps, index) => {
      steps[index]!.with!.enabled = "false";
    },
  ],
  [
    "token-input",
    (steps, index) => {
      steps[index]!.with!["github-token"] = "";
    },
  ],
];

const stagingReferenceVariants = [
  "./.github/actions/stage-native-podman-e2e-toolchains",
  "$/.github/actions/stage-native-podman-e2e-toolchains",
  "./.github/actions/stage-native-podman-e2e-toolchains/",
  "./.github/actions/../actions/stage-native-podman-e2e-toolchains",
  "./.github/actions/./stage-native-podman-e2e-toolchains",
  "NVIDIA/NemoClaw/.github/actions/stage-native-podman-e2e-toolchains/@main",
  "nvidia/nemoclaw/.github/actions/stage-native-podman-e2e-toolchains@" + "0".repeat(40),
  "NvIdIa/NeMoClAw/.github/actions/stage-native-podman-e2e-toolchains@main",
];

const actionMutations: Array<[string, (source: string) => string]> = [
  ["artifact-id", (source) => source.replace('artifact-ids: "10385514729"', 'artifact-ids: "1"')],
  ["digest", (source) => source.replace(/sha256:[a-f0-9]{64}/, "sha256:" + "0".repeat(64))],
  ["source-run", (source) => source.replace('run-id: "33211526093"', 'run-id: "1"')],
  [
    "verification-order",
    (source) => {
      const start = source.indexOf("    - name: Verify immutable");
      const end = source.indexOf("    - name: Download immutable");
      return source.slice(0, start) + source.slice(end) + source.slice(start, end);
    },
  ],
];

describe("shared E2E workflow boundary", () => {
  it.each([true, false, "${{ always() }}"])(
    "rejects generate-matrix continue-on-error=%s",
    (value) => {
      const errors = validateMutatedWorkflow((workflow) => {
        workflow.jobs["generate-matrix"]["continue-on-error"] = value;
      });
      expect(errors).toContain(
        "native Podman staging must preserve runtime selection, token, and fail-closed execution",
      );
    },
  );

  it.each([true, false, "${{ always() }}"])("rejects generate-matrix if=%s", (value) => {
    const errors = validateMutatedWorkflow((workflow) => {
      workflow.jobs["generate-matrix"].if = value;
    });
    expect(errors).toContain(
      "native Podman staging must preserve runtime selection, token, and fail-closed execution",
    );
  });

  it.each(["Stage immutable native Podman E2E toolchains", "Check out E2E candidate"])(
    "rejects an unrelated action before %s",
    (boundary) => {
      const errors = validateMutatedWorkflow((workflow) => {
        const steps = workflow.jobs["generate-matrix"].steps!;
        steps.splice(
          steps.findIndex((step) => step.name === boundary),
          0,
          {
            name: "Unreviewed publisher",
            uses: "unreviewed/example@" + "a".repeat(40),
          },
        );
      });
      expect(errors).toContain(
        "native Podman staging must run with only approved actions before candidate checkout",
      );
    },
  );

  it("rejects a duplicate approved action before candidate checkout", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const steps = workflow.jobs["generate-matrix"].steps!;
      const approved = steps.find((step) => step.name === "Check out trusted E2E planner")!;
      steps.splice(
        steps.findIndex((step) => step.name === "Check out E2E candidate"),
        0,
        { ...approved },
      );
    });
    expect(errors).toContain(
      "native Podman staging must run with only approved actions before candidate checkout",
    );
  });

  it("rejects an unrelated action using an approved step name", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const step = workflow.jobs["generate-matrix"].steps!.find(
        (step) => step.name === "Check out trusted E2E planner",
      )!;
      step.uses = "unreviewed/example@" + "a".repeat(40);
    });
    expect(errors).toContain(
      "native Podman staging must run with only approved actions before candidate checkout",
    );
  });

  it.each(["Check out trusted E2E planner", "Set up Node for trusted E2E planning"])(
    "rejects an alternate SHA for %s",
    (name) => {
      const errors = validateMutatedWorkflow((workflow) => {
        const step = workflow.jobs["generate-matrix"].steps!.find((step) => step.name === name)!;
        step.uses = step.uses!.split("@")[0] + "@" + "a".repeat(40);
      });
      expect(errors).toContain(
        "native Podman staging must run with only approved actions before candidate checkout",
      );
    },
  );

  it.each(["Stage immutable native Podman E2E toolchains", "Check out E2E candidate"])(
    "rejects arbitrary shell execution before %s",
    (boundary) => {
      const errors = validateMutatedWorkflow((workflow) => {
        const steps = workflow.jobs["generate-matrix"].steps!;
        steps.splice(
          steps.findIndex((step) => step.name === boundary),
          0,
          { name: "Unexpected shell", run: "printf unreviewed" },
        );
      });
      expect(errors).toContain(
        "native Podman staging must run with only approved actions before candidate checkout",
      );
    },
  );

  it.each([
    ["Check out trusted E2E planner", { run: "printf unreviewed" }],
    ["Install trusted E2E planner dependencies", { uses: "actions/checkout@" + "a".repeat(40) }],
    [
      "Install trusted E2E planner dependencies",
      { run: "npm ci --ignore-scripts --no-audit --no-fund" },
    ],
  ] as const)("rejects spoofed or duplicate trusted step %s", (name, fields) => {
    const errors = validateMutatedWorkflow((workflow) => {
      const steps = workflow.jobs["generate-matrix"].steps!;
      steps.splice(
        steps.findIndex((step) => step.name === "Check out E2E candidate"),
        0,
        { name, ...fields },
      );
    });
    expect(errors).toContain(
      "native Podman staging must run with only approved actions before candidate checkout",
    );
  });

  it.each([
    ["Check out trusted E2E planner", { run: "printf unreviewed" }],
    [
      "Install trusted E2E planner dependencies",
      { uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" },
    ],
  ] as const)("rejects replacing trusted step type for %s", (name, fields) => {
    const errors = validateMutatedWorkflow((workflow) => {
      const step = workflow.jobs["generate-matrix"].steps!.find((step) => step.name === name)!;
      delete step.uses;
      delete step.run;
      Object.assign(step, fields);
    });
    expect(errors).toContain(
      "native Podman staging must run with only approved actions before candidate checkout",
    );
  });

  it.each(stagingMutations)("rejects native Podman staging %s mutations", (_name, mutate) => {
    const errors = validateMutatedWorkflow((workflow) => {
      const steps = workflow.jobs["generate-matrix"].steps!;
      const index = steps.findIndex(
        (step) => step.name === "Stage immutable native Podman E2E toolchains",
      );
      mutate(steps, index);
    });
    expect(errors.some((error) => error.includes("native Podman staging"))).toBe(true);
  });

  it.each(stagingReferenceVariants)("rejects renamed staging action alias %s", (uses) => {
    const errors = validateMutatedWorkflow((workflow) => {
      const steps = workflow.jobs["generate-matrix"].steps!;
      const staging = steps.find(
        (step) => step.name === "Stage immutable native Podman E2E toolchains",
      )!;
      steps.push({ ...staging, name: "Candidate staging", uses });
    });
    expect(errors).toContain(
      "native Podman staging must use exactly one reviewed action reference",
    );
  });

  it("keeps action paths case-sensitive when classifying staging references", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      workflow.jobs["generate-matrix"].steps!.push({
        name: "Different action",
        uses:
          "NVIDIA/NemoClaw/.github/actions/STAGE-native-podman-e2e-toolchains@" + "0".repeat(40),
      });
    });
    expect(errors).not.toContain(
      "native Podman staging must use exactly one reviewed action reference",
    );
  });

  it("rejects replacement by a local staging action", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const staging = workflow.jobs["generate-matrix"].steps!.find(
        (step) => step.name === "Stage immutable native Podman E2E toolchains",
      )!;
      staging.uses = stagingReferenceVariants[0];
    });
    expect(errors).toContain(
      "native Podman staging must use exactly one reviewed action reference",
    );
  });

  it.each(actionMutations)("rejects native Podman staging action %s mutations", (_name, mutate) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-staging-"));
    const actionPath = path.join(directory, "action.yaml");
    const reviewedPath = path.resolve(
      ".github/actions/stage-native-podman-e2e-toolchains/action.yaml",
    );
    const source = fs.readFileSync(reviewedPath, "utf8");
    try {
      expect(validateNativePodmanStagingAction()).toEqual([]);
      const mutated = mutate(source);
      fs.writeFileSync(actionPath, mutated);
      expect(validateNativePodmanStagingAction(actionPath)).toContain(
        "native Podman staging action content must match its immutable commit pin",
      );
      const overrides = new Map([[reviewedPath, mutated]]);
      vi.mocked(readFileSync).mockImplementation(
        (file, options) => overrides.get(String(file)) ?? fs.readFileSync(file, options),
      );
      expect(validateE2eWorkflowBoundary()).toContain(
        "native Podman staging action content must match its immutable commit pin",
      );
    } finally {
      vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["22.19.0", "jetson-nvmap-gpu", "Set up Node for Jetson controller"],
    ["22.19.0", "generate-matrix", "Set up Node for trusted E2E planning"],
    ["22.19.0", "base-image-publication", "Set up Node for publication verification"],
    ["22.19.0", "hermes-gpu-startup", "Reassert trusted Node runtime"],
    ["^22.19.0", "jetson-nvmap-gpu", "Set up Node for Jetson controller"],
    ["^22.19.0", "generate-matrix", "Set up Node for trusted E2E planning"],
    ["^22.19.0", "base-image-publication", "Set up Node for publication verification"],
    ["^22.19.0", "hermes-gpu-startup", "Reassert trusted Node runtime"],
  ])("accepts the compatible Node selector %s in %s (%s)", (version, job, stepName) => {
    const errors = validateMutatedWorkflow((workflow) => {
      const step = workflow.jobs[job].steps!.find((candidate) => candidate.name === stepName)!;
      step.with!["node-version"] = version;
    });
    expect(errors).toEqual([]);
  });

  it(
    "keeps every tagged credential-free test visible to Vitest discovery",
    testTimeoutOptions(15_000),
    () => {
      const declaredFiles = fs
        .globSync(["**/*.test.js", "**/*.test.ts"], {
          cwd: process.cwd(),
          exclude: ["**/dist/**", "**/node_modules/**"],
        })
        .filter((file) => {
          const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
          return stripCredentialFreeTestDeclarations(source) !== source;
        })
        .sort();

      expect(
        discoverCredentialFreeTests()
          .map(({ file }) => file)
          .sort(),
      ).toEqual(declaredFiles);
    },
  );

  it("ratchets shared setup, tagged test execution, and aggregation", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const job = workflow.jobs["shared-e2e"];
      (job.env as Record<string, unknown>).CHECK_DOC_LINKS_REMOTE = "1";
      job.steps!.find((step) => step.name === "Run tagged credential-free test")!.run =
        "echo skipped";
      workflow.jobs["report-to-pr"].needs = workflow.jobs["report-to-pr"].needs!.filter(
        (name) => name !== "shared-e2e",
      );
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "shared E2E job must set CHECK_DOC_LINKS_REMOTE to 0",
        'step \'Run tagged credential-free test\' run script must include npx vitest run --project "${TEST_PROJECT}" "${TEST_FILE}"',
        "step 'Run tagged credential-free test' run script must include --tags-filter=e2e/credential-free",
        "report-to-pr job must wait for shared-e2e",
      ]),
    );
  });

  it("reports a missing shared job as a contract error", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      delete workflow.jobs["shared-e2e"];
    });

    expect(errors).toContain("workflow missing shared E2E job");
  });
});

describe("approved pre-candidate shell body integrity", () => {
  const owners = [
    "Authenticate manual PR dispatch",
    "Record trusted E2E dispatch receipt",
    "Authorize Launchable E2E maintainer dispatch",
    "Generate E2E target matrix",
  ];
  const mutations = [
    { label: "prepend", apply: (run: string) => "printf UNAPPROVED_BOUNDARY_MUTATION\n" + run },
    { label: "append", apply: (run: string) => run + "\nprintf UNAPPROVED_BOUNDARY_MUTATION\n" },
    {
      label: "weaken fail-closed shell",
      apply: (run: string) => run.replace("set -euo pipefail", "set -uo pipefail"),
    },
  ];
  it.each(owners.flatMap((name) => mutations.map((mutation) => ({ name, ...mutation }))))(
    "rejects $label in $name even when required fragments remain",
    ({ name, apply }) => {
      const errors = validateMutatedWorkflow((workflow) => {
        const step = workflow.jobs["generate-matrix"]!.steps!.find((step) => step.name === name)!;
        step.run = apply(step.run!);
      });
      expect(errors).toContain(
        `trusted pre-candidate step ${name} must preserve its exact reviewed command body`,
      );
    },
  );
});

describe("pre-candidate execution environment identity", () => {
  const stepNames = [
    "Build trusted larger-runner routing",
    "Authenticate manual PR dispatch",
    "Record trusted E2E dispatch receipt",
    "Upload trusted E2E dispatch receipt",
    "Authorize Launchable E2E maintainer dispatch",
    "Check out trusted E2E planner",
    "Set up Node for trusted E2E planning",
    "Install reviewed npm for trusted E2E planning",
    "Install trusted E2E planner dependencies",
    "Generate E2E target matrix",
    "Stage immutable native Podman E2E toolchains",
  ];
  const owners = [
    { name: "workflow", select: (workflow: Workflow) => workflow },
    {
      name: "generate-matrix job",
      select: (workflow: Workflow) => workflow.jobs["generate-matrix"]!,
    },
    ...stepNames.map((name) => ({
      name: `step ${name}`,
      select: (workflow: Workflow) =>
        workflow.jobs["generate-matrix"]!.steps!.find((step) => step.name === name)!,
    })),
  ];
  const mutations = [
    {
      label: "Bash initialization",
      apply: (env: unknown) => ({
        ...(env as Record<string, unknown>),
        BASH_ENV: "/tmp/unapproved-inert-init",
      }),
    },
    {
      label: "Node initialization",
      apply: (env: unknown) => ({
        ...(env as Record<string, unknown>),
        NODE_OPTIONS: "--require=/tmp/unapproved-inert-module",
      }),
    },
    {
      label: "expression instead of map",
      apply: () => "${{ inputs.environment }}",
    },
    { label: "array instead of map", apply: () => [] },
    { label: "null instead of map", apply: () => null },
  ];
  it.each(owners.flatMap((owner) => mutations.map((mutation) => ({ ...owner, ...mutation }))))(
    "rejects $label in $name",
    ({ name, select, apply }) => {
      const errors = validateMutatedWorkflow((workflow) => {
        const owner = select(workflow);
        owner.env = apply(owner.env);
      });
      expect(errors).toContain(
        `trusted pre-candidate ${name} must preserve its exact reviewed environment`,
      );
    },
  );
  const boundOwners = [
    { owner: owners[0]!, bindingName: "NEMOCLAW_E2E_EXPECTED_SHA" },
    { owner: owners[2]!, bindingName: "REPOSITORY" },
    { owner: owners[3]!, bindingName: "GITHUB_TOKEN" },
    { owner: owners[4]!, bindingName: "CANDIDATE_SHA" },
    { owner: owners[6]!, bindingName: "GITHUB_TOKEN" },
    { owner: owners[11]!, bindingName: "NEMOCLAW_E2E_CREDENTIALS_ALLOWED" },
  ];
  const bindingChanges = [
    {
      label: "missing",
      apply: (env: Record<string, unknown>, bindingName: string) => {
        delete env[bindingName];
      },
    },
    {
      label: "rebound",
      apply: (env: Record<string, unknown>, bindingName: string) => {
        env[bindingName] = "unapproved-binding";
      },
    },
  ];
  it.each(
    boundOwners.flatMap(({ owner, bindingName }) =>
      bindingChanges.map((change) => ({ ...owner, bindingName, ...change })),
    ),
  )("rejects $label binding in $name", ({ name, select, bindingName, apply }) => {
    const errors = validateMutatedWorkflow((workflow) => {
      apply(select(workflow).env as Record<string, unknown>, bindingName);
    });
    expect(errors).toContain(
      `trusted pre-candidate ${name} must preserve its exact reviewed environment`,
    );
  });
  it.each(boundOwners.map(({ owner }) => owner))(
    "accepts canonical bindings for $name regardless of key order",
    ({ select }) => {
      const errors = validateMutatedWorkflow((workflow) => {
        const owner = select(workflow);
        owner.env = Object.fromEntries(
          Object.entries((owner.env ?? {}) as Record<string, unknown>).reverse(),
        );
      });
      expect(errors).toEqual([]);
    },
  );
});

describe("manual PR authentication execution control", () => {
  it("rejects skipped authentication through the existing identity guard", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      workflow.jobs["generate-matrix"]!.steps!.find(
        (step) => step.name === "Authenticate manual PR dispatch",
      )!.if = false;
    });
    expect(errors).toContain(
      "Manual PR authentication must run when any candidate identity input is present",
    );
  });
  it.each([true, false, "${{ always() }}"])("rejects continue-on-error override %s", (value) => {
    const errors = validateMutatedWorkflow((workflow) => {
      workflow.jobs["generate-matrix"]!.steps!.find(
        (step) => step.name === "Authenticate manual PR dispatch",
      )!["continue-on-error"] = value;
    });
    expect(errors).toContain("Manual PR authentication must not tolerate authorization failure");
  });
});

describe("trusted prefix execution controls", () => {
  const names = [
    "Build trusted larger-runner routing",
    "Authenticate manual PR dispatch",
    "Record trusted E2E dispatch receipt",
    "Upload trusted E2E dispatch receipt",
    "Authorize Launchable E2E maintainer dispatch",
    "Check out trusted E2E planner",
    "Set up Node for trusted E2E planning",
    "Install reviewed npm for trusted E2E planning",
    "Install trusted E2E planner dependencies",
    "Generate E2E target matrix",
    "Stage immutable native Podman E2E toolchains",
  ];
  const overrides = [
    { field: "if" as const, value: false },
    { field: "if" as const, value: "${{ always() }}" },
    { field: "continue-on-error" as const, value: true },
    { field: "continue-on-error" as const, value: false },
    { field: "continue-on-error" as const, value: "${{ always() }}" },
  ];
  it.each(names.flatMap((name) => overrides.map((override) => ({ name, ...override }))))(
    "rejects $name $field=$value",
    ({ name, field, value }) => {
      const errors = validateMutatedWorkflow((workflow) => {
        workflow.jobs["generate-matrix"]!.steps!.find((step) => step.name === name)![field] = value;
      });
      expect(errors).toContain(
        `trusted pre-candidate step ${name} must preserve its reviewed execution condition and failure propagation`,
      );
    },
  );
  it.each([
    "Authenticate manual PR dispatch",
    "Record trusted E2E dispatch receipt",
    "Upload trusted E2E dispatch receipt",
    "Authorize Launchable E2E maintainer dispatch",
  ])("rejects missing reviewed condition for %s", (name) => {
    const errors = validateMutatedWorkflow((workflow) => {
      delete workflow.jobs["generate-matrix"]!.steps!.find((step) => step.name === name)!.if;
    });
    expect(errors).toContain(
      `trusted pre-candidate step ${name} must preserve its reviewed execution condition and failure propagation`,
    );
  });
});

describe("shared environment contract consumers", () => {
  it.each([
    { name: "full boundary", validate: validateE2eWorkflowBoundary },
    { name: "operations boundary", validate: validateE2eOperationsWorkflowBoundary },
  ])("$name rejects rebound shared workflow and authorization bindings", ({ validate }) => {
    const errors = validateMutatedWorkflow((workflow) => {
      (workflow.env as Record<string, unknown>).NEMOCLAW_E2E_EXPECTED_SHA = "unapproved-binding";
      const auth = workflow.jobs["generate-matrix"]!.steps!.find(
        (step) => step.name === "Authenticate manual PR dispatch",
      )!;
      (auth.env as Record<string, unknown>).CHECKOUT_SHA = "unapproved-binding";
    }, validate);
    expect(errors).toContain("E2E workflow must bind NEMOCLAW_E2E_EXPECTED_SHA");
    expect(errors).toContain("Manual PR authentication must bind CHECKOUT_SHA");
  });
});

describe("trusted script interpreter boundary", () => {
  const names = [
    "Build trusted larger-runner routing",
    "Authenticate manual PR dispatch",
    "Record trusted E2E dispatch receipt",
    "Authorize Launchable E2E maintainer dispatch",
    "Install trusted E2E planner dependencies",
    "Generate E2E target matrix",
  ];
  it.each(
    names.flatMap((name) =>
      [null, "sh", 'bash --noprofile --norc -c "exit 0" {0}'].map((shell) => ({
        name,
        shell,
      })),
    ),
  )("rejects $name shell=$shell", ({ name, shell }) => {
    const errors = validateMutatedWorkflow((workflow) => {
      workflow.jobs["generate-matrix"]!.steps!.find((step) => step.name === name)!.shell = shell;
    });
    expect(errors).toContain(`trusted pre-candidate step ${name} must preserve its reviewed shell`);
  });
});

describe("staging action read failures", () => {
  const diagnostic =
    "native Podman staging action must be readable to verify its immutable commit pin";
  it("returns a boundary violation for a missing action file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-missing-staging-"));
    try {
      expect(validateNativePodmanStagingAction(path.join(directory, "missing.yaml"))).toEqual([
        diagnostic,
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(["ENOENT", "EACCES"])(
    "reports %s safely through the complete workflow validator",
    (code) => {
      const reviewedPath = path.resolve(
        ".github/actions/stage-native-podman-e2e-toolchains/action.yaml",
      );
      const error = Object.assign(new Error("private-path-and-credential-must-not-appear"), {
        code,
      });
      try {
        const failures = new Map([
          [
            reviewedPath,
            () => {
              throw error;
            },
          ],
        ]);
        vi.mocked(readFileSync).mockImplementation((file, options) =>
          (failures.get(String(file)) ?? (() => fs.readFileSync(file, options)))(),
        );
        expect(validateE2eWorkflowBoundary()).toEqual([diagnostic]);
      } finally {
        vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
      }
    },
  );
});

it.each([
  { name: "workflow", select: (workflow: Workflow) => workflow },
  { name: "planner job", select: (workflow: Workflow) => workflow.jobs["generate-matrix"]! },
])("rejects inherited shell override from $name", ({ select }) => {
  const errors = validateMutatedWorkflow((workflow) => {
    select(workflow).defaults = { run: { shell: 'bash -c "exit 0" {0}' } };
  });
  expect(errors).toContain("trusted pre-candidate scripts must not inherit a custom default shell");
});

it.each([
  "Build trusted larger-runner routing",
  "Authenticate manual PR dispatch",
  "Record trusted E2E dispatch receipt",
  "Authorize Launchable E2E maintainer dispatch",
  "Install trusted E2E planner dependencies",
  "Generate E2E target matrix",
])("rejects working directory override for %s", (name) => {
  const errors = validateMutatedWorkflow((workflow) => {
    workflow.jobs["generate-matrix"]!.steps!.find((step) => step.name === name)![
      "working-directory"
    ] = "/tmp/unapproved-planner";
  });
  expect(errors).toContain(
    `trusted pre-candidate step ${name} must preserve its reviewed working directory`,
  );
});

it.each([
  { name: "workflow", select: (workflow: Workflow) => workflow },
  { name: "planner job", select: (workflow: Workflow) => workflow.jobs["generate-matrix"]! },
])("rejects inherited working directory override from $name", ({ select }) => {
  const errors = validateMutatedWorkflow((workflow) => {
    select(workflow).defaults = { run: { "working-directory": "/tmp/unapproved-planner" } };
  });
  expect(errors).toContain(
    "trusted pre-candidate scripts must not inherit a custom working directory",
  );
});
