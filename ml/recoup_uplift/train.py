from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import sklearn
from sklearn.model_selection import GroupKFold

from .dataset import UpliftDataset, load_dataset
from .evaluate import auuc, brier_score, calibration_table, log_loss, qini_coefficient
from .learners import DegenerateFitError, Learner, candidate_learners


class TrainingError(Exception):
    pass


MIN_ROWS_PER_ARM = 200


@dataclass
class ActionSkill:
    qini: float
    std_error: float
    rows: int
    folds: int


def _finite(value: float) -> float:
    return float(value) if np.isfinite(value) else 0.0


def is_trusted(skill: ActionSkill) -> bool:
    return bool(skill.folds > 1 and skill.qini - _finite(skill.std_error) > 0.0)


@dataclass
class FoldEvaluation:
    fold_qini: list[float]
    per_action_qini: dict[str, float]
    action_skill: dict[str, ActionSkill]
    response: np.ndarray
    reference_action: str
    reference_scores: np.ndarray


def _evaluate_action(
    learner: Learner, data: UpliftDataset, rows: np.ndarray, action_key: str
) -> tuple[np.ndarray, float]:
    tau = learner.predict_uplift(data.compose(rows, action_key), data.baseline(rows))
    return tau, qini_coefficient(tau, data.y[rows], data.treated[rows])


def cross_validate(learner: Learner, data: UpliftDataset, folds: int) -> FoldEvaluation:
    splitter = GroupKFold(n_splits=folds)
    action_keys = data.treatment_action_keys()
    if not action_keys:
        raise TrainingError("no action has enough acted-on rows to evaluate")

    fold_qini: list[float] = []
    weighted: dict[str, list[tuple[float, int]]] = {key: [] for key in action_keys}
    response = np.full(len(data), np.nan)
    reference = max(
        action_keys,
        key=lambda key: int(((data.action_keys == key) & (data.treated > 0.5)).sum()),
    )
    reference_scores = np.full(len(data), np.nan)

    for train_index, test_index in splitter.split(data.x_case, data.y, groups=data.groups):
        learner.fit(data, train_index)
        response[test_index] = learner.predict_response(data.as_logged(test_index))

        is_control = data.treated[test_index] <= 0.5
        total = 0.0
        support = 0

        for key in action_keys:
            acted = (data.treated[test_index] > 0.5) & (data.action_keys[test_index] == key)
            rows = test_index[acted | is_control]
            if rows.size == 0 or not acted.any():
                continue

            tau, score = _evaluate_action(learner, data, rows, key)
            if key == reference:
                reference_scores[rows] = tau

            count = int(acted.sum())
            weighted[key].append((score, count))
            total += score * count
            support += count

        fold_qini.append(total / support if support else 0.0)

    if np.isnan(response).any():
        raise TrainingError("cross-validation left rows unscored")

    per_action = {
        key: sum(score * count for score, count in entries)
        / max(1, sum(count for _, count in entries))
        for key, entries in weighted.items()
        if entries
    }

    action_skill: dict[str, ActionSkill] = {}
    for key, entries in weighted.items():
        if not entries:
            continue
        scores = np.asarray([score for score, _ in entries], dtype=np.float64)
        spread = (
            float(np.std(scores, ddof=1) / np.sqrt(scores.size))
            if scores.size > 1
            else float("inf")
        )
        action_skill[key] = ActionSkill(
            qini=per_action[key],
            std_error=spread,
            rows=sum(count for _, count in entries),
            folds=scores.size,
        )

    return FoldEvaluation(
        fold_qini, per_action, action_skill, response, reference, reference_scores
    )


def evaluate_candidates(data: UpliftDataset, folds: int) -> list[dict]:
    results: list[dict] = []

    for learner in candidate_learners():
        try:
            evaluation = cross_validate(learner, data, folds)
        except DegenerateFitError as error:
            print(f"  {learner.name:24} skipped: {error}", file=sys.stderr)
            continue

        mean = float(np.mean(evaluation.fold_qini))
        stderr = float(np.std(evaluation.fold_qini, ddof=1) / np.sqrt(len(evaluation.fold_qini)))
        scored = ~np.isnan(evaluation.reference_scores)

        results.append(
            {
                "learner": learner.name,
                "instance": learner,
                "complexity": learner.complexity,
                "evaluation": evaluation,
                "cvQini": mean,
                "cvQiniStdError": stderr,
                "cvAuuc": auuc(
                    evaluation.reference_scores[scored],
                    data.y[scored],
                    data.treated[scored],
                ),
                "outOfFoldLogLoss": log_loss(evaluation.response, data.y),
                "outOfFoldBrier": brier_score(evaluation.response, data.y),
            }
        )
        print(f"  {learner.name:24} qini {mean:+.4f} ± {stderr:.4f}", file=sys.stderr)

    if not results:
        raise TrainingError("every candidate learner failed to fit")

    return results


def select_winner(results: list[dict]) -> dict:
    best = max(results, key=lambda result: result["cvQini"])
    threshold = best["cvQini"] - best["cvQiniStdError"]
    contenders = [result for result in results if result["cvQini"] >= threshold]
    return min(contenders, key=lambda result: (result["complexity"], -result["cvQini"]))


def build_model(
    data: UpliftDataset,
    results: list[dict],
    winner: dict,
    version: str,
    seed: int,
) -> dict:
    everything = np.arange(len(data))
    winner["instance"].fit(data, everything)

    contract = winner["instance"].to_contract(data, everything)
    treated = int(data.treated.sum())

    return {
        "version": version,
        "featureNames": data.feature_names,
        **contract,
        "metrics": {
            "learner": winner["learner"],
            "cvQini": winner["cvQini"],
            "cvQiniStdError": winner["cvQiniStdError"],
            "cvAuuc": winner["cvAuuc"],
            "outOfFoldLogLoss": winner["outOfFoldLogLoss"],
            "outOfFoldBrier": winner["outOfFoldBrier"],
            "rows": len(data),
            "treatedRows": treated,
            "baselineRows": len(data) - treated,
            "positiveRate": float(data.y.mean()),
        },
        "actionSkill": {
            key: {
                "qini": skill.qini,
                "stdError": _finite(skill.std_error),
                "rows": skill.rows,
                "folds": skill.folds,
                "trusted": is_trusted(skill),
            }
            for key, skill in winner["evaluation"].action_skill.items()
        },
        "provenance": {
            "trainedAt": datetime.now(UTC).isoformat(timespec="seconds"),
            "datasetDigest": data.digest,
            "trainingSeed": seed,
            "trainer": f"recoup-uplift/scikit-learn {sklearn.__version__}",
            "candidates": [
                {
                    "learner": result["learner"],
                    "cvQini": result["cvQini"],
                    "cvQiniStdError": result["cvQiniStdError"],
                    "selected": result["learner"] == winner["learner"],
                }
                for result in results
            ],
        },
    }


GOLDEN_ROWS = 64


def write_golden_vectors(data: UpliftDataset, model: dict, path: Path) -> None:
    from .export import replay_scorer

    stride = max(1, len(data) // GOLDEN_ROWS)
    index = np.arange(0, len(data), stride)[:GOLDEN_ROWS]
    rows = data.as_logged(index)

    scorers = (
        {"treatedScorer": model["treatedScorer"], "controlScorer": model["controlScorer"]}
        if model["estimator"] == "two_model"
        else {"scorer": model["scorer"]}
    )

    path.write_text(
        json.dumps(
            {
                "modelVersion": model["version"],
                "rows": [[float(value) for value in row] for row in rows],
                "expected": {
                    name: [float(value) for value in replay_scorer(scorer, rows)]
                    for name, scorer in scorers.items()
                },
            },
            indent=2,
        )
        + "\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="recoup-train",
        description="Fit and select an uplift model for the Recoup decision engine.",
    )
    parser.add_argument("--data", default="../reports/training-data.jsonl")
    parser.add_argument("--out", default="../fixtures/uplift-model.json")
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--version", default=None)
    args = parser.parse_args()

    data = load_dataset(args.data)
    print(f"loaded {data.summary()}", file=sys.stderr)

    treated = int(data.treated.sum())
    if treated < MIN_ROWS_PER_ARM or len(data) - treated < MIN_ROWS_PER_ARM:
        raise TrainingError(
            f"need {MIN_ROWS_PER_ARM} rows in each arm to fit anything meaningful, "
            f"have {treated} acted and {len(data) - treated} waited"
        )

    print("cross-validating candidates (whole cases held out):", file=sys.stderr)
    results = evaluate_candidates(data, args.folds)
    winner = select_winner(results)

    if winner["cvQini"] <= 0:
        print(
            "\n  WARNING: the best candidate has a non-positive cross-validated Qini.\n"
            "  No learner here ranks who responds to treatment better than chance.\n"
            "  Shipping it anyway would give the engine confident noise.\n",
            file=sys.stderr,
        )

    version = args.version or f"seed-{args.seed}-{data.digest[:12]}"
    model = build_model(data, results, winner, version, args.seed)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(f"{json.dumps(model, indent=2)}\n")
    write_golden_vectors(data, model, out.with_name("uplift-golden.json"))

    evaluation: FoldEvaluation = winner["evaluation"]
    scored = ~np.isnan(evaluation.reference_scores)
    table = calibration_table(
        evaluation.reference_scores[scored], data.y[scored], data.treated[scored]
    )

    best = max(results, key=lambda result: result["cvQini"])
    print(f"\n  Uplift model: {out}\n")
    print(f"  selected                  {winner['learner']}")
    if winner["learner"] != best["learner"]:
        print(f"  (simplest within 1 s.e. of {best['learner']} at {best['cvQini']:+.4f})")
    print(f"  cross-validated qini      {winner['cvQini']:+.4f} ± {winner['cvQiniStdError']:.4f}")
    print(f"  out-of-fold log loss      {winner['outOfFoldLogLoss']:.4f}")
    print(f"  out-of-fold brier         {winner['outOfFoldBrier']:.4f}")
    print(f"  rows                      {len(data):,}")

    print("\n  Targeting quality per action (out-of-fold qini):")
    for key, skill in sorted(evaluation.action_skill.items(), key=lambda kv: -kv[1].qini):
        verdict = "used" if is_trusted(skill) else "NOT USED, not clear of its own error bar"
        print(
            f"    {key:34} {skill.qini:+.4f} ± {skill.std_error:.4f}  n={skill.rows:<6} {verdict}"
        )

    print(f"\n  Calibration under {evaluation.reference_action} (out of fold):")
    print(f"    {'rows':>8} {'predicted':>11} {'observed':>11} {'treated':>9} {'control':>9}")
    for bucket in table:
        print(
            f"    {bucket['rows']:>8.0f} {bucket['predicted']:>+11.4f} "
            f"{bucket['observed']:>+11.4f} {bucket['treated']:>9.0f} {bucket['control']:>9.0f}"
        )
    print(
        "\n  Predicted and observed should move together. If they do not, the engine is\n"
        "  multiplying a miscalibrated number by real money.\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
