<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Post-Merge Documentation Automation

This directory owns the trusted authoring and publishing boundary for `Docs / Author Post-Merge Catch-Up`.

Repository administrators retain the `POST_MERGE_DOCS_API_KEY` Actions secret until rotation or
removal. GitHub exposes it only to the author job's `Configure isolated inference` step. Hosted-runner
cleanup removes the gateway runtime copy. Sandboxes, artifacts, and the publisher do not receive the
secret.

The [workflow](../../.github/workflows/post-merge-docs.yaml) enforces where the secret is exposed,
and [`run.mts`](run.mts) constructs the credential-free sandbox inputs. [`contract.mts`](contract.mts)
validates approved documentation paths, release metadata, and bounded artifact reads. The
[documentation contributor guide](../../docs/CONTRIBUTING.md) describes the workflow's contributor-facing behavior.
