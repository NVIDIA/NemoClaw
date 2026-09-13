<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cut and Follow the Release

## 5. Confirm, Cut, and Report the Tag

Ask the maintainer to paste the plan's exact phrase:

```text
CONFIRM RELEASE vX.Y.Z <full-candidate-sha>
```

After receiving that exact phrase, run the cutter immediately. The cutter reads the immutable plan,
validates the signed release brief's documentation decision, and checks remote tag state before the
push.

Run:

```bash
npm run release:cut -- \
  --plan ../nemoclaw-release-vX.Y.Z/plan.json \
  --message-file ../nemoclaw-release-vX.Y.Z/release-brief.md \
  --confirm "CONFIRM RELEASE vX.Y.Z <full-candidate-sha>"
```

Require the script's remote readback to show that the signed annotated tag exists and peels to the
planned candidate. Report the tag, candidate, plan path, brief path, and readback. Then continue the
same task.

## 6. Follow Tag-Triggered Work and Draft the Announcement

Start these operations together:

1. Load `nemoclaw-maintainer-release-notes`. Draft `release-note-draft.md` from the plan's immutable
   range. Open the completed draft in the requested editor. Never create the Discussion.
2. Find the tag-push runs for these workflow files:
   - `.github/workflows/release-latest-tag.yaml`
   - `.github/workflows/docs-publish-public.yaml`
   - `.github/workflows/base-image.yaml`
3. Bind each run by workflow path, `event=push`, release tag, and planned candidate. Retain its run
   ID and attempt. Monitor the three runs concurrently until they reach terminal results.

Classify the effects that each workflow owns:

- For `Release / Latest Tag`, verify that `latest` identifies the release tag. Verify label
  carry-forward and released-label deletion.
- For `Docs / Publish Public`, require the `publish` job to succeed.
- For `Images / Publish Base and Managed Images`, require `Publish complete managed images` to
  succeed. Report Pi candidate failures separately; they do not determine production promotion.

A failed post-tag workflow does not change tag success. Report the failing job and recovery path.
For failed image jobs, check [retry prerequisites](candidate-evidence.md#check-prerequisites-before-a-retry).
Ask before a rerun. Bind and monitor the new attempt. The managed-image workflow supports failed-job
reruns that reuse successful producer artifacts from the same run. Existing build checks still verify those artifacts.

After image classification, read the peeled `lkg` commit. This skill never moves `lkg`. If
production promotion succeeded and `lkg` differs, show the current and proposed releases and ask for
separate maintainer authorization. If the maintainer moves `lkg`, monitor
`.github/workflows/release-lkg-brev-image.yaml` and its returned downstream production-image run.

Send the final response only after:

- all three automatic workflows are terminal and their effects are classified;
- the Announcement draft exists; and
- `lkg` already identifies the release, is ineligible because production promotion failed, awaits
  an explicit maintainer decision, or its authorized downstream production run is classified.

Keep the semver tag immutable.
