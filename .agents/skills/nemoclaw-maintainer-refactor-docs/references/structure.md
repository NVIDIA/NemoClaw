<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Step 1: Inventory Before Editing

Read the complete section rather than sampling the longest page.

1. List every page and nested group for every OpenClaw, Hermes, and Deep Agents navigation variant.
2. List every H2 and H3 in the source pages, then map meaningful prose blocks, tables, callouts, and provider-specific procedures that do not have their own heading.
3. Find inbound links, old route and anchor references, redirects, release-note links, README links, tests, generated-page mappings, source comments, and repository instructions that name the current docs owners.
4. Record which variants render each page or block.
5. Identify repeated procedures, troubleshooting guidance, reference facts, and related-topic lists.

Use `rg` for repository-wide discovery. Useful starting points include:

```bash
rg -n '^(##|###) ' docs/<section>
rg -n '<section-slug>|<page-slug>|<page-title>' docs fern README.md test scripts
```

Create an ownership inventory before proposing the new TOC:

| Current page or section | User task | Variants | Canonical owner | Action |
|---|---|---|---|---|
| Existing topic | What the reader is trying to do | Applicable guides | Destination page | Keep, split, move, merge, or delete |

Every old H2 and H3 must appear in this inventory.

## Step 2: Design Around the User Journey

Default to this sequence when it fits the subject.
Omit a phase when it has no substantial reader task; never invent a thin page only to complete the sequence.

1. **Choose**: Help readers select an option, provider, model, deployment, or approach.
2. **Set up**: Give each provider, platform, integration, or setup path its own focused page when the procedures differ.
3. **Operate**: Cover inspection, switching, configuration, lifecycle, and routine management.
4. **Validate**: Prove configuration and runtime behavior without mixing in broad troubleshooting.
5. **Troubleshoot and reference**: Keep reusable failure remediation and lookup material under the canonical Reference section.

Add an **About** or **Understand** page only when it explains a distinct mental model that readers need before choosing or operating.
Do not create an overview page merely to give a section a clickable first item.

Apply these navigation rules:

- Make section headings and foldable TOC nodes non-clickable grouping nodes. They must contain only `section`, `slug`, and `contents`, plus supported display settings such as `collapsed`.
- Put all reader-facing content on child pages.
- Default to `root section -> task group -> page`. Avoid deeper nesting unless the material demonstrates a real third-level distinction.
- Keep one primary topic or user task per page. Supporting prerequisites and immediate success verification may remain on the same page; split distinct user goals, provider flows, reusable concepts, and reusable reference material.
- Prefer verb-led page titles such as **Choose**, **Set Up**, **Configure**, **View**, **Switch**, **Verify**, and **Troubleshoot**.
- Use concise noun phrases for group labels.
- Keep provider-specific or platform-specific procedures on their own pages instead of adding more sections to a generic page.
- Reuse group slugs and ordering across variants where practical, omit unsupported pages, and never publish an empty group.

## Step 3: Establish Canonical Ownership

Assign each fact, procedure, and failure mode to one page before moving content.

- Keep setup steps on the focused setup page.
- Keep routine operations on manage or operate pages.
- Keep validation behavior on validation pages.
- Move reusable failure symptoms, diagnosis, and remediation to the canonical Reference troubleshooting area.
- Use `docs/reference/troubleshooting.mdx` when it remains a focused owner. If the canonical page is itself oversized, create a non-clickable **Troubleshooting** group with focused child pages instead of growing another monolith.
- Keep structured lookup material in Reference.
- Link to canonical content instead of restating it on several pages.

Before moving troubleshooting or reference content, search the destination for the same symptom, heading, commands, and distinctive phrases.
Merge with existing guidance when it is already documented.
Do not leave a shorter duplicate behind.

Preserve every unique fact from the old pages.
When two pages disagree, verify the behavior from authoritative sources instead of choosing whichever wording is newer.
