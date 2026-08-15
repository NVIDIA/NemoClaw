<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes Upgrade Variant

Load this reference only when the dependency target is Hermes. Apply the parent skill for the
release ledger, concern records, migration order, artifact review, and validation.

## Collect Hermes release ranges

Hermes release history can include multi-component CalVer tags. Inspect the generic collector's
current applicability. When it does not cover the selected range, use the
[Hermes CalVer supplement](../scripts/collect-hermes-release-supplement.py) to reconcile published
stable releases with the reviewed upstream clone. Use its ordered release endpoints as the parent
workflow's adjacent audit boundaries.

Apply the parent collector trust controls to this supplement.

## Publish the Hermes base image

When the migration requires a published base image:

1. Bind the source and compatibility changes to the intended source commit.
2. Check for conflicting publication work before dispatch.
3. Publish every required platform from that commit.
4. Verify the platform and index digests.
5. Pin the immutable image identity in the production selector.
6. Rebuild and inspect the final image from the pinned artifact.

Repeat publication when an image input changes. Do not use a moving image tag or a run for another
commit as evidence.
