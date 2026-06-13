// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildPreContractExternalProviderSkipEvidence,
  classifyPreContractExternalProviderFailure,
  PRE_CONTRACT_EXTERNAL_PROVIDER_REMOVAL_CONDITION,
  PRE_CONTRACT_EXTERNAL_PROVIDER_SKIP_REASON,
  PRE_CONTRACT_EXTERNAL_PROVIDER_SOURCE_BOUNDARY,
} from "../live/cloud-inference-provider-skip.ts";

function probeOutput(output: string): { stdout: string; stderr: string } {
  return { stdout: "", stderr: output };
}

describe("cloud inference pre-contract provider skip classifier", () => {
  it("skips only endpoint validation failures with transient provider evidence", () => {
    expect(
      classifyPreContractExternalProviderFailure(
        probeOutput("Chat Completions API validation failed: returned HTTP 429 from provider"),
      ),
    ).toMatchObject({
      classifier: "transient-endpoint-validation",
    });

    expect(
      classifyPreContractExternalProviderFailure(
        probeOutput("install failed: returned HTTP 429 while downloading a package"),
      ),
    ).toBeNull();
  });

  it("skips sanitized endpoint-validation failures before the legacy contract starts", () => {
    const classification = classifyPreContractExternalProviderFailure(
      probeOutput("failed to verify inference endpoint: provider response was sanitized"),
    );

    expect(classification).toMatchObject({
      classifier: "rate-limited-or-sanitized-endpoint-validation",
      outputTail: "failed to verify inference endpoint: provider response was sanitized",
    });
  });

  it("does not skip credential or auth endpoint-validation failures", () => {
    expect(
      classifyPreContractExternalProviderFailure(
        probeOutput("endpoint validation failed: invalid NVIDIA_API_KEY credential"),
      ),
    ).toBeNull();
    expect(
      classifyPreContractExternalProviderFailure(
        probeOutput("failed to verify inference endpoint: returned HTTP 401 unauthorized"),
      ),
    ).toBeNull();
    expect(
      classifyPreContractExternalProviderFailure(
        probeOutput("Chat Completions API validation failed: HTTP 403 forbidden"),
      ),
    ).toBeNull();
  });

  it("does not skip non-transient product validation failures", () => {
    expect(
      classifyPreContractExternalProviderFailure(
        probeOutput(
          "endpoint validation failed: install.sh wrote an invalid inference configuration schema",
        ),
      ),
    ).toBeNull();
  });

  it("builds skip evidence with the source boundary and removal condition", () => {
    const classification = classifyPreContractExternalProviderFailure(
      probeOutput("endpoint validation failed: returned HTTP 429 from provider"),
    );
    expect(classification).not.toBeNull();

    const evidence = buildPreContractExternalProviderSkipEvidence(
      {
        exitCode: 1,
        timedOut: false,
        artifacts: {
          stdout: "shell/install.stdout.txt",
          stderr: "shell/install.stderr.txt",
          result: "shell/install.result.json",
        },
      },
      classification!,
    );

    expect(evidence).toMatchObject({
      id: "cloud-inference",
      status: "skipped",
      reason: PRE_CONTRACT_EXTERNAL_PROVIDER_SKIP_REASON,
      phase: "install-sh-onboard",
      legacyContractStarted: false,
      sourceBoundary: PRE_CONTRACT_EXTERNAL_PROVIDER_SOURCE_BOUNDARY,
      removalCondition: PRE_CONTRACT_EXTERNAL_PROVIDER_REMOVAL_CONDITION,
      installExitCode: 1,
      installTimedOut: false,
      artifacts: {
        stdout: "shell/install.stdout.txt",
        stderr: "shell/install.stderr.txt",
        result: "shell/install.result.json",
      },
    });
  });
});
