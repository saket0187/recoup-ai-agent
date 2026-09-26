# Off-policy evaluation

Seed `43`, 600 accounts, 14,911 logged decisions.

Every decision the agent ever took recorded the probability with which it took it. That is what
makes it possible to score a policy the agent never ran, without running the simulator again.

Observed recovery within the attribution window: **3.14%** of decisions, under a
logging policy that explores. The first row below deterministically repeats whatever was logged,
so it drops the exploration and should score a little higher than the observed rate. It does.

| Target policy | IPS | SNIPS | Doubly robust | 95% interval (SNIPS) | Overlap | ESS |
|---|---:|---:|---:|---|---:|---:|
| Replay the logged action every time | 4.46% | 3.28% | 1.28% | [2.53%, 4.08%] | 100.00% | 8579 |
| Never act | 1.72% | 1.78% | 1.07% | [1.36%, 2.27%] | 80.05% | 7692 |
| The incumbent fixed schedule | 1.69% | 5.45% | 11.24% | [3.97%, 7.32%] | 21.81% | 2431 |
| Always retry, never message | 1.27% | 6.30% | 13.04% | [4.72%, 8.51%] | 12.26% | 1532 |
| Always WhatsApp a nudge | 0.00% | 0.00% | 0.00% | [0.00%, 0.00%] | 0.09% | 10 |

**How to read this.** IPS is unbiased but high variance. SNIPS divides by the realised
weight rather than the sample size, which trades a little bias for much less variance and
is the column to read. Doubly robust adds a per-stratum outcome model, so it stays honest
if either the propensities or that model is right.

**Overlap** is the share of logged decisions where the target policy would have chosen
what actually happened. **ESS** is the effective sample size after weighting. A policy far
from the logged one has low overlap and low ESS, and its estimate should not be trusted
however tight the interval looks. Weights are clipped at 20x.

This is an observational estimate on simulated data. It ranks policies, it does not
measure them.
