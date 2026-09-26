# Measurement report

Seed `43`, 600 synthetic accounts per arm, bootstrap of 1,000 resamples for every interval.

Every figure below comes from a simulated world whose constants are assumptions, not
measurements. They are documented in `docs/simulation-assumptions.md`. Treat the sign and
the ordering as the claim; do not quote the rupee figures as though they were observed.

Uplift model `seed-42-45280de5ea5f`, evaluated out of sample on seed `43`.

## Across held-out seeds

The full agent against its randomised control on 7 seeds the model never saw. One seed
has only about 130 control cases, so a single seed swings by several points; the average
across seeds is the steadier read.

| Seed | Recovered fraction | Net ₹ per case | Recovery rate T vs C | Messages per case T vs C | Agent ahead |
|---|---:|---:|---|---|---|
| 43 | -2.25pp | ₹670.03 | 15.3% vs 17.2% | 1.15 vs 0.75 | no |
| 44 | 1.04pp | ₹237.27 | 15.0% vs 13.8% | 1.28 vs 0.80 | yes |
| 45 | 4.13pp | ₹720.89 | 14.4% vs 10.8% | 1.10 vs 0.63 | yes |
| 46 | -1.08pp | -₹55.60 | 14.3% vs 14.0% | 1.29 vs 0.87 | no |
| 47 | 3.15pp | ₹174.52 | 17.4% vs 12.7% | 1.17 vs 0.63 | yes |
| 48 | 3.69pp | ₹316.70 | 20.9% vs 16.4% | 1.30 vs 0.92 | yes |
| 49 | 2.66pp | ₹37.28 | 16.4% vs 16.4% | 1.19 vs 0.90 | yes |
| **Average** | **1.62pp** | **₹300.15** | **16.3% vs 14.5%** | 1.21 vs 0.79 | **5 of 7** |

## Headline: incremental recovery against a randomised control

Two estimators are reported. Absolute rupees per case is the figure people ask for, but its
variance is dominated by how much invoice sizes differ rather than by the treatment. The
recovered *fraction* of each billed amount removes that variance and is the more sensitive
test of whether the agent actually helped.

The stratified column re-weights each amount-band by failure-class stratum by its own share of
the cases, which is how the arms were assigned in the first place. It estimates the same
quantity with less variance, so it is the column to read.

| Configuration | Incremental ₹/case | 95% interval | Fraction | 95% interval | Stratified | 95% interval | Significant |
|---|---:|---|---:|---|---:|---|---|
| Full agent | ₹670.18 | [-₹69.41, ₹1.4k] | -1.85pp | [-9.28, 5.42]pp | -2.25pp | [-10.85, 4.66]pp | no |
| Without timing | ₹665.48 | [-₹79.15, ₹1.36k] | -2.45pp | [-10.48, 4.45]pp | -2.88pp | [-11.41, 3.99]pp | no |
| Without diagnosis | ₹560.94 | [-₹180.10, ₹1.24k] | -3.38pp | [-10.84, 3.92]pp | -3.83pp | [-12.84, 3.04]pp | no |
| Without uplift | ₹662.60 | [-₹50.59, ₹1.36k] | -2.45pp | [-10.09, 4.66]pp | -3.15pp | [-11.68, 3.33]pp | no |
| Without the policy gate | ₹352.74 | [-₹265.99, ₹904.12] | 6.04pp | [2.13, 9.60]pp | 5.87pp | [2.50, 9.59]pp | **yes** |
| Without the reviewer | ₹670.18 | [-₹83.95, ₹1.33k] | -1.85pp | [-9.31, 5.23]pp | -2.25pp | [-11.30, 4.44]pp | no |
| Without allocation | ₹670.18 | [-₹90.57, ₹1.35k] | -1.85pp | [-9.50, 5.21]pp | -2.25pp | [-11.35, 4.93]pp | no |
| Without the action-skill gate | ₹719.72 | [₹38.84, ₹1.38k] | -1.68pp | [-8.93, 5.12]pp | -2.14pp | [-10.28, 4.61]pp | no |
| Without the incumbent floor | ₹395.74 | [-₹314.56, ₹1.08k] | -4.86pp | [-12.12, 2.03]pp | -5.71pp | [-13.42, 2.11]pp | no |

Recovery bought with spend is not the same as recovery. The engine maximises value
net of what it spends, so this is the estimator that scores it on its own objective.

| Configuration | Incremental net ₹/case | 95% interval | Significant | Spend/case T vs C |
|---|---:|---|---|---|
| Full agent | ₹670.03 | [-₹63.48, ₹1.36k] | no | ₹0.38 vs ₹0.23 |
| Without timing | ₹665.32 | [-₹31.35, ₹1.38k] | no | ₹0.39 vs ₹0.23 |
| Without diagnosis | ₹561.07 | [-₹95.90, ₹1.28k] | no | ₹0.10 vs ₹0.23 |
| Without uplift | ₹662.40 | [-₹51.68, ₹1.31k] | no | ₹0.42 vs ₹0.23 |
| Without the policy gate | ₹352.49 | [-₹241.44, ₹917.88] | no | ₹0.54 vs ₹0.29 |
| Without the reviewer | ₹670.03 | [-₹31.52, ₹1.37k] | no | ₹0.38 vs ₹0.23 |
| Without allocation | ₹670.03 | [-₹118.60, ₹1.39k] | no | ₹0.38 vs ₹0.23 |
| Without the action-skill gate | ₹719.55 | [₹39.95, ₹1.42k] | **yes** | ₹0.37 vs ₹0.20 |
| Without the incumbent floor | ₹395.58 | [-₹339.45, ₹1.01k] | no | ₹0.38 vs ₹0.23 |

| Configuration | Recovery rate T vs C | Cases T / C |
|---|---|---|
| Full agent | 15.3% vs 17.2% | 502 / 128 |
| Without timing | 14.7% vs 17.2% | 502 / 128 |
| Without diagnosis | 13.9% vs 17.3% | 502 / 127 |
| Without uplift | 14.7% vs 17.2% | 502 / 128 |
| Without the policy gate | 8.4% vs 2.3% | 501 / 128 |
| Without the reviewer | 15.3% vs 17.2% | 502 / 128 |
| Without allocation | 15.3% vs 17.2% | 502 / 128 |
| Without the action-skill gate | 13.9% vs 15.6% | 502 / 128 |
| Without the incumbent floor | 11.6% vs 16.4% | 502 / 128 |

## What each layer contributes

Each row bootstraps the difference between the full agent's treatment arm and the same
arm with one layer disabled, on the same world and seed. This is a more powerful test
than either configuration against control, because it removes the between-world variance.

| Layer removed | Change in recovered fraction | 95% interval | Layer earns its place |
|---|---:|---|---|
| Without timing | 0.60pp | [-3.59, 5.18]pp | not detectable |
| Without diagnosis | 1.39pp | [-3.00, 5.58]pp | not detectable |
| Without uplift | 0.60pp | [-3.58, 4.98]pp | not detectable |
| Without the policy gate | 6.95pp | [2.57, 10.94]pp | **yes** |
| Without the reviewer | 0.00pp | [-4.97, 4.58]pp | not detectable |
| Without allocation | 0.00pp | [-4.38, 4.38]pp | not detectable |
| Without the action-skill gate | 1.39pp | [-3.18, 5.78]pp | not detectable |
| Without the incumbent floor | 3.78pp | [-0.40, 7.97]pp | not detectable |

A positive change means the full agent recovers more than the version without that layer,
so the layer is pulling its weight.

## Harm

| Configuration | Touches per case | Opt-outs | False dunning | Over-contact | Policy violations |
|---|---:|---:|---:|---:|---:|
| Full agent | 1.15 | 15 | 0 | 0 | 0 |
| Without timing | 1.15 | 14 | 0 | 0 | 0 |
| Without diagnosis | 0.63 | 3 | 0 | 0 | 0 |
| Without uplift | 1.29 | 20 | 0 | 0 | 0 |
| Without the policy gate | 1.34 | 20 | 0 | 0 | 943 |
| Without the reviewer | 1.15 | 15 | 0 | 0 | 0 |
| Without allocation | 1.15 | 15 | 0 | 0 | 0 |
| Without the action-skill gate | 1.12 | 16 | 0 | 0 | 0 |
| Without the incumbent floor | 1.05 | 17 | 0 | 0 | 0 |

A policy violation is a message that was actually sent despite a `DENY` or `DEFER` recorded against it.
Under the full agent this must be zero. The no-policy row is the counterfactual: it is
the same engine with compliance removed, and it exists to make the trade-off visible.

## What each ablation removes

| Configuration | What is disabled |
|---|---|
| Full agent | every layer enabled |
| Without timing | bandit arms stop being bucketed by day and hour, so timing cannot be learned |
| Without diagnosis | every failure is treated as AMBIGUOUS, so the playbook cannot specialise |
| Without uplift | scores raw success probability instead of uplift over doing nothing |
| Without the policy gate | the safety argument: what the same engine does with compliance removed |
| Without the reviewer | drafted copy goes out without an independent veto on what it may contain |
| Without allocation | every admissible action is sent, with no per-cycle budget or capacity limit |
| Without the action-skill gate | the model scores every action, including the ones it ranks no better than chance |
| Without the incumbent floor | the agent may fall below the fixed schedule when its own economics say to do nothing |

## System

| Configuration | Decisions | Propensity coverage | Unmapped | Dead-lettered | Replay |
|---|---:|---:|---:|---:|---:|
| Full agent | 14911 | 100.0% | 3.6% | 0 | 25.9s |
| Without timing | 14991 | 100.0% | 3.7% | 0 | 24.9s |
| Without diagnosis | 14941 | 100.0% | 3.8% | 0 | 23.8s |
| Without uplift | 15237 | 100.0% | 3.7% | 0 | 19.5s |
| Without the policy gate | 34251 | 100.0% | 4.4% | 0 | 253.0s |
| Without the reviewer | 14911 | 100.0% | 3.6% | 0 | 27.0s |
| Without allocation | 14911 | 100.0% | 3.6% | 0 | 27.0s |
| Without the action-skill gate | 14986 | 100.0% | 3.7% | 0 | 32.9s |
| Without the incumbent floor | 15182 | 100.0% | 3.7% | 0 | 24.2s |

## Not measured here

- **Allocation** and **model-in-the-loop** ablations are absent because those layers are
  not built. Reporting a bar for them would be fabricating a number.
- **Churn avoided** is not reported: the simulator models cancellation, but the engine
  never observes it, so attributing it would require reading latent state.
- Every arm shares one seed and one world, so differences are attributable to the
  configuration rather than to the population.
