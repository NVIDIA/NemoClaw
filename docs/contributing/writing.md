# Write documentation that answers the reader's question

State the answer or required action first, then give the reasons and details the reader needs to act correctly.
Keep one canonical page for each task, reference topic, or failure mode.
This guide adapts the upstream NemoClaw writing rules for this Markdown documentation.

## Organize with the Minto Pyramid

Use the [Minto Pyramid Principle](https://www.barbaraminto.com/) to organize the argument from its governing point to supporting details.
Before drafting, identify the reader's question and write a one-sentence answer.
Group the supporting points by a clear relationship, such as ordered actions, responsibility boundaries, or comparable options.
Put evidence and exceptions under the point they qualify.

For a procedure, lead with the outcome and applicability, then provide prerequisites, ordered actions, verification, and recovery.
Place a condition or destructive consequence before the action it governs.
For an explanation, state the conclusion before the supporting reasons and implementation detail.
For a results page, state what the evidence establishes, then show the measurements and remaining gaps.
Do not add background that delays the reader's task.

## Use plain, consistent language

Follow [Google's developer documentation style](https://developers.google.com/style) for clear, direct technical prose.
Use active voice, present tense, and second person for instructions.
Use sentence case for titles and headings, including navigation labels.
Preserve the capitalization of product names and literal identifiers.
Use numbered steps for ordered actions and parallel bullets or tables for comparable items.
Introduce a code block or list with a complete sentence, and give each fence a language.
Do not include shell prompts in copyable commands.

Write one prose sentence per source line and one main point per paragraph.
Prefer short sentences, but preserve technical accuracy over a word limit.
Avoid contractions, vague pronouns, promotional claims, redundant summaries, and implementation history in operating guides.
Use `must` for requirements, `may` for permission, `can` for capability, and `should` for recommendations.

## Write durable guidance

Describe behavior and requirements directly, without defining NemoClaw by a temporary development stage.
Do not label NemoClaw or its deployment paths as experiments or prototypes in active guidance.
Retain historical wording only in clearly identified records and exact source identifiers that commands or links require.
Avoid relative-time phrases such as “currently,” “still,” “the latest,” and “the newer release” when describing capabilities.
Name the configuration, API, version, or revision that determines the behavior.
Keep dates in decision records and validation evidence, where they identify the scope of a claim.
Move development chronology and task-specific authorization into historical records.
Preserve actual constraints, literal command names, and the limits of recorded evidence.
Link to the [authoritative dependency inputs](../reference/dependencies.md) instead of copying release numbers or image hashes into operating prose.
Keep exact versions in historical evidence and where they define an API, schema, or compatibility boundary.
Do not turn planned work into implemented behavior by removing temporal wording.

## Keep terminology precise

| Term | Meaning in NemoClaw |
| --- | --- |
| Agent runtime | The software that executes agent work; prefer this to a generic “harness” in explanatory prose |
| `harness` | Fabric's literal adapter/recipe selector; preserve it in YAML, flags, code, and adapter-specific descriptions |
| Deployment | Resources bound to an explicit UID and selected local state directory |
| OpenShell workspace | The API resource that contains deployment registrations and memberships |
| Filesystem workspace | Agent files, such as `/sandbox/workspace`; distinct from the OpenShell resource |
| Tested or qualified here | Evidence for the named revision, scenario, and platform; not a product-support promise |
| Unknown | An observation failed or was incomplete; not equivalent to confirmed absence |

Use established names such as NeMo Fabric, OpenShell, OpenClaw, and Deep Agents consistently.
Do not rename a pinned package to match branding for a different product or release.
Do not use “supported” to turn a local test into a product commitment.

## Own each topic once

Keep current documentation under `docs/`, except standard repository entry, contribution, agent-instruction, and license files.
Keep operational skills and packaged legal notices in their required locations.
Use [the documentation index](../index.md) as the navigation entry point.
Link to a procedure or rule instead of copying it into several pages.
Use descriptive relative Markdown links for repository content.

Keep the RFC and dated validation log in the archive with prominent historical notices.
Do not rewrite a historical result to imply it tested the current implementation.
Record current evidence limits in the validation summary and retain raw evidence without altering its contents.
During a restructuring, update the [ownership map](documentation-map.md) and check inbound links and anchors.

## Review and validation

Verify commands, flags, defaults, effects, and failure behavior against the code and tests.
Documentation claims alone do not establish behavior.
For credentials or persistent state, explain location, access, lifetime, and removal where the reader must make a decision.
Put costs and destructive effects before the relevant command.
Provide a success criterion and a recovery action for procedures.

Check relative links, heading anchors, navigation coverage, and whitespace before finishing.
Review every changed page, not only the diff around moved paragraphs.
Obtain an independent documentation review of a structural refactor for lost content, duplicate ownership, accuracy, navigation, and readability.
Run the [appropriate validation](../validation/run-tests.md); do not create live resources just to validate a documentation move.

## Source guidance and local adaptations

The upstream baseline was read at commit `e9cf24220532e33e704298632d9006b30254efdd` on `origin/main`:

- [WRITING.md](https://github.com/NVIDIA/NemoClaw/blob/e9cf24220532e33e704298632d9006b30254efdd/WRITING.md): concise, accurate, action-oriented prose.
- [Documentation style](https://github.com/NVIDIA/NemoClaw/blob/e9cf24220532e33e704298632d9006b30254efdd/docs/STYLE.md) and [contribution rules](https://github.com/NVIDIA/NemoClaw/blob/e9cf24220532e33e704298632d9006b30254efdd/docs/CONTRIBUTING.md).
- [Documentation instructions](https://github.com/NVIDIA/NemoClaw/blob/e9cf24220532e33e704298632d9006b30254efdd/docs/AGENTS.md), [refactor workflow](https://github.com/NVIDIA/NemoClaw/blob/e9cf24220532e33e704298632d9006b30254efdd/.agents/skills/nemoclaw-maintainer-refactor-docs/SKILL.md), and [controlled terminology](https://github.com/NVIDIA/NemoClaw/blob/e9cf24220532e33e704298632d9006b30254efdd/.agents/skills/_shared/controlled-words.md).

The requested Google style takes precedence over the upstream title-case heading rule.
Google's [headings](https://developers.google.com/style/headings) and [procedures](https://developers.google.com/style/procedures) guides provide the applicable conventions.
This branch uses Markdown links, not Fern routes, generated runtime variants, or MDX components.
Those upstream publishing requirements do not imply that this repository has a documentation site.
Historical documents and literal output retain their original formatting when needed to preserve evidence.
