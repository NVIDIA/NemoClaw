"""Python web framework plugin — FastAPI, Django, Flask.

Extracts decorator-based routes, ORM models, middleware,
settings modules, and management commands.
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
    finalize_api_files,
    finalize_route_files,
    match_with_lines,
    meta,
    module_name_for_file,
    timestamp,
)
from tokensaver.core.models import ArtifactResult, BuildContext

FASTAPI_ROUTE = re.compile(
    r"@(?:\w+\.)?(?:app|router|api_router)\.(get|post|put|delete|patch|options|head)\(\s*['\"]([^'\"]+)['\"]"
)
FLASK_ROUTE = re.compile(
    r"@(?:\w+\.)?(?:app|bp|blueprint)\.(route|get|post|put|delete|patch)\(\s*['\"]([^'\"]+)['\"]"
)
DJANGO_URL_PATH = re.compile(
    r"(?:path|re_path)\(\s*['\"]([^'\"]+)['\"]"
)
DJANGO_MODEL_CLASS = re.compile(
    r"class\s+(\w+)\((?:models\.Model|AbstractUser|AbstractBaseUser|TimeStampedModel)\)"
)
FASTAPI_MODEL_CLASS = re.compile(
    r"class\s+(\w+)\((?:BaseModel|SQLModel|Base)\)"
)
DJANGO_MIDDLEWARE = re.compile(
    r"['\"](\w+(?:\.\w+)*Middleware)['\"]"
)
FASTAPI_MIDDLEWARE = re.compile(
    r"app\.add_middleware\(\s*(\w+)"
)
DJANGO_SETTING_KEY = re.compile(
    r"^([A-Z][A-Z0-9_]{2,})\s*=", re.MULTILINE
)
PYDANTIC_SETTINGS_FIELD = re.compile(
    r"(\w+)\s*:\s*(\w+)\s*=\s*(?:Field|Settings|)"
)
DJANGO_MANAGEMENT_CMD = re.compile(
    r"class\s+Command\(BaseCommand\)"
)


@dataclass(frozen=True)
class PythonWebPlugin:
    name: str = "python_web"
    frameworks: set[str] = frozenset({"fastapi", "django", "flask"})

    def build_artifacts(self, ctx: BuildContext) -> list[ArtifactResult]:
        return [
            build_module_graph(ctx),
            build_api_index(ctx),
            build_route_index(ctx),
            build_config_index(ctx),
        ]


def _detect_sub_framework(root: Path) -> str:
    if (root / "manage.py").exists():
        return "django"
    for fp in root.rglob("*.py"):
        if fp.name in ("__pycache__",):
            continue
        try:
            content = fp.read_text(errors="ignore")[:2000]
        except OSError:
            continue
        if "fastapi" in content.lower() or "FastAPI" in content:
            return "fastapi"
        if "Flask(" in content or "from flask" in content.lower():
            return "flask"
    return "fastapi"


def build_module_graph(ctx: BuildContext) -> ArtifactResult:
    return build_module_graph_artifact(ctx.root, ctx.scan.framework, ArtifactResult)


def build_api_index(ctx: BuildContext) -> ArtifactResult:
    api_files: dict = {}
    source_files: set[Path] = set()
    endpoint_count = 0
    sub = _detect_sub_framework(ctx.root)

    for fp in all_code_files(ctx.root):
        if "test" in fp.parts or fp.suffix != ".py":
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, fp)
        file_has = False

        if sub in ("fastapi", "flask"):
            pattern = FASTAPI_ROUTE if sub == "fastapi" else FLASK_ROUTE
            for _, method, path in match_with_lines(content, pattern, method_group=1, path_group=2):
                if add_api_file_entry(api_files, rel_path=rel, module=module, path=path, name="", method=method.upper()):
                    endpoint_count += 1
                    file_has = True

        if sub == "django":
            for _, url_path in match_with_lines(content, DJANGO_URL_PATH, value_group=1):
                path = "/" + url_path.lstrip("/") if url_path else "/"
                if add_api_file_entry(api_files, rel_path=rel, module=module, path=path, name="", method="VIEW"):
                    endpoint_count += 1
                    file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            **meta(ctx.root, f"{sub}_api_index_v1", source_files),
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
    sub = _detect_sub_framework(ctx.root)

    for fp in all_code_files(ctx.root):
        if "test" in fp.parts or fp.suffix != ".py":
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        if sub == "django":
            for line_no, url_path in match_with_lines(content, DJANGO_URL_PATH, value_group=1):
                route = "/" + url_path.lstrip("/") if url_path else "/"
                routes[route] = {
                    "path": route,
                    "kind": "url_pattern",
                    "source": [{"file": rel, "line": line_no}],
                    "usage_count": 1,
                    "navigated_from": [],
                }
                file_has = True
        else:
            for pattern in (FASTAPI_ROUTE, FLASK_ROUTE):
                for line_no, _, route_path in match_with_lines(content, pattern, method_group=1, path_group=2):
                    routes[route_path] = {
                        "path": route_path,
                        "kind": "api_route",
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
            "extractor": f"{sub}_route_index_v1",
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
    sub = _detect_sub_framework(ctx.root)

    for fp in all_code_files(ctx.root):
        if "test" in fp.parts or fp.suffix != ".py":
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

        if sub == "django" and fp.name == "settings.py":
            for line_no, key in match_with_lines(content, DJANGO_SETTING_KEY, value_group=1):
                entry = keys.setdefault(key, {
                    "name": key, "types": set(), "references": [],
                    "extractor": "django_settings_v1", "confidence": 0.98,
                })
                entry["types"].add("django_setting")
                entry["references"].append({"file": rel, "line": line_no})
                file_has = True

        for model_match in DJANGO_MODEL_CLASS.finditer(content):
            model_name = model_match.group(1)
            line_no = content.count("\n", 0, model_match.start()) + 1
            entry = keys.setdefault(f"model:{model_name}", {
                "name": f"model:{model_name}", "types": {"orm_model"}, "references": [],
                "extractor": f"{sub}_model_v1", "confidence": 0.95,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for model_match in FASTAPI_MODEL_CLASS.finditer(content):
            model_name = model_match.group(1)
            line_no = content.count("\n", 0, model_match.start()) + 1
            entry = keys.setdefault(f"model:{model_name}", {
                "name": f"model:{model_name}", "types": {"pydantic_model"}, "references": [],
                "extractor": f"{sub}_model_v1", "confidence": 0.95,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for mw_match in DJANGO_MIDDLEWARE.finditer(content):
            mw_name = mw_match.group(1)
            line_no = content.count("\n", 0, mw_match.start()) + 1
            entry = keys.setdefault(f"middleware:{mw_name}", {
                "name": f"middleware:{mw_name}", "types": {"middleware"}, "references": [],
                "extractor": f"{sub}_middleware_v1", "confidence": 0.9,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for mw_match in FASTAPI_MIDDLEWARE.finditer(content):
            mw_name = mw_match.group(1)
            line_no = content.count("\n", 0, mw_match.start()) + 1
            entry = keys.setdefault(f"middleware:{mw_name}", {
                "name": f"middleware:{mw_name}", "types": {"middleware"}, "references": [],
                "extractor": f"{sub}_middleware_v1", "confidence": 0.9,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        if file_has:
            source_files.add(fp)

    for env_name in (".env", ".env.example", ".env.sample", ".env.local"):
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
        "_meta": meta(ctx.root, f"{sub}_config_index_v1", source_files),
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


PYTHON_WEB_PLUGIN = PythonWebPlugin()
