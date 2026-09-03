from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .dataset import UpliftDataset, stabilised_weights


class DegenerateFitError(Exception):
    pass


class Learner(Protocol):
    name: str
    complexity: int

    def fit(self, data: UpliftDataset, index: np.ndarray) -> None: ...

    def predict_uplift(self, x: np.ndarray, x_baseline: np.ndarray) -> np.ndarray: ...

    def predict_response(self, x: np.ndarray) -> np.ndarray: ...

    def to_contract(self, data: UpliftDataset, index: np.ndarray) -> dict: ...


def _logistic() -> Pipeline:
    return Pipeline(
        [
            ("scale", StandardScaler()),
            (
                "model",
                LogisticRegression(
                    max_iter=2000,
                    C=1.0,
                    solver="lbfgs",
                    random_state=0,
                ),
            ),
        ]
    )


def _boosted(depth: int, estimators: int, learning_rate: float) -> GradientBoostingClassifier:
    return GradientBoostingClassifier(
        n_estimators=estimators,
        max_depth=depth,
        learning_rate=learning_rate,
        subsample=1.0,
        min_samples_leaf=40,
        random_state=0,
    )


def _check_fittable(y: np.ndarray, label: str) -> None:
    if y.shape[0] == 0:
        raise DegenerateFitError(f"{label} arm is empty")
    if np.unique(y).shape[0] < 2:
        raise DegenerateFitError(f"{label} arm has a single outcome class, so no model is defined")


def _probabilities(model: Any, x: np.ndarray) -> np.ndarray:
    return np.asarray(model.predict_proba(x))[:, 1]


@dataclass
class SingleModelLearner:
    name: str
    factory: Callable[[], Any]
    complexity: int
    model: Any = field(default=None, repr=False)

    def fit(self, data: UpliftDataset, index: np.ndarray) -> None:
        x = data.as_logged(index)
        y = data.y[index]
        _check_fittable(y, "pooled")
        weights = stabilised_weights(data.propensity[index], data.treated[index])
        model = self.factory()
        model.fit(x, y, **_weight_kwarg(model, weights))
        self.model = model

    def predict_uplift(self, x: np.ndarray, x_baseline: np.ndarray) -> np.ndarray:
        return _probabilities(self.model, x) - _probabilities(self.model, x_baseline)

    def predict_response(self, x: np.ndarray) -> np.ndarray:
        return _probabilities(self.model, x)

    def to_contract(self, data: UpliftDataset, index: np.ndarray) -> dict:
        return {
            "estimator": "outcome_difference",
            "link": "logistic",
            "scorer": _exported(self.model, data.as_logged(index)),
        }


@dataclass
class TwoModelLearner:
    name: str
    factory: Callable[[], Any]
    complexity: int
    treated_model: Any = field(default=None, repr=False)
    control_model: Any = field(default=None, repr=False)

    def fit(self, data: UpliftDataset, index: np.ndarray) -> None:
        treated_mask = data.treated[index] > 0.5
        treated_index = index[treated_mask]
        control_index = index[~treated_mask]

        _check_fittable(data.y[treated_index], "treated")
        _check_fittable(data.y[control_index], "control")

        treated_model = self.factory()
        treated_weights = stabilised_weights(
            data.propensity[treated_index], data.treated[treated_index]
        )
        treated_model.fit(
            data.as_logged(treated_index),
            data.y[treated_index],
            **_weight_kwarg(treated_model, treated_weights),
        )

        control_model = self.factory()
        control_weights = stabilised_weights(
            data.propensity[control_index], data.treated[control_index]
        )
        control_model.fit(
            data.baseline(control_index),
            data.y[control_index],
            **_weight_kwarg(control_model, control_weights),
        )

        self.treated_model = treated_model
        self.control_model = control_model

    def predict_uplift(self, x: np.ndarray, x_baseline: np.ndarray) -> np.ndarray:
        return _probabilities(self.treated_model, x) - _probabilities(
            self.control_model, x_baseline
        )

    def predict_response(self, x: np.ndarray) -> np.ndarray:
        return _probabilities(self.treated_model, x)

    def to_contract(self, data: UpliftDataset, index: np.ndarray) -> dict:
        treated_mask = data.treated[index] > 0.5
        return {
            "estimator": "two_model",
            "link": "logistic",
            "treatedScorer": _exported(self.treated_model, data.as_logged(index[treated_mask])),
            "controlScorer": _exported(self.control_model, data.baseline(index[~treated_mask])),
        }


def _exported(model: Any, x: np.ndarray) -> dict:
    from .export import calibrate_base_score, scorer_of, verify_scorer

    scorer = calibrate_base_score(scorer_of(model), model, x)
    verify_scorer(scorer, model, x)
    return scorer


def _weight_kwarg(model: Any, weights: np.ndarray) -> dict:
    if isinstance(model, Pipeline):
        step = model.steps[-1][0]
        return {f"{step}__sample_weight": weights}
    return {"sample_weight": weights}


def candidate_learners() -> list[Learner]:
    return [
        SingleModelLearner("s-learner/logistic", _logistic, complexity=1),
        SingleModelLearner("s-learner/gbm-d2", lambda: _boosted(2, 200, 0.05), complexity=3),
        SingleModelLearner("s-learner/gbm-d3", lambda: _boosted(3, 300, 0.05), complexity=4),
        TwoModelLearner("t-learner/logistic", _logistic, complexity=2),
        TwoModelLearner("t-learner/gbm-d2", lambda: _boosted(2, 200, 0.05), complexity=5),
        TwoModelLearner("t-learner/gbm-d3", lambda: _boosted(3, 300, 0.05), complexity=6),
    ]
