import numpy as np
import pytest

from recoup_uplift.evaluate import (
    brier_score,
    calibration_table,
    log_loss,
    qini_coefficient,
    qini_curve,
)


def _split_population(n: int, effect: float, seed: int = 0):
    rng = np.random.default_rng(seed)
    treated = np.tile([1.0, 0.0], n // 2)
    responsive = np.zeros(n)
    responsive[: n // 2] = 1.0
    base = 0.1
    probability = base + effect * responsive * treated
    y = (rng.random(n) < probability).astype(float)
    return responsive, y, treated


def test_qini_is_zero_for_a_ranking_that_carries_no_information():
    _, y, treated = _split_population(20_000, effect=0.2)
    noise = np.random.default_rng(1).random(y.shape[0])
    assert abs(qini_coefficient(noise, y, treated)) < 0.02


def test_qini_rewards_a_ranking_that_finds_the_responders():
    responsive, y, treated = _split_population(20_000, effect=0.2)
    informed = qini_coefficient(responsive, y, treated)
    noise = qini_coefficient(np.random.default_rng(2).random(y.shape[0]), y, treated)
    assert informed > noise + 0.05


def test_qini_is_negative_when_the_ranking_is_inverted():
    responsive, y, treated = _split_population(20_000, effect=0.2)
    assert qini_coefficient(-responsive, y, treated) < 0


def test_qini_curve_ends_at_the_overall_incremental_response():
    responsive, y, treated = _split_population(2_000, effect=0.3)
    curve = qini_curve(responsive, y, treated)
    treated_total = y[treated > 0.5].sum()
    control_total = y[treated <= 0.5].sum()
    ratio = treated.sum() / (treated.shape[0] - treated.sum())
    assert curve[-1] == pytest.approx(treated_total - control_total * ratio, rel=1e-9)


def test_qini_is_zero_when_nobody_converts():
    y = np.zeros(100)
    treated = np.tile([1.0, 0.0], 50)
    assert qini_coefficient(np.random.default_rng(3).random(100), y, treated) == 0.0


def test_ties_are_broken_deterministically():
    y = np.array([1.0, 0.0, 1.0, 0.0])
    treated = np.array([1.0, 0.0, 1.0, 0.0])
    flat = np.zeros(4)
    assert qini_coefficient(flat, y, treated) == qini_coefficient(flat, y, treated)


def test_log_loss_and_brier_reward_a_confident_correct_prediction():
    y = np.array([1.0, 0.0])
    good = np.array([0.99, 0.01])
    bad = np.array([0.01, 0.99])
    assert log_loss(good, y) < log_loss(bad, y)
    assert brier_score(good, y) < brier_score(bad, y)


def test_calibration_table_covers_every_row():
    responsive, y, treated = _split_population(1_000, effect=0.2)
    table = calibration_table(responsive, y, treated, bins=4)
    assert sum(bucket["rows"] for bucket in table) == 1_000
