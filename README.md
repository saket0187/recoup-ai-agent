# Recoup AI Agent

**Recovers what's recoverable. Stops when it isn't.**

Recoup AI Agent is an autonomous revenue-recovery agent for subscription and invoice
businesses. It watches for revenue at risk, works out why each payment failed, chooses the
cheapest intervention likely to work, executes it inside hard compliance and stopping
rules, and then measures how much money that actually brought back against a randomised
control group.

It handles three kinds of loss through one loop: failed payments, abandoned checkouts, and
overdue invoices.

The unusual part is the last step. Most recovery tooling reports gross amount recovered,
which is close to meaningless because most overdue payments arrive eventually whether you
chase or not. This agent holds one case in five out of its own reach, runs the old fixed
schedule on them, and reports only the difference, with a confidence interval, whether or
not that difference flatters it.

> The compliance rules here are engineering rules written against public regulatory
> sources. They are not legal advice. All data in this repository is simulated.

---

## Quick start

Node 22.6 or newer. No API keys, no database server, no native compilation.

```bash
npm install
npm run db:migrate
npm run demo          # 45 simulated days, full loop, under two minutes
```

To open the operator console instead:

```bash
npm run seed:console  # about a minute
npm run dev           # http://localhost:3000
```

`npm run check` runs the secret scan, formatter, type checker, linter and the 622 tests.

Retraining the model additionally needs Python 3.11+, and nothing else does. The trained
model is committed as JSON, so the demo, the tests and the measurement all run without it.

```bash
npm run ml:setup      # one-off virtualenv in ml/
npm run ml:check      # ruff, pyright, pytest, golden-vector verification
```

---

## Why this is an agent

It runs unattended over time and closes its own loop. Each cycle it perceives new gateway
events, updates its picture of every open case, decides what to do about each one, acts
through an outbox, reads what comes back, and revises. Nobody approves the individual
decisions. The work it replaces is a collections analyst deciding, case by case, who to
chase, how, when, and when to leave someone alone.

Four things separate it from a script that sends reminders on a timer:

**It decides rather than follows.** Every cycle it prices each available action against
doing nothing, and doing nothing frequently wins.

**It is bounded, and the bounds are outside the model.** A policy gate of 35 rules and a
stop gate of 18 conditions run as ordinary code, before and again at execution. A rule that
throws is counted as a refusal. No prediction can talk its way past them.

**It learns from its own logged behaviour.** Every decision stores the propensity with
which it was taken, which is what makes `npm run eval:offpolicy` able to score a policy the
agent never ran, from the log alone, with IPS, SNIPS and doubly-robust estimators reported
next to their effective sample size.

**It knows what it does not know.** The uplift model is scored per action during
cross-validation, and it may only rank an action whose Qini clears its own standard error.
On the current model that is 5 actions of 9. The other four are handed back to the
playbook rather than guessed at.

What it is not: there is no language model anywhere in the system. Message copy comes from
reviewed templates, and the intelligence is in the decision policy and the uplift model,
not in generation. Everything it does replays byte-identically from a seed.

---

## What happens to one failed payment

| Step         | What runs                                                              |
| ------------ | ---------------------------------------------------------------------- |
| **Detect**   | A signed webhook opens a case; what is owed is derived from the ledger |
| **Diagnose** | The bank's error code maps to one of 8 recovery classes                |
| **Decide**   | A playbook prices each option against doing nothing                    |
| **Gate**     | 35 compliance rules, then 18 stop conditions, both fail closed         |
| **Execute**  | Idempotent outbox; the stop gate runs again immediately before sending |
| **Measure**  | Against a randomised control arm, post-stratified, with intervals      |

Cohort health runs alongside it. When a `method × issuer` route starts failing, retries
into that route pause, and customers are not messaged about a failure that is ours or the
bank's.

---

## What the measurement says

Out of sample, on a seed the model never saw:

| Claim                     | Result                                                   |
| ------------------------- | -------------------------------------------------------- |
| Incremental recovery      | +1.62pp, 95% interval [-3.09, 5.88], **not significant** |
| Policy violations         | 0                                                        |
| Decisions with propensity | 100%                                                     |
| Audit chain               | verifies intact, checked in CI                           |

The headline is post-stratified by the amount-band by failure-class strata the arms were
assigned on. That is the same estimand as a plain difference of means, with about 28% less
variance, and on the current batch it moves the estimate down rather than up. The extra
precision is not cosmetic: removing the incumbent floor now measures **-5.08pp
[-9.52, -1.06]** against control, which the unstratified estimator could not separate from
zero.

**The revenue claim is parity, not a win.** The baseline is not a straw man: three retries,
one SMS and one email is roughly what a competent merchant already does. The agent contacts
about a third as often and lands in the same place. That is a real result, and it is not
the result anyone hopes for.

Ablation is more informative than the headline, because comparing configurations on the
same world removes the between-world variance:

| Layer removed                                                      | Change in recovered fraction | Earns its place    |
| ------------------------------------------------------------------ | ---------------------------: | ------------------ |
| The policy gate                                                    |                      -9.69pp | no, it costs money |
| The incumbent floor                                                |                      +6.27pp | **yes**            |
| Timing, diagnosis, uplift, reviewer, allocation, action-skill gate |                 within noise | not detectable     |

Only one layer is significant across every run, and it is the floor that stops the agent
regressing below the fixed schedule. The rest are reported as undetectable rather than
quietly dropped, because that is what the intervals say.

Every number above is regenerated by `npm run measure`, and the simulation constants behind
them are written down in `docs/simulation-assumptions.md` rather than buried in code.

---

## The model

Training runs in Python (`ml/`, scikit-learn). Serving runs in TypeScript. The boundary is
a committed JSON file, so a clone with no Python still runs everything.

Six candidates are compared under grouped cross-validation that holds whole cases out:
S-learner and T-learner, each over logistic regression and gradient boosting at depth 2 and 3. Selection uses the one-standard-error rule, taking the simplest candidate within one
standard error of the best, because cross-validated Qini is itself an estimate and chasing
its maximum selects for a lucky fold split. The current winner is an S-learner over
gradient boosting at depth 2, at **Qini 0.171 ± 0.011**.

Three things keep the language split honest:

- **TypeScript owns feature encoding.** The exporter emits the case block and a table of
  action blocks, both produced by the function the engine itself calls. Python composes
  blocks and never computes them, so train/serve skew is impossible by construction.
- **The export is verified, not trusted.** The exporter re-implements the TypeScript scorer
  and refuses to write a model whose replayed score differs by more than 1e-9.
- **Golden vectors are committed.** 64 encoded rows and their scores, re-derived by the
  TypeScript suite and by CI.

Per-action skill is the part worth arguing about. Cross-validated Qini ranges from
**+0.230** on `RETRY_CHARGE` down to **-0.443** on `MANDATE_REPAIR`, which is much worse
than random. The trainer exports that spread, and an action is trusted only when its Qini
clears its own standard error, which is the same one-standard-error discipline used to pick
the model. `SEND_NUDGE|SMS` at +0.041 ± 0.070 fails that test and is excluded, even though
its point estimate is positive.

The uplift machinery is separately validated on the Hillstrom email trial, a real
randomised experiment over 42,694 customers (`npm run ml:benchmark`). That tests the
statistics, not the payments domain, and the two claims are kept apart deliberately.

---

## Scoring a policy you never ran

```bash
npm run eval:offpolicy
```

Because every decision logged the probability with which it was taken, a policy the agent
never ran can be scored from the log alone. The report compares five, including doing
nothing and the incumbent schedule, under IPS, SNIPS and a doubly-robust estimator.

It reports overlap and effective sample size beside every estimate, which is the part that
matters: a policy far from the logged one scores whatever it likes on a handful of rows.
"Always WhatsApp a nudge" currently looks best in the table and has an effective sample
size of about 20, so it is not a finding, it is an artefact, and the report says so.

---

## Layout

```
src/
  runtime/     the composition root: one agent, assembled once
  core/        clock, seeded RNG, money, calendar, hashing, config
  domain/      enums and record types shared across layers
  providers/   two gateway adapters behind one port
  signal/      webhook receipt, case projection, degradation, root cause
  engine/      the cycle itself: orchestrator and case context builder
  decision/    playbook, EV scoring, bandit, control arm, feedback
  policy/      compliance rules, predicates, stop gate, escalation
  allocation/  budget and capacity constrained assignment
  review/      independent veto on drafted copy
  execution/   outbox, idempotency, dry run, kill switch
  inbound/     intent extraction, promises to pay, handoff
  uplift/      model contract and deterministic scorer
  measurement/ bootstrap intervals, ablations, off-policy estimators
  sim/         the synthetic world: accounts, latent state, outages
  db/          schema, migrations, hash-chained audit
  app/         landing pages, five-screen console, three API routes
ml/            Python trainer, evaluation, verified export
config/        policy, authority, costs, templates and calendar as YAML
tests/         622 tests across 35 files
```

`src/runtime/compose.ts` is the only place the agent is assembled. The webhook route and
the simulation harness both call it, so the thing under test is the thing that runs.

Anything with a threshold, cap or rate is configuration rather than code, so changing
policy does not mean changing the engine.

---

## Determinism

A given seed replays byte-identically. `Date.now`, `new Date`, `Math.random` and
`randomUUID` are banned by lint; the engine takes an injected `Clock`, a seeded `Rng` and
an `IdFactory`. Money is integer paise behind a branded type, and outstanding balances are
always derived from ledger events rather than stored. The audit log is append-only and hash
chained, each record over the previous hash plus its own canonical JSON.

`CONTRIBUTING.md` lists the constraints that will fail a change, and why each one exists.

---

## Integration

One webhook endpoint. Signatures are checked against the raw body with a constant-time
comparison before anything is parsed, and every outcome is a distinct status code so a
misconfigured integration is never mistaken for an accepted one.

```
POST /api/v1/events     202 accepted · 401 bad signature · 413 too large
                        422 schema mismatch · 503 secret not configured
GET  /api/v1/metrics    the same figures the console shows, as JSON
```

`DRY_RUN` defaults to true: every decision is made, gated and recorded, and nothing leaves
the process. Turning it off needs two independent signals, so the whole system can run
against production traffic in observation mode first.

---

## Licence

MIT. See `LICENSE`.
