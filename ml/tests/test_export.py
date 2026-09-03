import numpy as np
import pytest
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from recoup_uplift.export import (
    ExportError,
    calibrate_base_score,
    replay_scorer,
    scorer_of,
    verify_scorer,
)


def _data(n: int = 400, seed: int = 0):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, 6))
    y = (x[:, 0] + 0.5 * x[:, 1] > 0).astype(float)
    return x, y


def _logistic_pipeline():
    return Pipeline([("scale", StandardScaler()), ("model", LogisticRegression(max_iter=1000))])


def test_linear_export_reproduces_the_fitted_decision_function():
    x, y = _data()
    model = _logistic_pipeline().fit(x, y)
    scorer = scorer_of(model)
    assert verify_scorer(scorer, model, x) < 1e-9


def test_tree_ensemble_export_reproduces_the_fitted_decision_function():
    x, y = _data()
    model = GradientBoostingClassifier(n_estimators=40, max_depth=3, random_state=0).fit(x, y)
    scorer = calibrate_base_score(scorer_of(model), model, x)
    assert verify_scorer(scorer, model, x) < 1e-9


def test_replay_matches_the_typescript_traversal_rule():
    tree = {
        "feature": [0, -2, -2],
        "threshold": [1.5, 0.0, 0.0],
        "left": [1, -1, -1],
        "right": [2, -1, -1],
        "value": [0.0, 7.0, 9.0],
    }
    scorer = {"kind": "tree_ensemble", "baseScore": 0.0, "learningRate": 1.0, "trees": [tree]}
    assert replay_scorer(scorer, np.array([[1.5]]))[0] == 7.0
    assert replay_scorer(scorer, np.array([[1.5001]]))[0] == 9.0


def test_verification_fails_loudly_on_a_corrupted_scorer():
    x, y = _data()
    model = _logistic_pipeline().fit(x, y)
    scorer = scorer_of(model)
    scorer["bias"] += 1.0
    with pytest.raises(ExportError, match="disagrees"):
        verify_scorer(scorer, model, x)


def test_an_unsupported_model_is_refused_rather_than_half_exported():
    from sklearn.ensemble import RandomForestClassifier

    with pytest.raises(ExportError, match="serving contract"):
        scorer_of(RandomForestClassifier(n_estimators=2).fit(*_data()))
