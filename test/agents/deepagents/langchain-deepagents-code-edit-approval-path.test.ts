// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * The copied deepagents-code 0.1.71 fixture code below uses the following license.
 *
 * MIT License
 *
 * Copyright (c) LangChain, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupPackageFixtures,
  createPackageFixture,
  patcher,
  patchFixture,
  writeFixtureFile,
} from "../../helpers/langchain-deepagents-code-patch-fixture";

// The edit renderer and path formatter are from deepagents-code 0.1.71.
// Keep the real branches; replace only preview I/O and Textual mounting.
const rendererSource = String.raw`
from __future__ import annotations

import difflib
import json
import logging
from pathlib import Path
from typing import Any

from deepagents_code.tui.widgets.tool_renderers_base import ToolApprovalWidget, ToolRenderer

logger = logging.getLogger(__name__)


class EditFileApprovalWidget(ToolApprovalWidget):
    pass


class GenericApprovalWidget(ToolApprovalWidget):
    pass


def format_display_content(value):
    return value if isinstance(value, str) else json.dumps(value)


def split_diff_lines(value):
    return value.split("\n")


def is_sensitive_file_path(value):
    return Path(value).name == ".env"


def format_display_path(path_str: str | None) -> str:
    """Format a path for display.

    Returns:
        Formatted path string suitable for display.
    """
    if not path_str:
        return "(unknown)"
    try:
        path = Path(path_str)
        if path.is_absolute():
            return path.name or str(path)
        return str(path)
    except (OSError, ValueError):
        return str(path_str)

class EditFileRenderer(ToolRenderer):
    """Renderer for edit_file tool - shows unified diff."""
    @staticmethod
    def get_approval_widget(
        tool_args: dict[str, Any],
        assistant_id: str | None = None,
    ) -> tuple[type[ToolApprovalWidget], dict[str, Any]]:
        file_path = tool_args.get("file_path", "")
        old_arg = tool_args.get("old_string", "")
        new_arg = tool_args.get("new_string", "")
        if isinstance(old_arg, str) and isinstance(new_arg, str):
            preview = build_approval_preview(
                "edit_file",
                {
                    "file_path": file_path,
                    "old_string": old_arg,
                    "new_string": new_arg,
                    "replace_all": bool(tool_args.get("replace_all")),
                },
                assistant_id=assistant_id,
            )
            if (
                preview is not None
                and preview.diff is not None
                and preview.before is not None
                and preview.after is not None
            ):
                return EditFileApprovalWidget, {
                    "file_path": format_display_path(file_path),
                    "diff_lines": split_diff_lines(preview.diff),
                    "old_string": preview.before,
                    "new_string": preview.after,
                    "stats": preview.stats,
                    "show_numbers": True,
                }
            if preview is not None and preview.error:
                return GenericApprovalWidget, {
                    "file_path": format_display_path(file_path),
                    "error": preview.error,
                }
            if preview is not None and not is_sensitive_file_path(file_path):
                logger.debug(
                    "edit_file preview produced no diff for %s; "
                    "falling back to the fragment diff",
                    file_path,
                )
        old_string = format_display_content(old_arg)
        new_string = format_display_content(new_arg)
        diff_lines = EditFileRenderer._generate_diff(old_string, new_string)
        data = {
            "file_path": format_display_path(file_path),
            "diff_lines": diff_lines,
            "old_string": old_string,
            "new_string": new_string,
        }
        return EditFileApprovalWidget, data
    @staticmethod
    def _generate_diff(old_string: str, new_string: str) -> list[str]:
        """Generate unified diff lines from old and new strings.
        Returns:
            List of diff lines without the file headers.
        """
        if not old_string and not new_string:
            return []
        old_lines = old_string.splitlines() if old_string else []
        new_lines = new_string.splitlines() if new_string else []
        diff = difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile="before",
            tofile="after",
            lineterm="",
            n=3,
        )
        diff_list = list(diff)
        return diff_list[2:] if len(diff_list) > 2 else diff_list


def get_renderer(tool_name):
    return EditFileRenderer() if tool_name == "edit_file" else ToolRenderer()
`;

const approvalProbe = String.raw`
import asyncio
import copy
import json
import sys
from types import SimpleNamespace

from deepagents_code.tui.widgets import approval, tool_renderers

scenario = json.loads(sys.argv[1])
args = {"file_path": scenario["path"], "old_string": "before\n", "new_string": "after\n"}
original_args = copy.deepcopy(args)
previews = {
    "full": SimpleNamespace(diff="@@ -2 +2 @@\n-before\n+after", before="header\nbefore\n", after="header\nafter\n", stats={"additions": 1, "deletions": 1}, error=None),
    "error": SimpleNamespace(diff=None, before=None, after=None, stats=None, error="old_string no longer matches"),
    "fragment": None,
}
preview_calls = []


def preview(tool, values, assistant_id=None):
    preview_calls.append({"tool": tool, "args": values, "assistant_id": assistant_id})
    return previews[scenario["preview"]]


tool_renderers.build_approval_preview = preview


class Mounted:
    def __init__(self):
        self.widgets = []

    async def remove_children(self):
        self.widgets.clear()

    async def mount(self, widget):
        self.widgets.append(widget)


menu = approval.ApprovalMenu()
menu._action_requests = [{"name": scenario["tool"], "args": args}]
menu._assistant_id = "managed-agent"
menu._show_diff_line_numbers = False
menu._tool_info_container = Mounted()
asyncio.run(menu._update_tool_info())
menu._handle_selection(0)
menu._handle_selection(2, reject_message="keep the file")
print(json.dumps({
    "data": menu._tool_info_container.widgets[0].data,
    "args": args,
    "original_args": original_args,
    "preview_calls": preview_calls,
    "decisions": menu.decisions,
    "notifications": menu.notifications,
}))
`;

function renderApproval(filePath: string | null, preview: string, tool = "edit_file") {
  const fixture = createPackageFixture();
  const packageDir = path.join(fixture, "deepagents_code");
  fs.copyFileSync(
    path.join(packageDir, "tui/widgets/tool_renderers.py"),
    path.join(packageDir, "tui/widgets/tool_renderers_base.py"),
  );
  writeFixtureFile(packageDir, "tui/widgets/tool_renderers.py", rendererSource);
  patchFixture(fixture);
  return JSON.parse(
    execFileSync(
      "python3",
      ["-c", approvalProbe, JSON.stringify({ path: filePath, preview, tool })],
      { env: { PATH: process.env.PATH, PYTHONPATH: fixture }, encoding: "utf8" },
    ),
  );
}

afterEach(cleanupPackageFixtures);

describe("managed Deep Agents Code edit approval paths", () => {
  it.each([
    {
      preview: "full",
      expected: {
        diff_lines: ["@@ -2 +2 @@", "-before", "+after"],
        old_string: "header\nbefore\n",
        new_string: "header\nafter\n",
        stats: { additions: 1, deletions: 1 },
        show_numbers: false,
      },
    },
    { preview: "error", expected: { error: "old_string no longer matches" } },
    {
      preview: "fragment",
      expected: {
        diff_lines: ["@@ -1 +1 @@", "-before", "+after"],
        old_string: "before\n",
        new_string: "after\n",
      },
    },
  ])("keeps the full edit target and $preview preview (#13531)", ({ preview, expected }) => {
    const result = renderApproval("/tmp/square.py", preview);

    expect(result.data).toEqual({ file_path: "/tmp/square.py", ...expected });
    expect(result.args).toEqual(result.original_args);
    expect(result.preview_calls).toEqual([
      {
        tool: "edit_file",
        args: {
          file_path: "/tmp/square.py",
          old_string: "before\n",
          new_string: "after\n",
          replace_all: false,
        },
        assistant_id: "managed-agent",
      },
    ]);
    expect(result.decisions).toEqual([
      ["approve", null],
      ["reject", "keep the file"],
    ]);
    expect(result.notifications).toEqual([]);
  });

  it.each([
    { filePath: "/sandbox/square.py", expected: "/sandbox/square.py" },
    { filePath: "src/square.py", expected: "src/square.py" },
    { filePath: "", expected: "(unknown)" },
    { filePath: null, expected: "(unknown)" },
  ])("preserves the target or fallback for '$filePath' (#13531)", ({ filePath, expected }) => {
    const result = renderApproval(filePath, "fragment");

    expect(result.data.file_path).toBe(expected);
    expect(result.args).toEqual(result.original_args);
  });

  it("leaves other tool display data unchanged (#13531)", () => {
    const result = renderApproval("/tmp/square.py", "fragment", "another_tool");

    expect(result.data).toEqual(result.original_args);
    expect(result.preview_calls).toEqual([]);
    expect(result.args).toEqual(result.original_args);
  });

  it("refuses a marked package with a stale edit target patch (#13531)", () => {
    const fixture = createPackageFixture();
    patchFixture(fixture);
    const approvalPath = path.join(fixture, "deepagents_code/tui/widgets/approval.py");
    const changed = fs
      .readFileSync(approvalPath, "utf8")
      .replace('data["file_path"] = file_path', 'data["file_path"] = "stale"');
    fs.writeFileSync(approvalPath, changed);
    const result = spawnSync("python3", [patcher], {
      env: { PATH: process.env.PATH, PYTHONPATH: fixture },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/approval/i);
    expect(fs.readFileSync(approvalPath, "utf8")).toBe(changed);
  });

  it.each(["missing", "duplicate"])(
    "refuses a %s approval consumer anchor before writing the package (#13531)",
    (scenario) => {
      const fixture = createPackageFixture();
      const approvalPath = path.join(fixture, "deepagents_code/tui/widgets/approval.py");
      const original = fs.readFileSync(approvalPath, "utf8");
      const anchor = [
        "            widget_class, data = renderer.get_approval_widget(",
        "                tool_args, assistant_id=self._assistant_id",
        "            )",
      ].join("\n");
      const changed = original.replace(
        anchor,
        scenario === "missing"
          ? anchor.replace("get_approval_widget", "get_other_widget")
          : `${anchor}\n${anchor}`,
      );
      fs.writeFileSync(approvalPath, changed);
      const result = spawnSync("python3", [patcher], {
        env: { PATH: process.env.PATH, PYTHONPATH: fixture },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/approval/i);
      expect(fs.readFileSync(approvalPath, "utf8")).toBe(changed);
      expect(fs.existsSync(path.join(fixture, "deepagents_code/_nemoclaw_managed.py"))).toBe(false);
    },
  );
});
