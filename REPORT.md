**English** | [中文](REPORT.zh.md)

# dsh-compaction-prune — effect measurement (A1 / A2)

> **Status of the claim under test.** `README.md` says the effect is
> **NOT VERIFIED**: no measurement demonstrates that enabling this plugin reduces
> compaction attempts. This report supplies that measurement. It does not
> confirm the claim — it **refutes the mechanism and shows the effect is
> arithmetically unreachable on the recorded corpus**, for a reason the plugin
> cannot fix from where it sits.

---

## 0. The limits of A2, stated first

**A2 is an arithmetic counterfactual, not a behavioural one.** It replays the
recorded event stream verbatim and asks only *"was there enough token room for
this prune to have kept the session under the compaction threshold?"* It does
**not** answer *"what would the agent have done next?"*

Concretely, that means three things.

**Pruning changes the agent's subsequent behaviour.** Every pruned tool result is
context the model no longer sees. Removing it changes the next assistant
message, which changes the next tool call, which changes everything downstream.
A2 freezes that feedback loop at the recorded branch: it holds each later
settlement's provider-reported `usage.inputTokens` exactly as recorded, and
subtracts only the reclaim the pruner would have won at the moment it acted.
The counterfactual trajectory is therefore a **lower bound on pressure**, not a
prediction of it. The post-prune agent might have grown the context faster, or
slower, or taken a different path entirely.

**Consequently, "avoided" in A2 means "arithmetically avoided", never
"behaviourally avoided".** A counterfactual total below the threshold is a
*necessary* condition for compaction not firing — it is not a sufficient one. A
counterfactual total still above the threshold, however, **is** decisive: if the
arithmetic does not even leave room, no behaviour could have avoided the
crossing. That asymmetry is what makes the negative result in §3 sound despite
the limitation.

**No behavioural question is answered here.** Whether the plugin reduces
compaction *attempts* in a live session remains unmeasured, because measuring it
requires the A3 experiment in §7, which was not run.

---

## 1. What was measured, and against what

| Layer | Question | Model calls |
|---|---|---|
| **A1** | Does the mechanism actually fire and act? | 0 |
| **A2** | Had the rule pruned at 35%, would the recorded curves still have crossed the compaction threshold? | 0 |
| **A3** | Does `mode: warn` vs `mode: prune` change compactions per session in a live session? | skipped, see §7 |

Every number below is reproducible:

```sh
npm run test:a1          # A1, in a real Cordis composition
npm run test:a2-selftest # A2 control: must reproduce the real curve exactly
npm run a2               # A2 over every recorded session
npm run a2:sweep         # A2 under alternative plugin configurations
npm run recon            # corpus survey: peak pressure vs both thresholds
npm run trace   -- <id>  # one session's trajectory against both thresholds
npm run decompose -- <id> # per-boundary pressure decomposition
```

### Corpus

`$DSH_HOME/sessions` — **57** session logs in format v4, pinned by
`tools/corpus-manifest.json`. **51** carry per-settlement usage, **50** replay
cleanly (1 inherited its whole prefix and published no settlements of its own),
and they contain **8 real compactions** across **2** sessions.

**The directory is live**, so absolute counts drift the moment anyone runs a
session. Every tool therefore accepts `--manifest` and the numbers below are the
pinned ones, taken at the manifest's `generatedAt`. `node tools/corpus.mjs build`
re-pins; `show` reports drift. The counts in this report were last regenerated at
**2026-10-04T13:21:12Z**; a later run over a longer corpus may differ, and the
command to check is `npm run corpus:show`.

The corpus is small and that is stated as a limit, not hidden: one session
produced 7 of the 8 compactions.

### How the numbers were obtained

Four facts underpin the measurement, each read from installed code rather than
documentation.

**The trajectory is exact.** `TokenMeter.measure()` reduces to

```
totalTokens = baseline.tokens + (surfaceTokens - anchorSurfaceTokens)
```

and `baseline.kind === 'usage'` whenever the provider's reported total is at
least the route-priced anchor estimate. On all **2,104** settlements of the
largest session the reading equaled the raw usage total **to the token, with zero
exceptions**. So `totalTokens` is the provider's own number, and pruning — which
perturbs only `surfaceTokens` — moves the curve by exactly the pruner's own
re-pricing. No heuristic scaling factor is involved.

**The two thresholds are the harness's own.**

- The plugin's trigger is `floor(contextWindow * triggerRatio)`; at the shipped
  `0.35` and a 1,000,000-token window that is **350,000**.
- Compaction's threshold is `floor(min(contextWindow * 0.8, contextWindow -
  reservedCompletionTokens - headroomTokens))`, from `resolveCompactSpec` in
  `@deepseek-ai/dsh-compaction-basic`. With `maxTokens: 256000` and the default
  65,536 headroom that is **678,464**.

**The window follows the route.** A session can be re-routed, and each route
declares its own window, so the window in force at a given log position is the
one belonging to the `request/context` of the header most recently folded before
it. The largest session used 4 header/model combinations, all declaring
1,000,000.

**The reclaim is the real pruner's.** Every counterfactual prune calls the actual
`ToolResultPruner.pruneContent()` on the actual recorded payload and prices the
before/after through the actual token meter. Nothing is simulated.

### Control

A2 ships a control: with `mode: off`, the counterfactual must equal the real
curve at every sample. Result over the pinned corpus: **50 sessions, 0
deviations, 0 prunes** (1 session skipped — it inherited its whole prefix and
published no settlements of its own, so it has no trajectory to analyse). A
replay that had drifted would fail here.

---

## 2. A1 — the decision path works; the execution path never runs

`npm run test:a1`. 41 checks, all passing, at **zero model cost**.

### 2.1 The decision path is correct and reachable

The plugin is booted through the **real Cordis Loader** from a real `cordis.yml`,
in a composition that mounts the real `llm`, `tokenMeter`, and `toolResultPruner`
services. With a resolvable window:

- `decide()` does **not** act below `triggerRatio × contextWindow`;
- it **does** act once the crossing happens (measured 50,266 against a 35,000
  trigger), and the log names both numbers;
- in `mode: warn` the same decision is logged and the surface is left untouched.

This closes the gap that made the effect unverifiable. `tests/loader-e2e.spec.mjs`
boots the plugin but **never mounts an `llm` service**, so `_ensureWindow()`
returns early, the window is never cached, `decide()` always reports
`context window unresolved`, and no observer can ever act. That composition can
only prove availability — which is exactly what `README.md` claims for it.

### 2.2 The pruner works when driven directly

On a detached session, `pruneSession()` returns a real result object
(`{ pruned: [...], charsRemoved }`), lands replacement surface events, records
matching `compaction/prune` shadow-price events, and the **real token meter**
prices a smaller surface afterwards. The mechanism the plugin needs exists.

### 2.3 DEFECT — `mode: prune` never lands a prune in a live session

This is the finding that changes the picture.

```
[PASS] the observer DID decide to prune (the rule fires)
[PASS] every prune attempt failed with the append re-entrancy error
[PASS] no prune ever succeeded
[PASS] stats.acted stays at zero in prune mode
[PASS] ZERO replacement surface events landed
[evidence] 3 identical failures; first:
           compaction-prune: prune failed: session append cannot reenter
           while another append is being published
```

**Every attempt fails, on every event, in every session.** The cause is
structural, not a race:

1. The plugin's `_observe()` runs from its `session/event` listener.
2. `Session.append()` (`@deepseek-ai/dsh-session`) sets its re-entrancy guard
   `entry.appending = true` **before** dispatching `session/event`, and clears it
   only in its `finally`.
3. Dispatching a synchronous `session/event` listener happens **inside** that
   window.
4. So when the observer calls `pruner.pruneSession(session)`, the pruner's own
   `session.append('compaction/prune', …)` re-enters a guarded append and throws.

A1 verifies each link independently:

- appending from **outside** a listener on the same live session works;
- a **detached** session has no such guard (so the guard is store-owned);
- **any** append from inside a `session/event` listener fails identically.

The consequence is that `this._stats.acted` stays at **0** in `mode: prune`
forever, while the `warn` branch increments it. The plugin is not slow or
occasionally unlucky: **`mode: prune` is inert in any real deployment.** Its
`catch` swallows the failure and logs at `warn` level, so the observable symptom
is silence, not an error.

The same two results reproduce on **real recorded tool-result payloads**: zero
replacements land in a live session, while the identical payloads on a detached
session yield real savings. The only difference between the two runs is store
attachment.

**`README.md`'s advice to "start with `mode: warn`" is therefore not merely
prudent — it is the only mode whose decision path is observable end to end.** No
deployment can currently reach the `prune` branch's side effect at all.

### 2.4 Three further failure modes, and one existence proof

`npm run failure-modes` reproduces all four of these. They matter because the
defect above is not the only way `prune` mode fails, and because one of them is
what a deployment with dsh-purge applied actually hits.

**A patched pruner turns the failure SILENT — and this is the deployed case.** On
this machine the harness's own
`dsh-compaction-tool-result-pruner/lib/index.js` has been rewritten by `dsh-purge`
to disable pruning outright:

```js
pruneContent(blocks) {
  // [dsh-purge] tool-result pruning disabled: results pass through unchanged.
  return null;
```

An overriding `pruneContent` that always returns `null` means `pruneSession()`
never appends anything — so the re-entrancy guard **never fires**. The plugin then
logs a *success*:

```
compaction-prune: pruned 0 node(s), 0 chars removed — 10030 >= 2800, 23616 chars removable
```

and `stats.acted` increments, and the cooldown arms. The failure has changed
shape: from **"throws and warns every event"** to **"silently reports success
while doing nothing"**. That is strictly worse for diagnosis. It also means the
defect in §2.3 is *unpatched-only*: **fixing the synchronous timing would not make
pruning work on this machine**, because the pruner is neutered upstream of it.

**A failed prune never arms the cooldown.** `_lastPrune.set()` sits *after*
`pruneSession()` returns, so a throw skips it, and `decide()` reports
`cooling down` only when the timestamp was set. On the live-session path this
makes every qualifying event retry and re-warn forever — 5 drives at
`cooldownMs: 60000` produced 5 failures and **zero** cooldown suppressions. The
`catch` in `_observe` guards the session against the exception but not the log
against flooding.

**`warn` mode can overstate recoverable characters.** `estimateRemovable()` sums
`block.text.length`, which is **UTF-16 code units**, while the pruner measures
**code points** (`Array.from(text).length`). On text with astral characters the
two differ by 2x: a 4,600-emoji tool result is 9,200 by the plugin's measure and
4,600 by the pruner's. The plugin reports **1,008 removable characters** on a node
the pruner will refuse to touch. Since `warn` is the recommended mode, this is the
number a deployer would read when deciding whether the plugin is worth enabling.

**An existence proof that the timing is the sole obstacle.** Review implemented a
deferred variant that dispatches its prune one microtask later, escaping the
append window. On the *same* mounted session with the *same* unpatched pruner: 7
decisions acted, **6 prunes landed**, 0 guard errors, 7 `compaction/prune` events.
The defect is not that the plugin's logic is wrong; it is entirely a
synchronous-call-site problem. That is also the constructive next step — but note
it does not help on this machine until the pruner patch in §2.4 is reverted.

---

## 3. A2 — even granting the plugin the effect, the arithmetic does not close

A2 deliberately **waives §2.3**. It asks what the plugin's rule would have bought
if its prune had landed, so the negative result below is not a consequence of the
defect.

### 3.1 Every session with compaction activity

Two measurement instants matter and are kept distinct throughout: the **last
settlement** before a compaction (what the model last reported) and the
**`compaction/start` commit** (after `compaction-basic` has already run its own
pruner). §3.2 tabulates the commit; this table and the prose use the last
settlement, because that is the instant at which the threshold was crossed.

| session | peak tokens | routed window | threshold | crossed for real | crossed counterfactually | compactions avoided |
|---|---|---|---|---|---|---|
| `session-13e1a104-…` | 678,722 | 1,000,000 | 678,464 | **1 of 1** | 0 | **1 of 1** |
| `session-c0acb35e-…` | 802,075 | 1,000,000 | 678,464 then **550,464** | **7 of 7** | 7 | **0 of 7** |

`session-c0acb35e` is **not a single-threshold session.** Its routed
`config.maxTokens` changed inside the session — 256,000 for the first five
compactions, then **384,000** for the last two — and because the threshold is
`min(0.8 x window, window - maxTokens - headroom)`, that moves it from 678,464 to
**550,464**. Reported per point, the seven over-threshold margins are:

```
+115,482  +118,319  +121,862  +123,611  +122,154   (threshold 678,464)
+121,427  +467                                     (threshold 550,464)
```

Corpus total: **8 real compactions, 1 avoided arithmetically.**

Both directions of the question are answered, and they disagree:

**The rule does fire.** `decide()` acted in **7 of 50** sessions at the last pin,
and it fired in **both** sessions that actually compacted — **8 of 8 real
compactions were preceded by an `act: true` decision.** Recall is perfect. The
threshold is not mis-set, and no real compaction went unanticipated.

That "7 of 50" is the one figure here that **grows on its own**. Compaction counts
are historical facts no later append can change, but whether the rule *fires* is
derived from the corpus contents, and the pinned set includes sessions still being
written — so their decision counts rise between runs. It is verified as a lower
bound (`>= 7`), and a run during this report's own writing observed 8. The
conclusions do not depend on the exact value: what matters is that the rule fires
reliably, and covers every real compaction.

**The avoidances are marginal, and only one materialised.** In
`session-13e1a104` the recorded curve crossed by **258 tokens** — 0.038% of the
1,000,000-token window. The plugin had already reclaimed 34,231 tokens on that
surface, so the counterfactual total lands 33,973 **below** threshold: genuinely
avoided, arithmetically. In `session-c0acb35e` the first five crossings were not
marginal at all: **115k–124k tokens** over, roughly **18%** of the window. The
last one was marginal — **+467** — and still was not avoided.

### 3.2 Why the arithmetic loses — the mechanism, measured

`npm run decompose -- c0acb35e` breaks the pressure down at each real compaction
using the meter's own per-node pricing. **These rows are measured at the
`compaction/start` commit**, i.e. after `compaction-basic` has already run its own
pruner — which is exactly why the reach column is what it is. `tools/verify-report.mjs`
re-derives every row below from the raw logs.

| compaction | totalTokens at commit | over threshold | tool/result share of surface | pruner reach left | over-budget nodes | session `compaction/prune` events |
|---|---|---|---|---|---|---|
| `13e1a104` seq 3696 | 678,750 | **286** | **39.06%** | **34,231** | 13 | **0** |
| `c0acb35e` seq 2948 | 775,452 | 96,988 | 17.30% | **0** | **0** | 21 |
| `c0acb35e` seq 5705 | 792,643 | 114,179 | 15.10% | **0** | **0** | 21 |
| `c0acb35e` seq 8541 | 800,666 | 122,202 | 13.34% | **0** | **0** | 21 |
| `c0acb35e` seq 11120 | 802,142 | 123,678 | 6.93% | **0** | **0** | 21 |
| `c0acb35e` seq 13998 | 800,853 | 122,389 | 11.74% | **0** | **0** | 21 |
| `c0acb35e` seq 18450 | 666,812 | 116,348 | 11.78% | **0** | **0** | 21 |
| `c0acb35e` seq 20233 | 551,013 | 549 | 17.16% | **0** | **0** | 21 |

The commit-instant margins differ from §3.1's settlement-instant margins (e.g.
96,988 versus 115,482 at seq 2948) because tool results land between the two
instants. Both are real; they are two moments of the same compaction.

**The split is the finding.** The 7 unavoided boundaries all report **exactly
zero** pruner reach — there is nothing left to take at the moment compaction
commits. The 1 avoided boundary is the only one with reach (34,231 tokens), and
it is also the only boundary whose session recorded **zero `compaction/prune`
events in its entire log**.

That correlation is not a coincidence, and it identifies the real mechanism.

**`compaction-basic` runs the same pruner before it commits.** This is source
code, not inference from timestamps. In `@deepseek-ai/dsh-compaction-basic`'s
`compactIfNeeded`, the pressure path is:

```js
// lib/index.js — compactIfNeeded, "pressure" branch
if (measurement.totalTokens < spec.thresholdTokens) return null;   // :941
if (prune !== void 0) {
  prune.pruneSession(agent.session);                               // :943
  measurement = meter.measure(agent.session);                      // :944  re-measure
}
if (measurement.totalTokens < spec.thresholdTokens) return null;   // :946
...
result = await this.compactRegion(range.start, range.end, ...)     // :956
```

and `compaction/start` is appended only inside `compactRegion`:

```js
const startEvent = session.append("compaction/start", lifecycle);  // :469
```

So the pruner is called at :943, the threshold is re-checked at :946, and the
compaction commit — the event every log records — happens later at :469. By the
time `compaction/start` is durable, the pruner has already emptied every
over-budget node, and a plugin that prunes "earlier" finds a surface with nothing
left to give. The log's ordering (21 `compaction/prune` events before each of the
7 `compaction/start` events) is the *consequence* of this call order, not the
evidence for it.

**The plugin is therefore strictly dominated by a pruner that already runs**,
whenever that pruner is mounted. Its only reachable contribution is in the branch
where compaction's own prune is **not** in play — which is precisely
`13e1a104`, where the session recorded no prune events at all.

**What the log does and does not say about that branch.** `13e1a104` recorded 1
compaction and **0** `compaction/prune` events, and its compaction crossed the
threshold by only **286 tokens** — far enough past it that the pressure path would
have run. Two explanations fit the evidence and the log cannot separate them:
the pruner was **not mounted** in that deployment, or that compaction took a path
that **skips** the pruner (a manual compaction, say). What can be stated is the
observable: **no prune ran, 13 over-budget nodes remained, and the plugin's rule
had 34,231 tokens of reach against a 286-token crossing.**

That reading also bounds the one positive result. The avoidance is an arithmetic
verdict computed by **waiving §2.3** — assuming the plugin's prune actually lands.
In a deployment where the pruner is absent, the plugin has nothing to call and no
avoidance is possible; in a deployment where the pruner is present, `§2.3`'s defect
stops the plugin from landing anything anyway. So the single avoided compaction
is best read as **the ceiling of the remaining opportunity, not as an outcome any
current deployment can realise.**

Two further ceilings bound even that branch:

**The plugin acts a long way from the threshold.** The trigger is 350,000 and the
threshold is 678,464 — a gap of **328,464 tokens**. The largest reclaim the plugin
ever achieved on a live surface was **24,462 tokens**, roughly **7%** of that gap.
Worst-gap-over-threshold divided by best-ever-reclaim is **5.1×**. The one
avoidance worked only because the recorded crossing was **258 tokens** — 0.038% of
the window.

Those two sessions also differ in composition, which is worth noting because it is
the workload `README.md` claims to serve. `13e1a104` was tool-heavy —
`tool/result` was **39.06%** of its priced surface, 211,640 tokens across 821,227
characters, with **13** nodes over the 8,192-character budget. `c0acb35e` was
assistant-heavy — `tool/result` only **7–17%** of its surface (103,203 tokens at
the first boundary, falling to 35,302), and at the commit boundary **zero**
over-budget nodes. The plugin's premise holds in the first and fails in the
second; only the first is a tool-result-dominated session, and it is the only one
where the rule had anything to work with.

**The pressure is not in the surface at all.** At seq 2948 the meter's own
`surfaceTokens` is 596,631 while `totalTokens` is 775,452; the baseline is the
provider's reported **793,946** and the surface delta is *negative*. Most of what
compaction compares is the provider's context occupancy, which no surface-local
rewrite reaches: assistant text alone is **446k–478k** of the priced surface
(56–58%), and the plugin prunes none of it by design.

This is not a tuning problem, and §4 shows it cannot be tuned away.

---

## 4. Parameter sweep — the verdict is configuration-invariant

`npm run a2:sweep` drives both compacting sessions through settings from the
shipped defaults to the most aggressive configuration the schema permits.

| configuration | session | compactions | avoided | prunes fired | tokens reclaimed |
|---|---|---|---|---|---|
| as shipped (`0.35`, min 2048, 60 s) | `13e1a104` | 1 | **1** | 2 | 44,970 |
| as shipped | `c0acb35e` | 7 | **0** | 8 | 61,396 |
| `minimumCharsRemoved: 0` | `13e1a104` | 1 | **1** | 83 | 44,970 |
| `minimumCharsRemoved: 0` | `c0acb35e` | 7 | **0** | 543 | 64,522 |
| `triggerRatio: 0.05` | `13e1a104` | 1 | **1** | 9 | 43,725 |
| `triggerRatio: 0.05` | `c0acb35e` | 7 | **0** | 13 | 61,396 |
| `0.05` + min 0 + `cooldownMs: 0` | `13e1a104` | 1 | **1** | 843 | 44,970 |
| `0.05` + min 0 + `cooldownMs: 0` | `c0acb35e` | 7 | **0** | **2,068** | 64,522 |
| control: `mode: off` | both | unchanged | **0** | 0 | 0 |

The last aggressive row is the decisive one: the plugin prunes on **2,068 of
2,104 settlements** — it acts on essentially every event, at the lowest trigger
the schema allows, with no cooldown, reclaiming **more** than the shipped
configuration — and the avoided count is still **0**.

**More prunes did not buy more avoidance.** The reason is §3.2: after the first
pass over each over-budget node the reclaim is exhausted, so each additional
prune is a no-op on the total. `13e1a104` gained 44,970 tokens of reclaim on its
very first prune and never needed another.

---

## 5. The structural reason the claim cannot hold

The plugin's premise is that running the same pruner earlier reclaims more. The
measurements show four things that break it.

**The pruner already runs before the threshold is crossed, and empties the
surface.** `compaction-basic`'s pressure path measures, confirms the crossing,
calls `prune.pruneSession(session)`, **re-measures**, and only then writes
`compaction/start`. All 7 unavoided boundaries sit in a session whose log shows 21
`compaction/prune` events preceding its 7 compactions, and at every one of those
boundaries the plugin's reach is **exactly 0**. There is no "earlier" left to be:
the plugin's whole strategy is to do, sooner, a thing that is already done.

**Its one success is in the branch where that pruner is absent.** The single
avoided compaction is in the only session with **no `compaction/prune` events at
all** — the one deployment where the surface was never pruned. There the plugin
had 34,231 tokens of reach against a 286-token crossing and closed it. So the
plugin's value is real but **conditional on the pruner not being in play**, which
is the opposite of the composition `README.md` describes. And because it is a
waived-defect arithmetic verdict (§3.2), it is a ceiling on the opportunity
rather than a realisable outcome.

**The trigger and the threshold are separated by more than the plugin can
supply.** 328,464 tokens of gap against 24,462 tokens of best-case reclaim.

**The dominant pressure is unreachable.** 56–58% of the priced surface is
assistant text the plugin never touches, and `totalTokens` is anchored to the
provider's reported occupancy rather than to the recyclable surface.

So the honest statement of the effect is: **the plugin reduces neither compaction
attempts nor compaction triggers on this corpus, arithmetically — and in a real
deployment it cannot even execute its prune.** The one avoidance found is real
but fragile: a **258-token** crossing in a session where nothing else was pruning.
It says the rule *can* matter at the margin, not that it *does* matter in
general.

---

## 6. What this does and does not establish

**Established.**

- The plugin loads, configures, and rejects bad config through the real Loader.
- Its decision rule fires correctly, and on this corpus it fired before **8 of 8**
  real compactions.
- **`mode: prune` never lands a prune in a live session.** `Session.append()`'s
  re-entrancy guard rejects every attempt; with the unpatched pruner `stats.acted`
  stays at 0, and with the **patched (deployed) pruner the failure becomes a
  silently logged success**. Both are defects affecting real deployments, not test
  artefacts.
- Three further failure modes reproduce: a failed prune never arms the cooldown
  (so every event retries forever), `warn` mode overstates recoverable characters
  on astral text by up to 2x, and a detached session receives no events at all.
- A deferred dispatch on the same mounted session lands 6 prunes with 0 guard
  errors — so the synchronous call site, not the plugin's logic, is the obstacle.
- Granting the plugin its effect, **7 of 8 compactions remain arithmetically
  unavoidable**. At all 7 the pruner's remaining reach is **exactly 0**, because
  `compaction-basic` had already run the same pruner and re-measured.
- The 1 avoidance sits in the only session where that pruner never ran, and
  cleared a **258-token** crossing (0.038% of the window).
- The verdict is invariant across the whole legal configuration space.

**Not established.**

- **Behavioural** avoidance. A2 holds the recorded branch fixed; the agent would
  have behaved differently. See §0.
- Whether A1's defect fully explains the absence of real-world effect. It is a
  sufficient explanation, not necessarily the only one.
- Generalisation beyond this corpus: 8 compactions across 2 sessions, one of them
  producing 7. A corpus dominated by huge, sparsely-flagged tool output — which
  is the workload `README.md` claims to serve — might behave differently. **This
  corpus does not contain that workload**, and that is itself worth knowing.
- Anything about `mode: warn`'s cost. It evaluates every event and logs at
  `debug`; no measurement of its overhead was taken.

---

## 7. A3 was not run, and why

A3 (`mode: warn` for a stretch, then `mode: prune` for a stretch, comparing
compactions per session) was **skipped**. The reason is not cost.

**A3 as specified is confounded in both arms.**

- In the `prune` arm the plugin **cannot execute**, per §2.3, so the arm measures
  a configuration that does nothing. `mode: prune` and `mode: off` are
  indistinguishable in a live session — A1 proves it directly.
- In the `warn` arm the plugin provably **never mutates the session**, so the arm
  is behaviourally identical to not installing the plugin at all.

A live A/B would therefore compare "no plugin" against "no plugin" and return
**zero difference** — not because the plugin fails to help, but because neither
arm can differ. Spending API quota on it would produce a null result whose cause
is already pinned down, at a fraction of the cost, by A1.

The experiment worth running instead is upstream: fix the re-entrancy problem so
`prune` can execute, *then* measure. Until then the A3 numbers would be
uninterpretable, and §3 already gives the arithmetic ceiling such a run would be
bounded by.

---

## 8. Independent verification

The numbers above were re-derived by a second party working from the raw
artifact bytes, **independently implementing** the multi-frame Zstandard frame
scanner (RFC 8878), the surface fold, the token-pricing heuristic, and
`pruneContent` — not importing this repository's tools. The existing tools were
used only for cross-checking.

| Claim | Verdict | Independent figure |
|---|---|---|
| v4 log count, clean decode, usable subset | **confirmed** | 57 / 57 / 51 |
| `compaction/start` count and distribution | **confirmed** | 8 across 2 sessions (1 + 7) |
| Per-point totalTokens, window, threshold, margin | **confirmed** | all 8 points |
| `compaction/prune` counts | **confirmed** | `13e1a104` = 0, `c0acb35e` = 21 |
| `c0acb35e` first boundary | **confirmed** | seq 2928 / 793,946 / +115,482 |
| `13e1a104` boundary | **confirmed** | seq 3692 / 678,722 / +258 |

Beyond the claims it was asked to check, the reviewer's independent surface
pricing matched this report's **to the token on all 9 sampling points** (including
`tool/result share = 0.211640/0.541783 = 0.39063610…`), and its independently
computed over-budget node count (13) and theoretical reclaim (34,231) matched
exactly. Its route-fold cross-check agreed on all five fields at all 8 boundaries.

Three things that review changed in this report:

- **A real error, now fixed.** §3.1 originally gave `session-c0acb35e` a single
  threshold of 678,464 and described every crossing as "115k–124k over". That
  session's `config.maxTokens` changed from 256,000 to **384,000** mid-session,
  which moves the threshold to **550,464**; the last two margins are +121,427 and
  **+467**, not 115k. The per-point table in §3.2 had it right; the prose did not.
- **A measurement-instant ambiguity, now stated.** §3.1 and §3.2 measure different
  instants (last settlement versus the `compaction/start` commit), and the two
  differ by the tool results that land between them — at `c0acb35e` seq 2948,
  by exactly the 18,494 tokens its six prunes removed. Both are real; the tables
  now say which is which.
- **A causal claim strengthened.** The reviewer correctly noted that "prune events
  precede `compaction/start` in the log" is only *ordering*, and does not by itself
  identify the caller. That objection is answered in §5 from source code rather
  than timestamps: `compactIfNeeded` calls the pruner at `:943` and
  `compaction/start` is appended only inside `compactRegion` at `:469`.

The reviewer also flagged what it could **not** verify: this report's A2-internal
accumulators (`pluginPrunes`, `tokensReclaimed`, `peakCounterfactual`) were not
independently recomputed. No numbered claim in §3.1 depends on them, but they are
the one family of figures here that rests on this repository's own engine alone.

## 9. Reproducing

```sh
cd E:\DSH-Lab\repo-v4\dsh-compaction-prune

npm run test:a1            # 41 checks: mechanism works, execution does not
npm run test:failure-modes # the four failure modes of §2.4, incl. the silent one
npm run test:a2-selftest   # control: 50 sessions reproduce the real curve exactly
npm run test:report        # re-derive every claim in this report from the raw logs
npm run a2                 # the A2 table (pinned to the corpus manifest)
npm run a2:sweep           # the configuration sweep
npm run recon              # corpus survey
npm run trace   -- c0acb35e
npm run decompose -- c0acb35e
npm run trigger-audit      # how each real compaction was triggered
npm run corpus:show        # report drift of the live sessions directory
```

Environment: Node v22.22.3, `@deepseek-ai/cordis` 4.0.4, `@deepseek-ai/dsh-session` /
`dsh-token-meter` / `dsh-compaction-tool-result-pruner` 0.2.0-rc.2,
`@deepseek-ai/dsh-compaction-basic` 0.2.0-rc.2 for the threshold formula.

Two environment notes.

- **`src/index.js` is unmodified.** Every measurement reads it or mounts it as
  shipped.
- **The harness installation's own copy of `dsh-compaction-tool-result-pruner`
  has been patched by `dsh-purge`** to disable pruning: its `pruneContent()`
  begins `// [dsh-purge] tool-result pruning disabled` / `return null`, with the
  original preserved as `index.js.dshpurge.bak`. Every measurement here uses this
  repository's **unpatched** copy from `node_modules`, so the pruner's real
  behaviour — not the neutered one — is what was measured. `tools/resolve-module.mjs`
  reports which tree each package resolved from, and flags the harness tree as
  tainted.

### Files

| File | Role |
|---|---|
| `tests/a1-mechanism.spec.mjs` | A1 — real Loader, real services, synthetic + recorded payloads |
| `tools/failure-modes.mjs` | The four execution failure modes of §2.4 |
| `tools/a2-counterfactual.mjs` | A2 engine, control, and configuration sweep |
| `tools/session-log.mjs` | Multi-frame Zstandard session-log reader |
| `tools/replay.mjs` | Faithful `Session` reconstruction from a recorded log |
| `tools/metrics.mjs` | Threshold formulas and route/window resolution |
| `tools/surface.mjs` | Incremental surface fold, cross-checked against `foldSurface` |
| `tools/recon.mjs` | Corpus survey |
| `tools/trace.mjs` | One session's trajectory |
| `tools/decompose.mjs` | Per-boundary pressure decomposition |
| `tools/trigger-audit.mjs` | How each real compaction was triggered |
| `tools/corpus.mjs` + `corpus-manifest.json` | Pins the analysed session set |
| `tools/resolve-module.mjs` | Harness-package resolution that flags patched trees |
