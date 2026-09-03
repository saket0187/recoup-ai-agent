from __future__ import annotations

import numpy as np


def _ordered(scores: np.ndarray) -> np.ndarray:
    return np.lexsort((np.arange(scores.shape[0]), -scores))


def qini_curve(
    scores: np.ndarray,
    y: np.ndarray,
    treated: np.ndarray,
    weights: np.ndarray | None = None,
) -> np.ndarray:
    weights = np.ones_like(y) if weights is None else weights
    order = _ordered(scores)

    y_ordered = y[order] * weights[order]
    t_ordered = treated[order]
    w_ordered = weights[order]

    treated_response = np.cumsum(np.where(t_ordered > 0.5, y_ordered, 0.0))
    control_response = np.cumsum(np.where(t_ordered > 0.5, 0.0, y_ordered))
    treated_count = np.cumsum(np.where(t_ordered > 0.5, w_ordered, 0.0))
    control_count = np.cumsum(np.where(t_ordered > 0.5, 0.0, w_ordered))

    ratio = np.divide(
        treated_count,
        control_count,
        out=np.zeros_like(treated_count),
        where=control_count > 0,
    )
    return treated_response - control_response * ratio


def qini_coefficient(
    scores: np.ndarray,
    y: np.ndarray,
    treated: np.ndarray,
    weights: np.ndarray | None = None,
) -> float:
    n = scores.shape[0]
    if n == 0:
        return 0.0

    scale = float(np.sum(y * (treated > 0.5)))
    if scale <= 0:
        return 0.0

    curve = qini_curve(scores, y, treated, weights)
    random_line = curve[-1] * (np.arange(1, n + 1) / n)
    return float(np.trapezoid(curve - random_line, dx=1.0 / n) / scale)


def auuc(
    scores: np.ndarray,
    y: np.ndarray,
    treated: np.ndarray,
    weights: np.ndarray | None = None,
) -> float:
    n = scores.shape[0]
    if n == 0:
        return 0.0
    scale = float(np.sum(y * (treated > 0.5)))
    if scale <= 0:
        return 0.0
    curve = qini_curve(scores, y, treated, weights)
    return float(np.trapezoid(curve, dx=1.0 / n) / scale)


def brier_score(probabilities: np.ndarray, y: np.ndarray) -> float:
    if probabilities.shape[0] == 0:
        return 0.0
    return float(np.mean((probabilities - y) ** 2))


def log_loss(probabilities: np.ndarray, y: np.ndarray) -> float:
    if probabilities.shape[0] == 0:
        return 0.0
    clipped = np.clip(probabilities, 1e-9, 1 - 1e-9)
    return float(-np.mean(y * np.log(clipped) + (1 - y) * np.log(1 - clipped)))


def calibration_table(
    scores: np.ndarray,
    y: np.ndarray,
    treated: np.ndarray,
    bins: int = 5,
) -> list[dict[str, float]]:
    n = scores.shape[0]
    if n == 0:
        return []

    order = _ordered(scores)
    rows: list[dict[str, float]] = []

    for chunk in np.array_split(order, bins):
        if chunk.size == 0:
            continue
        treated_mask = treated[chunk] > 0.5
        control_mask = ~treated_mask
        treated_rate = float(y[chunk][treated_mask].mean()) if treated_mask.any() else float("nan")
        control_rate = float(y[chunk][control_mask].mean()) if control_mask.any() else float("nan")
        rows.append(
            {
                "rows": float(chunk.size),
                "predicted": float(scores[chunk].mean()),
                "observed": treated_rate - control_rate,
                "treated": float(treated_mask.sum()),
                "control": float(control_mask.sum()),
            }
        )

    return rows
