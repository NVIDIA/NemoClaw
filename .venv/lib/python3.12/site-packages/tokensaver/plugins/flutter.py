"""Flutter-specific TokenSaver plugin."""

from __future__ import annotations

from dataclasses import dataclass

from tokensaver import SCHEMA_VERSION
from tokensaver.core.helpers import (
    DART_NAMED_URL_PATTERN,
    DART_RC_CALL_PATTERN,
    DART_URL_ASSIGN_PATTERN,
    GETX_ROUTE_BINDING,
    GETX_ROUTE_CONST,
    GET_NAMED_EXPR,
    ROUTE_TO_EXPR,
    add_api_file_entry,
    all_code_files,
    build_module_graph_artifact,
    clean_url,
    extract_dart_map_block,
    extract_top_level_map_entries,
    finalize_api_files,
    finalize_route_files,
    match_with_lines,
    meta,
    module_name_for_file,
    remote_config_type_from_getter,
    resolve_flutter_route_expression,
    should_include_api_reference,
    timestamp,
)
from tokensaver.core.models import ArtifactResult, BuildContext


@dataclass(frozen=True)
class FlutterPlugin:
    name: str = "flutter"
    frameworks: set[str] = frozenset({"flutter"})

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
        if "test" in file_path.parts or file_path.suffix != ".dart":
            continue
        content = file_path.read_text(errors="ignore")
        rel_path = str(file_path.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, file_path)
        file_has_endpoint = False

        for _, name, url in match_with_lines(content, DART_URL_ASSIGN_PATTERN, value_group=1, second_group=2):
            cleaned_url = clean_url(url)
            if not should_include_api_reference(cleaned_url, url, name, rel_path):
                continue
            if add_api_file_entry(
                api_files,
                rel_path=rel_path,
                module=module,
                path=cleaned_url,
                name=name or "",
                method="",
            ):
                endpoint_count += 1
                file_has_endpoint = True
        for _, url in match_with_lines(content, DART_NAMED_URL_PATTERN, value_group=1):
            cleaned_url = clean_url(url)
            if not should_include_api_reference(cleaned_url, url, None, rel_path):
                continue
            if add_api_file_entry(
                api_files,
                rel_path=rel_path,
                module=module,
                path=cleaned_url,
                name="",
                method="",
            ):
                endpoint_count += 1
                file_has_endpoint = True
        if file_has_endpoint:
            source_files.add(file_path)

    payload = {
        "_meta": {
            **meta(ctx.root, "api_index_v1", source_files),
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
    route_defs = {}
    source_files = set()

    for file_path in all_code_files(ctx.root):
        if "test" in file_path.parts or file_path.suffix != ".dart":
            continue
        content = file_path.read_text(errors="ignore")
        rel_path = str(file_path.relative_to(ctx.root))
        file_has_routes = False

        if "AppRoutes" in content or file_path.name.endswith("app_routes.dart"):
            for line_no, name, route_path in match_with_lines(
                content,
                GETX_ROUTE_CONST,
                value_group=1,
                second_group=2,
            ):
                route_defs[name] = route_path
                route_entry = routes.setdefault(
                    route_path,
                    {
                        "path": route_path,
                        "kind": "ui_route",
                        "aliases": [],
                        "source": [{"file": rel_path, "line": line_no}],
                        "usage_count": 0,
                        "navigated_from": [],
                    },
                )
                if name not in route_entry["aliases"]:
                    route_entry["aliases"].append(name)
                file_has_routes = True

            for line_no, route_name, screen in match_with_lines(
                content,
                GETX_ROUTE_BINDING,
                value_group=1,
                second_group=2,
            ):
                route_path = route_defs.get(route_name, f"/{route_name}")
                route_entry = routes.setdefault(
                    route_path,
                    {
                        "path": route_path,
                        "kind": "ui_route",
                        "aliases": [route_name],
                        "source": [{"file": rel_path, "line": line_no}],
                        "usage_count": 0,
                        "navigated_from": [],
                    },
                )
                route_entry["screen"] = screen
                if route_name not in route_entry.get("aliases", []):
                    route_entry.setdefault("aliases", []).append(route_name)
                file_has_routes = True

        usage_paths = set()
        for _, expression in match_with_lines(content, GET_NAMED_EXPR, value_group=1):
            resolved = resolve_flutter_route_expression(expression.strip(), route_defs)
            if resolved:
                usage_paths.add(resolved)
        for _, parent_expr, sub_expr in match_with_lines(
            content,
            ROUTE_TO_EXPR,
            value_group=1,
            second_group=2,
        ):
            resolved = resolve_flutter_route_expression(parent_expr, route_defs)
            if sub_expr:
                sub_path = resolve_flutter_route_expression(sub_expr, route_defs)
                if resolved and sub_path:
                    resolved = f"{resolved}{sub_path}"
            if resolved:
                usage_paths.add(resolved)

        if usage_paths:
            module = file_path.relative_to(ctx.root / "lib").parts[0] if (ctx.root / "lib") in file_path.parents else "root"
            for route_path in usage_paths:
                route_entry = routes.setdefault(
                    route_path,
                    {
                        "path": route_path,
                        "kind": "ui_route",
                        "source": [{"file": rel_path}],
                        "usage_count": 0,
                        "navigated_from": [],
                    },
                )
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
            "extractor": "route_index_v1",
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
        if file_path.suffix != ".dart":
            continue
        content = file_path.read_text(errors="ignore")
        rel_path = str(file_path.relative_to(ctx.root))
        file_has_keys = False

        if file_path.name == "remote_config_service.dart":
            defaults_block = extract_dart_map_block(content, "_defaults =")
            if defaults_block:
                for key, value_type in extract_top_level_map_entries(defaults_block):
                    entry = keys.setdefault(
                        key,
                        {
                            "name": key,
                            "types": set(),
                            "references": [],
                            "extractor": "flutter_remote_defaults_v1",
                            "confidence": 0.95,
                        },
                    )
                    entry["types"].add(value_type)
                    entry["references"].append({"file": rel_path})
                    file_has_keys = True

        for line_no, getter_name, key in match_with_lines(
            content,
            DART_RC_CALL_PATTERN,
            value_group=1,
            second_group=2,
        ):
            entry = keys.setdefault(
                key,
                {
                    "name": key,
                    "types": set(),
                    "references": [],
                    "extractor": "flutter_remote_usage_v1",
                    "confidence": 0.9,
                },
            )
            entry["types"].add(remote_config_type_from_getter(getter_name))
            entry["references"].append({"file": rel_path, "line": line_no})
            file_has_keys = True

        if file_has_keys:
            source_files.add(file_path)

    payload = {
        "_meta": meta(ctx.root, "config_index_v1", source_files),
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


FLUTTER_PLUGIN = FlutterPlugin()
