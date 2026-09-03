# Measurement report

Seed `43`, 1200 synthetic accounts per arm, bootstrap of 1,000 resamples for every interval.

Every figure below comes from a simulated world whose constants are assumptions, not
measurements. They are documented in `docs/simulation-assumptions.md`. Treat the sign and
the ordering as the claim; do not quote the rupee figures as though they were observed.

Uplift model `seed-42-c473e5fa2342`, evaluated out of sample on seed `43`.

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
| Full agent | ₹1.42k | [-₹7.05k, ₹9.59k] | 2.14pp | [-4.07, 8.40]pp | 1.62pp | [-3.09, 5.88]pp | no |
| Without timing | ₹1.36k | [-₹7.98k, ₹10.32k] | 2.43pp | [-3.36, 8.73]pp | 1.89pp | [-2.50, 6.20]pp | no |
| Without diagnosis | ₹1.31k | [-₹7.43k, ₹10.95k] | 1.60pp | [-4.46, 7.28]pp | 1.30pp | [-2.90, 5.13]pp | no |
| Without uplift | ₹1.38k | [-₹8.81k, ₹10.42k] | 1.85pp | [-4.50, 8.20]pp | 1.33pp | [-3.08, 5.43]pp | no |
| Without the policy gate | ₹10.2k | [-₹1.01k, ₹22.85k] | 5.02pp | [-0.26, 10.80]pp | 4.54pp | [-0.55, 9.20]pp | no |
| Without the reviewer | ₹1.42k | [-₹7.17k, ₹10.17k] | 2.14pp | [-3.72, 8.29]pp | 1.62pp | [-2.85, 5.93]pp | no |
| Without allocation | ₹1.42k | [-₹8.42k, ₹9.63k] | 2.14pp | [-3.72, 7.95]pp | 1.62pp | [-3.16, 5.65]pp | no |
| Without the action-skill gate | ₹1.41k | [-₹7.79k, ₹9.82k] | 2.64pp | [-3.17, 8.62]pp | 2.05pp | [-2.18, 6.23]pp | no |
| Without the incumbent floor | ₹1.05k | [-₹8.19k, ₹9.42k] | -4.14pp | [-9.97, 1.50]pp | -5.08pp | [-9.52, -1.06]pp | **yes** |

Recovery bought with spend is not the same as recovery. The engine maximises value
net of what it spends, so this is the estimator that scores it on its own objective.

| Configuration | Incremental net ₹/case | 95% interval | Significant | Spend/case T vs C |
|---|---:|---|---|---|
| Full agent | ₹1.42k | [-₹7.78k, ₹10.12k] | no | ₹0.49 vs ₹0.04 |
| Without timing | ₹1.36k | [-₹8.31k, ₹10.05k] | no | ₹0.50 vs ₹0.04 |
| Without diagnosis | ₹1.31k | [-₹7.73k, ₹10.11k] | no | ₹0.03 vs ₹0.05 |
| Without uplift | ₹1.38k | [-₹8.21k, ₹9.88k] | no | ₹0.57 vs ₹0.04 |
| Without the policy gate | ₹10.2k | [-₹1.62k, ₹21.65k] | no | ₹0.86 vs ₹0.14 |
| Without the reviewer | ₹1.42k | [-₹7.91k, ₹10.43k] | no | ₹0.49 vs ₹0.04 |
| Without allocation | ₹1.42k | [-₹6.92k, ₹10.18k] | no | ₹0.49 vs ₹0.04 |
| Without the action-skill gate | ₹1.41k | [-₹7.92k, ₹10.49k] | no | ₹0.50 vs ₹0.04 |
| Without the incumbent floor | ₹1.05k | [-₹8.73k, ₹9.27k] | no | ₹0.53 vs ₹0.04 |

| Configuration | Recovery rate T vs C | Cases T / C |
|---|---|---|
| Full agent | 46.8% vs 44.7% | 1386 / 329 |
| Without timing | 47.1% vs 44.7% | 1386 / 329 |
| Without diagnosis | 46.9% vs 45.3% | 1386 / 329 |
| Without uplift | 46.5% vs 44.7% | 1386 / 329 |
| Without the policy gate | 56.5% vs 51.5% | 1387 / 328 |
| Without the reviewer | 46.8% vs 44.7% | 1386 / 329 |
| Without allocation | 46.8% vs 44.7% | 1386 / 329 |
| Without the action-skill gate | 47.3% vs 44.7% | 1386 / 329 |
| Without the incumbent floor | 40.5% vs 44.7% | 1386 / 329 |

## What each layer contributes

Each row bootstraps the difference between the full agent's treatment arm and the same
arm with one layer disabled, on the same world and seed. This is a more powerful test
than either configuration against control, because it removes the between-world variance.

| Layer removed | Change in recovered fraction | 95% interval | Layer earns its place |
|---|---:|---|---|
| Without timing | -0.29pp | [-4.03, 3.61]pp | not detectable |
| Without diagnosis | -0.07pp | [-3.67, 3.74]pp | not detectable |
| Without uplift | 0.29pp | [-3.46, 4.17]pp | not detectable |
| Without the policy gate | -9.69pp | [-13.44, -5.75]pp | **no, it costs recovery** |
| Without the reviewer | 0.00pp | [-3.79, 3.59]pp | not detectable |
| Without allocation | 0.00pp | [-3.68, 3.69]pp | not detectable |
| Without the action-skill gate | -0.51pp | [-4.26, 3.30]pp | not detectable |
| Without the incumbent floor | 6.27pp | [2.59, 9.86]pp | **yes** |

A positive change means the full agent recovers more than the version without that layer,
so the layer is pulling its weight.

## Harm

| Configuration | Touches per case | Opt-outs | False dunning | Over-contact | Policy violations |
|---|---:|---:|---:|---:|---:|
| Full agent | 1.14 | 57 | 0 | 0 | 0 |
| Without timing | 1.15 | 54 | 0 | 0 | 0 |
| Without diagnosis | 0.20 | 2 | 0 | 0 | 0 |
| Without uplift | 1.32 | 61 | 0 | 0 | 0 |
| Without the policy gate | 1.86 | 88 | 0 | 0 | 4407 |
| Without the reviewer | 1.14 | 57 | 0 | 0 | 0 |
| Without allocation | 1.14 | 57 | 0 | 0 | 0 |
| Without the action-skill gate | 1.15 | 53 | 0 | 0 | 0 |
| Without the incumbent floor | 1.17 | 52 | 0 | 0 | 0 |

A policy violation is a message that was actually sent despite a `DENY` recorded against it.
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
| Full agent | 25846 | 100.0% | 3.5% | 0 | 49.1s |
| Without timing | 25899 | 100.0% | 3.5% | 0 | 46.6s |
| Without diagnosis | 25606 | 100.0% | 3.3% | 0 | 38.9s |
| Without uplift | 26086 | 100.0% | 3.5% | 0 | 36.7s |
| Without the policy gate | 26165 | 100.0% | 3.8% | 0 | 77.3s |
| Without the reviewer | 25846 | 100.0% | 3.5% | 0 | 47.6s |
| Without allocation | 25846 | 100.0% | 3.5% | 0 | 46.4s |
| Without the action-skill gate | 25928 | 100.0% | 3.5% | 0 | 52.8s |
| Without the incumbent floor | 27254 | 100.0% | 3.5% | 0 | 45.5s |

## Not measured here

- **Allocation** and **model-in-the-loop** ablations are absent because those layers are
  not built. Reporting a bar for them would be fabricating a number.
- **Churn avoided** is not reported: the simulator models cancellation, but the engine
  never observes it, so attributing it would require reading latent state.
- Every arm shares one seed and one world, so differences are attributable to the
  configuration rather than to the population.
