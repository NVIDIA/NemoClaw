"""React (web) plugin — React Router, APIs, components.

Extracts React Router routes (v5 + v6), fetch/axios API calls,
process.env config, and component/hook structure.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from tokensaver import SCHEMA_VERSION
from tokensaver.core.helpers import (
    AXIOS_BASE_URL_PATTERN,
    AXIOS_CREATE_PATTERN,
    AXIOS_METHOD_PATTERN,
    ENV_PATTERNS,
    FETCH_CALL_PATTERN,
    add_api_file_entry,
    all_code_files,
    build_module_graph_artifact,
    clean_url,
    finalize_api_files,
    finalize_route_files,
    match_with_lines,
    meta,
    module_name_for_file,
    strip_quotes,
    timestamp,
)
from tokensaver.core.models import ArtifactResult, BuildContext

JS_EXTS = {".js", ".jsx", ".ts", ".tsx"}

REACT_ROUTE_V5 = re.compile(r'<Route[^>]+path=[\'"]([^\'"]+)[\'"]')
REACT_ROUTE_V6 = re.compile(r'\{\s*path\s*:\s*[\'"]([^\'"]+)[\'"]')
REACT_LINK = re.compile(r'<(?:Link|NavLink)[^>]+to=[\'"]([^\'"]+)[\'"]')
NAVIGATE_CALL = re.compile(r'navigate\(\s*[\'"]([^\'"]+)[\'"]')
LAZY_IMPORT = re.compile(r'(?:React\.)?lazy\(\s*\(\)\s*=>\s*import\(\s*[\'"]([^\'"]+)[\'"]')
USE_HOOK = re.compile(r'export\s+(?:const|function)\s+(use[A-Z]\w+)')


@dataclass(frozen=True)
class ReactWebPlugin:
    name: str = "react_web"
    frameworks: set[str] = frozenset({"react"})

    def build_artifacts(self, ctx: BuildContext) -> list[ArtifactResult]:
        return [
            build_module_graph(ctx),
            build_api_index(ctx),
            build_route_index(ctx),
            build_config_index(ctx),
        ]


def build_module_graph(ctx: BuildContext) -> ArtifactResult:
    return build_module_graph_artifact(ctx.root, ctx.scan.framework, ArtifactResult)


def build_api_index(ctx: BuildContext) -> ArtifactResult:
    api_files: dict = {}
    source_files: set[Path] = set()
    endpoint_count = 0

    for fp in all_code_files(ctx.root):
        if "test" in fp.parts or fp.suffix not in JS_EXTS:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, fp)
        file_has = False

        for _, method, path in match_with_lines(content, AXIOS_METHOD_PATTERN, method_group=1, path_group=2):
            cleaned = clean_url(path)
            if cleaned:
                if add_api_file_entry(api_files, rel_path=rel, module=module, path=cleaned, name="", method=method.upper()):
                    endpoint_count += 1
                    file_has = True

        for _, raw_url in match_with_lines(content, FETCH_CALL_PATTERN, value_group=1):
            cleaned = clean_url(strip_quotes(raw_url))
            if cleaned:
                if add_api_file_entry(api_files, rel_path=rel, module=module, path=cleaned, name="", method="FETCH"):
                    endpoint_count += 1
                    file_has = True

        for match in AXIOS_CREATE_PATTERN.finditer(content):
            body = match.group(2)
            base_match = AXIOS_BASE_URL_PATTERN.search(body)
            if base_match:
                raw_base = base_match.group(1).strip()
                base_path = clean_url(strip_quotes(raw_base)) if raw_base.startswith(("'", '"')) else "<dynamic>"
                if add_api_file_entry(api_files, rel_path=rel, module=module, path=base_path or "<root>", name=f"{match.group(1)}:baseURL", method="BASE"):
                    endpoint_count += 1
                    file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            **meta(ctx.root, "react_web_api_index_v1", source_files),
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

    for fp in all_code_files(ctx.root):
        if fp.suffix not in JS_EXTS:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        for line_no, route_path in match_with_lines(content, REACT_ROUTE_V5, value_group=1):
            routes[route_path] = {
                "path": route_path, "kind": "react_route",
                "source": [{"file": rel, "line": line_no}],
                "usage_count": 1, "navigated_from": [],
            }
            file_has = True

        for line_no, route_path in match_with_lines(content, REACT_ROUTE_V6, value_group=1):
            if route_path not in routes:
                routes[route_path] = {
                    "path": route_path, "kind": "react_route",
                    "source": [{"file": rel, "line": line_no}],
                    "usage_count": 1, "navigated_from": [],
                }
                file_has = True

        for _, target in match_with_lines(content, REACT_LINK, value_group=1):
            if target.startswith("/"):
                entry = routes.setdefault(target, {
                    "path": target, "kind": "react_route",
                    "source": [{"file": rel}], "usage_count": 0, "navigated_from": [],
                })
                entry["usage_count"] += 1
                file_has = True

        for _, target in match_with_lines(content, NAVIGATE_CALL, value_group=1):
            if target.startswith("/"):
                entry = routes.setdefault(target, {
                    "path": target, "kind": "react_route",
                    "source": [{"file": rel}], "usage_count": 0, "navigated_from": [],
                })
                entry["usage_count"] += 1
                file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            "schema_version": SCHEMA_VERSION,
            "generated_at": timestamp(),
            "extractor": "react_web_route_index_v1",
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

    for fp in all_code_files(ctx.root):
        if "test" in fp.parts or fp.suffix not in JS_EXTS:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        for extractor, pattern in ENV_PATTERNS:
            for line_no, key in match_with_lines(content, pattern, value_group=1):
                is_public = key.startswith("REACT_APP_")
                entry = keys.setdefault(key, {
                    "name": key, "types": set(), "references": [],
                    "extractor": extractor, "confidence": 0.95,
                })
                if is_public:
                    entry["types"].add("public")
                entry["references"].append({"file": rel, "line": line_no})
                file_has = True

        if file_has:
            source_files.add(fp)

    for env_name in (".env", ".env.local", ".env.development", ".env.production", ".env.example"):
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
                "extractor": "react_env_v1",
                "confidence": 0.95 if key.startswith("REACT_APP_") else 0.85,
            })
            entry["references"].append({"file": env_name, "line": line_no})
        source_files.add(env_path)

    payload = {
        "_meta": meta(ctx.root, "react_web_config_index_v1", source_files),
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


REACT_WEB_PLUGIN = ReactWebPlugin()
