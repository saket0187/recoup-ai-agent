# Cost sensitivity

Seed `43`, 800 accounts per point. Only the annoyance component of contact cost
is varied; direct channel cost and risk cost are unchanged. A scale of 1 is the value in
`config/costs.yaml`. A scale of 0 means the agent treats contacting someone as free.

The question this answers: is the agent under-acting because contact is genuinely not worth it,
or because the assumed annoyance cost is too large relative to the uplift it can earn?

| Annoyance scale | Incremental fraction | 95% interval | Significant | Touches/case | Opt-outs | Recovery T vs C |
|---:|---:|---|---|---:|---:|---|
| 0 | -0.11pp | [-6.68, 7.01]pp | no | 0.92 | 40 | 35.5% vs 35.7% |
| 0.1 | -0.63pp | [-7.82, 6.17]pp | no | 0.81 | 24 | 36.1% vs 36.8% |
| 0.25 | -8.93pp | [-16.77, -1.23]pp | **yes** | 0.60 | 22 | 36.2% vs 45.1% |
| 0.5 | 3.17pp | [-3.62, 9.28]pp | no | 0.58 | 18 | 37.2% vs 34.0% |
| 1 | -0.69pp | [-7.79, 5.71]pp | no | 0.45 | 19 | 36.1% vs 36.9% |
| 2 | -0.61pp | [-7.92, 6.25]pp | no | 0.39 | 12 | 37.3% vs 37.9% |
| 4 | 2.59pp | [-4.17, 9.31]pp | no | 0.30 | 9 | 38.7% vs 36.1% |

Opt-outs are the price of the extra contact. Read the two columns together: a scale that
recovers more while opting out many more customers has not found free money, it has
chosen a different point on the same trade-off.
