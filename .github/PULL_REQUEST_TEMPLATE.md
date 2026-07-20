<!-- markdownlint-disable MD041 -->
## Summary
<!-- 1-3 plain sentences: what changes and why. Describe before-and-after behavior when it applies. Use the NemoClaw Technical English profile: https://github.com/NVIDIA/NemoClaw/blob/main/CONTRIBUTING.md#nemoclaw-technical-english. During the changed-text pilot, do not expand this PR to clean up unrelated prose. -->

## Related Issue
<!-- Fixes #NNN or Closes #NNN. Remove this section if none. -->

## Changes
<!-- List concrete changes. If this adds an abstraction, configuration, fallback, migration, or compatibility path, name its current requirement and consumer, explain why a direct change is insufficient, and identify the test that protects it. -->

## Type of Change

- [ ] Code change (feature, bug fix, or refactor)
- [ ] Code change with doc updates
- [ ] Doc only (prose changes, no code sample modifications)
- [ ] Doc only (includes code sample changes)

## Quality Gates
<!-- Check one tests line and one docs line. Check other lines when applicable. Add every requested justification or approval reference. -->
- [ ] Tests added or updated for changed behavior
- [ ] Existing tests cover changed behavior — justification:
- [ ] Tests not applicable — justification:
- [ ] Docs updated for user-facing behavior changes
- [ ] Docs not applicable — justification:
- [ ] Sensitive paths changed (security, policy, credentials, preflight, onboarding, inference, runner, sandbox, or messaging)
- [ ] Sensitive-path review completed or maintainer-approved waiver recorded — reviewer/approval link/justification:
- [ ] Non-success, skipped, or missing CI check accepted by maintainer — check name, approval link, and follow-up issue:

## DGX Station Hardware Evidence
<!-- Required only when scripts/prepare-dgx-station-host.sh changes. Maintainers must review the linked evidence before approving or merging. This is human-reviewed evidence, not authenticated hardware provenance. Exceptional bypasses use existing repository governance and must be documented on the PR. -->
- [ ] Tested on DGX Station
- Tested commit:
- Station profile/scenario:
- Result:
- Supporting evidence:

## Verification
<!-- Check each applicable item only when supported by the requested evidence. Run targeted tests once per relevant change set and rerun after later edits or hook autofixes that can affect the tested behavior. Do not rerun hook-covered checks. -->
- [ ] PR description includes a `Signed-off-by:` line and every commit appears as `Verified` in GitHub
- [ ] Normal `pre-commit`, `commit-msg`, and `pre-push` hooks passed, or `npm run check:diff` passed when hooks were skipped or unavailable
- [ ] Targeted behavior tests pass for the current change set, or tests are marked not applicable above — command/result or justification:
- [ ] Applicable broad gate passed — `npm test` for broad runtime/test-harness changes; `npm run check` for repo-wide validation/coverage changes — command/result:
- [ ] Quality Gates section completed with required justifications or waivers
- [ ] No secrets, API keys, or credentials committed
- [ ] `npm run docs` builds without warnings (doc changes only)
- [ ] Doc pages follow the [style guide](https://github.com/NVIDIA/NemoClaw/blob/main/docs/CONTRIBUTING.md) (doc changes only)
- [ ] New doc pages include SPDX header and frontmatter (new pages only)

---
<!-- DCO sign-off is required in this PR description, and every commit must appear as Verified in GitHub. Run: git config user.name && git config user.email -->
Signed-off-by: Your Name <your-email@example.com>
