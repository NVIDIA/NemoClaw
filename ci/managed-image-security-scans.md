<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Optional managed-image security scans

The manual base-image publication workflow accepts `run_security_scans`, defaulting to false.
When selected on canonical `main`, all six OpenClaw, Hermes, and Deep Agents Code platform images
must pass scanning before cohort promotion. Tags and ordinary publication retain their existing behavior.
Pi and llama.cpp use separate publication paths and are outside this option.

This continues the scope recorded in [PR #11876](https://github.com/NVIDIA/NemoClaw/pull/11876).
The checks cover the published workload digest and its base layers:

- Grype blocks Critical vulnerabilities. Lower severities do not block.
- Pulse Secret Scanner blocks verified secrets and scan errors. Unverified findings remain advisory;
  findings covered by the reviewed `.nspect-allowlist.toml` do not block.
- Pulse Malware Scanner submits the workload image and platform through Charon. Only a successful
  process with a valid `CLEAN` report passes. Submission alone is insufficient.

These are image scans. The source-code workflows in `NVIDIA/security-workflows` do not replace them.
Grype results are not Pulse container vulnerability records or nSpect inventory updates.

## Platform prerequisites

Before the first live run, the platform owner must provision:

- Access to the NVIDIA `linux-amd64-cpu4` runner pool.
- The existing `NV_VAULT_URL` and `NVCR_VAULT_*` organization variables for the repository.
- A repository `NSPECT_ID` Actions variable identifying the intended NemoClaw program.
- A Charon tenant for `NVIDIA/NemoClaw`, allowing `refs/heads/main` and the malware CLI's
  nSpect verification, image-digest lookup, image-scan submission, and report retrieval routes.
- Pulse permission to pull the published GHCR images and use the `github-first` tenant for image scans.

The scan job retrieves the NVCR pull credential from Vault through GitHub OIDC. Its private Docker
configuration is deleted during cleanup. The pinned malware scanner receives only the short-lived
GitHub OIDC request environment; Charon supplies backend authorization. No static SSA secret is needed.
The candidate image is never executed. Grype and the secret scanner receive no OIDC or registry credentials.

Raw reports and scanner logs remain in job-private temporary files and are deleted during cleanup.
Public summaries contain only scan categories and pass/fail. The workflow uploads no raw reports.
Use the authorized Pulse backend for detailed malware evidence and remediation.

## Qualification before enabling production scans

Local tests establish candidate binding, result handling, promotion decisions, and cleanup with
stubbed scanners. They do not establish live scanner access or detection.

Before production use, retain restricted evidence of an actual image scan on both architectures.
Record the source commit, workload digest, scanner digest, backend scan record, and final verdict.
Use approved harmless fixtures to verify detection and the promotion block. Verify that missing access,
scanner failure, invalid reports, and timeout block promotion, and confirm temporary-state cleanup.
Keep detailed findings out of public logs and artifacts.

NemoClaw's Charon tenant and image-scan permission were not confirmed when this change was prepared.
Do not interpret passing local tests or source-code scans in another repository as image-scan qualification.
