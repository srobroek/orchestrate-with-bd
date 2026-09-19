"""The prose gate policy: errors fail, warnings and the score are reported.

One policy, two entry points:

    check-prose-report.py <report.json>
        Apply the policy to a complete slopvac JSON report written by another step.

    check-prose-report.py --gate <document>... [--profile <name>]
        Run prose-gate.py on the documents with the same interpreter, then apply the
        policy to what it printed. Run it through the pinned tool environment:
        `uvx --from slopvac==2.3.2 python scripts/check-prose-report.py --gate ...`.

prose-gate.py exits 1 for slopvac's own score threshold; that verdict is replaced by this
policy, so a document with warnings and a low score passes. Any other nonzero exit means
the tool did not complete and fails the job. When GITHUB_STEP_SUMMARY is set, the score
line is appended there so the number stays visible on every run without failing one.
"""

import json
import math
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = HERE / "prose-gate.py"


def validate(report: object) -> dict:
    """Return the summary of a complete report, or raise ValueError for an unusable one."""
    if not isinstance(report, dict):
        raise ValueError("report must be an object")
    documents = report.get("documents")
    if not isinstance(documents, list) or not documents:
        raise ValueError("report must contain checked documents")
    for document in documents:
        if not isinstance(document, dict) or document.get("unchecked") != []:
            raise ValueError("document has missing or unchecked rule coverage")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        raise ValueError("report must contain a summary")
    for field in ("documents", "words", "findings", "errors", "warnings", "suggestions"):
        value = summary.get(field)
        if type(value) is not int or value < 0:
            raise ValueError(f"summary.{field} must be a nonnegative integer")
    if summary["documents"] != len(documents):
        raise ValueError("summary document count disagrees with checked documents")
    score = summary.get("score")
    if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 100:
        raise ValueError("summary.score must be a finite number between 0 and 100")
    return summary


def run_gate(documents: list[str], profile: str) -> object:
    """Run prose-gate.py and return its JSON report, or exit when the tool did not complete."""
    command = [sys.executable, str(GATE), *documents, "--profile", profile, "--format", "json"]
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    # Exit 1 is slopvac's threshold verdict, replaced by the policy below. Anything else
    # means the tool did not run to completion.
    if result.returncode not in (0, 1):
        sys.exit(f"slopvac failed to run reliably (exit {result.returncode})\n{result.stderr.strip()}")
    if not result.stdout.strip():
        sys.exit(f"slopvac wrote no report (exit {result.returncode})\n{result.stderr.strip()}")
    try:
        return json.loads(result.stdout)
    except ValueError as exc:
        sys.exit(f"prose report invalid: {exc}")


def load_report(path: str) -> object:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        sys.exit(f"prose report invalid: {exc}")


def parse_args(argv: list[str]) -> tuple[list[str] | None, str | None, str]:
    """Return (gate documents, report path, profile). Exactly one of the first two is set."""
    profile = "normal"
    if "--profile" in argv:
        index = argv.index("--profile")
        if index + 1 >= len(argv):
            sys.exit("usage: --profile needs a value")
        profile = argv[index + 1]
        argv = argv[:index] + argv[index + 2 :]
    if argv[:1] == ["--gate"]:
        documents = argv[1:]
        if not documents:
            sys.exit("usage: check-prose-report.py --gate <document>... [--profile <name>]")
        return documents, None, profile
    if len(argv) != 1:
        sys.exit("usage: check-prose-report.py <report.json> | --gate <document>... [--profile <name>]")
    return None, argv[0], profile


def main() -> None:
    documents, report_path, profile = parse_args(sys.argv[1:])
    report = run_gate(documents, profile) if documents is not None else load_report(report_path)
    try:
        summary = validate(report)
    except ValueError as exc:
        sys.exit(f"prose report invalid: {exc}")

    score = summary["score"]
    errors = summary["errors"]
    warnings = summary["warnings"]
    line = f"slopvac score={score} errors={errors} warnings={warnings}"
    print(line)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        checked = ", ".join(documents) if documents is not None else f"{summary['documents']} document(s)"
        with open(step_summary, "a", encoding="utf-8") as handle:
            handle.write(f"- prose gate ({checked}): {line}\n")
    if errors:
        sys.exit(f"prose gate failed: {errors} error(s)")
    print("prose gate passed: no errors (warnings and the score do not fail the job)")


if __name__ == "__main__":
    main()
