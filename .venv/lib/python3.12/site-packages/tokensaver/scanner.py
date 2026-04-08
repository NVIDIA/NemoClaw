"""Project scanner focused on exact token accounting."""

from __future__ import annotations

import json
import os
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from tokensaver.tokenizer import count_file_tokens, tokenizer_name

SKIP_DIRS = {
    "node_modules",
    ".git",
    "vendor",
    "build",
    ".dart_tool",
    ".gradle",
    "Pods",
    "__pycache__",
    ".next",
    "dist",
    ".build",
    "DerivedData",
    ".pub-cache",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
}

EXT_MAP = {
    ".dart": "dart",
    ".kt": "kotlin",
    ".java": "java",
    ".swift": "swift",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".cpp": "cpp",
    ".c": "c",
    ".cs": "csharp",
    ".m": "objc",
    ".h": "c_header",
}

PACKAGE_MANAGER_FILES = {
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
    "package-lock.json": "npm",
    "bun.lockb": "bun",
    "bun.lock": "bun",
    "poetry.lock": "poetry",
    "uv.lock": "uv",
    "Pipfile.lock": "pipenv",
    "Cargo.lock": "cargo",
    "go.sum": "go",
    "pubspec.lock": "pub",
}


@dataclass
class ScanResult:
    root: str
    project_name: str
    framework: str
    total_files: int = 0
    total_lines: int = 0
    total_bytes: int = 0
    total_tokens: int = 0
    tokenizer: str = tokenizer_name()
    package_managers: list[str] = field(default_factory=list)
    manifests: list[str] = field(default_factory=list)
    languages: dict = field(default_factory=dict)
    top_files: list = field(default_factory=list)
    top_dirs: list = field(default_factory=list)
    entrypoints: list[str] = field(default_factory=list)


def scan_project(root: str | Path) -> ScanResult:
    """Scan a project directory and return exact file and token counts."""
    root = Path(root).resolve()
    framework = _detect_framework(root)
    result = ScanResult(
        root=str(root),
        project_name=root.name or str(root),
        framework=framework,
        package_managers=_detect_package_managers(root),
        manifests=_detect_manifests(root),
        entrypoints=_detect_entrypoints(root),
    )

    lang_bytes = defaultdict(int)
    lang_files = defaultdict(int)
    lang_tokens = defaultdict(int)
    dir_sizes = defaultdict(lambda: {"bytes": 0, "tokens": 0})
    file_sizes = []

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        rel_dir = os.path.relpath(dirpath, root)

        for fname in filenames:
            fpath = Path(dirpath) / fname
            ext = fpath.suffix.lower()
            if ext not in EXT_MAP:
                continue

            try:
                size = fpath.stat().st_size
                content = fpath.read_text(errors="ignore")
            except OSError:
                continue

            lang = EXT_MAP[ext]
            lines = content.count("\n") + (1 if content else 0)
            tokens = count_file_tokens(fpath, text=content)

            lang_bytes[lang] += size
            lang_files[lang] += 1
            lang_tokens[lang] += tokens

            result.total_files += 1
            result.total_lines += lines
            result.total_bytes += size
            result.total_tokens += tokens

            parts = Path(rel_dir).parts
            top_dir = "." if rel_dir == "." else parts[0]
            dir_sizes[top_dir]["bytes"] += size
            dir_sizes[top_dir]["tokens"] += tokens

            file_sizes.append(
                {
                    "path": os.path.relpath(fpath, root),
                    "bytes": size,
                    "lines": lines,
                    "tokens": tokens,
                }
            )

    result.languages = {
        lang: {
            "files": lang_files[lang],
            "bytes": lang_bytes[lang],
            "tokens": lang_tokens[lang],
        }
        for lang in sorted(lang_tokens, key=lang_tokens.get, reverse=True)
    }
    result.top_files = sorted(file_sizes, key=lambda item: item["tokens"], reverse=True)[:20]
    result.top_dirs = [
        {"dir": name, "bytes": stats["bytes"], "tokens": stats["tokens"]}
        for name, stats in sorted(
            dir_sizes.items(),
            key=lambda item: item[1]["tokens"],
            reverse=True,
        )[:15]
    ]
    return result


def _detect_framework(root: Path) -> str:
    if (root / "pubspec.yaml").exists():
        return "flutter"

    if _is_ios_project(root):
        return "ios_swift"

    package_json = root / "package.json"
    if package_json.exists():
        try:
            package_data = json.loads(package_json.read_text())
        except json.JSONDecodeError:
            package_data = {}
        deps = {
            **package_data.get("dependencies", {}),
            **package_data.get("devDependencies", {}),
        }
        if "react-native" in deps:
            return "react_native"
        if "next" in deps:
            return "nextjs"
        if "@angular/core" in deps:
            return "angular"
        if "react" in deps:
            return "react"
        return "node"

    if (root / "build.gradle.kts").exists() or (root / "build.gradle").exists():
        if _has_spring_boot(root):
            return "spring_boot"
        return "android_native"

    if (root / "pom.xml").exists():
        if _has_spring_boot(root):
            return "spring_boot"

    python_framework = _detect_python_framework(root)
    if python_framework:
        return python_framework

    if (root / "Cargo.toml").exists():
        return "rust"
    if (root / "go.mod").exists():
        return "go"
    if any(root.glob("*.py")) or any(child.is_dir() and (child / "__init__.py").exists() for child in root.iterdir()):
        return "python"
    return "unknown"


def _is_ios_project(root: Path) -> bool:
    """Detect native iOS/Swift projects (not Flutter, not RN)."""
    has_xcodeproj = any(root.glob("*.xcodeproj")) or any(root.glob("*.xcworkspace"))
    has_package_swift = (root / "Package.swift").exists()
    if not has_xcodeproj and not has_package_swift:
        return False
    if (root / "pubspec.yaml").exists():
        return False
    if (root / "package.json").exists():
        return False
    has_swift_files = any(root.rglob("*.swift"))
    return has_swift_files


def _has_spring_boot(root: Path) -> bool:
    """Check if a Java/Kotlin project uses Spring Boot."""
    for gradle_name in ("build.gradle.kts", "build.gradle"):
        gradle = root / gradle_name
        if gradle.exists():
            content = gradle.read_text(errors="ignore")[:3000]
            if "spring-boot" in content or "org.springframework.boot" in content:
                return True
    pom = root / "pom.xml"
    if pom.exists():
        content = pom.read_text(errors="ignore")[:5000]
        if "spring-boot" in content:
            return True
    src_main = root / "src" / "main" / "java"
    if src_main.exists():
        for fp in src_main.rglob("*Application.java"):
            try:
                content = fp.read_text(errors="ignore")[:1000]
                if "@SpringBootApplication" in content:
                    return True
            except OSError:
                continue
    return False


def _detect_python_framework(root: Path) -> str | None:
    """Detect specific Python web framework (FastAPI, Django, Flask) or generic Python."""
    has_manage_py = (root / "manage.py").exists()
    has_pyproject = (root / "pyproject.toml").exists()
    has_requirements = (root / "requirements.txt").exists()

    if not has_manage_py and not has_pyproject and not has_requirements:
        return None

    if has_manage_py:
        return "django"

    dep_content = ""
    if has_requirements:
        try:
            dep_content += (root / "requirements.txt").read_text(errors="ignore").lower()
        except OSError:
            pass
    if has_pyproject:
        try:
            dep_content += (root / "pyproject.toml").read_text(errors="ignore").lower()
        except OSError:
            pass

    if "django" in dep_content:
        return "django"
    if "fastapi" in dep_content:
        return "fastapi"
    if "flask" in dep_content:
        return "flask"
    return "python"


def _detect_package_managers(root: Path) -> list[str]:
    managers = []
    for file_name, manager in PACKAGE_MANAGER_FILES.items():
        if (root / file_name).exists():
            managers.append(manager)
    if (root / "package.json").exists() and not managers:
        managers.append("npm")
    return managers


def _detect_manifests(root: Path) -> list[str]:
    manifest_names = [
        "package.json",
        "pyproject.toml",
        "requirements.txt",
        "pubspec.yaml",
        "Cargo.toml",
        "go.mod",
        "Dockerfile",
        "docker-compose.yml",
        "docker-compose.yaml",
        "Makefile",
    ]
    return [name for name in manifest_names if (root / name).exists()]


def _detect_entrypoints(root: Path) -> list[str]:
    candidates = [
        "App.tsx",
        "App.js",
        "index.ts",
        "index.js",
        "main.py",
        "app.py",
        "manage.py",
        "server.py",
        "tokensaver_cli.py",
        "src/main.ts",
        "src/index.ts",
        "src/index.js",
        "main.dart",
        "lib/main.dart",
    ]
    return [path for path in candidates if (root / path).exists()]
