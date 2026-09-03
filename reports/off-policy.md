# Off-policy evaluation

Seed `43`, 300 accounts, 6,575 logged decisions.

Every decision the agent ever took recorded the probability with which it took it. That is what
makes it possible to score a policy the agent never ran, without running the simulator again.

Observed recovery within the attribution window: **4.15%** of decisions, under a
logging policy that explores. The first row below deterministically repeats whatever was logged,
so it drops the exploration and should score a little higher than the observed rate. It does.

| Target policy | IPS | SNIPS | Doubly robust | 95% interval (SNIPS) | Overlap | ESS |
|---|---:|---:|---:|---|---:|---:|
| Replay the logged action every time | 7.73% | 4.96% | 3.55% | [3.58%, 6.51%] | 100.00% | 3279 |
| Never act | 2.65% | 2.82% | 3.02% | [1.75%, 4.22%] | 74.02% | 3122 |
| The incumbent fixed schedule | 2.21% | 5.57% | 7.55% | [3.68%, 8.04%] | 28.67% | 1397 |
| Always retry, never message | 2.27% | 9.26% | 11.28% | [6.62%, 12.95%] | 16.20% | 916 |
| Always WhatsApp a nudge | 0.14% | 8.79% | 2.24% | [0.00%, 18.81%] | 0.44% | 26 |

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
