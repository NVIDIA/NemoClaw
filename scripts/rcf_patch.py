"""
Patch replaceConfigFile in OpenClaw dist to wrap the
tryWriteSingleTopLevelIncludeMutation/writeConfigFile block in a try/catch
that suppresses EACCES when running inside an OpenShell sandbox.

Uses a broad regex anchored on function-call names, not whitespace or object
property ordering, so minor formatting changes across OpenClaw versions don't
cause false misses (#2689). The match is scoped to the replaceConfigFile
function body to avoid patching unrelated blocks.
"""
import re
import sys

p = sys.argv[1]
src = open(p).read()


def skip_quoted(text, i, quote):
    i += 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == quote:
            return i + 1
        i += 1
    raise AssertionError("unterminated string while scanning replaceConfigFile")


def find_matching_brace(text, open_idx):
    depth = 0
    i = open_idx
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""

        if ch in ("'", '"', "`"):
            i = skip_quoted(text, i, ch)
            continue
        if ch == "/" and nxt == "/":
            newline = text.find("\n", i + 2)
            i = len(text) if newline == -1 else newline + 1
            continue
        if ch == "/" and nxt == "*":
            end = text.find("*/", i + 2)
            assert end != -1, "unterminated block comment while scanning replaceConfigFile"
            i = end + 2
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
            assert depth > 0, "replaceConfigFile function body closed before it opened"
        i += 1

    raise AssertionError("replaceConfigFile function body not terminated")


# Scope the search to the replaceConfigFile function body.
fn_start = src.find("async function replaceConfigFile(")
assert fn_start != -1, "replaceConfigFile function not found in file"
fn_body_start = src.index("{", fn_start)
fn_body_end = find_matching_brace(src, fn_body_start)
fn_src = src[fn_body_start : fn_body_end + 1]

# Match the tryWriteSingleTopLevelIncludeMutation / writeConfigFile block.
# - Tolerates any whitespace around !, await, (, {, }, commas, ;
# - Allows snapshot / nextConfig properties in either order
# - Allows optional semicolon at end
# - Uses DOTALL so \s matches newlines
pat = re.compile(
    r"(?P<pre>[ \t]*)if\s*\(\s*!\s*await\s+tryWriteSingleTopLevelIncludeMutation\s*\("
    r"\s*\{(?=[^}]*\bsnapshot\b)(?=[^}]*\bnextConfig\s*:\s*params\.nextConfig\b)[^}]*?\}\s*\)\s*\)"
    r"\s*await\s+writeConfigFile\s*\(\s*params\.nextConfig\s*,\s*\{[^}]*?\}\s*\)\s*;?",
    re.DOTALL,
)
m = pat.search(fn_src)
assert m, "tryWriteSingleTopLevelIncludeMutation/writeConfigFile pattern not found in replaceConfigFile"

indent = m.group("pre")
replacement = (
    indent + "try { if (!await tryWriteSingleTopLevelIncludeMutation({\n"
    + indent + "\tsnapshot,\n"
    + indent + "\tnextConfig: params.nextConfig\n"
    + indent + "})) await writeConfigFile(params.nextConfig, {\n"
    + indent + "\tbaseSnapshot: snapshot,\n"
    + indent + "\t...writeOptions,\n"
    + indent + "\t...params.writeOptions\n"
    + indent + '}); } catch(_rcfErr) { if (process.env.OPENSHELL_SANDBOX === "1" && _rcfErr.code === "EACCES") {'
    + ' console.error("[nemoclaw] Config is read-only in sandbox \\u2014 plugin metadata not persisted (plugins auto-load from extensions/)"); }'
    + " else { throw _rcfErr; } }"
)

# Reconstruct: everything before the fn body match, patched fn body, rest.
fn_offset = fn_body_start
patched_fn = fn_src[: m.start()] + replacement + fn_src[m.end() :]
out = src[:fn_offset] + patched_fn + src[fn_body_end + 1:]
open(p, "w").write(out)
print(f"[nemoclaw] rcf_patch applied to {p}")
