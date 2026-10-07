#!/usr/bin/env python3
"""Sayuri developer fast-path CLI.

A dependency-free helper for restoring project context, selecting targeted checks,
and safely finishing small development tasks without re-auditing the repository.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

STATE_PATH = Path(".sayuri/dev_state.json")
INDEX_PATH = Path(".sayuri/dev_index.json")
PROJECT_STATE_PATH = Path("SAYURI_PROJECT_STATE.json")


def _run(args: list[str], *, cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        args,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
        raise RuntimeError(f"{' '.join(args)}: {detail}")
    return proc


def repo_root(start: Path | None = None) -> Path:
    cwd = (start or Path.cwd()).resolve()
    proc = _run(["git", "rev-parse", "--show-toplevel"], cwd=cwd)
    return Path(proc.stdout.strip()).resolve()


def git(root: Path, *args: str, check: bool = True) -> str:
    return _run(["git", *args], cwd=root, check=check).stdout.strip()


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read {path}: {exc}") from exc


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    path.write_text(rendered, encoding="utf-8", newline="\n")


def branch(root: Path) -> str:
    return git(root, "branch", "--show-current") or "(detached)"


def head(root: Path) -> str:
    return git(root, "rev-parse", "HEAD")


def _split_nul(text: str) -> list[str]:
    return [part for part in text.split("\0") if part]


def changed_files(root: Path) -> list[str]:
    names: set[str] = set()
    for args in (
        ("diff", "--name-only", "-z"),
        ("diff", "--cached", "--name-only", "-z"),
        ("ls-files", "--others", "--exclude-standard", "-z"),
    ):
        names.update(_split_nul(git(root, *args)))
    return sorted(names)


def delta_files(root: Path, base: str | None) -> list[str]:
    if not base:
        return []
    probe = _run(["git", "cat-file", "-e", f"{base}^{{commit}}"], cwd=root, check=False)
    if probe.returncode != 0:
        return []
    merge = _run(["git", "merge-base", "--is-ancestor", base, "HEAD"], cwd=root, check=False)
    if merge.returncode != 0:
        return []
    return _split_nul(git(root, "diff", "--name-only", "-z", f"{base}..HEAD"))


def project_version(root: Path, state: dict[str, Any]) -> str:
    project = read_json(root / PROJECT_STATE_PATH, {})
    return str(project.get("version") or state.get("project_version") or "unknown")


def load_state(root: Path) -> dict[str, Any]:
    default = {
        "schema_version": 1,
        "project": "Sayuri Tsukishiro",
        "project_version": "unknown",
        "stage": "unknown",
        "task": {
            "id": "",
            "goal": "",
            "owned_paths": [],
            "target_tests": [],
            "acceptance": [],
        },
        "last_result": "UNKNOWN",
        "next_action": "",
        "blockers": [],
    }
    state = read_json(root / STATE_PATH, default)
    if not isinstance(state, dict):
        raise RuntimeError(f"{STATE_PATH} must contain a JSON object")
    return state


def load_index(root: Path) -> dict[str, Any]:
    value = read_json(root / INDEX_PATH, {})
    return value if isinstance(value, dict) else {}


def snapshot(root: Path) -> dict[str, Any]:
    state = load_state(root)
    dirty = changed_files(root)
    return {
        "project": state.get("project", "Sayuri Tsukishiro"),
        "version": project_version(root, state),
        "branch": branch(root),
        "head": head(root),
        "dirty": bool(dirty),
        "changed_files": dirty,
        "stage": state.get("stage", "unknown"),
        "task": state.get("task", {}),
        "last_result": state.get("last_result", "UNKNOWN"),
        "next_action": state.get("next_action", ""),
        "blockers": state.get("blockers", []),
    }


def print_value(value: Any, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, (dict, list)):
                rendered = json.dumps(item, ensure_ascii=False, sort_keys=True)
            else:
                rendered = str(item)
            print(f"{key.upper()}: {rendered}")
    else:
        print(value)


def command_state(args: argparse.Namespace) -> int:
    root = repo_root()
    print_value(snapshot(root), as_json=args.json)
    return 0


def command_recover(args: argparse.Namespace) -> int:
    root = repo_root()
    state = load_state(root)
    snap = snapshot(root)
    base = state.get("baseline_ref") or ""
    delta = delta_files(root, str(base)) if base else []
    blockers = list(state.get("blockers", []))
    result = {
        **snap,
        "baseline_ref": base,
        "delta_from_baseline": delta,
        "trusted_fast_path": not blockers,
        "recovery_action": "continue next_action" if not blockers else "resolve blockers first",
    }
    print_value(result, as_json=args.json)
    return 0 if not blockers else 2


def all_tracked_files(root: Path) -> list[str]:
    return sorted(_split_nul(git(root, "ls-files", "-z")))


def module_name(path: str) -> str | None:
    parts = Path(path).parts
    if not parts:
        return None
    if parts[0] == "src" and len(parts) >= 2:
        return parts[1]
    if parts[0] == "scripts":
        return "scripts"
    if parts[0] == "python":
        return "python"
    if parts[0] == "tools":
        return "dev-tools"
    return None


def _test_stem(path: str) -> str:
    name = Path(path).name
    for suffix in (".test.tsx", ".test.ts", ".test.js", ".spec.tsx", ".spec.ts", ".spec.js"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return Path(name).stem


def build_index(root: Path) -> dict[str, Any]:
    files = all_tracked_files(root)
    tests = [
        p
        for p in files
        if any(token in p for token in (".test.ts", ".test.tsx", ".test.js", ".spec.ts", ".spec.tsx", ".spec.js"))
    ]
    modules: dict[str, dict[str, Any]] = {}
    for path in files:
        name = module_name(path)
        if not name:
            continue
        item = modules.setdefault(name, {"paths": [], "tests": []})
        item["paths"].append(path)
    for test in tests:
        name = module_name(test)
        if name:
            modules.setdefault(name, {"paths": [], "tests": []})["tests"].append(test)

    package = read_json(root / "package.json", {})
    scripts = package.get("scripts", {}) if isinstance(package, dict) else {}
    return {
        "schema_version": 1,
        "generated_by": "tools/dev.py reindex",
        "source_roots": [p for p in ("src", "scripts", "python", "tools") if (root / p).exists()],
        "modules": modules,
        "tests": tests,
        "package_scripts": scripts if isinstance(scripts, dict) else {},
        "impact_rules": [
            {"match": ["tools/dev.py", "tools/test_dev.py", ".sayuri/*.json"], "checks": ["python-selftest", "json"]},
            {"match": ["src/**/*.ts", "src/**/*.tsx"], "checks": ["related-tests", "biome-targeted"]},
            {"match": ["scripts/**/*.ts", "scripts/**/*.js", "scripts/**/*.cjs"], "checks": ["related-tests"]},
            {"match": ["package.json", "tsconfig*.json", ".github/workflows/*"], "checks": ["release-escalation"]},
        ],
    }


def command_reindex(args: argparse.Namespace) -> int:
    root = repo_root()
    index = build_index(root)
    write_json(root / INDEX_PATH, index)
    print_value({"updated": str(INDEX_PATH), "modules": len(index["modules"]), "tests": len(index["tests"])}, as_json=args.json)
    return 0


def _matches(path: str, pattern: str) -> bool:
    return fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(path, pattern.replace("**/", ""))


def related_tests(files: Iterable[str], index: dict[str, Any]) -> list[str]:
    tests = [str(x) for x in index.get("tests", [])]
    selected: set[str] = set()
    for path in files:
        p = Path(path)
        if ".test." in p.name or ".spec." in p.name:
            if path in tests:
                selected.add(path)
            continue
        stem = p.stem
        parent = p.parent.as_posix()
        mod = module_name(path)
        for test in tests:
            test_path = Path(test)
            same_stem = _test_stem(test) == stem
            same_dir = test_path.parent.as_posix() == parent
            same_module = mod is not None and module_name(test) == mod
            if same_stem and (same_dir or same_module):
                selected.add(test)
    return sorted(selected)


def _validate_json_files(root: Path, files: Iterable[str]) -> None:
    for path in files:
        if path.endswith(".json") and (root / path).exists():
            read_json(root / path, {})


def check_plan(root: Path, files: list[str]) -> list[list[str]]:
    index = load_index(root)
    plan: list[list[str]] = []
    py_changed = any(path.endswith(".py") for path in files)
    dev_meta = any(path in {"tools/dev.py", "tools/test_dev.py"} or path.startswith(".sayuri/") for path in files)
    source_changed = [p for p in files if p.endswith((".ts", ".tsx", ".js", ".cjs")) and (p.startswith("src/") or p.startswith("scripts/"))]
    release_sensitive = any(
        p == "package.json" or p.startswith(".github/workflows/") or Path(p).name.startswith("tsconfig")
        for p in files
    )

    if py_changed or dev_meta:
        plan.append([sys.executable, "-m", "unittest", "tools.test_dev"])
    tests = related_tests(source_changed, index)
    if tests:
        plan.append(["bun", "test", *tests])
    elif source_changed:
        plan.append(["bunx", "--bun", "@biomejs/biome@2.2.5", "check", *source_changed])
    if release_sensitive:
        plan.append(["bun", "run", "check"])
    return plan


def command_check(args: argparse.Namespace) -> int:
    root = repo_root()
    files = changed_files(root)
    _validate_json_files(root, files)
    plan = check_plan(root, files)
    result: dict[str, Any] = {"changed_files": files, "commands": plan, "status": "PASS"}
    if args.dry_run:
        print_value(result, as_json=args.json)
        return 0
    for command in plan:
        proc = _run(command, cwd=root, check=False)
        if proc.stdout:
            print(proc.stdout, end="" if proc.stdout.endswith("\n") else "\n")
        if proc.returncode != 0:
            if proc.stderr:
                print(proc.stderr, file=sys.stderr, end="" if proc.stderr.endswith("\n") else "\n")
            result["status"] = "FAIL"
            result["failed_command"] = command
            if args.json:
                print_value(result, as_json=True)
            return proc.returncode or 1
    print_value(result, as_json=args.json)
    return 0


def _owned_changed_files(state: dict[str, Any], changed: list[str]) -> list[str]:
    task = state.get("task", {}) if isinstance(state.get("task"), dict) else {}
    patterns = [str(x) for x in task.get("owned_paths", [])]
    if not patterns:
        return []
    return [path for path in changed if any(_matches(path, pattern) for pattern in patterns)]


def _update_state_result(root: Path, *, result: str, next_action: str | None) -> dict[str, Any]:
    state = load_state(root)
    state["last_result"] = result
    if next_action is not None:
        state["next_action"] = next_action
    write_json(root / STATE_PATH, state)
    return state


def command_finish(args: argparse.Namespace) -> int:
    root = repo_root()
    if command_check(argparse.Namespace(dry_run=False, json=False)) != 0:
        return 1

    _update_state_result(root, result="PASS", next_action=args.next_action)
    result: dict[str, Any] = {"status": "PASS", "state_updated": str(STATE_PATH)}
    if not args.commit_message:
        print_value(result, as_json=args.json)
        return 0

    current_branch = branch(root)
    if current_branch in {"main", "master", "(detached)"}:
        raise RuntimeError("Automatic commit is disabled on main/master/detached HEAD")

    state = load_state(root)
    changed = changed_files(root)
    owned = _owned_changed_files(state, changed)
    if str(STATE_PATH) in changed and str(STATE_PATH) not in owned:
        owned.append(str(STATE_PATH))
    if not owned:
        raise RuntimeError("No task-owned changed files. Set task.owned_paths before automatic finish.")

    unrelated = sorted(set(changed) - set(owned))
    if unrelated and not args.allow_unrelated:
        raise RuntimeError("Unrelated changes present; refusing automatic commit: " + ", ".join(unrelated))

    _run(["git", "add", "--", *owned], cwd=root)
    staged = _split_nul(git(root, "diff", "--cached", "--name-only", "-z"))
    if not staged:
        raise RuntimeError("Nothing staged for commit")
    _run(["git", "commit", "-m", args.commit_message], cwd=root)
    result["commit"] = head(root)
    result["staged_files"] = staged

    if args.push:
        _run(["git", "push", "origin", current_branch], cwd=root)
        result["pushed"] = True
    print_value(result, as_json=args.json)
    return 0


def command_task(args: argparse.Namespace) -> int:
    root = repo_root()
    state = load_state(root)
    if not any((args.id, args.goal, args.path, args.test, args.accept, args.next_action, args.stage)):
        print_value(state.get("task", {}), as_json=args.json)
        return 0
    task = state.setdefault("task", {})
    if args.id is not None:
        task["id"] = args.id
    if args.goal is not None:
        task["goal"] = args.goal
    if args.path:
        task["owned_paths"] = args.path
    if args.test:
        task["target_tests"] = args.test
    if args.accept:
        task["acceptance"] = args.accept
    if args.next_action is not None:
        state["next_action"] = args.next_action
    if args.stage is not None:
        state["stage"] = args.stage
    state["last_result"] = "IN_PROGRESS"
    write_json(root / STATE_PATH, state)
    print_value(task, as_json=args.json)
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Sayuri zero-latency developer helper")
    sub = p.add_subparsers(dest="command", required=True)

    def common(name: str, help_text: str) -> argparse.ArgumentParser:
        cmd = sub.add_parser(name, help=help_text)
        cmd.add_argument("--json", action="store_true", help="emit machine-readable JSON")
        return cmd

    state = common("state", "show compact live development state")
    state.set_defaults(func=command_state)

    recover = common("recover", "restore task context without a full repository audit")
    recover.set_defaults(func=command_recover)

    reindex = common("reindex", "regenerate deterministic repository/test index")
    reindex.set_defaults(func=command_reindex)

    check = common("check", "run targeted checks inferred from the current diff")
    check.add_argument("--dry-run", action="store_true", help="show selected checks without executing them")
    check.set_defaults(func=command_check)

    finish = common("finish", "check, checkpoint and optionally commit/push task-owned changes")
    finish.add_argument("--commit-message", help="create one guarded logical commit")
    finish.add_argument("--push", action="store_true", help="push the current non-main branch after commit")
    finish.add_argument("--allow-unrelated", action="store_true", help="allow unrelated dirty files to remain unstaged")
    finish.add_argument("--next-action", help="set next_action after successful checks")
    finish.set_defaults(func=command_finish)

    task = common("task", "show or update the current task manifest")
    task.add_argument("--id")
    task.add_argument("--goal")
    task.add_argument("--path", action="append", default=[])
    task.add_argument("--test", action="append", default=[])
    task.add_argument("--accept", action="append", default=[])
    task.add_argument("--next-action")
    task.add_argument("--stage")
    task.set_defaults(func=command_task)
    return p


def main() -> int:
    args = parser().parse_args()
    try:
        return int(args.func(args))
    except RuntimeError as exc:
        print(f"sayuri-dev: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
