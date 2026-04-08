"""Shared helper functions used by core builders and plugins."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path

from tokensaver import SCHEMA_VERSION
from tokensaver.tokenizer import count_file_tokens

CODE_EXTENSIONS = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".dart",
    ".kt",
    ".java",
    ".go",
    ".rs",
    ".swift",
}

ENV_PATTERNS = [
    ("python_os_getenv", re.compile(r"os\.getenv\(\s*['\"]([A-Z0-9_]+)['\"]")),
    ("python_os_environ", re.compile(r"os\.environ\[\s*['\"]([A-Z0-9_]+)['\"]\s*\]")),
    ("node_process_env", re.compile(r"process\.env(?:\.|\[\s*['\"])([A-Z0-9_]+)")),
    ("dart_string_env", re.compile(r"String\.fromEnvironment\(\s*['\"]([A-Z0-9_]+)['\"]")),
    ("dart_dotenv", re.compile(r"dotenv\.env\[\s*['\"]([A-Z0-9_]+)['\"]\s*\]")),
]

PYTHON_API_PATTERN = re.compile(
    r"@(?:\w+\.)?(?:app|router)\.(get|post|put|delete|patch)\(\s*['\"]([^'\"]+)['\"]"
)
NODE_API_PATTERN = re.compile(
    r"(?:app|router)\.(get|post|put|delete|patch)\(\s*['\"]([^'\"]+)['\"]"
)
REACT_ROUTE_PATTERN = re.compile(r"<Route[^>]+path=['\"]([^'\"]+)['\"]")
EXPRESS_USE_PATTERN = re.compile(r"(?:app|router)\.use\(\s*['\"]([^'\"]+)['\"]")
PYTHON_ROUTE_PATTERN = re.compile(
    r"@(?:\w+\.)?(?:app|router|bp|blueprint)\.(route|get|post|put|delete|patch)\(\s*['\"]([^'\"]+)['\"]"
)
GETX_ROUTE_CONST = re.compile(r"static\s+const\s+(\w+)\s*=\s*['\"]([^'\"]+)['\"]")
GETX_ROUTE_BINDING = re.compile(
    r"GetPage\s*\([^)]*name\s*:\s*(?:AppRoutes\.)?(\w+)[^)]*page\s*:\s*\(\)\s*=>\s*(\w+)",
    re.DOTALL,
)
GET_NAMED_EXPR = re.compile(r"Get\.(?:toNamed|offNamed|offAllNamed|offNamedUntil)\(\s*([^,\)\n]+)")
ROUTE_TO_EXPR = re.compile(
    r"routeTo\(\s*parentRoute:\s*([A-Za-z0-9_\.]+)(?:\s*,\s*subRoute:\s*([A-Za-z0-9_\.]+))?"
)
DART_RC_CALL_PATTERN = re.compile(
    r"(?:RemoteConfigService\.get\(\)|remoteConfigService|_remoteConfig|remoteConfig)\s*\.\s*"
    r"(getString|getBool|getInt|getDouble|getJson|getValue)\(\s*['\"]([A-Za-z0-9_]+)['\"]"
)
DART_URL_ASSIGN_PATTERN = re.compile(
    r"(?:static\s+)?(?:final|const)\s+\w+\s+(\w+)\s*=\s*['\"]([^'\"]*(?:/api/|https?://)[^'\"]*)['\"]"
)
DART_NAMED_URL_PATTERN = re.compile(
    r"(?:url|endpoint|path|baseUrl|baseURL)\s*:\s*['\"]([^'\"]*(?:/api/|https?://)[^'\"]*)['\"]"
)
TS_ENUM_BLOCK_PATTERN = re.compile(r"export\s+enum\s+(\w+)\s*\{(.*?)\}", re.DOTALL)
TS_ENUM_ENTRY_PATTERN = re.compile(r"(\w+)\s*=\s*['\"]([^'\"]+)['\"]")
RN_STACK_SCREEN_PATTERN = re.compile(
    r"<(?:[A-Za-z0-9_]+)\.Screen\b[^>]*\bname=\{([^}]+)\}[^>]*(?:\bcomponent=\{([^}]+)\})?",
    re.DOTALL,
)
RN_NAVIGATE_PATTERN = re.compile(
    r"\bnavigate\(\s*(?:\{\s*name\s*:\s*)?([A-Za-z0-9_\.]+|['\"][^'\"]+['\"])",
    re.DOTALL,
)
AXIOS_CREATE_PATTERN = re.compile(r"\b([A-Za-z0-9_]+)\s*=\s*axios\.create\(\s*\{(.*?)\}\s*\)", re.DOTALL)
AXIOS_BASE_URL_PATTERN = re.compile(r"\bbaseURL\s*:\s*([^,\n}]+)")
AXIOS_METHOD_PATTERN = re.compile(r"\.((?:get|post|put|delete|patch))\(\s*['\"]([^'\"]+)['\"]")
FETCH_CALL_PATTERN = re.compile(r"\bfetch\(\s*(['\"][^'\"]+['\"])")
RN_CONFIG_IMPORT_PATTERN = re.compile(
    r"import\s+([A-Za-z0-9_]+)\s+from\s+['\"]react-native-config['\"]"
)


def meta(root: Path, extractor: str, source_files: set[Path]) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": timestamp(),
        "extractor": extractor,
        "source_files": sorted(str(path.relative_to(root)) for path in source_files if path.exists()),
    }


def value_with_meta(value, sources: list[dict], extractor: str, confidence: float) -> dict:
    return {
        "value": value,
        "source": sources,
        "extractor": extractor,
        "confidence": confidence,
    }


def sources(root: Path, source_files: set[Path] | list[Path]) -> list[dict]:
    return [{"file": str(path.relative_to(root))} for path in sorted(source_files) if path.exists()]


def module_roots(root: Path, framework: str) -> list[Path]:
    candidates = []
    if framework == "flutter":
        lib_dir = root / "lib"
        if lib_dir.exists():
            candidates.extend(path for path in sorted(lib_dir.iterdir()) if path.is_dir())
    elif framework in {"react", "react_native", "nextjs", "node", "angular"}:
        for base_name in ("src", "app", "pages", "packages"):
            base_dir = root / base_name
            if base_dir.exists():
                candidates.extend(path for path in sorted(base_dir.iterdir()) if path.is_dir())
    elif framework in {"python", "fastapi", "django", "flask"}:
        for base_name in ("src", "app"):
            base_dir = root / base_name
            if base_dir.exists() and base_dir.is_dir():
                candidates.extend(path for path in sorted(base_dir.iterdir()) if path.is_dir())
        for child in sorted(root.iterdir()):
            if child.is_dir() and child not in candidates and (
                (child / "__init__.py").exists()
                or any(path.suffix == ".py" for path in child.iterdir())
            ):
                candidates.append(child)
        if not candidates and any(path.suffix == ".py" for path in root.iterdir() if path.is_file()):
            candidates.append(root)
    elif framework == "spring_boot":
        src_main = root / "src" / "main" / "java"
        if src_main.exists():
            candidates.extend(path for path in sorted(src_main.rglob("*")) if path.is_dir() and any(f.suffix in {".java", ".kt"} for f in path.iterdir() if f.is_file()))
        src_kt = root / "src" / "main" / "kotlin"
        if src_kt.exists():
            candidates.extend(path for path in sorted(src_kt.rglob("*")) if path.is_dir() and any(f.suffix == ".kt" for f in path.iterdir() if f.is_file()))
        if not candidates:
            for base in ("src",):
                base_dir = root / base
                if base_dir.exists():
                    candidates.extend(path for path in sorted(base_dir.iterdir()) if path.is_dir())
    elif framework == "android_native":
        for base_name in ("app/src/main/java", "app/src/main/kotlin"):
            base_dir = root / base_name
            if base_dir.exists():
                candidates.extend(path for path in sorted(base_dir.rglob("*")) if path.is_dir() and any(f.suffix in {".java", ".kt"} for f in path.iterdir() if f.is_file()))
        if not candidates:
            for child in sorted(root.iterdir()):
                if child.is_dir() and any(child.rglob("*.kt")) or any(child.rglob("*.java")):
                    candidates.append(child)
    elif framework == "ios_swift":
        for child in sorted(root.iterdir()):
            if child.is_dir() and any(child.rglob("*.swift")):
                if child.name not in ("Pods", ".build", "DerivedData", "Build", "Tests"):
                    candidates.append(child)
        if not candidates and any(root.glob("*.swift")):
            candidates.append(root)
    elif framework == "go":
        for base_name in ("cmd", "internal", "pkg", "api", "handlers", "routes", "server"):
            base_dir = root / base_name
            if base_dir.exists():
                candidates.append(base_dir)
                candidates.extend(path for path in sorted(base_dir.iterdir()) if path.is_dir())
        if not candidates:
            candidates.extend(
                child
                for child in sorted(root.iterdir())
                if child.is_dir() and any(f.suffix == ".go" for f in child.rglob("*.go"))
            )
        if not candidates and any(root.glob("*.go")):
            candidates.append(root)
    else:
        candidates.extend(
            child
            for child in sorted(root.iterdir())
            if child.is_dir() and any(code_files_under(child))
        )
    return candidates


def all_code_files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and path.suffix in CODE_EXTENSIONS and ".git" not in path.parts:
            if any(part.startswith(".") and part not in {".github"} for part in path.parts):
                continue
            if any(
                part in {"node_modules", "__pycache__", "dist", "build", ".next", ".venv", "venv", "docs", "vendor"}
                for part in path.parts
            ):
                continue
            yield path


def code_files_under(root: Path) -> list[Path]:
    return [path for path in all_code_files(root) if path.is_file()]


def code_files_for_language(root: Path, language: str) -> set[Path]:
    extension_map = {
        "python": ".py",
        "dart": ".dart",
        "typescript": ".ts",
        "javascript": ".js",
        "java": ".java",
        "kotlin": ".kt",
        "go": ".go",
        "rust": ".rs",
    }
    extension = extension_map.get(language)
    if not extension:
        return set()
    return {path for path in all_code_files(root) if path.suffix == extension}


def language_source_refs(root: Path, language: str) -> list[dict]:
    refs = set()
    for path in code_files_for_language(root, language):
        rel_path = path.relative_to(root)
        if len(rel_path.parts) == 1:
            refs.add(str(rel_path))
        else:
            refs.add(f"{rel_path.parts[0]}/")
    return [{"file": ref} for ref in sorted(refs)]


def module_name_for_file(root: Path, file_path: Path) -> str:
    try:
        rel_path = file_path.relative_to(root)
    except ValueError:
        return "root"
    if len(rel_path.parts) == 1:
        return "root"
    if rel_path.parts[0] == "lib" and len(rel_path.parts) > 1:
        return rel_path.parts[1]
    return rel_path.parts[0]


def categorize_command(name: str) -> str:
    lowered = name.lower()
    if lowered in {"dev", "start", "serve"}:
        return "dev"
    if "test" in lowered:
        return "test"
    if "lint" in lowered:
        return "lint"
    if "build" in lowered:
        return "build"
    if "format" in lowered or "fmt" in lowered:
        return "format"
    return "task"


def match_with_lines(content: str, pattern, value_group=1, second_group=None, method_group=None, path_group=None):
    for match in pattern.finditer(content):
        line_no = content.count("\n", 0, match.start()) + 1
        if method_group and path_group:
            yield line_no, match.group(method_group), match.group(path_group)
        elif second_group is not None:
            yield line_no, match.group(value_group), match.group(second_group)
        else:
            yield line_no, match.group(value_group)


def timestamp() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def clean_url(url: str) -> str:
    url = re.sub(r"https?://[^/]+", "", url)
    url = url.split("?")[0].strip()
    return url.rstrip("/") or ""


def strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def should_include_api_reference(cleaned_url: str, raw_url: str, name: str | None, rel_path: str) -> bool:
    if not cleaned_url:
        return False
    if rel_path.startswith("test/"):
        return False
    lowered_path = cleaned_url.lower()
    if any(lowered_path.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".pdf")):
        return False
    if any(token in raw_url for token in ("placeholder.com", "unsplash.com", "raw.githubusercontent.com")):
        return False
    if "/api/" in raw_url or "/api/" in cleaned_url:
        return True
    lowered_name = (name or "").lower()
    if any(token in lowered_name for token in ("url", "endpoint", "token", "login", "auth")):
        return True
    lowered_file = rel_path.lower()
    if any(token in lowered_file for token in ("helper", "endpoint", "api_", "api/", "const")):
        return True
    return False


def resolve_flutter_route_expression(expression: str, route_defs: dict[str, str]) -> str | None:
    expr = expression.strip()
    if not expr:
        return None
    parts = [part.strip() for part in expr.split("+")]
    resolved_parts = []
    for part in parts:
        if part.startswith("AppRoutes."):
            route_name = part.split(".", 1)[1]
            route_value = route_defs.get(route_name)
            if not route_value:
                return None
            resolved_parts.append(route_value)
        elif (part.startswith("'") and part.endswith("'")) or (part.startswith('"') and part.endswith('"')):
            resolved_parts.append(part[1:-1])
        else:
            return None
    return "".join(resolved_parts) if resolved_parts else None


def extract_dart_map_block(content: str, marker: str) -> str | None:
    marker_index = content.find(marker)
    if marker_index == -1:
        return None
    start = content.find("{", marker_index)
    if start == -1:
        return None

    depth = 0
    index = start
    in_string = False
    string_delim = ""
    triple = False

    while index < len(content):
        chunk = content[index:index + 3]
        char = content[index]

        if in_string:
            if triple and chunk == string_delim * 3:
                in_string = False
                index += 3
                continue
            if not triple and char == string_delim and (index == 0 or content[index - 1] != "\\"):
                in_string = False
            index += 1
            continue

        if chunk in {"'''", '"""'}:
            in_string = True
            string_delim = chunk[0]
            triple = True
            index += 3
            continue
        if char in {"'", '"'}:
            in_string = True
            string_delim = char
            triple = False
            index += 1
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return content[start:index + 1]
        index += 1

    return None


def extract_top_level_map_entries(block: str) -> list[tuple[str, str]]:
    entries = []
    depth = 0
    index = 0
    in_string = False
    string_delim = ""
    triple = False

    while index < len(block):
        chunk = block[index:index + 3]
        char = block[index]

        if in_string:
            if triple and chunk == string_delim * 3:
                in_string = False
                index += 3
                continue
            if not triple and char == string_delim and (index == 0 or block[index - 1] != "\\"):
                in_string = False
            index += 1
            continue

        if chunk in {"'''", '"""'}:
            in_string = True
            string_delim = chunk[0]
            triple = True
            index += 3
            continue
        if char in {"'", '"'}:
            end_index = block.find(char, index + 1)
            if depth == 1 and end_index != -1:
                key = block[index + 1:end_index]
                cursor = end_index + 1
                while cursor < len(block) and block[cursor].isspace():
                    cursor += 1
                if cursor < len(block) and block[cursor] == ":":
                    value_type = infer_dart_value_type(block[cursor + 1:])
                    entries.append((key, value_type))
            in_string = True
            string_delim = char
            triple = False
            index += 1
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        index += 1

    deduped = []
    seen = set()
    for key, value_type in entries:
        if key in seen:
            continue
        seen.add(key)
        deduped.append((key, value_type))
    return deduped


def infer_dart_value_type(value_slice: str) -> str:
    trimmed = value_slice.lstrip()
    if trimmed.startswith(("'''", '"""', "'", '"')):
        return "string"
    if trimmed.startswith("{"):
        return "map"
    if trimmed.startswith("["):
        return "list"
    if trimmed.startswith(("true", "false")):
        return "bool"
    if re.match(r"-?\d+\.\d+", trimmed):
        return "double"
    if re.match(r"-?\d+", trimmed):
        return "int"
    return "unknown"


def remote_config_type_from_getter(getter_name: str) -> str:
    return {
        "getBool": "bool",
        "getString": "string",
        "getInt": "int",
        "getDouble": "double",
        "getJson": "json",
        "getValue": "value",
    }.get(getter_name, "unknown")


def add_api_file_entry(
    api_files: dict,
    *,
    rel_path: str,
    module: str,
    path: str,
    name: str,
    method: str,
) -> bool:
    api_file = api_files.setdefault(
        rel_path,
        {
            "file": rel_path,
            "module": module,
            "entries": [],
            "seen": set(),
        },
    )
    row = (path, name, method)
    if row in api_file["seen"]:
        return False
    api_file["seen"].add(row)
    api_file["entries"].append(row)
    return True


def finalize_api_files(api_files: dict) -> list[list]:
    groups = []
    for rel_path, api_file in sorted(api_files.items()):
        entries = sorted(api_file["entries"], key=lambda row: (row[0], row[1], row[2]))
        compact_entries = [[path, name, method] for path, name, method in entries]
        groups.append([rel_path, api_file["module"], compact_entries])
    return groups


def finalize_route_files(routes: dict) -> list[list]:
    grouped = {}
    for route in routes.values():
        source = route.get("source", [])
        if isinstance(source, list) and source:
            source_file = source[0]["file"]
        elif isinstance(source, dict):
            source_file = source["file"]
        else:
            source_file = "unknown"
        row = [
            route["path"],
            route.get("screen", ""),
            route.get("usage_count", 0),
            "|".join(sorted(route.get("aliases", []))) if route.get("aliases") else "",
            "|".join(sorted(route.get("navigated_from", []))) if route.get("navigated_from") else "",
        ]
        grouped.setdefault(source_file, []).append(row)

    result = []
    for source_file, entries in sorted(grouped.items()):
        result.append([source_file, sorted(entries, key=lambda row: row[0])])
    return result


def build_module_graph_artifact(root: Path, framework: str, artifact_cls, extractor_name: str = "module_graph_v1"):
    modules = []
    source_files = set()
    for module_path in module_roots(root, framework):
        files = sorted(code_files_under(module_path))
        if not files:
            continue
        source_files.update(files)
        modules.append(
            {
                "name": str(module_path.relative_to(root)),
                "path": str(module_path.relative_to(root)),
                "file_count": len(files),
                "tokens": sum(count_file_tokens(path) for path in files),
                "source": [{"file": str(module_path.relative_to(root))}],
                "extractor": extractor_name,
                "confidence": 0.8,
            }
        )
    return artifact_cls(
        name="module_graph",
        file_name="MODULE_GRAPH.json",
        payload={"_meta": meta(root, extractor_name, source_files), "modules": modules},
        source_files=source_files,
        entity_count=len(modules),
    )
