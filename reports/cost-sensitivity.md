# Cost sensitivity

Seed `43`, 800 accounts per point. Only the annoyance component of contact cost
is varied; direct channel cost and risk cost are unchanged. A scale of 1 is the value in
`config/costs.yaml`. A scale of 0 means the agent treats contacting someone as free.

The question this answers: is the agent under-acting because contact is genuinely not worth it,
or because the assumed annoyance cost is too large relative to the uplift it can earn?

| Annoyance scale | Incremental fraction | 95% interval | Significant | Touches/case | Opt-outs | Recovery T vs C |
|---:|---:|---|---|---:|---:|---|
| 0 | -0.50pp | [-7.12, 5.37]pp | no | 1.48 | 36 | 14.8% vs 15.3% |
| 0.1 | -0.50pp | [-6.42, 5.67]pp | no | 1.46 | 33 | 14.8% vs 15.3% |
| 0.25 | -0.33pp | [-6.46, 5.84]pp | no | 1.34 | 29 | 15.0% vs 15.3% |
| 0.5 | -0.58pp | [-6.55, 5.25]pp | no | 1.31 | 34 | 14.1% vs 14.6% |
| 1 | 0.30pp | [-5.87, 6.43]pp | no | 1.19 | 25 | 15.0% vs 14.6% |
| 2 | 0.35pp | [-6.01, 7.11]pp | no | 1.03 | 19 | 14.4% vs 14.0% |
| 4 | -0.03pp | [-6.73, 5.79]pp | no | 0.87 | 12 | 14.1% vs 14.1% |

Opt-outs are the price of the extra contact. Read the two columns together: a scale that
recovers more while opting out many more customers has not found free money, it has
chosen a different point on the same trade-off.
