"""Go-specific TokenSaver plugin.

Extracts net/http handlers, gin/chi/echo routes, struct models,
go.mod dependencies, and environment config usage.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from tokensaver import SCHEMA_VERSION
from tokensaver.core.helpers import (
    add_api_file_entry,
    build_module_graph_artifact,
    finalize_api_files,
    finalize_route_files,
    match_with_lines,
    meta,
    module_name_for_file,
    timestamp,
)
from tokensaver.core.models import ArtifactResult, BuildContext

NET_HTTP_HANDLE = re.compile(
    r"(?:http\.Handle(?:Func)?|mux\.Handle(?:Func)?)\(\s*['\"]([^'\"]+)['\"]"
)
GIN_ROUTE = re.compile(
    r"\.(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Handle)\(\s*['\"]([^'\"]+)['\"]"
)
GIN_GROUP = re.compile(
    r"\.Group\(\s*['\"]([^'\"]+)['\"]"
)
CHI_ROUTE = re.compile(
    r"r\.(?:Get|Post|Put|Delete|Patch|Head|Options|Handle|Method)\(\s*['\"]([^'\"]+)['\"]"
)
ECHO_ROUTE = re.compile(
    r"e\.(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\(\s*['\"]([^'\"]+)['\"]"
)
FIBER_ROUTE = re.compile(
    r"(?:app|group|router)\.(?:Get|Post|Put|Delete|Patch|Head|Options|All)\(\s*['\"]([^'\"]+)['\"]"
)
HTTP_METHOD_EXTRACT = re.compile(
    r"\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch|Head|Options|Handle(?:Func)?|Any|All|Method)\("
)
GO_STRUCT = re.compile(r"type\s+(\w+)\s+struct\s*\{")
GO_INTERFACE = re.compile(r"type\s+(\w+)\s+interface\s*\{")
GO_GETENV = re.compile(r'os\.Getenv\(\s*["\']([A-Z0-9_]+)["\']')
GO_LOOKUP_ENV = re.compile(r'os\.LookupEnv\(\s*["\']([A-Z0-9_]+)["\']')
VIPER_GET = re.compile(r'viper\.(?:GetString|GetInt|GetBool|Get)\(\s*["\']([^"\']+)["\']')


@dataclass(frozen=True)
class GoPlugin:
    name: str = "go"
    frameworks: set[str] = frozenset({"go"})

    def build_artifacts(self, ctx: BuildContext) -> list[ArtifactResult]:
        return [
            build_module_graph(ctx),
            build_api_index(ctx),
            build_route_index(ctx),
            build_config_index(ctx),
        ]


def _go_files(root: Path):
    for path in root.rglob("*.go"):
        if ".git" in path.parts:
            continue
        if any(part in ("vendor", "testdata") for part in path.parts):
            continue
        yield path


def _extract_method(line: str) -> str:
    m = HTTP_METHOD_EXTRACT.search(line)
    if not m:
        return "ALL"
    method = m.group(1).upper()
    if method in ("HANDLEFUNC", "HANDLE", "ANY", "ALL", "METHOD"):
        return "ALL"
    return method


def build_module_graph(ctx: BuildContext) -> ArtifactResult:
    return build_module_graph_artifact(ctx.root, ctx.scan.framework, ArtifactResult)


def build_api_index(ctx: BuildContext) -> ArtifactResult:
    api_files: dict = {}
    source_files: set[Path] = set()
    endpoint_count = 0

    for fp in _go_files(ctx.root):
        if "_test.go" in fp.name:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, fp)
        file_has = False

        all_patterns = [NET_HTTP_HANDLE, GIN_ROUTE, CHI_ROUTE, ECHO_ROUTE, FIBER_ROUTE]
        for pattern in all_patterns:
            for match in pattern.finditer(content):
                path = match.group(1)
                line_start = content.rfind("\n", 0, match.start())
                line = content[line_start:match.end()]
                method = _extract_method(line)
                if add_api_file_entry(api_files, rel_path=rel, module=module, path=path, name="", method=method):
                    endpoint_count += 1
                    file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            **meta(ctx.root, "go_api_index_v1", source_files),
            "entry_schema": ["path", "name", "method"],
            "group_schema": ["file", "module", "entries"],
        },
        "files": finalize_api_files(api_files),
    }
    return ArtifactResult(
        name="api_index",
        file_name="API_INDEX.json",
        payload=payload,
        source_files=source_files,
        entity_count=endpoint_count,
    )


def build_route_index(ctx: BuildContext) -> ArtifactResult:
    routes: dict = {}
    source_files: set[Path] = set()

    for fp in _go_files(ctx.root):
        if "_test.go" in fp.name:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        all_patterns = [NET_HTTP_HANDLE, GIN_ROUTE, CHI_ROUTE, ECHO_ROUTE, FIBER_ROUTE]
        for pattern in all_patterns:
            for match in pattern.finditer(content):
                path = match.group(1)
                line_no = content.count("\n", 0, match.start()) + 1
                line_start = content.rfind("\n", 0, match.start())
                line = content[line_start:match.end()]
                method = _extract_method(line)
                route_key = f"{method}:{path}"
                routes[route_key] = {
                    "path": path,
                    "kind": "api_handler",
                    "source": [{"file": rel, "line": line_no}],
                    "usage_count": 1,
                    "navigated_from": [],
                }
                file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            "schema_version": SCHEMA_VERSION,
            "generated_at": timestamp(),
            "extractor": "go_route_index_v1",
            "entry_schema": ["path", "screen", "usage_count", "aliases", "navigated_from"],
            "group_schema": ["file", "entries"],
        },
        "files": finalize_route_files(routes),
    }
    return ArtifactResult(
        name="route_index",
        file_name="ROUTE_INDEX.json",
        payload=payload,
        source_files=source_files,
        entity_count=len(routes),
    )


def build_config_index(ctx: BuildContext) -> ArtifactResult:
    keys: dict = {}
    source_files: set[Path] = set()

    for fp in _go_files(ctx.root):
        if "_test.go" in fp.name:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        for line_no, key in match_with_lines(content, GO_GETENV, value_group=1):
            entry = keys.setdefault(key, {
                "name": key, "types": set(), "references": [],
                "extractor": "go_os_getenv_v1", "confidence": 0.95,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for line_no, key in match_with_lines(content, GO_LOOKUP_ENV, value_group=1):
            entry = keys.setdefault(key, {
                "name": key, "types": set(), "references": [],
                "extractor": "go_os_lookupenv_v1", "confidence": 0.95,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for line_no, key in match_with_lines(content, VIPER_GET, value_group=1):
            entry = keys.setdefault(key, {
                "name": key, "types": set(), "references": [],
                "extractor": "go_viper_v1", "confidence": 0.9,
            })
            entry["types"].add("viper_config")
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for struct_match in GO_STRUCT.finditer(content):
            struct_name = struct_match.group(1)
            if struct_name[0].isupper():
                line_no = content.count("\n", 0, struct_match.start()) + 1
                entry = keys.setdefault(f"struct:{struct_name}", {
                    "name": f"struct:{struct_name}", "types": {"go_struct"}, "references": [],
                    "extractor": "go_struct_v1", "confidence": 0.85,
                })
                entry["references"].append({"file": rel, "line": line_no})
                file_has = True

        if file_has:
            source_files.add(fp)

    go_mod = ctx.root / "go.mod"
    if go_mod.exists():
        content = go_mod.read_text(errors="ignore")
        dep_pattern = re.compile(r"^\t([^\s]+)\s+v", re.MULTILINE)
        for line_no, dep in match_with_lines(content, dep_pattern, value_group=1):
            entry = keys.setdefault(f"dep:{dep}", {
                "name": f"dep:{dep}", "types": {"go_dependency"}, "references": [],
                "extractor": "go_mod_deps_v1", "confidence": 1.0,
            })
            entry["references"].append({"file": "go.mod", "line": line_no})
        source_files.add(go_mod)

    for env_name in (".env", ".env.example", ".env.local"):
        env_path = ctx.root / env_name
        if not env_path.exists():
            continue
        try:
            content = env_path.read_text(errors="ignore")
        except OSError:
            continue
        for line_no, line in enumerate(content.splitlines(), start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key = line.split("=", 1)[0].strip()
            if not key or not key.replace("_", "").isalnum():
                continue
            entry = keys.setdefault(key, {
                "name": key, "types": set(), "references": [],
                "extractor": "dotenv_file_v1", "confidence": 0.85,
            })
            entry["references"].append({"file": env_name, "line": line_no})
        source_files.add(env_path)

    payload = {
        "_meta": meta(ctx.root, "go_config_index_v1", source_files),
        "config_keys": [
            {
                "name": item["name"],
                "types": sorted(item["types"]) if item["types"] else ["unknown"],
                "references": item["references"],
                "source": item["references"],
                "extractor": item["extractor"],
                "confidence": item["confidence"],
            }
            for item in sorted(keys.values(), key=lambda v: v["name"])
        ],
    }
    return ArtifactResult(
        name="config_index",
        file_name="CONFIG_INDEX.json",
        payload=payload,
        source_files=source_files,
        entity_count=len(keys),
    )


GO_PLUGIN = GoPlugin()
