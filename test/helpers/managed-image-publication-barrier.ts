// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const publicationAgents = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
export const publicationPlatforms = ["linux/amd64", "linux/arm64"] as const;

const revision = "a".repeat(40);
const repository = "NVIDIA/NemoClaw";
const runId = "7744";
const runAttempt = "2";
const cohort = `ghrun-${runId}-${runAttempt}`;

type Candidate = {
  agent: (typeof publicationAgents)[number];
  platform: (typeof publicationPlatforms)[number];
  contract: Record<string, unknown>;
  artifact: string;
};

export type CandidateMutation = (candidates: Candidate[]) => Candidate[];

type PromotionResult = {
  calls: string[];
  cohortContract: Record<string, unknown> | null;
  platformContracts: Record<string, Record<string, unknown>>;
  status: number | null;
  stderr: string;
};

function imageFor(agent: (typeof publicationAgents)[number]): string {
  return `ghcr.io/nvidia/nemoclaw/${agent}-sandbox`;
}

function digestFor(agentIndex: number, platformIndex: number, base: boolean): string {
  const offset = base ? 20 : 1;
  return `sha256:${(offset + agentIndex * 2 + platformIndex).toString(16).padStart(64, "0")}`;
}

function candidates(): Candidate[] {
  return publicationAgents.flatMap((agent, agentIndex) =>
    publicationPlatforms.map((platform, platformIndex) => {
      const image = imageFor(agent);
      const digest = digestFor(agentIndex, platformIndex, false);
      const baseDigest = digestFor(agentIndex, platformIndex, true);
      return {
        agent,
        platform,
        artifact: `managed-image-candidate-${agent}-${platform.replace("/", "-")}`,
        contract: {
          contractVersion: 1,
          phase: "candidate",
          agent,
          image,
          digest,
          reference: `${image}@${digest}`,
          baseReference: `ghcr.io/nvidia/nemoclaw/${agent}-sandbox-base@${baseDigest}`,
          platform,
          attestations: { provenance: "mode=max", sbom: true },
          source: {
            repository,
            revision,
            ref: "refs/heads/main",
            cohort,
          },
          run: { id: Number(runId), attempt: Number(runAttempt) },
          release: null,
        },
      };
    }),
  );
}

export function runPublicationBarrier(
  script: string,
  mutate: CandidateMutation = (value) => value,
  afterBarrier = "",
): {
  dockerCalls: string[];
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-candidates-"));
  const candidateRoot = path.join(root, "candidates");
  const output = path.join(root, "github-output");
  const dockerCalls = path.join(root, "docker-calls");
  const bin = path.join(root, "bin");
  fs.mkdirSync(candidateRoot);
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "docker"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$DOCKER_CALLS"\nexit 97\n',
  );
  fs.chmodSync(path.join(bin, "docker"), 0o755);

  try {
    for (const candidate of mutate(candidates())) {
      const artifactDir = path.join(candidateRoot, candidate.artifact);
      fs.mkdirSync(artifactDir);
      fs.writeFileSync(
        path.join(artifactDir, "contract.json"),
        `${JSON.stringify(candidate.contract)}\n`,
      );
    }
    const result = spawnSync("bash", ["-c", `${script}\n${afterBarrier}`], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CANDIDATE_ROOT: candidateRoot,
        DOCKER_CALLS: dockerCalls,
        GITHUB_OUTPUT: output,
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ATTEMPT: runAttempt,
        GITHUB_RUN_ID: runId,
        GITHUB_SHA: revision,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
      },
    });
    return {
      dockerCalls: fs.existsSync(dockerCalls)
        ? fs.readFileSync(dockerCalls, "utf8").split(/\r?\n/u).filter(Boolean)
        : [],
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function runManagedImagePromotion(script: string, failCohortAgent = ""): PromotionResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-promotion-"));
  const bin = path.join(root, "bin");
  const calls = path.join(root, "docker-calls");
  const candidateSet = path.join(root, "candidate-set.json");
  const contracts = path.join(root, "managed-image-contracts");
  const digest = `sha256:${"f".repeat(64)}`;
  const raw = JSON.stringify({
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        digest: `sha256:${"1".repeat(64)}`,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        digest: `sha256:${"2".repeat(64)}`,
        platform: { os: "linux", architecture: "arm64" },
      },
    ],
  });
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
if [ -n "\${FAIL_COHORT_AGENT:-}" ] &&
   [[ "$*" == *"imagetools create"* ]] &&
   [[ "$*" == *"/\${FAIL_COHORT_AGENT}-sandbox:cohort-"* ]]; then
  exit 91
fi
if [[ "$*" == *"imagetools inspect"* ]] && [[ "$*" == *"--raw"* ]]; then
  printf '%s' '${raw}'
elif [[ "$*" == *"imagetools inspect"* ]]; then
  printf 'Name: fake\\nMediaType: application/vnd.oci.image.index.v1+json\\nDigest: ${digest}\\n'
fi
`,
  );
  fs.chmodSync(path.join(bin, "docker"), 0o755);
  fs.writeFileSync(
    candidateSet,
    `${JSON.stringify(candidates().map(({ contract }) => contract))}\n`,
  );

  try {
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CANDIDATE_SET: candidateSet,
        DOCKER_CALLS: calls,
        FAIL_COHORT_AGENT: failCohortAgent,
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ATTEMPT: runAttempt,
        GITHUB_RUN_ID: runId,
        GITHUB_SHA: revision,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
      },
    });
    const platformContracts: Record<string, Record<string, unknown>> = {};
    for (const agent of publicationAgents) {
      for (const platform of publicationPlatforms) {
        const artifactPlatform = platform.replace("/", "-");
        const contract = path.join(contracts, agent, artifactPlatform, "contract.json");
        if (fs.existsSync(contract)) {
          platformContracts[`${agent}|${platform}`] = JSON.parse(
            fs.readFileSync(contract, "utf8"),
          ) as Record<string, unknown>;
        }
      }
    }
    const cohortContract = path.join(contracts, "cohort.json");
    return {
      calls: fs.existsSync(calls)
        ? fs.readFileSync(calls, "utf8").split(/\r?\n/u).filter(Boolean)
        : [],
      cohortContract: fs.existsSync(cohortContract)
        ? (JSON.parse(fs.readFileSync(cohortContract, "utf8")) as Record<string, unknown>)
        : null,
      platformContracts,
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
