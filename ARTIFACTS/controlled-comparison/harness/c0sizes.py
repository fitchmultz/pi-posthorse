#!/usr/bin/env python3
"""Size of every Commit0 library skeleton: stubbed functions, source lines, official test count.

Usage: c0sizes.py ROWS_TSV REPOS_DIR   (ROWS_TSV: repo, base_commit, src_dir, test_dir, python per line)
A stub is a function or method whose body is only `pass` (after an optional docstring).
"""
import ast
import bz2
import sys
from pathlib import Path

import commit0


def stubs_and_lines(src):
    stubs = functions = lines = 0
    for path in src.rglob("*.py"):
        if any(part in ("tests", "test", "testing") for part in path.relative_to(src).parts):
            continue
        text = path.read_text(errors="replace")
        lines += text.count("\n")
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions += 1
                body = node.body
                if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
                    body = body[1:]
                stubs += len(body) == 1 and isinstance(body[0], ast.Pass)
    return stubs, functions, lines


def main():
    ids_dir = Path(commit0.__file__).parent / "data" / "test_ids"
    for line in Path(sys.argv[1]).read_text().splitlines():
        repo, _, src_dir, test_dir, python = line.split("\t")
        name = repo.split("/")[-1]
        stubs, functions, lines = stubs_and_lines(Path(sys.argv[2]) / name / src_dir)
        ids_file = ids_dir / f"{name.lower().replace('.', '-')}.bz2"
        tests = len(bz2.open(ids_file, "rt").read().split("\n")) if ids_file.exists() else -1
        print(name, stubs, functions, lines, tests, python, sep="\t")


if __name__ == "__main__":
    main()
