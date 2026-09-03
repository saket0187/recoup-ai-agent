# Simulation assumptions

Every number in this file is an **assumption chosen by the author**, not a
measurement. None of it is calibrated against a real payment portfolio, because
no real portfolio was available. Results produced by the simulator are therefore
conditional on these values.

Each entry carries an honest provenance label:

| Label                | Meaning                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `structural`         | Encodes a mechanism, not a magnitude. The shape matters; the exact value does not.                                    |
| `estimate`           | The author's judgement. Plausible, unverified. This is where the risk lives.                                          |
| `calibration-target` | Drives headline output directly. Must be replaced with real data before any result is quoted outside this repository. |

Where a value is a `calibration-target`, the sensitivity section says what
happens to the reported result when it moves.

---

## 1. Population

| Constant                | Value                                                                                                       | Label      | Reasoning                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Portfolio mix           | 45% subscription, 35% one-time, 20% B2B invoice                                                             | `estimate` | A plausible mid-market Indian merchant. Chosen so all three recovery playbooks get meaningful volume.                                                  |
| Subscription amount     | lognormal, median ₹599, floor ₹99, ceiling ₹9,999                                                           | `estimate` | Spans the common Indian consumer subscription range.                                                                                                   |
| One-time amount         | lognormal, median ₹1,800, floor ₹200, ceiling ₹50,000                                                       | `estimate` | Typical D2C basket.                                                                                                                                    |
| B2B invoice amount      | lognormal, median ₹95,000, floor ₹5,000, ceiling ₹25,00,000                                                 | `estimate` | Mid-market receivable. Wide spread so the write-off floor and the human-approval ceiling both get exercised.                                           |
| Payment-method mix      | Subscription 55% UPI / 28% e-mandate / 17% card; checkout 62% UPI / 22% card; B2B 58% netbanking / 30% NACH | `estimate` | Reflects UPI dominance in Indian consumer payments and the persistence of netbanking and NACH in B2B. Directionally confident, precise values are not. |
| Issuer mix              | HDFC 22%, SBI 20%, ICICI 18%, AXIS 12%, then a tail                                                         | `estimate` | Needed only so cohort cells have unequal volume, which is what makes the minimum-volume gate meaningful.                                               |
| Language preference     | 46% Hinglish, 38% English, 16% Hindi                                                                        | `estimate` | Makes code-mixed handling the majority case rather than an afterthought.                                                                               |
| Mandate health at start | 88% active, 5% revoked, 4% expired, 3% paused                                                               | `estimate` | Gives the mandate-repair playbook a real population without dominating the run.                                                                        |

## 2. Archetype shares

| Archetype                 | Share          | Label        |
| ------------------------- | -------------- | ------------ |
| Ordinary                  | 62% (consumer) | `estimate`   |
| Serial promiser           | 6%             | `estimate`   |
| Disputer                  | 5%             | `estimate`   |
| Injector                  | 2%             | `structural` |
| Abusive                   | 2%             | `estimate`   |
| Vulnerable                | 3%             | `estimate`   |
| Wrong number              | 3%             | `estimate`   |
| TDS deductor              | 22% of B2B     | `estimate`   |
| AP clerk on a fixed cycle | 20% of B2B     | `estimate`   |

The injector share is `structural`: its purpose is to guarantee the red-team
path is exercised on every run, not to claim that 2% of real customers attempt
prompt injection. They almost certainly do not.

## 3. Outcome model

The model treats payment as four independent barriers:

```
P(pay in 24h) = hazard × awareness × ability × willingness × instrument
```

| Constant                  | Value                                                           | Label                | Reasoning                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DAILY_PAYMENT_HAZARD`    | 0.09                                                            | `calibration-target` | Sets the absolute recovery rate. A fully aware, able, willing customer pays with probability 0.09 per day, which compounds to roughly 60% over 30 days.                                                 |
| `AWARENESS_DECAY_DAYS`    | 14                                                              | `calibration-target` | How fast someone who forgot notices on their own. This is the single most important constant in the model: it sets how much uplift contact can possibly generate, because contact only sells awareness. |
| `REACH_MULTIPLIER`        | 2.2                                                             | `estimate`           | People read roughly twice as often as they reply, so reach is derived from reply propensity.                                                                                                            |
| Retry fatigue             | ×0.85 per prior attempt                                         | `estimate`           | Successive retries on the same instrument succeed less often; the easy wins go first.                                                                                                                   |
| Method authorisation rate | UPI 0.58, e-mandate 0.62, NACH 0.56, netbanking 0.52, card 0.44 | `estimate`           | Ordering is the load-bearing part: UPI and mandate-backed rails beat cards in India. The gaps are guesses.                                                                                              |
| Salary-window boost       | +0.22 ability, days 1–5                                         | `calibration-target` | Drives the entire retry-timing result. If this is zero, Thompson sampling over timing has nothing to learn and the timing ablation collapses.                                                           |
| Month-end dip             | −0.14 ability, last 5 days                                      | `estimate`           | The mirror of the salary effect.                                                                                                                                                                        |
| B2B pay-cycle swing       | +0.30 on cycle, −0.25 off cycle                                 | `estimate`           | Encodes "we pay on the 15th and 30th". Large by design so the B2B timing playbook is distinguishable from noise.                                                                                        |
| Contact fatigue           | up to −45% payment probability at the annoyance threshold       | `estimate`           | Prevents unbounded contact from being free.                                                                                                                                                             |

## 4. Harm

| Constant                       | Value                           | Label                | Reasoning                                                                                                                                                                        |
| ------------------------------ | ------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_OPT_OUT_HAZARD`           | 0.16                            | `calibration-target` | Ceiling on opt-out probability per contact once well past the annoyance threshold. Directly sets the harm metric that the aggressive-policy ablation is supposed to expose.      |
| Annoyance threshold            | mean 4.5 touches, ~1.4 spread   | `estimate`           | Number of touches before opt-out risk climbs steeply.                                                                                                                            |
| `BASELINE_CANCELLATION_HAZARD` | 0.01                            | `structural`         | Churn that happens with no contact at all. Must be non-zero, or the control arm never churns and "churn avoided" is inflated by construction.                                    |
| `DUNNING_CANCELLATION_HAZARD`  | 0.06                            | `calibration-target` | The sleeping-dog effect: how much over-contact multiplies churn. Six times the baseline at full over-contact. **This is the assumption the uplift result is most sensitive to.** |
| Voice intrusiveness            | 1.6× a text channel; email 0.5× | `estimate`           | Makes channel choice carry a real harm cost.                                                                                                                                     |

Cancellation is disabled for B2B invoices: an invoice cannot be churned.

## 5. World events

Defined in `fixtures/world.yaml`, with day 1 as the start date.

| Event                      | Window                                        | Label        | Purpose                                                                                                                                |
| -------------------------- | --------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| HDFC UPI degradation       | Day 3, 14:20–16:05, severity 0.94             | `structural` | Ground truth for root-cause attribution. Because the injected cell is known, attribution precision is measurable rather than asserted. |
| Public holiday             | Day 7, Day 33                                 | `structural` | Exercises the banking-day rule for NACH and e-mandate.                                                                                 |
| Festival week              | Days 12–16                                    | `structural` | Exercises the holiday-dunning deferral.                                                                                                |
| Merchant bad deploy        | Day 5, 11:00–11:40, `input_validation_failed` | `structural` | Ground truth for the merchant-defect class. Forty minutes so the detector must be prompt.                                              |
| Low-volume netbanking blip | Day 21, 03:10–04:00                           | `structural` | A cell with too little volume to alert on. Tests that the minimum-volume gate suppresses a false alarm.                                |

Bank holidays also follow the standing Indian rule that banks close on Sundays
and on the second and fourth Saturday of each month. That rule is factual, not
an assumption.

## 6. Tax deducted at source

| Constant                                              | Value                                                    | Label      |
| ----------------------------------------------------- | -------------------------------------------------------- | ---------- |
| Sections modelled                                     | 194Q 0.1%, 194C 1%/2%, 194J 2%/10%, 194H 5%, 194I 2%/10% | factual    | Statutory rates under the Income Tax Act.                                                                                                               |
| GST rates considered when recovering the taxable base | 0, 5, 12, 18, 28%                                        | factual    | Statutory slabs.                                                                                                                                        |
| Detection tolerance                                   | ₹1                                                       | `estimate` | Deductors round TDS to the rupee, so genuine variance should be under a rupee. Tightening this reduces false positives and increases missed detections. |
| Share of B2B payers who deduct                        | 22%                                                      | `estimate` |                                                                                                                                                         |

The rates are statutory. Which section applies to a given merchant is not
something the simulator can know, so it samples from 1%, 2% and 10%.

## 7. What this simulator deliberately does not model

Naming these matters more than the constants above, because they bound what any
result can mean.

- **Correlation between customers.** Each account is drawn independently. Real
  portfolios have shared shocks beyond the scripted world events.
- **Word of mouth and reputation.** Aggressive dunning has no reputational cost
  here beyond the individual's churn.
- **Partial-payment negotiation dynamics.** A customer either pays or does not;
  they never counter-offer an amount.
- **Seasonal demand.** Only the salary and festival cycles are modelled.
- **Instrument recovery over time.** An expired card is never spontaneously
  replaced without a prompt.
- **Any real message content effect.** Copy quality does not change outcomes;
  only channel, action type and timing do. A better-written message cannot beat
  a worse one in this world, so no result here supports a claim about copy.

## 8. Sensitivity, what to distrust

Ranked by how much the headline number moves when the assumption is wrong.

1. **`DUNNING_CANCELLATION_HAZARD` (0.06).** The entire uplift argument. "we
   contacted fewer people and did better", depends on over-contact being
   genuinely costly. If real churn induced by dunning is near zero, the
   uplift-targeting layer wins much less, and the honest conclusion becomes
   "contact everyone". If it is higher, targeting wins more. Nothing else in the
   build has this leverage.
2. **`AWARENESS_DECAY_DAYS` (14).** Sets the ceiling on achievable uplift. If
   people notice a failed payment in two days rather than fourteen, contact buys
   very little and measured incremental recovery falls sharply.
3. **Salary-window boost (+0.22).** If ability does not actually spike on
   payday, the retry-timing layer has nothing real to learn and its ablation bar
   should collapse to the baseline.
4. **`DAILY_PAYMENT_HAZARD` (0.09).** Moves gross recovery up and down, but
   affects treatment and control roughly equally, so the incremental figure is
   more robust to it than the gross figure is.
5. **`MAX_OPT_OUT_HAZARD` (0.16).** Sets the size of the harm metric, and so how
   damning the aggressive-policy ablation looks.

## 9. How to falsify this

The right way to use the simulator is not to trust it. Two checks are worth
running before any number is quoted:

- **Sweep the four `calibration-target` constants** across a plausible range and
  report the headline result as a band rather than a point.
- **Check the sign, not the magnitude.** The defensible claim is "targeting by
  uplift beats targeting by propensity under a wide range of assumptions". The
  indefensible claim is a specific rupee figure.
