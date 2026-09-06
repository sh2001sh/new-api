# CodeGo 多上游智能路由渐进重构方案

## 1. 文档目的

本文用于指导 CodeGo 网关多上游路由的渐进重构。目标是在不破坏长上下文连续性、生图可用性、计费幂等和现有生产故障恢复能力的前提下，降低上游失败造成的首字长尾、502/504、流提前关闭和候选耗尽 503。

本方案不是从零重写路由系统。当前 `new-api` 已具备自动路由池、渠道与故障域健康状态、半开探测、软粘性、Responses 流阶段标记和基础审计。重构重点是统一这些能力的决策边界，消除重复状态和互相冲突的入口。

核心顺序为：

1. 先统一请求分类、错误分类、尝试阶段和审计事实；
2. 再统一候选资格、健康状态、请求预算和恢复探测；
3. 最后才在健康候选之间引入轻量在线学习；
4. 任何学习算法都不能绕过确定性的安全、计费和可重放约束。

## 2. 现有实现基线

当前代码已经实现以下能力：

- 自动路由池忽略传统 `priority/weight`，按采购成本、近期成功率、TTFT 和探索率选择成员；
- 渠道+模型健康状态与故障域健康状态；
- `healthy/degraded/cooling/half_open` 状态和恢复探测；
- 全冷却时的 last-resort 与 emergency probe；
- `prompt_cache_key` 显式粘性和自动池短期粘性；
- `selected/connected/bootstrap/semantic_committed/completed` 尝试阶段；
- Responses 在语义内容前允许安全重试，语义内容提交后禁止重放；
- 故障域自适应并发限制；
- 路由选择、排除原因、重试和探测模式的基础审计。

主要实现位置：

- `internal/gateway/routing/app/channel_selection.go`
- `internal/gateway/routing/app/route_pool_selection.go`
- `internal/gateway/routing/app/route_pool_scoring.go`
- `internal/gateway/runtime/channel_health.go`
- `internal/gateway/runtime/fault_domain_health.go`
- `internal/gateway/runtime/fault_domain_concurrency.go`
- `internal/gateway/stream/attempt_stage.go`
- `internal/gateway/transport/http/relay_runtime.go`
- `internal/gateway/execution/app/channel_error_handling.go`

因此，本次重构应以替换内部契约和影子决策为主，不应一次性删除现有生产恢复路径。

## 3. 当前需要解决的问题

### 3.1 健康维度未按请求类型隔离

当前渠道健康键主要是 `channel_id + model`，故障域健康键主要是 `fault_domain + model`。短文本流、长上下文、工具调用和生图可能共享健康与 TTFT 数据，导致慢但正常的长任务冷却普通文本渠道，或生图延迟污染 GPT 流式判断。

### 3.2 成本仍存在硬优先边界

自动池会先保留低于固定成本门槛的候选，再将高成本渠道作为备用。这可能让低价但正在退化的渠道继续承接正常流量，与“先稳定性、后成本”的原则不完全一致。

### 3.3 全冷却 fail-open 没有严格的全局上限

当前 last-resort 逻辑在探测租约不可用时仍可能返回一个 fail-open 候选。单进程低流量下能减少 503，但多实例或并发突发时可能形成多个并行探测，放大上游故障。

### 3.4 重试事实仍分散

虽然已有 `AttemptStage`，重试仍同时依赖 `ResponseBodyDelivered`、`StreamContentDelivered`、Responses 专用标记、全局重试次数和 GPT 固定时间窗口。多个布尔状态可能在协议适配器之间产生不一致。

### 3.5 审计不足以支持可靠回放

当前聚合性能指标主要按 `model + group` 记录，缺少每次尝试的候选集、排除原因、请求类型、失败阶段、故障域、采购成本和预算消耗。没有这些事实，不应直接启用机器学习路由。

## 4. 设计原则

### 4.1 单一决策入口

每次上游尝试只允许一个 `RouteDecisioner` 生成候选顺序或选择结果。传统分组路由和自动池可以作为不同的 `CandidateProvider`，但不能在一次尝试中分别进行第二次排序。

### 4.2 硬约束与软评分分离

以下规则必须是确定性的硬约束：

- 模型、协议和能力兼容；
- 请求错误、鉴权错误和内容安全错误的处理；
- 是否已经提交语义内容；
- 最大尝试数、总时间预算和跨故障域预算；
- 冷却、半开租约和并发容量；
- 计费、退款和幂等约束。

成本、可靠性、TTFT、负载、粘性和探索只能影响合格候选之间的软排序。

### 4.3 先稳定性，后成本

不得使用固定采购成本阈值把健康但较贵的渠道从正常候选集中提前删除。候选先按稳定性分层，再在同层内优化成本和延迟。

### 4.4 健康状态按故障因果建模

`group`、`tenant` 和 `user` 是策略或审计维度，不应默认进入上游健康键，否则同一个真实故障会被切碎成多个小样本状态。

建议使用三类健康键：

```text
channel_health:
  channel_id + model_family + protocol + request_type

credential_health:
  channel_id + key_fingerprint + model_family

fault_domain_health:
  fault_domain + model_family + protocol + request_type
```

其中：

- `channel_health` 处理渠道和模型路径质量；
- `credential_health` 处理 API Key 失效、余额不足或账号权限问题；
- `fault_domain_health` 处理共享主机、代理、区域或供应商容量故障；
- 原始 Key、提示词和用户敏感信息不得进入日志或缓存键。

### 4.5 粘性是可撤销的软偏好

显式 prompt cache 粘性和自动池粘性应通过统一的 `AffinityPreference` 接口参与决策。底层允许在迁移期保留不同缓存命名空间，但健康校验、失效条件和审计必须一致。

### 4.6 轻量在线学习只能优化排序

在线学习不得决定是否重试、是否冷却、是否返回用户错误或是否重放流。算法异常、数据不足或 Redis 不可用时，必须显式回退到确定性评分，并记录回退原因。

## 5. 请求分类

在第一次选路前生成不可变的 `RequestProfile`：

```text
RequestProfile {
  request_type
  protocol
  model_family
  prompt_size_bucket
  has_tools
  has_conversation_state
  is_stream
  migration_capability
}
```

`request_type` 至少包括：

- `chat_short_stream`：普通流式对话；
- `chat_long_stream`：长上下文或 Codex Responses；
- `tool_call_stream`：包含工具调用或函数调用；
- `chat_non_stream`：非流式文本；
- `image_non_stream`：非流式生图；
- `image_stream`：流式生图或媒体生成；
- `embedding_or_other`：Embedding、Rerank 等接口。

分类完成后不得在重试过程中变化。切换渠道时沿用同一 `RequestProfile` 和请求级预算。

## 6. 统一路由流程

```text
请求解析
  -> 构建 RequestProfile
  -> CandidateProvider 获取候选
  -> 模型/协议/能力硬过滤
  -> 凭据健康过滤
  -> 渠道与故障域健康过滤
  -> 故障域并发与探测租约过滤
  -> 稳定性分层
  -> 确定性评分或受约束在线学习
  -> 软粘性修正
  -> RouteDecisioner 返回一个候选
  -> AttemptController 执行尝试
  -> 失败时按请求预算决定是否选择下一个候选
```

所有候选被排除时，`RouteDecisioner` 必须返回结构化的排除原因，不能只返回 `no available channel`。

## 7. 健康状态机

### 7.1 状态

```text
healthy -> suspect -> cooling -> half_open -> healthy
                     ^             |
                     +-------------+
```

- `healthy`：正常参与路由；
- `suspect`：近期质量下降，只降权，不立即驱逐；
- `cooling`：不接收普通流量；
- `half_open`：只接收持有恢复租约的探测请求；
- 探测失败：回到 `cooling` 并增加退避级别；
- 探测成功：先恢复少量流量，再逐步回到 `healthy`。

代码迁移期可以继续兼容现有 `degraded` 名称，但新契约统一使用 `suspect`；审计中应记录状态版本。

### 7.2 失败分类

| 分类 | 示例 | 是否重试 | 是否影响上游健康 |
| --- | --- | --- | --- |
| 客户端取消 | context canceled、client disconnect | 否 | 否 |
| 请求错误 | 400、413、参数或内容错误 | 否 | 否 |
| 本地业务错误 | 额度、账本、数据库、序列化 | 否 | 否 |
| 凭据错误 | 明确的 invalid API key、账号禁用 | 可换 Key | 只影响凭据健康 |
| 模型不可用 | model not found、账号无模型权限 | 可换渠道 | 影响渠道+模型健康 |
| 限流 | 429 | 预算内跨域一次 | 轻度影响 |
| 容量不足 | selected model is at capacity | 预算内跨域 | 轻度影响 |
| 上游网关故障 | 502、504、524、连接重置 | 是 | 是 |
| 流未完成 | 未收到完成事件或语义前 EOF | 语义前是，语义后否 | 是 |

错误分类必须由一个结构化分类器输出，不应在多个 handler 中重复匹配字符串。字符串匹配仅作为协议适配层的最后兼容手段。

### 7.3 统计门槛

第一阶段使用 Beta-Binomial 或 Wilson 下置信界，不使用小样本原始成功率直接驱逐：

- 默认先验建议 `Beta(19, 1)`，表达新候选初始成功率约 95%，但不赋予过强置信度；
- 少于 10 次有效请求：只记录，不因比例触发硬冷却；
- 10 至 20 次：允许进入 `suspect`，不因统计比例单独进入 `cooling`；
- 至少 20 次后，才允许依据下置信界触发统计冷却；
- 连续、可归因的 502/504/流未完成仍可快速触发短冷却；
- 客户端取消和本地错误不进入成功率分母。

TTFT 只用于降权，不能仅凭 3 个慢样本直接冷却渠道。只有“延迟异常 + 超时/失败”共同出现时才进入冷却。

## 8. 稳定性分层与确定性评分

### 8.1 稳定性分层

- A 层：成功率下置信界达到目标，TTFT 和错误爆发正常；
- B 层：可靠但延迟偏高，或样本仍不足；
- C 层：`suspect`、显著退化或仅允许探索；
- D 层：`cooling/half_open`，不参与普通流量。

优先从 A 层选择；A 层为空时选择 B 层；A/B 均为空时才允许 C 层受控探索。D 层只能通过恢复租约进入。

### 8.2 评分

建议使用可解释的加法评分，避免多个倍率相乘后难以判断单个因素的实际贡献：

```text
score = w_cost        * normalized_cost
      + w_failure     * posterior_failure_probability
      + w_ttft        * normalized_ttft_p95
      + w_concurrency * normalized_domain_load
      + w_switch      * cache_switch_penalty
      + w_domain      * recent_domain_failure_penalty
```

所有输入必须有上下界，单项异常不能产生无限分数。初始权重通过最近 7 天日志回放确定，并以配置版本记录到审计中。

### 8.3 粘性

粘性键建议为：

```text
tenant_or_token + group + model_family + request_type + affinity_fingerprint
```

粘性有效期默认 3 分钟，仅在以下条件下加分：

- 当前候选属于 A/B 层；
- 没有新的连续失败；
- 没有明显 TTFT 退化；
- 没有被当前请求的 `used_channels` 或 `failed_fault_domains` 排除；
- 请求携带的会话状态允许迁移或继续留在当前上游。

502、504、流未完成、明确凭据失败或进入 `suspect/cooling` 后，立即使当前请求的粘性失效。

## 9. AttemptController 与请求预算

### 9.1 单一尝试阶段

`AttemptController` 是重试安全的唯一事实源：

```text
selected -> connected -> bootstrap -> semantic_committed -> completed
                                  \-> failed
任意阶段 -> client_gone
```

- `semantic_committed` 必须在写出文本、tool call、图像结果或其他模型语义前设置；
- 进入 `semantic_committed` 后禁止重放完整请求；
- `ResponseBodyDelivered` 等旧布尔值在迁移期只作为派生兼容字段，不能继续独立决定重试；
- 每个协议适配器必须通过统一事件更新阶段。

### 9.2 请求预算

```text
RequestBudget {
  started_at
  deadline
  max_attempts
  attempts_used
  max_fault_domains
  fault_domains_used
  reserve_for_response
}
```

初始建议：

| 请求类型 | 最大尝试数 | 总路由预算 | 故障域上限 |
| --- | ---: | ---: | ---: |
| 普通 GPT 流 | 2 | 35 秒 | 2 |
| 长上下文/Codex | 2 | 90 秒 | 2 |
| 工具调用流 | 2 | 60 秒 | 2 |
| 非流式生图 | 2 | 180 秒 | 2 |
| 其他模型 | 2 | 60 秒 | 2 |

预算包括选路等待、账本预扣、上游连接、Retry-After 和重试。每次切换不得重新计时。

429 的 `Retry-After` 只在剩余预算允许时等待，并设置可配置上限；没有 `Retry-After` 时使用短抖动退避后跨故障域尝试一次。

## 10. 全冷却恢复与并发保护

当所有候选都在冷却时：

1. 按成功率后验下界、最近成功时间、剩余冷却时间和成本选择一个候选；
2. 使用 Redis 原子操作获取 `{fault_domain, model_family, request_type}` 恢复租约；
3. 每个故障域同一时刻最多一个普通半开探测；
4. 紧急重试可以使用独立且严格有上限的令牌桶；
5. 未获得租约时不得直接绕过并发限制；
6. Redis 不可用时回退到进程内租约，并在审计中标记 `health_scope=local`；
7. 不得批量解冻、清空冷却状态或直接恢复全部流量。

恢复成功后建议以 10% 流量起步，连续成功后逐级恢复；失败则提高退避级别，最大冷却 5 分钟。

## 11. 轻量在线学习方案

### 11.1 推荐算法

第一版采用受约束 Thompson Sampling：

- 每个合格候选维护成功率 Beta 后验；
- 仅在同一稳定性层内采样；
- 将采样失败概率与确定性的成本、TTFT 和负载项组合；
- 初期探索流量限制为 1%，有足够证据后最高不超过 5%；
- `suspect/cooling`、语义已提交、预算不足和故障域超限不能被探索绕过。

该方案不需要离线训练服务，状态量小，能够自然处理小样本和非平稳上游。

### 11.2 上下文特征

允许使用：

- 请求类型；
- 协议；
- 模型族；
- 上下文长度分桶；
- 是否包含工具调用；
- 当前故障域负载；
- 最近成功率和 TTFT；
- 采购成本；
- 是否发生缓存迁移。

禁止使用：

- 原始提示词、输出内容或 API Key；
- 用户身份、敏感业务字段或跨租户行为画像；
- 无法审计和解释的外部模型输出。

### 11.3 暂不采用的方案

- 不使用大模型进行在线语义路由；
- 不使用深度强化学习；
- 不在缺少 attempt 级数据时训练离线分类器；
- 不让模型预测覆盖错误分类、重试安全或计费逻辑。

## 12. 数据模型与审计

### 12.1 尝试事件

每次上游尝试记录不可变的 `route_attempt`：

```text
request_id, attempt_id, retry_index
request_type, protocol, model_family, prompt_size_bucket
requested_group, selected_group
channel_id, key_fingerprint, fault_domain
candidate_count, exclusion_reasons
health_state, health_scope, probe_mode
decision_policy_version, score_components
stage_before_error, failure_class, upstream_status
retry_decision, retry_reason
ttft_ms, total_ms, semantic_output_seen
procurement_multiplier, budget_remaining_ms
```

最终请求再记录 `route_summary`，区分：

- `attempt_error`：单次上游尝试失败；
- `final_error`：用户最终收到的错误；
- `local_error`：本站内部错误；
- `client_gone`：客户端主动断开。

### 12.2 隐私和存储

- `key_fingerprint` 只能使用不可逆摘要；
- 不存储原始 prompt cache key；
- 尝试事件设置合理 TTL，并聚合为长期指标；
- 决策配置、权重和算法版本必须可追溯；
- 影子决策不得发起额外上游请求。

## 13. 迁移步骤

### 阶段一：契约和观测

1. 新增 `RequestProfile`、`FailureEvent`、`RequestBudget` 和 attempt 级审计；
2. 将现有 `AttemptStage` 设为重试安全的主事实源；
3. 新 `RouteDecisioner` 只运行影子决策，不改变生产渠道；
4. 回放最近 7 天请求，比较新旧成功率、TTFT、成本、切换次数和候选耗尽率。

### 阶段二：健康状态 v2

1. 新建带 `request_type/protocol` 的 v2 健康命名空间；
2. 保留 v1 只读用于管理端对照，不将混合统计直接复制到 v2；
3. 将凭据、渠道和故障域健康分离；
4. 用 Beta/Wilson 下界替换小样本原始成功率判断；
5. 将单纯慢 TTFT 从硬冷却改为排序惩罚。

### 阶段三：统一执行与恢复

1. `AttemptController` 接管重试和请求预算；
2. 清理 handler 中重复的重试分支和布尔判断；
3. 使用 Redis 原子租约实现严格有界的 half-open 和 last-resort；
4. 显式统一 prompt cache 粘性与自动池粘性的健康检查和失效条件。

### 阶段四：确定性灰度

1. 仅对 `auto` 分组启用；
2. 按 5%、10%、25%、50%、100% 扩大；
3. 每档至少覆盖一个完整业务高峰；
4. 确定性策略达到验收标准后，才进入在线学习阶段。

### 阶段五：在线学习灰度

1. Thompson Sampling 先以 1% 探索率运行；
2. 与确定性策略持续做影子对照；
3. 只有成功率不下降且成本/TTFT 至少一项改善时才扩大；
4. 算法状态异常时自动切回确定性评分，不影响健康状态机。

## 14. 必测场景

1. 上游连接前 503：跨故障域备用成功，用户只看到一次响应；
2. Responses 只收到生命周期事件后 EOF：缓存丢弃并安全重试；
3. 文本 delta 后 EOF：不重放，发送协议级脱敏错误；
4. tool call 后 EOF：视为语义已提交，不重放；
5. 客户端取消：不重试、不冷却、不进入失败率分母；
6. 100 个并发请求共享一个故障：只有受控数量的故障域事件和探测；
7. 所有候选冷却：只有持有租约的请求进入半开；
8. 429 带 Retry-After：等待受请求预算约束并优先跨域；
9. 长上下文首包超过普通阈值：不污染短文本健康；
10. 生图慢响应：不污染 GPT 文本 TTFT 和冷却；
11. 自动池粘性渠道退化：立即迁移到健康候选；
12. Redis 不可用：明确降级到本地状态并产生审计标记；
13. 预扣、重试、退款和最终计费保持幂等；
14. 在线学习选择永远不能突破硬过滤与请求预算。

## 15. 验收指标

- GPT 最终成功率不低于 99%；
- 502/504 导致的最终失败率下降 50% 以上；
- 用户可见 503 不超过总请求的 0.1%；
- 普通 GPT P95 TTFT 不高于基线；
- 同一请求平均切换次数不超过 0.35；
- 重试放大系数不超过 1.20；
- 自动池采购成本降低 10% 以上；
- 缓存粘性命中率下降不超过 10%；
- 生图成功率和 P95 总时长不恶化；
- 长上下文上下文丢失为 0；
- 数据库、账本、预扣和客户端取消不得记录为上游失败；
- 全冷却期间半开并发符合租约上限。

## 16. 回滚条件

出现以下任一情况立即关闭新决策器，恢复确定性旧策略：

- GPT 最终成功率连续 10 分钟低于 98%；
- 用户可见 503 超过 0.5%；
- 重试放大系数超过 1.30；
- 出现重复文本、重复 tool call 或重复图像结果；
- 长上下文切换后出现上下文丢失；
- 生图 504 或 P95 总时长较基线增加 20% 以上；
- 账本出现重复扣费、漏结算或 outbox 异常；
- 半开探测并发超过配置上限；
- 在线学习无法读取状态、产生非法分数或策略版本不可追溯。

回滚只切换决策策略，不删除审计和健康数据。在线学习回滚到确定性评分时，不得连带恢复已经被确认不健康的候选。

## 17. 参考资料

- LiteLLM Router: https://docs.litellm.ai/docs/routing
- Envoy Outlier Detection: https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier
- Google SRE Book, Addressing Cascading Failures: https://sre.google/sre-book/addressing-cascading-failures/
- AWS Exponential Backoff and Jitter: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- Thompson Sampling: https://web.stanford.edu/~bvr/pubs/TS_Tutorial.pdf
- RouteLLM: https://arxiv.org/abs/2406.18665
- FrugalGPT: https://arxiv.org/abs/2305.05176

## 18. 最终决策

本项目不采用全量重写，也不把机器学习作为第一阶段。先用 `RequestProfile + RouteDecisioner + AttemptController + Health v2` 收敛确定性事实和安全边界，再使用受约束 Thompson Sampling 优化健康候选之间的成本与延迟。

机器学习是排序增强器，不是故障恢复控制器。任何时候，协议正确性、语义不可重放、故障域隔离、请求预算和计费幂等都优先于算法收益。
