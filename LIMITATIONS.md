**English** | [中文](LIMITATIONS.zh.md)

# Limitations, and what upstream would need to do instead

> This file exists because **this plugin is a partial measure and should not be
> mistaken for a fix.** It states what it cannot do, why, and what would actually
> be required — with enough specificity that someone can implement it.

---

## 1. The two things this plugin cannot do

### 1.1 Stop a failing compaction from retrying

**What is needed.** Session-scoped attempt counting across both the `pressure` and
`context-overflow` paths, exponential backoff, and a tripped state that skips
further attempts until the context materially changes.

**Why a plugin cannot provide it.** Breaker behaviour means *skipping an attempt
before it happens*. Every extension point was enumerated, and none can:

| Extension point | Why it cannot block |
|---|---|
| `agent/pre-step` | `compaction-basic` calls `compactIfNeeded` **inside its own listener body**, before its `next()`. Waterfall ordering runs listeners earlier or later; it does not move the call out of a listener. |
| `compaction/summary-error` | Fires only *after* a failure. It can repair input and retry, not prevent the next attempt. |
| `llm/stream` | Wraps an invocation. It cannot decide that no invocation happens. |
| `session/event` | Read-only observation. |
| surface rewrite | Addresses *fewer triggers*, not *do not retry a failing one*. |

**Where the fix belongs.** Inside the `agent/pre-step` listener in
`packages/compaction/compaction-basic/src/index.ts`:

```ts
// upstream only — no plugin can insert this
if (breakerTripped(session)) return next()
```

The counter must live where both the pressure and overflow paths can see it. Note
that `maxOverflowRetries` today counts only the `agent/request-error` path, and the
pressure path has no session-wide counter at all — its retry counter is local to a
single `compactIfNeeded` call.

### 1.2 Bound the summarization request by bytes

**What is needed.** The summarization request replays the compacted region
verbatim. When that region exceeds a transport limit, the request is refused and
compaction cannot proceed — the session is stuck.

**Why a plugin cannot provide it.** The request is assembled inside
`compaction-basic`'s `summarizer.ts`. A plugin sees the resulting stream, not the
message array being built, so it cannot chunk the region.

**Where the fix belongs.** In `summarizer.ts`, chunking the region when either a
token or a byte bound is exceeded. Upstream discussion
[#7626](https://github.com/deepseek-ai/deepseek-harness/discussions/7626) proposes
exactly this.

**Useful prior art for the implementation:**

- `bvbhu/dsh-quilt-compact` — overlapping chunks with cuts snapped to
  sentence-ending lines, lines kept atomic, three-stage budget subtraction, and a
  bundled real tokenizer (its comments note that a `chars/4` heuristic
  under-counts CJK sessions by roughly 2–2.4×).
- `mrbeandev/dsh-hypercompact` — a working byte budget
  (`maxRequestBytes` / `targetRequestBytes` / `retainBytes`), though it avoids the
  problem entirely by not calling an LLM.

The two halves exist separately. **The intersection — keep the LLM summarizer and
bound its request in bytes — is unbuilt.**

---

## 2. What this plugin does not guarantee

Even within its narrow scope:

- **It reduces trigger frequency; it does not eliminate triggers.** A session can
  still cross the compaction threshold.
- **It cannot rescue an already-stuck session.** Once the context exceeds the
  transport limit, pruning removes too little to matter.
- **It has not been measured end-to-end.** Each step is tested in isolation; no
  before/after measurement on a live long session exists. See README.md.
- **Its effect is workload-dependent.** A session dominated by large tool results
  benefits most. A session whose bulk is assistant reasoning or user messages
  benefits little, because there is nothing prunable.
- **It competes for the same resource as compaction.** Both rewrite the session
  surface. Running this plugin does not remove compaction's own pruning pass.

---

## 3. Interaction risks

| Risk | Detail |
|---|---|
| **Double pruning** | `compaction-basic` prunes before summarizing. This plugin prunes earlier. Both call the same service; the second finds less to remove. Not harmful, but the `charsRemoved` figures will differ from a single pass. |
| **Surface rewrite churn** | Each prune rewrites the session surface. The `cooldownMs` default exists to bound this; setting it to 0 on a tool-heavy session can produce a rewrite per tool result. |
| **Unresolved windows** | If `ctx.llm.resolveModelInfo()` returns no window for a route, the plugin stays inactive for that session rather than guessing. The harness's own fallback is 262144; inheriting it would make this plugin act on a number it cannot justify. |
| **Pruner not mounted** | The plugin loads and does nothing. It does not fail the composition. |

---

## 4. If you want to help

The two upstream changes in §1 are the real fix. Both are scoped and both have
prior art. If you are in a position to contribute upstream, those are worth more
than any plugin.

For this plugin specifically, the most useful contribution is **measurement**: a
before/after comparison of compaction attempts per session with `mode: warn`
versus `mode: prune`. That is the claim this repository cannot currently make.

---

## 5. Related reading

- `dsh-compaction-guide` — the full analysis: three mechanisms, controlled
  comparisons, a compatibility map of 20 existing plugins, and the measurement
  methodology behind every number quoted here.
- Upstream [#7626](https://github.com/deepseek-ai/deepseek-harness/discussions/7626)
  — compaction cannot rescue an oversized session.
- Upstream [#7214](https://github.com/deepseek-ai/deepseek-harness/discussions/7214)
  — a length stop with one output token escapes overflow detection.
