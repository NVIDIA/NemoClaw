"""React Native-specific TokenSaver plugin."""

from __future__ import annotations

import re
from dataclasses import dataclass

from tokensaver import SCHEMA_VERSION
from tokensaver.core.helpers import (
    AXIOS_BASE_URL_PATTERN,
    AXIOS_CREATE_PATTERN,
    AXIOS_METHOD_PATTERN,
    ENV_PATTERNS,
    FETCH_CALL_PATTERN,
    RN_CONFIG_IMPORT_PATTERN,
    RN_NAVIGATE_PATTERN,
    RN_STACK_SCREEN_PATTERN,
    TS_ENUM_BLOCK_PATTERN,
    TS_ENUM_ENTRY_PATTERN,
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

JS_CODE_SUFFIXES = {".js", ".jsx", ".ts", ".tsx"}


@dataclass(frozen=True)
class ReactNativePlugin:
    name: str = "react_native"
    frameworks: set[str] = frozenset({"react_native"})

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
    api_files = {}
    source_files = set()
    endpoint_count = 0

    for file_path in all_code_files(ctx.root):
        if "test" in file_path.parts or file_path.suffix not in JS_CODE_SUFFIXES:
            continue
        content = file_path.read_text(errors="ignore")
        rel_path = str(file_path.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, file_path)
        file_has_endpoint = False

        for line_no, method, path in match_with_lines(
            content,
            AXIOS_METHOD_PATTERN,
            method_group=1,
            path_group=2,
        ):
            cleaned_path = clean_url(path)
            if not cleaned_path:
                continue
            if add_api_file_entry(
                api_files,
                rel_path=rel_path,
                module=module,
                path=cleaned_path,
                name=f"line:{line_no}",
                method=method.upper(),
            ):
                endpoint_count += 1
                file_has_endpoint = True

        for line_no, raw_url in match_with_lines(content, FETCH_CALL_PATTERN, value_group=1):
            cleaned_path = clean_url(strip_quotes(raw_url))
            if not cleaned_path:
                continue
            if add_api_file_entry(
                api_files,
                rel_path=rel_path,
                module=module,
                path=cleaned_path,
                name=f"fetch:{line_no}",
                method="FETCH",
            ):
                endpoint_count += 1
                file_has_endpoint = True

        for match in AXIOS_CREATE_PATTERN.finditer(content):
            body = match.group(2)
            base_url_match = AXIOS_BASE_URL_PATTERN.search(body)
            if not base_url_match:
                continue
            raw_base = base_url_match.group(1).strip()
            if raw_base.startswith(("'", '"')):
                base_path = clean_url(strip_quotes(raw_base))
            else:
                base_path = "<dynamic>"
            if add_api_file_entry(
                api_files,
                rel_path=rel_path,
                module=module,
                path=base_path or "<root>",
                name=f"{match.group(1)}:baseURL",
                method="BASE",
            ):
                endpoint_count += 1
                file_has_endpoint = True

        if file_has_endpoint:
            source_files.add(file_path)

    payload = {
        "_meta": {
            **meta(ctx.root, "react_native_api_index_v1", source_files),
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
    routes = {}
    route_defs = _collect_route_defs(ctx)
    source_files = {
        ctx.root / rel_path
        for _, rel_path, _, _ in route_defs.values()
        if (ctx.root / rel_path).exists()
    }

    for file_path in all_code_files(ctx.root):
        if "test" in file_path.parts or file_path.suffix not in JS_CODE_SUFFIXES:
            continue
        content = file_path.read_text(errors="ignore")
        rel_path = str(file_path.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, file_path)
        file_has_routes = False

        for match in RN_STACK_SCREEN_PATTERN.finditer(content):
            line_no = content.count("\n", 0, match.start()) + 1
            route_expr = match.group(1).strip()
            screen = (match.group(2) or "").strip()
            route_name = _resolve_route_name(route_expr, route_defs)
            if not route_name:
                continue
            route_entry = routes.setdefault(
                route_name,
                {
                    "path": route_name,
                    "kind": "ui_route",
                    "aliases": [],
                    "source": [{"file": rel_path, "line": line_no}],
                    "usage_count": 0,
                    "navigated_from": [],
                },
            )
            route_entry.setdefault("aliases", [])
            route_entry.setdefault("navigated_from", [])
            if route_expr not in route_entry["aliases"]:
                route_entry["aliases"].append(route_expr)
            if screen and not route_entry.get("screen"):
                route_entry["screen"] = screen
            file_has_routes = True

        usage_paths = set()
        for _, route_expr in match_with_lines(content, RN_NAVIGATE_PATTERN, value_group=1):
            route_name = _resolve_route_name(route_expr, route_defs)
            if route_name:
                usage_paths.add(route_name)

        for route_name in usage_paths:
            route_entry = routes.setdefault(
                route_name,
                {
                    "path": route_name,
                    "kind": "ui_route",
                    "aliases": [],
                    "source": [{"file": rel_path}],
                    "usage_count": 0,
                    "navigated_from": [],
                },
            )
            route_entry.setdefault("aliases", [])
            route_entry.setdefault("navigated_from", [])
            route_entry["usage_count"] += 1
            if module not in route_entry["navigated_from"]:
                route_entry["navigated_from"].append(module)
            file_has_routes = True

        if file_has_routes:
            source_files.add(file_path)

    payload = {
        "_meta": {
            "schema_version": SCHEMA_VERSION,
            "generated_at": timestamp(),
            "extractor": "react_native_route_index_v1",
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
    keys = {}
    source_files = set()

    for file_path in all_code_files(ctx.root):
        if "test" in file_path.parts or file_path.suffix not in JS_CODE_SUFFIXES:
            continue
        content = file_path.read_text(errors="ignore")
        rel_path = str(file_path.relative_to(ctx.root))
        file_has_keys = False

        for extractor, pattern in ENV_PATTERNS:
            for line_no, key in match_with_lines(content, pattern, value_group=1):
                entry = keys.setdefault(
                    key,
                    {
                        "name": key,
                        "types": set(),
                        "references": [],
                        "extractor": extractor,
                        "confidence": 0.95,
                    },
                )
                entry["references"].append({"file": rel_path, "line": line_no})
                file_has_keys = True

        import_aliases = {match.group(1) for match in RN_CONFIG_IMPORT_PATTERN.finditer(content)}
        if import_aliases:
            for alias in import_aliases:
                pattern = re.compile(rf"\b{alias}\.([A-Z0-9_]+)\b")
                for line_no, key in match_with_lines(content, pattern, value_group=1):
                    entry = keys.setdefault(
                        key,
                        {
                            "name": key,
                            "types": set(),
                            "references": [],
                            "extractor": "react_native_config_v1",
                            "confidence": 0.98,
                        },
                    )
                    entry["references"].append({"file": rel_path, "line": line_no})
                    file_has_keys = True

        if file_has_keys:
            source_files.add(file_path)

    payload = {
        "_meta": meta(ctx.root, "react_native_config_index_v1", source_files),
        "config_keys": [
            {
                "name": item["name"],
                "types": sorted(item["types"]) if item["types"] else ["unknown"],
                "references": item["references"],
                "source": item["references"],
                "extractor": item["extractor"],
                "confidence": item["confidence"],
            }
            for item in sorted(keys.values(), key=lambda value: value["name"])
        ],
    }
    return ArtifactResult(
        name="config_index",
        file_name="CONFIG_INDEX.json",
        payload=payload,
        source_files=source_files,
        entity_count=len(keys),
    )


def _collect_route_defs(ctx: BuildContext) -> dict[str, tuple[str, str, int, str]]:
    route_defs = {}

    for file_path in all_code_files(ctx.root):
        if "test" in file_path.parts or file_path.suffix not in JS_CODE_SUFFIXES:
            continue
        content = file_path.read_text(errors="ignore")
        rel_path = str(file_path.relative_to(ctx.root))

        for enum_match in TS_ENUM_BLOCK_PATTERN.finditer(content):
            enum_name = enum_match.group(1)
            body = enum_match.group(2)
            for entry_match in TS_ENUM_ENTRY_PATTERN.finditer(body):
                member_name = entry_match.group(1)
                route_value = entry_match.group(2)
                line_no = content.count("\n", 0, enum_match.start()) + body[:entry_match.start()].count("\n") + 1
                route_defs[f"{enum_name}.{member_name}"] = (route_value, rel_path, line_no, member_name)

    return route_defs


def _resolve_route_name(route_expr: str, route_defs: dict[str, tuple[str, str, int, str]]) -> str | None:
    expr = route_expr.strip()
    if not expr:
        return None
    if expr in route_defs:
        return route_defs[expr][0]
    literal = strip_quotes(expr)
    return literal or None


REACT_NATIVE_PLUGIN = ReactNativePlugin()
