# Uplift training

Fits the model the decision engine uses to estimate **how much a given action
changes the chance a case is recovered**, relative to doing nothing.

Training lives here, in Python. Serving lives in `src/uplift/`, in TypeScript.
Nothing in the running system depends on this package: the trained model is a
committed JSON file, so `npm run demo`, `npm test` and `npm run measure` all work
on a clone with no Python installed.

## Setup

```bash
npm run ml:setup      # or: python3 -m venv .venv && ./.venv/bin/pip install -e '.[dev,benchmark]'
npm run ml:check      # ruff, pyright, pytest, golden-vector verification
```

## Retraining

```bash
npm run export:training-data    # writes reports/training-data.jsonl
npm run train:uplift            # writes fixtures/uplift-model.json + uplift-golden.json
npm test                        # the TypeScript suite checks the new golden vectors
```

Both output files are regenerated together and must be committed together. CI
fails if the model no longer reproduces its golden vectors.

## Why the split

Python is better at machine learning and TypeScript has to serve the prediction
inside a deterministic engine, so the boundary is a data file rather than a call.

Three properties keep that honest:

**One encoder.** `scripts/eval/export-training-data.ts` emits the case feature block
and a table of action feature blocks, both produced by the same TypeScript
function the engine calls at decision time. Python composes blocks but never
computes them, so the trainer cannot drift from the server.

**A verified export.** `export.py` re-implements `src/uplift/scorer.ts` exactly
and refuses to write any model whose replayed score differs from the fitted
model's own `decision_function` by more than 1e-9.

**Committed golden vectors.** The trainer freezes 64 encoded rows with their
scores. The TypeScript test suite and CI both re-derive them.

## What it fits

One row per logged decision: features as of that decision, the action taken, the
logged propensity, and whether the case recovered inside the attribution window.

Six candidates are compared, S-learner and T-learner, each over logistic
regression and gradient boosting at depth 2 and 3, under `GroupKFold` that holds
**whole cases** out, because one case contributes many decisions.

Two details matter more than the model family:

- **Propensity weighting.** Rows are weighted by the stabilised inverse of the
  logged propensity, clipped at 10×. The behaviour policy is known exactly here,
  which is what makes the off-policy correction well defined.
- **Every row in a comparison is scored under the same action.** Scoring a `WAIT`
  row under `WAIT` gives identically zero uplift, so ranking those against treated
  rows measures the encoding rather than the model. The first version of this
  evaluation did exactly that and reported a Qini three orders of magnitude too
  high.

Selection is the one-standard-error rule: the simplest candidate within one
standard error of the best score, because cross-validated Qini is itself an
estimate and chasing its maximum selects for a lucky fold split.

## Benchmark

```bash
npm run ml:benchmark
```

Downloads the Hillstrom MineThatData email trial. A real randomised experiment
over 42,694 customers, and scores the learners out of fold. It exists to test
the learner code and the Qini implementation against real data rather than
against our own simulator. It says nothing about the payments domain.

The dataset is downloaded on demand into `ml/data/` and git-ignored. No external
data is committed to this repository.
