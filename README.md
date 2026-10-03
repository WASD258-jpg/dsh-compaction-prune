**English** | [中文](README.zh.md)

# dsh-compaction-prune

**Proactive tool-result pruning for DeepSeek Harness — fewer compaction attempts, so a failing compaction has fewer chances to fail.**

> **This plugin is deliberately incomplete.** It addresses one narrow symptom of a
> larger problem and cannot address the rest. Read
> [`LIMITATIONS.md`](LIMITATIONS.md) before relying on it, and
> [`dsh-compaction-guide`](https://github.com/WASD258-jpg/dsh-compaction-guide)
> for the surrounding analysis. If you are looking for a fix that stops a session
> from dying, this is not it.

---

## The problem it narrows

In the corpus analysed by `dsh-compaction-guide`, automatic compaction succeeded
**9 times out of 51 (17.6%)**. Failures repeated without backoff — **18 consecutive
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

### Effect — not verified

| Claim | Verified how |
|---|---|
| Configuration validation rejects bad input | 8 malformed inputs, each rejected with a field-naming message |
| `decide()` is correct on every branch | 6 branches, including two must-never-act cases |
| **It reduces compaction frequency in a live session** | **NOT VERIFIED.** |

That last row is the honest gap. Every component is tested, and the plugin boots
and configures correctly — but **no measurement demonstrates that enabling it on a
long session actually reduces compaction attempts.** That needs a controlled
before/after on a real workload, which has not been run.

If you try it, the numbers worth reporting are compaction attempts per session
with `mode: warn` versus `mode: prune`, plus the `pruneSession()` results in the
log.

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
