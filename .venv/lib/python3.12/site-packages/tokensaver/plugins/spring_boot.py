"""Spring Boot / Java-specific TokenSaver plugin.

Extracts @RequestMapping/@GetMapping endpoints, @Entity models,
application.properties/yml config, and Gradle/Maven commands.
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

JAVA_EXTS = {".java", ".kt"}

CLASS_LEVEL_MAPPING = re.compile(
    r"@RequestMapping\(\s*(?:value\s*=\s*)?['\"]([^'\"]+)['\"]"
)
METHOD_MAPPING = re.compile(
    r"@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\("
    r"\s*(?:value\s*=\s*|path\s*=\s*)?['\"]([^'\"]+)['\"]"
)
METHOD_NO_PATH = re.compile(
    r"@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*$", re.MULTILINE
)
ENTITY_CLASS = re.compile(r"@Entity\b[^{]*class\s+(\w+)", re.DOTALL)
TABLE_ANNOTATION = re.compile(r'@Table\(\s*name\s*=\s*["\']([^"\']+)["\']')
JPA_REPOSITORY = re.compile(r"interface\s+(\w+)\s+extends\s+(?:JpaRepository|CrudRepository|PagingAndSortingRepository)")
COMPONENT_SCAN = re.compile(r"@(Service|Repository|Component|Controller|RestController|Configuration)\b")
SPRING_PROPERTY_USAGE = re.compile(r'@Value\(\s*["\']\$\{([^}]+)\}["\']')
PROPERTY_LINE = re.compile(r"^([a-z][a-z0-9._-]+)\s*=\s*(.*)$", re.MULTILINE)
YML_KEY = re.compile(r"^(\s*)([a-z][a-z0-9_-]+)\s*:", re.MULTILINE)


MAPPING_METHOD_MAP = {
    "GetMapping": "GET",
    "PostMapping": "POST",
    "PutMapping": "PUT",
    "DeleteMapping": "DELETE",
    "PatchMapping": "PATCH",
    "RequestMapping": "ALL",
}


@dataclass(frozen=True)
class SpringBootPlugin:
    name: str = "spring_boot"
    frameworks: set[str] = frozenset({"spring_boot"})

    def build_artifacts(self, ctx: BuildContext) -> list[ArtifactResult]:
        return [
            build_module_graph(ctx),
            build_api_index(ctx),
            build_route_index(ctx),
            build_config_index(ctx),
        ]


def _java_code_files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and path.suffix in JAVA_EXTS and ".git" not in path.parts:
            if any(part in ("build", "target", ".gradle", "node_modules") for part in path.parts):
                continue
            yield path


def build_module_graph(ctx: BuildContext) -> ArtifactResult:
    return build_module_graph_artifact(ctx.root, ctx.scan.framework, ArtifactResult)


def build_api_index(ctx: BuildContext) -> ArtifactResult:
    api_files: dict = {}
    source_files: set[Path] = set()
    endpoint_count = 0

    for fp in _java_code_files(ctx.root):
        if "test" in fp.parts:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, fp)

        class_path = ""
        class_match = CLASS_LEVEL_MAPPING.search(content)
        if class_match:
            class_path = class_match.group(1).rstrip("/")

        file_has = False
        for _, annotation, method_path in match_with_lines(content, METHOD_MAPPING, method_group=1, path_group=2):
            http_method = MAPPING_METHOD_MAP.get(annotation, "ALL")
            full_path = f"{class_path}/{method_path.lstrip('/')}" if class_path else f"/{method_path.lstrip('/')}"
            if add_api_file_entry(api_files, rel_path=rel, module=module, path=full_path, name="", method=http_method):
                endpoint_count += 1
                file_has = True

        for _, annotation in match_with_lines(content, METHOD_NO_PATH, value_group=1):
            http_method = MAPPING_METHOD_MAP.get(annotation, "ALL")
            path = class_path or "/"
            if add_api_file_entry(api_files, rel_path=rel, module=module, path=path, name="", method=http_method):
                endpoint_count += 1
                file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            **meta(ctx.root, "spring_boot_api_index_v1", source_files),
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

    for fp in _java_code_files(ctx.root):
        if "test" in fp.parts:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))

        class_path = ""
        class_match = CLASS_LEVEL_MAPPING.search(content)
        if class_match:
            class_path = class_match.group(1).rstrip("/")

        file_has = False
        for line_no, annotation, method_path in match_with_lines(content, METHOD_MAPPING, method_group=1, path_group=2):
            full_path = f"{class_path}/{method_path.lstrip('/')}" if class_path else f"/{method_path.lstrip('/')}"
            http_method = MAPPING_METHOD_MAP.get(annotation, "ALL")
            routes[f"{http_method}:{full_path}"] = {
                "path": full_path,
                "kind": "api_endpoint",
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
            "extractor": "spring_boot_route_index_v1",
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

    for fp in _java_code_files(ctx.root):
        if "test" in fp.parts:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        for line_no, key in match_with_lines(content, SPRING_PROPERTY_USAGE, value_group=1):
            clean_key = key.split(":")[0].strip()
            entry = keys.setdefault(clean_key, {
                "name": clean_key, "types": set(), "references": [],
                "extractor": "spring_value_annotation_v1", "confidence": 0.95,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for entity_match in ENTITY_CLASS.finditer(content):
            entity_name = entity_match.group(1)
            line_no = content.count("\n", 0, entity_match.start()) + 1
            entry = keys.setdefault(f"entity:{entity_name}", {
                "name": f"entity:{entity_name}", "types": {"jpa_entity"}, "references": [],
                "extractor": "spring_entity_v1", "confidence": 0.98,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for repo_match in JPA_REPOSITORY.finditer(content):
            repo_name = repo_match.group(1)
            line_no = content.count("\n", 0, repo_match.start()) + 1
            entry = keys.setdefault(f"repository:{repo_name}", {
                "name": f"repository:{repo_name}", "types": {"jpa_repository"}, "references": [],
                "extractor": "spring_repository_v1", "confidence": 0.98,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        if file_has:
            source_files.add(fp)

    props_candidates = [
        "src/main/resources/application.properties",
        "src/main/resources/application-dev.properties",
        "src/main/resources/application-prod.properties",
    ]
    for props_path in props_candidates:
        full = ctx.root / props_path
        if not full.exists():
            continue
        content = full.read_text(errors="ignore")
        for line_no, key in match_with_lines(content, PROPERTY_LINE, value_group=1):
            entry = keys.setdefault(key, {
                "name": key, "types": set(), "references": [],
                "extractor": "spring_properties_v1", "confidence": 0.98,
            })
            entry["types"].add("property")
            entry["references"].append({"file": props_path, "line": line_no})
        source_files.add(full)

    yml_candidates = [
        "src/main/resources/application.yml",
        "src/main/resources/application.yaml",
        "src/main/resources/application-dev.yml",
        "src/main/resources/application-prod.yml",
    ]
    for yml_path in yml_candidates:
        full = ctx.root / yml_path
        if not full.exists():
            continue
        content = full.read_text(errors="ignore")
        key_stack: list[tuple[int, str]] = []
        for line_no, line in enumerate(content.splitlines(), start=1):
            yml_match = YML_KEY.match(line)
            if not yml_match:
                continue
            indent = len(yml_match.group(1))
            key_name = yml_match.group(2)
            while key_stack and key_stack[-1][0] >= indent:
                key_stack.pop()
            key_stack.append((indent, key_name))
            full_key = ".".join(k for _, k in key_stack)
            entry = keys.setdefault(full_key, {
                "name": full_key, "types": set(), "references": [],
                "extractor": "spring_yml_v1", "confidence": 0.9,
            })
            entry["types"].add("yml_property")
            entry["references"].append({"file": yml_path, "line": line_no})
        source_files.add(full)

    payload = {
        "_meta": meta(ctx.root, "spring_boot_config_index_v1", source_files),
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


SPRING_BOOT_PLUGIN = SpringBootPlugin()
