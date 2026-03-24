<!-- markdownlint-disable MD041 -->
## Summary
<!-- 1-3 sentences: what this PR does and why. -->

## Related Issue
<!-- Link to the issue: Fixes #NNN or Closes #NNN. Remove this section if none. -->

## Changes
<!-- Bullet list of key changes. -->

## Type of Change
<!-- Check the one that applies. -->
- [ ] Code change for a new feature, bug fix, or refactor.
- [ ] Code change with doc updates.
- [ ] Doc only. Prose changes without code sample modifications.
- [ ] Doc only. Includes code sample changes.

## Testing
<!-- What testing was done? -->
- [ ] `npx prek run --all-files` passes (or equivalently `make check`).
- [ ] `npm test` passes.
- [ ] `make docs` builds without warnings. (for doc-only changes)

## Checklist

### General

- [ ] I have read and followed the [contributing guide](CONTRIBUTING.md).
- [ ] I have read and followed the [style guide](docs/CONTRIBUTING.md). (for doc-only changes)

### Code Changes
<!-- Skip if this is a doc-only PR. -->
- [ ] Formatters applied — `npx prek run --all-files` auto-fixes formatting (or `make format` for targeted runs).
- [ ] Tests added or updated for new or changed behavior.
- [ ] No secrets, API keys, or credentials committed.
- [ ] Doc pages updated for any user-facing behavior changes (new commands, changed defaults, new features, bug fixes that contradict existing docs).

### Doc Changes
<!-- Skip if this PR has no doc changes. -->
- [ ] Follows the [style guide](docs/CONTRIBUTING.md). Try running the `update-docs` agent skill to draft changes while complying with the style guide. For example, prompt your agent with "`/update-docs` catch up the docs for the new changes I made in this PR."
- [ ] New pages include SPDX license header and frontmatter, if creating a new page.
- [ ] Cross-references and links verified.
