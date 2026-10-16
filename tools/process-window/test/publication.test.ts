// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishMapping, type GitHubApi } from "../src/publish.js";

test("signed publication preserves concurrent edits and rejects unsigned or mismatched readback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "process-window-api-"));
  try {
    const mapping = join(directory, "mapping.yaml"),
      bootstrap = "a".repeat(40);
    await writeFile(mapping, "guidance map\n");
    let head = "",
      valid = true,
      race = false,
      wrongReadback = false,
      commits = 0;
    const api: GitHubApi = {
      async request(route, p) {
        if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
          if (!head) throw Object.assign(Error("Not found"), { status: 404 });
          return { data: { object: { sha: head } } };
        }
        if (route === "POST /repos/{owner}/{repo}/git/refs") {
          if (race) {
            head = "c".repeat(40);
            throw Error("Already exists");
          }
          assert.equal(head, "");
          head = p.sha as string;
          return { data: { object: { sha: head } } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}")
          return { data: { verification: { verified: valid } } };
        throw Error(`Unexpected endpoint ${route}`);
      },
      async graphql(_query, p) {
        const input = p.input as any;
        if (race) head = "c".repeat(40);
        if (input.expectedHeadOid !== head) throw Error("Competing manual edit");
        assert.deepEqual(
          input.fileChanges.additions.map((f: any) => f.path),
          ["mapping.yaml"],
        );
        assert.equal(
          Buffer.from(input.fileChanges.additions[0].contents, "base64").toString(),
          "guidance map\n",
        );
        assert.equal(input.author, undefined);
        assert.equal(input.committer, undefined);
        commits++;
        head = wrongReadback ? "d".repeat(40) : "e".repeat(40);
        return { createCommitOnBranch: { commit: { oid: "e".repeat(40) } } };
      },
    };
    const publish = (expected: string, previous?: string) =>
      publishMapping(
        api,
        "example/repo",
        "process-window-data",
        expected,
        bootstrap,
        mapping,
        previous,
      );
    valid = false;
    await assert.rejects(publish(""), /verified/);
    assert.equal(head, "");
    valid = true;
    race = true;
    await assert.rejects(publish(""));
    assert.equal(head, "c".repeat(40));
    head = "";
    race = false;
    assert.equal(await publish(""), "e".repeat(40));
    const before = commits;
    assert.equal(await publish(head, "guidance map\n"), head);
    assert.equal(commits, before, "Unchanged mapping creates no commit");
    await assert.rejects(publish("a".repeat(40)), /changed/);
    assert.equal(commits, before);
    race = true;
    await assert.rejects(publish(head));
    assert.equal(head, "c".repeat(40));
    race = false;
    assert.equal(await publish(head), "e".repeat(40));
    wrongReadback = true;
    await assert.rejects(publish(head), /readback/);
    wrongReadback = false;
    valid = false;
    await assert.rejects(publish(head), /verified/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
