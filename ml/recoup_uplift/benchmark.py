from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

import numpy as np
from sklearn.model_selection import KFold

from .evaluate import qini_coefficient
from .learners import _boosted, _logistic

HILLSTROM_URL = (
    "http://www.minethatdata.com/"
    "Kevin_Hillstrom_MineThatData_E-MailAnalytics_DataMiningChallenge_2008.03.20.csv"
)

HILLSTROM_CACHE = Path("data/hillstrom.csv")

PUBLISHED_QINI_FLOOR = 0.01


class BenchmarkError(Exception):
    pass


def download(url: str = HILLSTROM_URL, destination: Path = HILLSTROM_CACHE) -> Path:
    if destination.exists():
        return destination

    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {url}", file=sys.stderr)
    try:
        with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310
            destination.write_bytes(response.read())
    except Exception as error:
        raise BenchmarkError(
            f"could not download the benchmark dataset ({error}). It is optional; the "
            f"domain model does not depend on it."
        ) from error

    return destination


def load_hillstrom(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    try:
        import pandas as pd
    except ImportError as error:
        raise BenchmarkError("the benchmark needs pandas: pip install -e '.[benchmark]'") from error

    frame = pd.read_csv(path)
    frame = frame[frame["segment"] != "No E-Mail"].copy()

    treated = np.asarray(frame["segment"] == "Mens E-Mail", dtype=np.float64)
    y = np.asarray(frame["visit"], dtype=np.float64)

    features = frame.drop(columns=["segment", "visit", "conversion", "spend"])
    x = np.asarray(pd.get_dummies(features, drop_first=True), dtype=np.float64)

    return x, y, treated


def run(x: np.ndarray, y: np.ndarray, treated: np.ndarray, folds: int) -> dict[str, float]:
    designs = {
        "s-learner/logistic": _logistic,
        "s-learner/gbm-d3": lambda: _boosted(3, 300, 0.05),
    }
    scores: dict[str, float] = {}

    for name, factory in designs.items():
        splitter = KFold(n_splits=folds, shuffle=True, random_state=0)
        predictions = np.zeros_like(y)

        for train_index, test_index in splitter.split(x):
            model = factory()
            model.fit(np.hstack([x[train_index], treated[train_index, None]]), y[train_index])
            with_treatment = np.hstack([x[test_index], np.ones((test_index.size, 1))])
            without = np.hstack([x[test_index], np.zeros((test_index.size, 1))])
            predictions[test_index] = (
                model.predict_proba(with_treatment)[:, 1] - model.predict_proba(without)[:, 1]
            )

        scores[name] = qini_coefficient(predictions, y, treated)

    return scores


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="recoup-benchmark",
        description="Check the uplift learners against a real randomised trial.",
    )
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--data", default=str(HILLSTROM_CACHE))
    args = parser.parse_args()

    path = download(destination=Path(args.data))
    x, y, treated = load_hillstrom(path)

    print(
        f"Hillstrom email trial: {x.shape[0]:,} customers, {x.shape[1]} features, "
        f"{int(treated.sum()):,} treated, visit rate {y.mean():.3%}",
        file=sys.stderr,
    )

    scores = run(x, y, treated, args.folds)

    print("\n  Out-of-fold Qini on real randomised data:\n")
    for name, score in scores.items():
        print(f"    {name:24} {score:+.4f}")

    best = max(scores.values())
    verdict = "PASS" if best >= PUBLISHED_QINI_FLOOR else "FAIL"
    print(
        f"\n  {verdict}: best {best:+.4f} against a floor of {PUBLISHED_QINI_FLOOR:+.4f}.\n"
        f"  This says the learner code can recover a known treatment effect from a real\n"
        f"  experiment. It says nothing about the payments domain, where the effect sizes,\n"
        f"  the features and the confounding are all different.\n"
    )

    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
