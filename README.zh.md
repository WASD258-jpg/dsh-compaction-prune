[English](README.md) | **中文**

# dsh-compaction-prune

**DeepSeek Harness 的主动工具结果裁剪 —— 更少的压缩尝试，因此一次失败的压缩有更少的失败机会。**

> **本插件刻意不完整。** 它只针对一个更大问题的一个狭窄症状，其余部分它无法处理。
> 依赖它之前请先读 [`LIMITATIONS.md`](LIMITATIONS.zh.md)，以及
> [`dsh-compaction-guide`](https://github.com/WASD258-jpg/dsh-compaction-guide)
> 了解完整的分析。如果你要找的是能让会话不死掉的修复，那不是它。

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

### 效果 —— 未验证

| 主张 | 如何验证 |
|---|---|
| 配置校验拒绝坏输入 | 8 个畸形输入，每一个都以指明字段的消息被拒绝 |
| `decide()` 在每个分支上都正确 | 6 个分支，含两个「绝不能动手」的用例 |
| **它在真实会话中降低压缩频率** | **未验证。** |

最后一行是诚实的缺口。每个部件都测过，插件能正确启动与配置 ——
但**没有任何测量表明，在一个长会话上启用它真的降低了压缩尝试次数。**
那需要在真实工作负载上做受控的启用前/启用后对比，而这项工作尚未进行。

如果你试了，值得报告的数字是：`mode: warn` 与 `mode: prune` 下每会话的压缩尝试次数，
以及日志中的 `pruneSession()` 结果。

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
