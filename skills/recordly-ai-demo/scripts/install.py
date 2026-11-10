#!/usr/bin/env python3
"""Install this skill for Claude Code, Codex / Gemini CLI (.agents) and Hermes Agent.

    python install.py -g              # global: every agent of this user (like `skills add -g`)
    python install.py                 # project: only the current working directory
    python install.py -g --deps       # also pip-install the optional extras (PyYAML, pywinauto)
    python install.py -g --agents claude hermes --copy
    python install.py -g --uninstall

Targets (global -g / project):
  claude  ~/.claude/skills/<name>         ./.claude/skills/<name>
  agents  ~/.agents/skills/<name>         ./.agents/skills/<name>     (Codex CLI, Gemini CLI alias)
  gemini  ~/.gemini/skills/<name>         ./.gemini/skills/<name>
  hermes  <HERMES_HOME|~/.hermes|%LOCALAPPDATA%/hermes>/skills/media/<name>   ./.hermes/skills/<name>
On Windows a directory junction is used (no admin rights needed); elsewhere a symlink.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
NAME = SKILL_DIR.name


def hermes_home() -> Path:
    if os.environ.get("HERMES_HOME"):
        return Path(os.environ["HERMES_HOME"])
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes"
    if sys.platform == "win32" and local.exists():
        return local
    return Path.home() / ".hermes"


def targets(global_scope: bool) -> dict:
    if not global_scope:
        project = Path.cwd()
        return {
            "claude": project / ".claude" / "skills" / NAME,
            "agents": project / ".agents" / "skills" / NAME,
            "gemini": project / ".gemini" / "skills" / NAME,
            "hermes": project / ".hermes" / "skills" / NAME,
        }
    home = Path.home()
    return {
        "claude": home / ".claude" / "skills" / NAME,
        "agents": home / ".agents" / "skills" / NAME,
        "gemini": home / ".gemini" / "skills" / NAME,
        "hermes": hermes_home() / "skills" / "media" / NAME,
    }


def install_deps() -> str:
    requirements = Path(__file__).resolve().parent / "requirements.txt"
    result = subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(requirements)], capture_output=True, text=True)
    if result.returncode != 0:
        return "pip failed: " + (result.stderr or result.stdout).strip()[-400:]
    return f"installed into {sys.executable}"


def is_link(path: Path) -> bool:
    """Symlink or Windows junction (os.readlink resolves both)."""
    try:
        os.readlink(path)
        return True
    except (OSError, ValueError):
        return False


def remove(path: Path) -> None:
    # Never rmtree a link: on older Pythons that would delete the skill sources it points to.
    if is_link(path):
        if path.is_symlink():
            path.unlink()
        else:
            os.rmdir(path)
    elif path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def overlaps_source(target: Path) -> bool:
    """True when `target` is (or contains) the real skill sources, e.g. because a parent folder
    like ~/.claude/skills is itself a link into this repository. A link created by this script
    is not an overlap: removing the link never touches what it points to."""
    if is_link(target):
        return False
    try:
        resolved = target.resolve()
    except OSError:
        return False
    source = SKILL_DIR.resolve()
    return resolved == source or source.is_relative_to(resolved)


def link(source: Path, target: Path, copy: bool) -> str:
    if overlaps_source(target):
        return "skipped (target already resolves to the skill sources)"
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink() or is_link(target):
        remove(target)
    if copy:
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", ".narration-cache"))
        return "copied"
    if sys.platform == "win32":
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(target), str(source)], capture_output=True, text=True)
        if result.returncode == 0:
            return "junction"
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", ".narration-cache"))
        return "copied"
    target.symlink_to(source, target_is_directory=True)
    return "symlink"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--agents", nargs="*", default=["claude", "agents", "gemini", "hermes"], choices=["claude", "agents", "gemini", "hermes"])
    parser.add_argument("--copy", action="store_true", help="copy instead of linking")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("-g", "--global", dest="global_scope", action="store_true", help="install for the user (all projects) instead of the current project")
    parser.add_argument("--deps", action="store_true", help="pip-install requirements.txt (PyYAML, pywinauto) for this Python")
    args = parser.parse_args()
    report = {"scope": "global" if args.global_scope else f"project {Path.cwd()}"}
    for agent in args.agents:
        target = targets(args.global_scope)[agent]
        if args.uninstall:
            if overlaps_source(target):
                report[agent] = "skipped (resolves to the skill sources)"
            elif target.exists() or target.is_symlink() or is_link(target):
                remove(target)
                report[agent] = f"removed {target}"
            else:
                report[agent] = "not installed"
            continue
        report[agent] = f"{link(SKILL_DIR, target, args.copy)} → {target}"
    if args.deps and not args.uninstall:
        report["deps"] = install_deps()
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if not args.deps:
        print("Optional extras: python install.py --deps   (PyYAML for YAML scripts, pywinauto for UIA actions)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
