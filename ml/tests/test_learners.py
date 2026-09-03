import json

import numpy as np
import pytest

from recoup_uplift.dataset import DatasetError, load_dataset, stabilised_weights
from recoup_uplift.learners import DegenerateFitError, SingleModelLearner, _logistic
from recoup_uplift.train import select_winner

CASE_FEATURES = ["amount", "age"]
ACTION_FEATURES = ["is_wait", "is_nudge"]


def _write_dataset(tmp_path, rows, *, digest="deadbeef"):
    path = tmp_path / "training-data.jsonl"
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    (tmp_path / "training-data.meta.json").write_text(
        json.dumps(
            {
                "featureNames": CASE_FEATURES + ACTION_FEATURES,
                "caseFeatureNames": CASE_FEATURES,
                "actionFeatureNames": ACTION_FEATURES,
                "baselineActionKey": "WAIT|",
                "actionEncodings": {"WAIT|": [1, 0], "SEND_NUDGE|SMS": [0, 1]},
                "datasetDigest": digest,
            }
        )
    )
    return path


def _row(index, *, treated, y, propensity=0.5):
    return {
        "caseId": f"case_{index // 2}",
        "decisionId": f"dec_{index}",
        "at": index,
        "arm": "TREATMENT",
        "action": "SEND_NUDGE" if treated else "WAIT",
        "channel": "SMS" if treated else None,
        "treated": 1 if treated else 0,
        "propensity": propensity,
        "y": y,
        "amountPaise": 1000,
        "verdict": "EXECUTE" if treated else "SUPPRESS",
        "policyConstrained": 0,
        "xCase": [float(index % 7), float(index % 3)],
        "actionKey": "SEND_NUDGE|SMS" if treated else "WAIT|",
    }


def test_dataset_composes_any_action_onto_any_case(tmp_path):
    rows = [_row(i, treated=i % 2 == 0, y=i % 3 == 0) for i in range(20)]
    data = load_dataset(_write_dataset(tmp_path, rows))

    index = np.arange(len(data))
    composed = data.compose(index, "SEND_NUDGE|SMS")

    assert composed.shape == (20, 4)
    assert np.all(composed[:, 2] == 0)
    assert np.all(composed[:, 3] == 1)
    assert np.array_equal(composed[:, :2], data.x_case)


def test_baseline_scores_every_row_as_doing_nothing(tmp_path):
    rows = [_row(i, treated=i % 2 == 0, y=i % 3 == 0) for i in range(10)]
    data = load_dataset(_write_dataset(tmp_path, rows))
    baseline = data.baseline(np.arange(len(data)))
    assert np.all(baseline[:, 2] == 1)


def test_a_zero_propensity_is_refused_because_it_breaks_the_correction(tmp_path):
    rows = [_row(i, treated=i % 2 == 0, y=i % 3 == 0) for i in range(10)]
    rows[0]["propensity"] = 0.0
    with pytest.raises(DatasetError, match="propensity"):
        load_dataset(_write_dataset(tmp_path, rows))


def test_missing_metadata_is_refused(tmp_path):
    path = tmp_path / "training-data.jsonl"
    path.write_text(json.dumps(_row(0, treated=True, y=1)) + "\n")
    with pytest.raises(DatasetError, match="no metadata"):
        load_dataset(path)


def test_stabilised_weights_are_clipped_at_both_ends():
    propensity = np.array([0.001, 0.5, 1.0])
    treated = np.array([1.0, 1.0, 0.0])
    weights = stabilised_weights(propensity, treated, clip=10.0)
    assert weights.max() <= 10.0
    assert weights.min() >= 0.1


def test_a_single_class_arm_is_refused_rather_than_fitted(tmp_path):
    rows = [_row(i, treated=i % 2 == 0, y=0) for i in range(20)]
    data = load_dataset(_write_dataset(tmp_path, rows))
    learner = SingleModelLearner("s-learner/logistic", _logistic, complexity=1)
    with pytest.raises(DegenerateFitError):
        learner.fit(data, np.arange(len(data)))


def test_uplift_is_zero_when_the_action_matches_the_baseline(tmp_path):
    rows = [_row(i, treated=i % 2 == 0, y=i % 3 == 0) for i in range(60)]
    data = load_dataset(_write_dataset(tmp_path, rows))
    learner = SingleModelLearner("s-learner/logistic", _logistic, complexity=1)
    learner.fit(data, np.arange(len(data)))

    index = np.arange(len(data))
    identical = learner.predict_uplift(data.baseline(index), data.baseline(index))
    assert np.allclose(identical, 0.0)


def _candidate(name, qini, stderr, complexity):
    return {
        "learner": name,
        "cvQini": qini,
        "cvQiniStdError": stderr,
        "complexity": complexity,
    }


def test_the_simplest_candidate_within_one_standard_error_wins():
    results = [
        _candidate("simple", 0.100, 0.02, complexity=1),
        _candidate("complex", 0.108, 0.02, complexity=4),
    ]
    assert select_winner(results)["learner"] == "simple"


def test_a_clearly_better_candidate_still_wins():
    results = [
        _candidate("simple", 0.050, 0.005, complexity=1),
        _candidate("complex", 0.200, 0.005, complexity=4),
    ]
    assert select_winner(results)["learner"] == "complex"
