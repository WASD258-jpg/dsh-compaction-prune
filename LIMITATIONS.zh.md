[English](LIMITATIONS.md) | **中文**

# 局限，以及上游应当改做什么

> 本文件之所以存在，是因为**本插件是一种部分措施，不应被误认为修复。**
> 它说明自己做不到什么、为什么做不到，以及真正需要的改动是什么 ——
> 具体到足以让别人直接上手实现。

---

## 1. 本插件做不到的两件事

### 1.1 阻止一次失败的压缩继续重试

**需要什么。** 一个跨 `pressure` 与 `context-overflow` 两条路径的会话级尝试计数器、
指数退避，以及一个在上下文实质变化之前跳过后续尝试的熔断状态。

**为什么插件做不到。** 熔断行为意味着*在一次尝试发生之前跳过它*。所有扩展点都已枚举，没有一个能做到：

| 扩展点 | 为何无法阻断 |
|---|---|
| `agent/pre-step` | `compaction-basic` 在**它自己的监听器体内**调用 `compactIfNeeded`，早于其 `next()`。waterfall 排序只是让监听器跑得更早或更晚；它不会把调用移出监听器。 |
| `compaction/summary-error` | 只在失败**之后**触发。它可以修复输入并重试，但无法阻止下一次尝试。 |
| `llm/stream` | 包裹一次调用。它无法决定不发生调用。 |
| `session/event` | 只读观测。 |
| surface 改写 | 治的是*更少触发*，不是*失败了别重试*。 |

**修复应放在哪里。** `packages/compaction/compaction-basic/src/index.ts` 的
`agent/pre-step` 监听器内部：

```ts
// upstream only — no plugin can insert this
if (breakerTripped(session)) return next()
```

计数器必须放在 `pressure` 与 overflow 两条路径都能看到的地方。注意今天的
`maxOverflowRetries` 只统计 `agent/request-error` 路径，而 pressure 路径
完全没有会话级计数器 —— 它的重试计数器是单次 `compactIfNeeded` 调用局部的。

### 1.2 按字节为摘要请求设界

**需要什么。** 摘要请求逐字重放被压缩区。当该区域超出传输限制时，请求被拒绝、
压缩无法推进 —— 会话卡死。

**为什么插件做不到。** 该请求在 `compaction-basic` 的 `summarizer.ts` 内部组装。
插件看到的是结果流，不是正在构建的消息数组，因此无法对被压缩区分块。

**修复应放在哪里。** 在 `summarizer.ts` 中，当超出 token 或字节界时对被压缩区分块。
上游讨论
[#7626](https://github.com/deepseek-ai/deepseek-harness/discussions/7626) 提出的正是这一点。

**可用的先行工作参考：**

- `bvbhu/dsh-quilt-compact` —— 重叠分块，切点吸附到以句子结尾的行，行保持原子性，
  三阶段预算扣减，并自带真实 tokenizer（其注释指出 `chars/4` 启发式对 CJK 会话
  低估约 2–2.4 倍）。
- `mrbeandev/dsh-hypercompact` —— 可用的字节预算
  （`maxRequestBytes` / `targetRequestBytes` / `retainBytes`），尽管它通过完全不调用 LLM
  绕开了这个问题。

这两半各自都存在。**而它们的交集 —— 保留 LLM 摘要器、同时按其请求的字节数设界 —— 尚未有人做。**

---

## 2. 本插件不保证什么

即便在其狭窄范围内：

- **它降低触发频率；它不消除触发。** 会话仍可能跨过压缩阈值。
  **已测量：在已记录的语料上，两者都没有降低** —— 见 [`REPORT.zh.md`](REPORT.zh.md) §3。
- **`mode: prune` 目前根本无法行动。** observer 运行在 `Session.append()` 内部，
  此时 store 的重入保护已经抬起，所以每一次 `pruneSession()` 调用都被拒绝。
  `mode: warn` 是唯一其决策路径能端到端运行的模式。见 [`REPORT.zh.md`](REPORT.zh.md) §2.3。
- **它救不回已经卡死的会话。** 一旦上下文超出传输限制，裁剪去掉的东西太少，无济于事。
- **它现在已经被测量，而效果未被找到。** 每个部件都测过，插件能正确启动、配置与决策 ——
  但把当前无法交付的效果白送给它后，**8 次**已记录压缩中仍有 **7 次**在算术上不可避免。
  见 [`REPORT.zh.md`](REPORT.zh.md)。
- **它的效果依赖工作负载。** 由大块工具结果主导的会话收益最大。
  主体是 assistant 推理或用户消息的会话收益很小，因为没有可裁剪的东西。
  **已测量：唯一一次避免来自工具密集的会话（`tool/result` 占表面 39%）；
  assistant 密集的那个会话什么都没避免。**
- **它与压缩争抢同一资源。** 两者都改写会话表面。运行本插件不会移除压缩自身的裁剪过程 ——
  而且由于压缩是在提交**之前**跑那趟裁剪，一个更早裁剪的插件会发现表面已经被清空。

---

## 3. 交互风险

| 风险 | 细节 |
|---|---|
| **双重裁剪** | `compaction-basic` 在摘要前裁剪。本插件裁剪得更早。两者调用同一个服务；第二次能去掉的更少。并非有害，但 `charsRemoved` 数字会与单次裁剪不同。 |
| **surface 改写抖动** | 每次裁剪都会改写会话表面。`cooldownMs` 默认值的存在就是为了限制这一点；在工具密集的会话上把它设为 0，可能产生每个工具结果一次改写。 |
| **窗口未解析** | 若 `ctx.llm.resolveModelInfo()` 对某条路由不返回窗口，插件会在该会话上保持不生效，而不是去猜。harness 自身的兜底值是 262144；继承它会迫使本插件依据一个自己无法证成的数字行动。 |
| **裁剪器未挂载** | 插件加载后什么都不做。它不会让组合失败。 |

---

## 4. 如果你想帮忙

§1 中的两项上游改动才是真正的修复。两者范围都明确，也都有先行工作。
如果你有能力向上游贡献，那比任何插件都更有价值。

就本插件具体而言，最有用的贡献是**测量**：`mode: warn` 与 `mode: prune` 下
每会话压缩尝试次数的启用前/启用后对比。那正是本仓库目前无法给出的主张。

---

## 5. 相关阅读

- `dsh-compaction-guide` —— 完整分析：三条机制、对照实验、20 个既有插件的兼容性地图，
  以及此处引用的每个数字背后的测量方法学。
- 上游 [#7626](https://github.com/deepseek-ai/deepseek-harness/discussions/7626)
  —— 压缩无法救回超大会话。
- 上游 [#7214](https://github.com/deepseek-ai/deepseek-harness/discussions/7214)
  —— 只有一个输出 token 的 length stop 逃逸溢出检测。
