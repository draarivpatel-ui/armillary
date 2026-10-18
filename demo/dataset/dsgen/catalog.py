"""Collects every session definition. Each module exposes sessions()."""

import importlib

MODULES = [
    "heroes_claude",
    "heroes_other",
    "proj_skyline_weather",
    "proj_nexus_gateway",
    "proj_aurora_docs",
    "proj_vortex_pipeline",
    "proj_zenith_cli",
]


def all_sessions():
    out = []
    for name in MODULES:
        out.extend(importlib.import_module(f"dsgen.{name}").sessions())
    keys = [s.key for s in out]
    assert len(keys) == len(set(keys)), "duplicate session keys"
    return out
