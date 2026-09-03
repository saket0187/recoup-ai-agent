from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np


class DatasetError(Exception):
    pass


@dataclass(frozen=True)
class UpliftDataset:
    x_case: np.ndarray
    action_keys: np.ndarray
    action_encodings: dict[str, np.ndarray]
    baseline_action_key: str
    y: np.ndarray
    treated: np.ndarray
    propensity: np.ndarray
    groups: np.ndarray
    amount_paise: np.ndarray
    actions: np.ndarray
    policy_constrained: np.ndarray
    feature_names: list[str]
    digest: str

    def __len__(self) -> int:
        return int(self.x_case.shape[0])

    @property
    def n_features(self) -> int:
        return len(self.feature_names)

    def compose(self, index: np.ndarray, action_key: str) -> np.ndarray:
        block = self.action_encodings[action_key]
        tiled = np.tile(block, (index.shape[0], 1))
        return np.hstack([self.x_case[index], tiled])

    def as_logged(self, index: np.ndarray) -> np.ndarray:
        blocks = np.asarray([self.action_encodings[key] for key in self.action_keys[index]])
        return np.hstack([self.x_case[index], blocks])

    def baseline(self, index: np.ndarray) -> np.ndarray:
        return self.compose(index, self.baseline_action_key)

    def treatment_action_keys(self, minimum: int = 100) -> list[str]:
        keys, counts = np.unique(self.action_keys[self.treated > 0.5], return_counts=True)
        return sorted(str(key) for key, count in zip(keys, counts, strict=True) if count >= minimum)

    def summary(self) -> str:
        treated = int(self.treated.sum())
        return (
            f"{len(self):,} decisions across {len(np.unique(self.groups)):,} cases, "
            f"{treated:,} acted / {len(self) - treated:,} waited, "
            f"{self.n_features} features, positive rate {self.y.mean():.3%}"
        )


def load_dataset(path: str | Path) -> UpliftDataset:
    path = Path(path)
    meta_path = path.with_suffix("").with_suffix(".meta.json")
    if not meta_path.exists():
        meta_path = Path(str(path).replace(".jsonl", ".meta.json"))
    if not meta_path.exists():
        raise DatasetError(
            f"no metadata beside {path}. Run `npm run export:training-data` to regenerate both."
        )

    meta = json.loads(meta_path.read_text())
    feature_names: list[str] = meta["featureNames"]

    rows = []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    if not rows:
        raise DatasetError(f"{path} is empty")

    x_case = np.asarray([row["xCase"] for row in rows], dtype=np.float64)
    action_encodings = {
        key: np.asarray(block, dtype=np.float64) for key, block in meta["actionEncodings"].items()
    }
    case_width = len(meta["caseFeatureNames"])
    action_width = len(meta["actionFeatureNames"])
    observed_width = len(rows[0]["xCase"])

    if observed_width != case_width or case_width + action_width != len(feature_names):
        raise DatasetError(
            f"rows carry {observed_width} case features against a manifest declaring "
            f"{case_width} of {len(feature_names)}; the export is inconsistent"
        )

    missing = set(np.unique([row["actionKey"] for row in rows])) - set(action_encodings)
    if missing:
        raise DatasetError(f"no encoding for actions {sorted(missing)}; the export is incomplete")

    propensity = np.asarray([row["propensity"] for row in rows], dtype=np.float64)
    if not np.all((propensity > 0) & (propensity <= 1)):
        raise DatasetError(
            "every logged propensity must be in (0, 1]; off-policy correction is "
            "undefined otherwise"
        )

    return UpliftDataset(
        x_case=x_case,
        action_keys=np.asarray([row["actionKey"] for row in rows]),
        action_encodings=action_encodings,
        baseline_action_key=meta["baselineActionKey"],
        y=np.asarray([row["y"] for row in rows], dtype=np.float64),
        treated=np.asarray([row["treated"] for row in rows], dtype=np.float64),
        propensity=propensity,
        groups=np.asarray([row["caseId"] for row in rows]),
        amount_paise=np.asarray([row["amountPaise"] for row in rows], dtype=np.float64),
        actions=np.asarray([row["action"] for row in rows]),
        policy_constrained=np.asarray([row["policyConstrained"] for row in rows], dtype=np.float64),
        feature_names=feature_names,
        digest=meta["datasetDigest"],
    )


def stabilised_weights(
    propensity: np.ndarray, treated: np.ndarray, clip: float = 10.0
) -> np.ndarray:
    marginal = np.where(treated > 0.5, treated.mean(), 1.0 - treated.mean())
    weights = marginal / np.clip(propensity, 1e-6, None)
    return np.clip(weights, 1.0 / clip, clip)
