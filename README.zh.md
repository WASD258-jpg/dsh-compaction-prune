[English](README.md) | **中文**

# dsh-compaction-prune

> **本仓库的译文是人工维护的，不是机器生成。**
> 如果你正在通过浏览器自带的翻译阅读本文，术语将与这里的用法不符 ——
> `prune` 会被译成「修剪」、`compaction` 会被译成「压缩」，
> 而撤回结论所依赖的那组区分会因此丢失。
> **[English version here](README.md)** — terminology matches this document.

> ## ⚠️ 不要使用本插件。它已被测量，且它不成立。
>
> 其前提 —— 比压缩更早地裁剪工具结果，可以降低压缩触发频率 —— 是**错的**，
> 有两个独立原因：
>
> 1. **`compaction-basic` 在压缩之前本来就已经跑过裁剪器，并且会重新测量。**
>    `compactIfNeeded` 在 `index.ts:297` 调用 `prune.pruneSession(session)`，
>    在 `:298` 重新测量，然后才写入 `compaction/start`。「更早」没有任何存在空间。
> 2. **在真实会话中裁剪从未落地。** `Session.append()` 在派发 `session/event`
>    **之前**就置位重入守卫，因此从该监听器内发起的裁剪会抛出
>    `session append cannot reenter while another append is being published`。
>    插件自己的 `catch` 吞掉了它；症状是沉默。
>
> 重放所记录的 token 轨迹、并假定插件能完全实现其效果，**8 次压缩中有 7 次仍然不可避免**；
> 唯一避免的那一次，位于唯一一个裁剪器从未运行过的会话中，且只消掉一个 258 token 的越界。
>
> **测量结果、含从原始字节出发的独立复算，见 [`REPORT.md`](REPORT.md)。**
> 该推荐已在
> [`dsh-compaction-guide`](https://github.com/WASD258-jpg/dsh-compaction-guide) §7 中撤回。
> 本仓库保持公开，作为一个「看似合理的机制在与整个系统接触时不成立」的实例。

**DeepSeek Harness 的主动工具结果裁剪 —— 更少的压缩尝试，因此一次失败的压缩有更少的失败机会。**

> **本插件刻意不完整。** 它只针对一个更大问题的一个狭窄症状，其余部分它无法处理。
> 依赖它之前请先读 [`LIMITATIONS.md`](LIMITATIONS.zh.md)，以及
> [`dsh-compaction-guide`](https://github.com/WASD258-jpg/dsh-compaction-guide)
> 了解完整的分析。

> **以上两端如今都已不适用。** 该插件经过测量，其核心主张不成立 ——
> 见 [效果 —— 已测量，且该主张不成立](#效果--已测量而该主张不成立) 与
> [`REPORT.md`](REPORT.md)。本文件顶部的横幅是当前状态；
> 上面两端描述的是这个插件原本被设计成什么。

---

## 它缩窄的问题

在 `dsh-compaction-guide` 分析的语料中，自动压缩 **51 次里成功 9 次（17.6%）**。
失败反复出现且没有退避 —— **单个回合内 18 次连续尝试**，间隔从不增长。

根因是摘要请求逐字重放被压缩区，因此只要对话已经超出摘要模型的窗口，它就会溢出。

**没有插件能修好这一点**，也没有插件能阻止一次失败的压缩继续重试：
压缩调用运行在 `compaction-basic` 自己的 `agent/pre-step` 监听器体内，早于其 `next()`，
因此没有任何扩展点能抑制它。

插件*能*改变的，是**压缩被触发的频率**。工具结果通常是长时间 agent 会话中最大的部分。
压缩在决定动手时本来就会跑裁剪器 —— 本插件让它跑得**更早**，在仍有余量的时候，
于是阈值被跨过的次数更少。

**更少的尝试不是修复。它是更少的失败机会。**

---

## 它做什么

在每一次使 surface 增长的事件上（`tool/result`、`assistant/message`）：

1. 通过 `ctx.tokenMeter.measure(session)` 测量当前上下文压力。
2. 与 `triggerRatio × contextWindow` 比较。
3. 估算裁剪器能回收多少字符。
4. 若已跨过触发点、冷却已过、且回收值得，则调用
   `ctx.toolResultPruner.pruneSession(session)`。

每一项缺少信息的检查都返回「什么都不做」。本插件观测的是一个可能已经出问题的会话；
在它之上再加一种新的失败模式，比沉默更糟。

---

## 安装

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

**从 `mode: warn` 开始。** 它会评估每一次决策并记录它*将要*做什么，但不改动会话。
本插件会修改持久化的会话状态，因此先在你自己的流量上观察它的决策，再让它动手。

---

## 配置

| 键 | 默认 | 范围 | 含义 |
|---|---|---|---|
| `mode` | `warn` | `off` \| `warn` \| `prune` | `off` 禁用；`warn` 记录决策；`prune` 执行 |
| `triggerRatio` | `0.35` | 0.05–0.95 | 在窗口的哪个比例上裁剪 |
| `minimumCharsRemoved` | `2048` | ≥ 0 | 回收量低于此值的裁剪直接跳过 |
| `cooldownMs` | `60000` | ≥ 0 | 两次裁剪之间的最小时间 |

### 为什么 `triggerRatio` 默认 0.35

压缩通常在窗口的 0.5 到 0.8 之间触发。较低的触发点让本插件的决策与压缩的决策
清晰分离，因此它永远不会与压缩争抢同一次调用。

**插件不知道压缩的实际阈值**，也不试图推导它。照搬那个公式意味着两份独立实现，
而它们可能静默地产生分歧。它按自己的预算裁剪，让压缩作为结果而少触发一些。

### 配置错误是响亮的

未知键、超范围的值、非法的枚举值，都会在加载时被拒绝，并给出指明违规字段的消息。
`schemastery` 的 `z.object()` 会静默接受未知键，因此显式的 `validateConfig()` 检查
正是为了阻止一个拼错的 `triggerRatio` 造出一个安静地从不生效的插件。

---

## 它不是什么

| 局限 | 原因 |
|---|---|
| **它不是熔断器。** | 它无法阻止一次失败的压缩继续重试。没有任何扩展点能抑制一次尝试。 |
| **它不添加退避。** | 同样的原因。重试循环位于本插件无法抢占的监听器内部。 |
| **它不防止摘要溢出。** | 那个请求在 `compaction-basic` 内部构建，插件无法对其分块。 |
| **它不保证压缩永不触发。** | 它降低触发频率；它无法消除触发。 |
| **它救不回已经卡死的会话。** | 一旦上下文超出传输层限制，裁剪无法把它缩得足够小。 |
| **退避与按字节有界的摘要需要上游改动。** | 要请求什么、向哪里请求，见 [`LIMITATIONS.zh.md`](LIMITATIONS.zh.md)。 |

---

## 验证状态

**精确陈述，因为这个区分很重要。**

### 可用性 —— 已端到端验证

插件是**通过真实 Cordis Loader 启动**的，与部署所走的路径相同，使用真实的 `cordis.yml`：

| 主张 | 结果 |
|---|---|
| 包名可从 profile 的 `node_modules` 解析 | 通过 |
| `dsh.bundle.patch` 被接受，patch 条目被合成 | 通过 |
| Loader 实例化插件并注册 `compactionPrune` | 通过 |
| 默认配置被应用 | 通过 |
| 显式 `config:` 块被遵循 | 通过 |
| 在**未**挂载任何依赖时也能加载（不使用压缩的组合） | 通过 |
| 坏配置使服务不注册 | 通过 |
| 坏配置发出指明违规字段的错误 | 通过 |

最后两项值得说明。**Loader 把插件构造失败视为非致命** —— 它记录日志后继续，
这是 harness 的设计，不是插件能改变的。因此坏配置不会阻止 `dsh` 启动。
它确实做到的是：让服务不注册，*并且*记录一条指明字段的消息：

```
[error] CompactionPruneConfig: unknown key "triggerRatios"
        (allowed: triggerRatio, minimumCharsRemoved, cooldownMs, mode)
```

**插件不是静默地半生效；它是完全缺席，并带一个可查到的错误。**

### 效果 —— 已测量，而该主张不成立

已测量。完整方法、每一个数字、以及反事实的局限见 [`REPORT.zh.md`](REPORT.zh.md)。

| 主张 | 结果 |
|---|---|
| 配置校验拒绝坏输入 | 8 个畸形输入，每一个都以指明字段的消息被拒绝 |
| `decide()` 在每个分支上都正确 | 6 个分支，含两个「绝不能动手」的用例 |
| 决策路径在真实组合中可用 | 通过 —— 41 项检查，零模型调用 |
| **它在真实会话中降低压缩频率** | **未达成。** 见下。 |

**一个缺陷：`mode: prune` 根本无法行动。** observer 由插件的 `session/event`
监听器调用，而 `Session.append()` 在派发该监听器**之前**就抬起了重入保护。于是当
observer 调用 `pruner.pruneSession(session)` 时，裁剪器自己的 `session.append()`
被拒绝：

```
compaction-prune: prune failed: session append cannot reenter while another append is being published
```

每一次尝试都失败，在每一个事件上，在每一个会话中；`stats.acted` 恒为 `0`。失败被
以 `warn` 级别吞掉，所以症状是沉默。因此「先用 `mode: warn`」不只是审慎建议 ——
它是唯一其决策路径能端到端运行的模式。

**而在裁剪器本身被禁用的部署上，它转而静默失败。** `dsh-purge` 把 harness 的
工具结果裁剪器改写成 `pruneContent()` 无条件返回 `null`。于是 `pruneSession()` 从不
append，重入保护一次都不响，插件记录一条*成功*：

```
compaction-prune: pruned 0 node(s), 0 chars removed — 10030 >= 2800, 23616 chars removable
```

`stats.acted` 递增，冷却上锁。失败形态从「每次事件抛错并告警」变成
**「报告成功，同时什么都没做」** —— 对诊断而言严格更糟。注意这意味着什么：
**修好同步时序，在那里也仍然不会让裁剪生效**，因为裁剪器在插件之前就被阉割了。
`npm run test:failure-modes` 可复现这一条，以及另外三条较小的：失败的裁剪从不设置冷却
（于是每个事件永远重试）、`warn` 模式在星光面文本上高报可回收字符达 2 倍、
以及 detached 会话收不到任何事件。

**而且算术也不闭合。** 重放钉死的 57 个会话语料（50 个可分析，8 次真实压缩），并把插件
当前无法交付的效果白送给它：

| 会话 | 峰值 token | 阈值 | 实际跨过 | 反事实跨过 | 避免 |
|---|---|---|---|---|---|
| `session-13e1a104` | 678,722 | 678,464 | 1 / 1 | 0 | **1 / 1** |
| `session-c0acb35e` | 802,075 | 678,464 | 7 / 7 | 7 | **0 / 7** |

规则确实触发 —— `decide()` 在 50 个会话中的 7 个里行动过，且 **8 / 8** 次真实压缩都
由一次 `act: true` 决策先行。但是：

- 在 **8 个边界中的 7 个**上，裁剪器的剩余可裁量**恰好为 0**：`compaction-basic`
  在提交之前就跑同一个裁剪器，所以一个「更早」裁剪的插件发现无处可拿。
- 那 **1** 次避免，位于唯一一个 **`compaction/prune` 事件数为零**的会话中，闭合的是
  一次 **258 token** 的越线（窗口的 0.038%）。
- 该结论**与配置无关**：在 `triggerRatio: 0.05` + `minimumCharsRemoved: 0` +
  `cooldownMs: 0` 下，插件在 2,104 次结算中的 2,068 次上执行裁剪，避免数仍是 **0**。

`REPORT.zh.md` §0 先陈述该测量的局限：它是**算术**反事实，所以「避免」永远不意味着
「行为上避免」。总量仍高于阈值，是对插件的决定性反证；总量低于阈值，只是避免的必要
条件。

`warn` 模式自身的开销是否值得付，尚未测量。

---

## 测试

```sh
npm test
```

五个测试套件，全部无需真实会话即可运行：

- `tests/decide.spec.mjs` —— 决策逻辑，每个分支，外加负向用例
- `tests/mount.spec.mjs` —— 挂载、配置校验、可选依赖
- `tests/config-loading.spec.mjs` —— 配置如何到达插件
- `tests/availability.spec.mjs` —— 包名解析与导入
- `tests/loader-e2e.spec.mjs` —— 经真实 Cordis Loader 启动

它们证明什么、不证明什么，见 [验证状态](#验证状态)。

---

## 它与其他插件的关系

本插件**挂接的是会话事件面**，不是压缩服务。因此它能与任何压缩后端组合，
包括 `dsh-compaction-guide` 的先行工作调研中记录的那组互斥集合 —— 它不加入那场冲突。

它**不是**
[`@argszero/cordis-plugin-length-stop-overflow`](https://github.com/argszero/cordis-plugin-length-stop-overflow)
的替代品，后者修的是另一个缺陷（413 误判）。如果你的会话直接就死掉，要装的是那一个。

---

## 许可证

MIT
