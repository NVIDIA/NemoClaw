<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes Image Source

Hermes Agent source is pinned to `29112bef099274229cadff79cdff7bf7b99c4b77` from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
Its upstream license and notices remain in `/opt/hermes` and the retained source archive.

2026-09-28: apply the unmodified `adapters/python/hermes/metadata-propagate.patch` from NeMo Fabric `24f068c895e5cbc30286bc743498be4e5014d658`, matching Fabric's `install-hermes-agent` recipe.
The patch forwards OpenAI request metadata into Hermes Relay turn metadata.
The retained Fabric source archive includes the exact patch and its upstream notices.
Remove this patch step when the pinned Hermes source includes the behavior, as directed by Fabric's recipe.
