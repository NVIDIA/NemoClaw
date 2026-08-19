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

type BarrierOptions = {
  publicationCohort?: string;
};

type PromotionResult = {
  calls: string[];
  cohortContract: Record<string, unknown> | null;
  platformContracts: Record<string, Record<string, unknown>>;
  status: number | null;
  stderr: string;
};

type PromotionOptions = {
  mutate?: CandidateMutation;
  publicationCohort?: string;
};

function imageFor(agent: (typeof publicationAgents)[number]): string {
  return `ghcr.io/nvidia/nemoclaw/${agent}-sandbox`;
}

function digestFor(agentIndex: number, platformIndex: number, offset: number): string {
  return `sha256:${(offset + agentIndex * 2 + platformIndex).toString(16).padStart(64, "0")}`;
}

function candidates(): Candidate[] {
  return publicationAgents.flatMap((agent, agentIndex) =>
    publicationPlatforms.map((platform, platformIndex) => {
      const image = imageFor(agent);
      const digest = digestFor(agentIndex, platformIndex, 1);
      const baseDigest = digestFor(agentIndex, platformIndex, 20);
      const baseReference = `ghcr.io/nvidia/nemoclaw/${agent}-sandbox-base@${baseDigest}`;
      const workloadDigest = digestFor(agentIndex, platformIndex, 40);
      const attestationDigest = digestFor(agentIndex, platformIndex, 60);
      const slsaDigest = digestFor(agentIndex, platformIndex, 80);
      const spdxDigest = digestFor(agentIndex, platformIndex, 100);
      return {
        agent,
        platform,
        artifact: `managed-image-candidate-${runId}-${agent}-${platform.replaceAll("/", "-")}`,
        contract: {
          contractVersion: 2,
          phase: "candidate",
          agent,
          image,
          digest,
          reference: `${image}@${digest}`,
          baseReference,
          platform,
          publicationEvidence: {
            candidateDescriptor: {
              mediaType: "application/vnd.oci.image.index.v1+json",
              digest,
              size: 1200 + agentIndex * 10 + platformIndex,
            },
            workloadDescriptor: {
              mediaType: "application/vnd.oci.image.manifest.v1+json",
              digest: workloadDigest,
              size: 900 + agentIndex * 10 + platformIndex,
              platform: {
                os: "linux",
                architecture: platform.replaceAll("linux/", ""),
              },
            },
            attestations: {
              manifestDescriptor: {
                mediaType: "application/vnd.oci.image.manifest.v1+json",
                digest: attestationDigest,
                size: 700 + agentIndex * 10 + platformIndex,
                annotations: {
                  "vnd.docker.reference.digest": workloadDigest,
                  "vnd.docker.reference.type": "attestation-manifest",
                },
                platform: { os: "unknown", architecture: "unknown" },
              },
              slsa: {
                descriptor: {
                  mediaType: "application/vnd.in-toto+json",
                  digest: slsaDigest,
                  size: 500 + agentIndex * 10 + platformIndex,
                  annotations: {
                    "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1",
                  },
                },
                statement: {
                  type: "https://in-toto.io/Statement/v1",
                  predicateType: "https://slsa.dev/provenance/v1",
                  subject: {
                    name: `pkg:docker/${image}@latest?platform=${platform.replaceAll("/", "%2F")}`,
                    digest: workloadDigest,
                  },
                  buildType:
                    "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
                  builderId: `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
                  bindings: {
                    agent,
                    baseReference,
                    cohort,
                    platform,
                    revision,
                    source: `https://github.com/${repository}`,
                  },
                },
              },
              spdx: {
                descriptor: {
                  mediaType: "application/vnd.in-toto+json",
                  digest: spdxDigest,
                  size: 600 + agentIndex * 10 + platformIndex,
                  annotations: {
                    "in-toto.io/predicate-type": "https://spdx.dev/Document",
                  },
                },
                statement: {
                  type: "https://in-toto.io/Statement/v1",
                  predicateType: "https://spdx.dev/Document",
                  subject: {
                    name: `pkg:docker/${image}@latest?platform=${platform.replaceAll("/", "%2F")}`,
                    digest: workloadDigest,
                  },
                },
              },
            },
          },
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

export const reuseOpenclawAmd64FromAttemptOne: CandidateMutation = (candidateSet) =>
  candidateSet.map((candidate) => {
    const contract = structuredClone(candidate.contract);
    const producerAttempt =
      `${candidate.agent}|${candidate.platform}` === "openclaw|linux/amd64" ? 1 : 2;
    (contract.source as Record<string, unknown>).cohort = "ghrun-7744-1";
    (contract.run as Record<string, unknown>).attempt = producerAttempt;
    const evidence = contract.publicationEvidence as Record<string, unknown>;
    const attestations = evidence.attestations as Record<string, unknown>;
    const statement = (attestations.slsa as Record<string, unknown>).statement as Record<
      string,
      unknown
    >;
    statement.builderId = `https://github.com/NVIDIA/NemoClaw/actions/runs/7744/attempts/${producerAttempt}`;
    (statement.bindings as Record<string, unknown>).cohort = "ghrun-7744-1";
    return {
      ...candidate,
      contract,
    };
  });

export function runManagedImageBaseRestore(
  script: string,
  contract: string,
): { restored: boolean; status: number | null; stderr: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-base-restore-"));
  try {
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT: "openclaw",
        DCODE_CONTRACT_BASE64: contract,
        HERMES_CONTRACT_BASE64: contract,
        OPENCLAW_CONTRACT_BASE64: contract,
        RUNNER_TEMP: root,
      },
    });
    return {
      restored: fs.existsSync(path.join(root, "managed-base-contract", "contract.json")),
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function runPublicationBarrier(
  script: string,
  mutate: CandidateMutation = (value) => value,
  afterBarrier = "",
  options: BarrierOptions = {},
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
        PUBLICATION_COHORT: options.publicationCohort ?? cohort,
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

export function runManagedImagePromotion(
  script: string,
  failCohortAgent = "",
  pointerScript = "",
  options: PromotionOptions = {},
): PromotionResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-promotion-"));
  const bin = path.join(root, "bin");
  const calls = path.join(root, "docker-calls");
  const candidateSet = path.join(root, "candidate-set.json");
  const contracts = path.join(root, "managed-image-contracts");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
agent_for_reference() {
  case "$1" in
    *'/openclaw-sandbox:'* | *'/openclaw-sandbox@'*) printf 'openclaw\\n' ;;
    *'/hermes-sandbox:'* | *'/hermes-sandbox@'*) printf 'hermes\\n' ;;
    *'/langchain-deepagents-code-sandbox:'* | *'/langchain-deepagents-code-sandbox@'*)
      printf 'langchain-deepagents-code\\n'
      ;;
    *) return 1 ;;
  esac
}
if [ "\${1:-} \${2:-} \${3:-}" = "buildx imagetools create" ]; then
  shift 3
  tag=""
  metadata=""
  files=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tag) tag="$2"; shift 2 ;;
      --metadata-file) metadata="$2"; shift 2 ;;
      --file) files+=("$2"); shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$tag" == *':cohort-'* ]]; then
    agent="$(agent_for_reference "$tag")"
    if [ -n "\${FAIL_COHORT_AGENT:-}" ] && [ "$agent" = "$FAIL_COHORT_AGENT" ]; then
      exit 91
    fi
    raw="$STATE_ROOT/$agent.raw"
    jq -cs '{
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: .
    }' "\${files[@]}" > "$raw"
    digest="sha256:$(sha256sum "$raw" | awk '{print $1}')"
    size="$(wc -c < "$raw" | tr -d '[:space:]')"
    jq -n --arg digest "$digest" --argjson size "$size" '{
      "containerimage.descriptor": {
        mediaType: "application/vnd.oci.image.index.v1+json",
        digest: $digest,
        size: $size
      }
    }' > "$metadata"
  fi
elif [ "\${1:-} \${2:-} \${3:-}" = "buildx imagetools inspect" ] &&
     [ "\${5:-}" = "--raw" ]; then
  agent="$(agent_for_reference "$4")"
  cat "$STATE_ROOT/$agent.raw"
fi
`,
  );
  fs.chmodSync(path.join(bin, "docker"), 0o755);
  const candidateValues = options.mutate ? options.mutate(candidates()) : candidates();
  fs.writeFileSync(
    candidateSet,
    `${JSON.stringify(candidateValues.map(({ contract }) => contract))}\n`,
  );

  try {
    const result = spawnSync("bash", ["-c", `${script}\n${pointerScript}`], {
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
        PUBLICATION_COHORT: options.publicationCohort ?? cohort,
        RUNNER_TEMP: root,
        STATE_ROOT: root,
      },
    });
    const platformContracts: Record<string, Record<string, unknown>> = {};
    for (const agent of publicationAgents) {
      for (const platform of publicationPlatforms) {
        const artifactPlatform = platform.replaceAll("/", "-");
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
