"""Run pinned slopvac with its supplementary Unicode range preserved."""

from importlib.metadata import version

from slopvac import rules
from slopvac.model import Category


_build_category = rules._build_category


def build_category(data: dict, origin: str) -> Category:
    category = _build_category(data, origin)
    for rule in category.rules:
        if rule.pattern:
            # Keep the emoji range literal for compatibility with slopvac's Vale rules.
            rule.pattern = rule.pattern.replace(
                r"\U0001F300-\U0001FAFF", "\U0001F300-\U0001FAFF"
            )
    return category


if __name__ == "__main__":
    if version("slopvac") != "2.3.2":
        raise SystemExit("prose-gate requires slopvac==2.3.2; review the adapter before upgrading")
    rules._build_category = build_category
    from slopvac.cli import main

    main()
