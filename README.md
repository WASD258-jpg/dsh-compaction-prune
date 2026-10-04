**English** | [中文](README.zh.md)

# dsh-compaction-prune

> **Translations in this repository are maintained by hand, not generated.**
> If you are reading this through a browser's built-in translation, the terms
> will not match the ones used here — `prune` becomes "trim", `compaction`
> becomes "compression", and the distinction the withdrawal depends on is lost.
> **[中文版在此](README.zh.md)**，术语与本文一致。

> ## ⚠️ Do not use this plugin. It has been measured and it does not work.
>
> The premise — that pruning tool results *earlier* than compaction would reduces
> how often compaction fires — is **false**, for two independent reasons:
>
> 1. **`compaction-basic` already prunes before it compacts, and re-measures.**
>    `compactIfNeeded` calls `prune.pruneSession(session)` at `index.ts:297` and
>    re-measures at `:298` before appending `compaction/start`. There is no
>    "earlier" left to occupy.
> 2. **In a live session the prune never lands.** `Session.append()` sets its
>    re-entrancy guard before dispatching `session/event`, so a prune from that
>    listener throws `session append cannot reenter while another append is being
>    published`. The plugin's `catch` swallows it; the symptom is silence.
>
> Replaying the recorded token trajectories and granting the plugin its full
> effect, **7 of 8 compactions remain unavoidable**; the one avoidance cleared a
> 258-token crossing in the only session where the pruner had never run.
>
> **The measurement, with an independent re-derivation from raw bytes, is in
> [`REPORT.md`](REPORT.md).** The recommendation was retracted in
> [`dsh-compaction-guide`](https://github.com/WASD258-jpg/dsh-compaction-guide)
> §7. This repository is kept public as a worked example of a plausible mechanism
> that does not survive contact with the whole system.

**Proactive tool-result pruning for DeepSeek Harness — fewer compaction attempts, so a failing compaction has fewer chances to fail.**

> **This plugin is deliberately incomplete.** It addresses one narrow symptom of a
> larger problem and cannot address the rest. Read
> [`LIMITATIONS.md`](LIMITATIONS.md) before relying on it, and
> [`dsh-compaction-guide`](https://github.com/WASD258-jpg/dsh-compaction-guide)
> for the surrounding analysis. If you are looking for a fix that stops a session
> from dying, this is not it.

> **Both of the above are now moot.** The plugin was measured and its central
> claim does not hold — see
> [Effect — measured, and the claim does not hold](#effect--measured-and-the-claim-does-not-hold)
> and [`REPORT.md`](REPORT.md). The banner at the top of this file is the current
> status; the two paragraphs above describe what the plugin was built to be.

---

## The problem it narrows

In the corpus analysed by `dsh-compaction-guide`, automatic compaction succeeded
**9 times out of 30 (30.0%)**. (An earlier version said 9/51 = 17.6%; that
denominator counted a forked session's replay of its parent's compactions twice.
See the guide's `CORRECTIONS.md`.) Failures repeated without backoff — **18 consecutive
attempts in a single turn**, with intervals that never grew.

The root cause is that the summarization request replays the compacted region
verbatim, so it overflows whenever the conversation has outgrown the summarization
model's window.

**No plugin can fix that**, and no plugin can stop a failing compaction from
retrying: the compaction call runs inside `compaction-basic`'s own `agent/pre-step`
listener body, before its `next()`, so no extension point can suppress it.

What a plugin *can* change is **how often compaction is triggered**. Tool results
are usually the largest part of a long agent session. Compaction already runs the
pruner once it decides to act — this plugin runs it **earlier**, while there is
still headroom, so the threshold is crossed less often.

**Fewer attempts is not a fix. It is fewer opportunities to fail.**

---

## What it does

On each surface-growing session event (`tool/result`, `assistant/message`):

1. Measure current context pressure via `ctx.tokenMeter.measure(session)`.
2. Compare against `triggerRatio × contextWindow`.
3. Estimate how many characters the pruner would reclaim.
4. If the trigger is crossed, the cooldown has elapsed, and the reclaim is
   worthwhile, call `ctx.toolResultPruner.pruneSession(session)`.

Every check that lacks information returns "do nothing". This plugin observes a
session that may already be in trouble; adding a new failure mode on top of that
would be worse than silence.

---

## Install

```sh
npm install dsh-compaction-prune
```

```yaml
- insert:
    - id: compaction-prune
      name: 'dsh-compaction-prune'
      config:
        mode: warn
```

**Start with `mode: warn`.** It evaluates every decision and logs what it *would*
do, without mutating the session. This plugin alters durable session state, so
observe its decisions on your own traffic before letting it act.

---

## Configuration

| Key | Default | Range | Meaning |
|---|---|---|---|
| `mode` | `warn` | `off` \| `warn` \| `prune` | `off` disables; `warn` logs decisions; `prune` acts |
| `triggerRatio` | `0.35` | 0.05–0.95 | Fraction of the context window at which to prune |
| `minimumCharsRemoved` | `2048` | ≥ 0 | Skip prunes that would reclaim less than this |
| `cooldownMs` | `60000` | ≥ 0 | Minimum time between prunes |

### Why `triggerRatio` defaults to 0.35

Compaction typically fires between 0.5 and 0.8 of the window. A lower trigger
keeps this plugin's decision clearly separated from compaction's, so it never
competes with compaction for the same call.

**The plugin does not know compaction's actual threshold**, and does not try to
derive it. Mirroring that formula would mean two independent implementations that
can silently disagree. It prunes on its own budget and lets compaction fire less
often as a consequence.

### Configuration errors are loud

Unknown keys, out-of-range values, and invalid enums are rejected at load with a
message naming the offending field. `schemastery`'s `z.object()` accepts unknown
keys silently, so the explicit `validateConfig()` check exists precisely to stop a
misspelled `triggerRatio` from producing a plugin that quietly never acts.

---

## What it is not

| Limitation | Why |
|---|---|
| **It is not a circuit breaker.** | It cannot stop a failing compaction from retrying. No extension point can suppress an attempt. |
| **It does not add backoff.** | Same reason. The retry loop lives inside a listener this plugin cannot preempt. |
| **It does not prevent summarization overflow.** | That request is built inside `compaction-basic` and cannot be chunked by a plugin. |
| **It does not guarantee compaction never fires.** | It reduces trigger frequency; it cannot eliminate triggers. |
| **It does not rescue an already-stuck session.** | Once the context exceeds the transport limit, pruning cannot shrink it enough. |
| **Backoff and byte-bounded summarization need upstream changes.** | See [`LIMITATIONS.md`](LIMITATIONS.md) for what to ask for and where. |

---

## Verification status

**Stated precisely, because the distinction matters.**

### Availability — verified end-to-end

The plugin was booted **through the real Cordis Loader**, the same path a
deployment takes, with a real `cordis.yml`:

| Claim | Result |
|---|---|
| Package name resolves from a profile's `node_modules` | pass |
| `dsh.bundle.patch` is accepted and the patch entry composed | pass |
| The Loader instantiates the plugin and registers `compactionPrune` | pass |
| Default configuration is applied | pass |
| An explicit `config:` block is honoured | pass |
| Loads with **no** dependencies mounted (compositions without compaction) | pass |
| A bad config prevents the service registering | pass |
| A bad config emits an error naming the offending field | pass |

That last pair deserves a note. **The Loader treats a plugin construction failure
as non-fatal** — it logs and continues, which is the harness's design and not
something a plugin can change. So a bad config does not stop `dsh` from starting.
What it does do is keep the service from registering *and* log a message naming
the field:

```
[error] CompactionPruneConfig: unknown key "triggerRatios"
        (allowed: triggerRatio, minimumCharsRemoved, cooldownMs, mode)
```

**The plugin is not silently half-active; it is fully absent, with a findable
error.**

### Effect — measured, and the claim does not hold

Measured. See [`REPORT.md`](REPORT.md) for the full method, every number, and the
limits of the counterfactual.

| Claim | Result |
|---|---|
| Configuration validation rejects bad input | 8 malformed inputs, each rejected with a field-naming message |
| `decide()` is correct on every branch | 6 branches, including two must-never-act cases |
| The decision path works in a real composition | pass — 41 checks, zero model calls |
| **It reduces compaction frequency in a live session** | **Not achieved.** See below. |

**A defect: `mode: prune` cannot act at all.** The observer runs from the plugin's
`session/event` listener, and `Session.append()` raises its re-entrancy guard
*before* dispatching that listener. So when the observer calls
`pruner.pruneSession(session)`, the pruner's own `session.append()` is rejected:

```
compaction-prune: prune failed: session append cannot reenter while another append is being published
```

Every attempt fails, on every event, in every session; `stats.acted` stays at
`0`. The failure is swallowed at `warn` level, so the symptom is silence. Start
with `mode: warn` is therefore not just prudent advice — it is the only mode whose
decision path runs end to end.

**And on a deployment where the pruner itself is disabled, it fails silently
instead.** `dsh-purge` rewrites the harness's tool-result pruner so that
`pruneContent()` returns `null` unconditionally. Then `pruneSession()` never
appends, the re-entrancy guard never fires, and the plugin logs a *success*:

```
compaction-prune: pruned 0 node(s), 0 chars removed — 10030 >= 2800, 23616 chars removable
```

`stats.acted` increments and the cooldown arms. The failure has changed shape from
"throws and warns every event" to **"reports success while doing nothing"** —
strictly worse for diagnosis. Note what this implies: **fixing the synchronous
timing would still not make pruning work there**, because the pruner is neutered
upstream of the plugin. `npm run test:failure-modes` reproduces this, plus three
smaller ones: a failed prune never arms its cooldown (so every event retries
forever), `warn` mode overstates recoverable characters on astral text by up to
2x, and a detached session receives no events at all.

**And the arithmetic does not close either.** Replaying the pinned 57-session
corpus (50 analysable, 8 real compactions) and granting the plugin the effect it
cannot currently deliver:

| Session | Peak tokens | Threshold | Crossed for real | Crossed counterfactually | Avoided |
|---|---|---|---|---|---|
| `session-13e1a104` | 678,722 | 678,464 | 1 / 1 | 0 | **1 / 1** |
| `session-c0acb35e` | 802,075 | 678,464 | 7 / 7 | 7 | **0 / 7** |

The rule fires — `decide()` acted in 7 of 50 sessions, and **8 of 8** real
compactions were preceded by an `act: true` decision. But:

- At **7 of the 8** boundaries the pruner's remaining reach is **exactly 0**:
  `compaction-basic` runs the same pruner before committing, so a plugin that
  prunes "earlier" finds nothing left to take.
- The **1** avoidance is in the only session with **zero `compaction/prune`
  events**, and it cleared a **258-token** crossing (0.038% of the window).
- The verdict is **configuration-invariant**: at `triggerRatio: 0.05` with
  `minimumCharsRemoved: 0` and `cooldownMs: 0` the plugin prunes on 2,068 of
  2,104 settlements and still avoids **0**.

`REPORT.md` §0 states the limits of that measurement first: it is an **arithmetic**
counterfactual, so "avoided" never means "behaviourally avoided". A total still
above the threshold is decisive against the plugin; a total below it is only a
necessary condition for avoidance.

Whether `warn` mode's own overhead is worth paying has not been measured.

---

## Tests

```sh
npm test
```

Three suites, all runnable without a live session:

- `tests/decide.spec.mjs` — decision logic, every branch, plus negative cases
- `tests/mount.spec.mjs` — mounting, config validation, optional dependencies
- `tests/config-loading.spec.mjs` — how configuration reaches the plugin
- `tests/availability.spec.mjs` — package-name resolution and import
- `tests/loader-e2e.spec.mjs` — boot through the real Cordis Loader

Five suites, all runnable without a live session. See
[Verification status](#verification-status) for what they do and do not prove.

---

## How it relates to other plugins

This plugin **hooks the session event plane**, not the compaction service. It
therefore composes with any compaction backend, including the mutually exclusive
set documented in `dsh-compaction-guide`'s prior-art review — it does not join
that conflict.

It is **not** a substitute for
[`@argszero/cordis-plugin-length-stop-overflow`](https://github.com/argszero/cordis-plugin-length-stop-overflow),
which fixes a different defect (misclassified 413s). That plugin is the one to
install if your sessions die outright.

---

## License

MIT
