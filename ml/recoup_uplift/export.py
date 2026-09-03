from __future__ import annotations

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


class ExportError(Exception):
    pass


AGREEMENT_TOLERANCE = 1e-9


def scorer_of(model) -> dict:
    if isinstance(model, Pipeline):
        return _linear_scorer(model)
    if isinstance(model, GradientBoostingClassifier):
        return _tree_ensemble_scorer(model)
    raise ExportError(
        f"{type(model).__name__} has no representation in the serving contract. "
        f"Add one to src/uplift/scorer.ts before training with it."
    )


def _linear_scorer(pipeline: Pipeline) -> dict:
    scaler = pipeline.named_steps.get("scale")
    model = pipeline.named_steps.get("model")

    if not isinstance(scaler, StandardScaler) or not isinstance(model, LogisticRegression):
        raise ExportError("only a StandardScaler + LogisticRegression pipeline can be exported")

    coefficients = np.asarray(model.coef_, dtype=np.float64)
    intercept = np.asarray(model.intercept_, dtype=np.float64)
    means = np.asarray(scaler.mean_, dtype=np.float64)
    scales = np.asarray(scaler.scale_, dtype=np.float64)

    if coefficients.shape[0] != 1:
        raise ExportError("only binary logistic regression can be exported")

    return {
        "kind": "linear",
        "bias": float(intercept[0]),
        "weights": [float(value) for value in coefficients[0]],
        "means": [float(value) for value in means],
        "scales": [float(value) for value in scales],
    }


def _tree_ensemble_scorer(clf: GradientBoostingClassifier) -> dict:
    if clf.estimators_.shape[1] != 1:
        raise ExportError("only binary gradient boosting can be exported")

    trees = []
    for stage in clf.estimators_[:, 0]:
        tree = stage.tree_
        trees.append(
            {
                "feature": [int(value) for value in tree.feature],
                "threshold": [float(value) for value in tree.threshold],
                "left": [int(value) for value in tree.children_left],
                "right": [int(value) for value in tree.children_right],
                "value": [float(value) for value in tree.value[:, 0, 0]],
            }
        )

    return {
        "kind": "tree_ensemble",
        "baseScore": 0.0,
        "learningRate": float(clf.learning_rate),
        "trees": trees,
    }


def _score_linear(scorer: dict, x: np.ndarray) -> np.ndarray:
    weights = np.asarray(scorer["weights"])
    means = np.asarray(scorer["means"])
    scales = np.asarray(scorer["scales"])
    return scorer["bias"] + ((x - means) / scales) @ weights


def _score_tree(tree: dict, row: np.ndarray) -> float:
    node = 0
    while tree["feature"][node] >= 0:
        threshold = tree["threshold"][node]
        node = (
            tree["left"][node] if row[tree["feature"][node]] <= threshold else tree["right"][node]
        )
    return tree["value"][node]


def _score_ensemble(scorer: dict, x: np.ndarray) -> np.ndarray:
    out = np.full(x.shape[0], scorer["baseScore"], dtype=np.float64)
    for tree in scorer["trees"]:
        for i in range(x.shape[0]):
            out[i] += scorer["learningRate"] * _score_tree(tree, x[i])
    return out


def replay_scorer(scorer: dict, x: np.ndarray) -> np.ndarray:
    if scorer["kind"] == "linear":
        return _score_linear(scorer, x)
    return _score_ensemble(scorer, x)


def calibrate_base_score(scorer: dict, model, x: np.ndarray) -> dict:
    if scorer["kind"] != "tree_ensemble":
        return scorer

    sample = x[: min(256, x.shape[0])]
    raw = np.asarray(model.decision_function(sample), dtype=np.float64).ravel()
    without_base = _score_ensemble({**scorer, "baseScore": 0.0}, sample)
    offsets = raw - without_base

    spread = float(offsets.max() - offsets.min())
    if spread > 1e-6:
        raise ExportError(
            f"the ensemble's initial score is not constant (spread {spread:.3g}); "
            f"this exporter cannot represent that model"
        )

    return {**scorer, "baseScore": float(offsets.mean())}


def verify_scorer(scorer: dict, model, x: np.ndarray) -> float:
    expected = np.asarray(model.decision_function(x), dtype=np.float64).ravel()
    actual = replay_scorer(scorer, x)
    error = float(np.abs(expected - actual).max())

    if error > AGREEMENT_TOLERANCE:
        raise ExportError(
            f"the exported scorer disagrees with the fitted model by {error:.3g}, "
            f"above the {AGREEMENT_TOLERANCE:.0e} tolerance. The engine would serve "
            f"predictions that no reported metric describes."
        )

    return error
