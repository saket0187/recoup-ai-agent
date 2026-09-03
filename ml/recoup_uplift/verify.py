from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from .export import AGREEMENT_TOLERANCE, replay_scorer


class VerificationError(Exception):
    pass


def verify(model_path: Path, golden_path: Path) -> float:
    model = json.loads(model_path.read_text())
    golden = json.loads(golden_path.read_text())

    if model["version"] != golden["modelVersion"]:
        raise VerificationError(
            f"model is version {model['version']} but the golden vectors were produced "
            f"from {golden['modelVersion']}; retrain to regenerate both together"
        )

    rows = np.asarray(golden["rows"], dtype=np.float64)
    worst = 0.0

    for name, expected in golden["expected"].items():
        if name not in model:
            raise VerificationError(f"the model has no scorer named {name}")
        actual = replay_scorer(model[name], rows)
        worst = max(worst, float(np.abs(np.asarray(expected) - actual).max()))

    if worst > AGREEMENT_TOLERANCE:
        raise VerificationError(
            f"the committed model no longer reproduces its golden vectors "
            f"(worst difference {worst:.3g})"
        )

    return worst


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="recoup-verify",
        description="Check a committed uplift model against its frozen golden vectors.",
    )
    parser.add_argument("model", type=Path)
    parser.add_argument("golden", type=Path)
    args = parser.parse_args()

    try:
        worst = verify(args.model, args.golden)
    except VerificationError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1

    print(f"OK: {args.model} matches its golden vectors (worst difference {worst:.3g})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
