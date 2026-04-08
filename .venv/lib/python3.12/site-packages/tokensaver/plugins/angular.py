"""Angular plugin — RouterModule, HttpClient, environment.ts.

Extracts Angular route definitions, HttpClient API calls,
environment.ts config, @Component/@Injectable decorators,
and angular.json project settings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from tokensaver import SCHEMA_VERSION
from tokensaver.core.helpers import (
    ENV_PATTERNS,
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

TS_EXTS = {".ts", ".tsx"}

ANGULAR_ROUTE_PATH = re.compile(
    r"\{\s*path\s*:\s*['\"]([^'\"]*)['\"]"
)
ANGULAR_ROUTER_LINK = re.compile(
    r"routerLink=['\"\[]+'?([^'\"]+?)'?\s*['\"\]]"
)
ANGULAR_NAVIGATE = re.compile(
    r"router\.navigate(?:ByUrl)?\(\s*\[?\s*['\"]([^'\"]+)['\"]"
)
HTTP_METHOD_CALL = re.compile(
    r"\.(?:http|httpClient)\.(get|post|put|delete|patch|head|options)\s*[<(]\s*.*?['\"]([^'\"]+)['\"]",
    re.DOTALL,
)
HTTP_URL_TEMPLATE = re.compile(
    r"(?:apiUrl|baseUrl|API_URL|BASE_URL)\s*(?:\+\s*)?[`'\"]([^`'\"]+)[`'\"]"
)
ENVIRONMENT_KEY = re.compile(
    r"environment\.(\w+)"
)
ENVIRONMENT_FILE_KEY = re.compile(
    r"^\s*(\w+)\s*:", re.MULTILINE
)
COMPONENT_DECORATOR = re.compile(
    r"@Component\(\s*\{[^}]*selector\s*:\s*['\"]([^'\"]+)['\"]",
    re.DOTALL,
)
INJECTABLE_DECORATOR = re.compile(
    r"@Injectable\(\s*\{[^}]*providedIn\s*:\s*['\"]([^'\"]+)['\"]",
    re.DOTALL,
)


@dataclass(frozen=True)
class AngularPlugin:
    name: str = "angular"
    frameworks: set[str] = frozenset({"angular"})

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
        if "test" in fp.parts or fp.suffix not in TS_EXTS:
            continue
        if fp.name.endswith(".spec.ts"):
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, fp)
        file_has = False

        for _, method, url in match_with_lines(content, HTTP_METHOD_CALL, method_group=1, path_group=2):
            cleaned = clean_url(url)
            if cleaned:
                if add_api_file_entry(api_files, rel_path=rel, module=module, path=cleaned, name="", method=method.upper()):
                    endpoint_count += 1
                    file_has = True

        for _, url in match_with_lines(content, HTTP_URL_TEMPLATE, value_group=1):
            cleaned = clean_url(url)
            if cleaned:
                if add_api_file_entry(api_files, rel_path=rel, module=module, path=cleaned, name="template", method="URL"):
                    endpoint_count += 1
                    file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            **meta(ctx.root, "angular_api_index_v1", source_files),
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
        if fp.suffix not in TS_EXTS:
            continue
        if fp.name.endswith(".spec.ts"):
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        for line_no, route_path in match_with_lines(content, ANGULAR_ROUTE_PATH, value_group=1):
            full_path = f"/{route_path}" if route_path and not route_path.startswith("/") else route_path or "/"
            routes[full_path] = {
                "path": full_path, "kind": "angular_route",
                "source": [{"file": rel, "line": line_no}],
                "usage_count": 1, "navigated_from": [],
            }
            file_has = True

        for _, target in match_with_lines(content, ANGULAR_NAVIGATE, value_group=1):
            if target.startswith("/"):
                entry = routes.setdefault(target, {
                    "path": target, "kind": "angular_route",
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
            "extractor": "angular_route_index_v1",
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
        if "test" in fp.parts or fp.suffix not in TS_EXTS:
            continue
        if fp.name.endswith(".spec.ts"):
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        for extractor, pattern in ENV_PATTERNS:
            for line_no, key in match_with_lines(content, pattern, value_group=1):
                entry = keys.setdefault(key, {
                    "name": key, "types": set(), "references": [],
                    "extractor": extractor, "confidence": 0.95,
                })
                entry["references"].append({"file": rel, "line": line_no})
                file_has = True

        for line_no, key in match_with_lines(content, ENVIRONMENT_KEY, value_group=1):
            if key in ("production", "ts", "development"):
                continue
            entry = keys.setdefault(f"environment.{key}", {
                "name": f"environment.{key}", "types": {"angular_environment"}, "references": [],
                "extractor": "angular_environment_v1", "confidence": 0.9,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        if file_has:
            source_files.add(fp)

    for env_name in (
        "src/environments/environment.ts",
        "src/environments/environment.prod.ts",
        "src/environments/environment.development.ts",
    ):
        env_path = ctx.root / env_name
        if not env_path.exists():
            continue
        content = env_path.read_text(errors="ignore")
        for line_no, key in match_with_lines(content, ENVIRONMENT_FILE_KEY, value_group=1):
            if key in ("export", "const", "production", "import"):
                continue
            entry = keys.setdefault(f"environment.{key}", {
                "name": f"environment.{key}", "types": {"angular_environment"}, "references": [],
                "extractor": "angular_environment_file_v1", "confidence": 0.98,
            })
            entry["references"].append({"file": env_name, "line": line_no})
        source_files.add(env_path)

    payload = {
        "_meta": meta(ctx.root, "angular_config_index_v1", source_files),
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


ANGULAR_PLUGIN = AngularPlugin()
