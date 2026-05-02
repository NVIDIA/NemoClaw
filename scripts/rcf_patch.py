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

# Scope the search to the replaceConfigFile function body.
fn_start = src.find("async function replaceConfigFile(")
assert fn_start != -1, "replaceConfigFile function not found in file"
# Find the matching closing brace by walking the source.
depth = 0
fn_body_start = src.index("{", fn_start)
i = fn_body_start
while i < len(src):
    if src[i] == "{":
        depth += 1
    elif src[i] == "}":
        depth -= 1
        if depth == 0:
            break
    i += 1
fn_src = src[fn_body_start : i + 1]

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
out = src[:fn_offset] + patched_fn + src[fn_offset + len(fn_src):]
open(p, "w").write(out)
print(f"[nemoclaw] rcf_patch applied to {p}")
