"""Android Native plugin — Kotlin, Java, Jetpack Compose.

Extracts Activities, Fragments, Composable screens, Jetpack Navigation
routes, Retrofit/Ktor API definitions, BuildConfig references,
Hilt/Dagger modules, and resource config (strings.xml, build.gradle).
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

ANDROID_EXTS = {".kt", ".java"}

RETROFIT_ANNOTATION = re.compile(
    r"@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\(\s*['\"]([^'\"]+)['\"]"
)
KTOR_ROUTE = re.compile(
    r"(?:get|post|put|delete|patch)\(\s*['\"]([^'\"]+)['\"]"
)
RETROFIT_BASE_URL = re.compile(
    r"(?:BASE_URL|baseUrl|base_url)\s*=\s*['\"]([^'\"]+)['\"]"
)
NAV_COMPOSABLE = re.compile(
    r"composable\(\s*(?:route\s*=\s*)?['\"]([^'\"]+)['\"]"
)
NAV_NAVIGATE = re.compile(
    r"navigate\(\s*['\"]([^'\"]+)['\"]"
)
NAV_DEEP_LINK = re.compile(
    r"deepLinks\s*=.*?uriPattern\s*=\s*['\"]([^'\"]+)['\"]", re.DOTALL
)
ACTIVITY_CLASS = re.compile(
    r"class\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*(?:AppCompat)?Activity\s*\("
)
FRAGMENT_CLASS = re.compile(
    r"class\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*Fragment\s*\("
)
COMPOSABLE_FN = re.compile(
    r"@Composable\s+(?:fun\s+)?(\w+)"
)
INTENT_ACTION = re.compile(
    r"Intent\(\s*[^,]*,\s*(\w+)::class"
)
BUILDCONFIG_REF = re.compile(
    r"BuildConfig\.([A-Z][A-Z0-9_]+)"
)
BUILD_CONFIG_FIELD = re.compile(
    r'buildConfigField\s*\(\s*["\'](\w+)["\']\s*,\s*["\'](\w+)["\']'
)
HILT_MODULE = re.compile(r"@Module\b")
HILT_INJECT = re.compile(r"@Inject\b")
DAGGER_COMPONENT = re.compile(r"@Component\b")
STRING_RES = re.compile(r'<string\s+name="([^"]+)"')
GRADLE_DEPENDENCY = re.compile(
    r"(?:implementation|api|kapt|ksp)\s*[\(]?\s*['\"]([^'\"]+)['\"]"
)


@dataclass(frozen=True)
class AndroidNativePlugin:
    name: str = "android_native"
    frameworks: set[str] = frozenset({"android_native"})

    def build_artifacts(self, ctx: BuildContext) -> list[ArtifactResult]:
        return [
            build_module_graph(ctx),
            build_api_index(ctx),
            build_route_index(ctx),
            build_config_index(ctx),
        ]


def _android_code_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in ANDROID_EXTS:
            continue
        if ".git" in path.parts:
            continue
        if any(p in ("build", ".gradle", "node_modules") for p in path.parts):
            continue
        yield path


def build_module_graph(ctx: BuildContext) -> ArtifactResult:
    return build_module_graph_artifact(ctx.root, ctx.scan.framework, ArtifactResult)


def build_api_index(ctx: BuildContext) -> ArtifactResult:
    api_files: dict = {}
    source_files: set[Path] = set()
    endpoint_count = 0

    for fp in _android_code_files(ctx.root):
        if "test" in fp.parts or "androidTest" in fp.parts:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, fp)
        file_has = False

        for _, method, path in match_with_lines(content, RETROFIT_ANNOTATION, method_group=1, path_group=2):
            if add_api_file_entry(api_files, rel_path=rel, module=module, path=path, name="", method=method):
                endpoint_count += 1
                file_has = True

        for _, path in match_with_lines(content, KTOR_ROUTE, value_group=1):
            if add_api_file_entry(api_files, rel_path=rel, module=module, path=path, name="", method="ALL"):
                endpoint_count += 1
                file_has = True

        for _, base_url in match_with_lines(content, RETROFIT_BASE_URL, value_group=1):
            if add_api_file_entry(api_files, rel_path=rel, module=module, path=base_url, name="baseUrl", method="BASE"):
                endpoint_count += 1
                file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            **meta(ctx.root, "android_native_api_index_v1", source_files),
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

    for fp in _android_code_files(ctx.root):
        if "test" in fp.parts or "androidTest" in fp.parts:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        for line_no, route in match_with_lines(content, NAV_COMPOSABLE, value_group=1):
            routes[route] = {
                "path": route,
                "kind": "composable_route",
                "source": [{"file": rel, "line": line_no}],
                "usage_count": 0,
                "navigated_from": [],
            }
            file_has = True

        for _, route in match_with_lines(content, NAV_NAVIGATE, value_group=1):
            entry = routes.setdefault(route, {
                "path": route, "kind": "composable_route",
                "source": [{"file": rel}], "usage_count": 0, "navigated_from": [],
            })
            entry["usage_count"] += 1
            file_has = True

        for activity_match in ACTIVITY_CLASS.finditer(content):
            name = activity_match.group(1)
            line_no = content.count("\n", 0, activity_match.start()) + 1
            routes[f"activity:{name}"] = {
                "path": f"activity:{name}",
                "kind": "activity",
                "source": [{"file": rel, "line": line_no}],
                "usage_count": 0,
                "navigated_from": [],
                "screen": name,
            }
            file_has = True

        for frag_match in FRAGMENT_CLASS.finditer(content):
            name = frag_match.group(1)
            line_no = content.count("\n", 0, frag_match.start()) + 1
            routes[f"fragment:{name}"] = {
                "path": f"fragment:{name}",
                "kind": "fragment",
                "source": [{"file": rel, "line": line_no}],
                "usage_count": 0,
                "navigated_from": [],
                "screen": name,
            }
            file_has = True

        for intent_match in INTENT_ACTION.finditer(content):
            target = intent_match.group(1)
            line_no = content.count("\n", 0, intent_match.start()) + 1
            entry = routes.setdefault(f"activity:{target}", {
                "path": f"activity:{target}", "kind": "activity",
                "source": [{"file": rel, "line": line_no}], "usage_count": 0, "navigated_from": [],
            })
            entry["usage_count"] += 1
            file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            "schema_version": SCHEMA_VERSION,
            "generated_at": timestamp(),
            "extractor": "android_native_route_index_v1",
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

    for fp in _android_code_files(ctx.root):
        if "test" in fp.parts or "androidTest" in fp.parts:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        for line_no, key in match_with_lines(content, BUILDCONFIG_REF, value_group=1):
            entry = keys.setdefault(f"BuildConfig.{key}", {
                "name": f"BuildConfig.{key}", "types": {"build_config"}, "references": [],
                "extractor": "android_buildconfig_v1", "confidence": 0.95,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        if file_has:
            source_files.add(fp)

    for gradle_name in ("build.gradle.kts", "build.gradle", "app/build.gradle.kts", "app/build.gradle"):
        gradle = ctx.root / gradle_name
        if not gradle.exists():
            continue
        content = gradle.read_text(errors="ignore")
        rel = gradle_name

        for line_no, field_type, field_name in match_with_lines(content, BUILD_CONFIG_FIELD, method_group=1, path_group=2):
            entry = keys.setdefault(f"BuildConfig.{field_name}", {
                "name": f"BuildConfig.{field_name}", "types": {field_type.lower()}, "references": [],
                "extractor": "android_gradle_buildconfig_v1", "confidence": 0.98,
            })
            entry["references"].append({"file": rel, "line": line_no})

        for line_no, dep in match_with_lines(content, GRADLE_DEPENDENCY, value_group=1):
            short = dep.split(":")[-2] if ":" in dep else dep
            entry = keys.setdefault(f"dep:{short}", {
                "name": f"dep:{short}", "types": {"gradle_dependency"}, "references": [],
                "extractor": "android_gradle_dep_v1", "confidence": 1.0,
            })
            entry["references"].append({"file": rel, "line": line_no})

        source_files.add(gradle)

    for res_path in ctx.root.rglob("strings.xml"):
        if "build" in res_path.parts or ".gradle" in res_path.parts:
            continue
        content = res_path.read_text(errors="ignore")
        rel = str(res_path.relative_to(ctx.root))
        for line_no, name in match_with_lines(content, STRING_RES, value_group=1):
            entry = keys.setdefault(f"string:{name}", {
                "name": f"string:{name}", "types": {"string_resource"}, "references": [],
                "extractor": "android_strings_xml_v1", "confidence": 1.0,
            })
            entry["references"].append({"file": rel, "line": line_no})
        source_files.add(res_path)

    payload = {
        "_meta": meta(ctx.root, "android_native_config_index_v1", source_files),
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


ANDROID_NATIVE_PLUGIN = AndroidNativePlugin()
