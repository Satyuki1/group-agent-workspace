# Buzz + DeepSeek Harness 接入评估

> **历史评估，已被远端 Web 架构替代。** 下文保留早期 ACP 路线的研究依据，不作为当前部署说明。2026-11-04 已部署 Buzz Web Host、独立 DSH Web Runtime 和原生右侧嵌入；真实双人群聊、DeepSeek 执行及共享文件链路已通过。当前架构和验收边界见 [实施记录](docs/IMPLEMENTATION.md)，操作命令见 [运维说明](docs/OPERATIONS.md)。不要按下文同时启动 ACP 和 Web 进程写同一会话。

核查日期：2026-11-04。范围：官方源码、配置项和协议契约核查。尚未安装运行这套组合，也未验证真实模型、两个真人和三个 Agent 的端到端协作。下文区分已有能力与建议实现。

结论：可行。最短验证路径是现成 `buzz-acp` 启动 DSH 的 ACP 服务；正式产品建议在新版 `buzz-app` 中增加 DSH Agent 类型，复用共享 ACP 客户端、群消息工具和 Attention 调度。DSH 核心第一版可以保持不改。主要新增工作在 Buzz 侧的多人授权、任务协调、会话恢复和部署。

## 版本边界

本次源码快照：

| 仓库 | 固定提交 | 用途 |
|---|---|---|
| `block/buzz` | `49fcab3324549cba9043b661c4fd0acf0f980a03` | Relay、CLI、`buzz-acp`、原桌面应用 |
| `block/buzz-app` | `0b2dfbf9889ea95873f175b216fbb0b5795f104e` | 新桌面应用、插件式 Agent、共享 ACP 客户端、Attention |
| `deepseek-ai/deepseek-harness` | `8bd073392eef6f54e921a093b95076248eb08cbb` | Agent 执行与 ACP 服务 |

两个 Buzz 仓库的接入方式不能混用：原桌面的 `custom_harnesses/*.json` 不等于新应用的 Agent 插件。新应用内置 Agent 类型接入共享 ACP 客户端时，不需要再串一个 `buzz-acp` 进程。

## 最短验证路径：先复用 buzz-acp

```text
真人 A、真人 B
      ↕
Buzz 客户端 ↔ Buzz Relay
                  ├─ 群管家身份 ↔ buzz-acp ↔ DSH ACP
                  ├─ 调研员身份 ↔ buzz-acp ↔ DSH ACP
                  └─ 写作员身份 ↔ buzz-acp ↔ DSH ACP
                                               │
                                  Buzz CLI 发消息、读消息、@ 其他 Agent
```

`buzz-acp` 已支持可配置的 ACP 子进程；DSH 提供 `dsh --profile acp`。接入配置草案见同目录 `buzz-dsh.env.example`。[旧桥接器](https://github.com/block/buzz/blob/49fcab3324549cba9043b661c4fd0acf0f980a03/crates/buzz-acp/README.md)、[DSH ACP 应用](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/bundle/acp-app/README.md)。

前提：先配置好 DSH 的模型凭证及工具；每个 Agent 拥有独立 Buzz 身份并加入社区、群；子进程能访问 `buzz` CLI。桥接器的基础提示词要求 Agent 主动调用 CLI 发消息，不能把 ACP 标准输出直接当成已经发到群里的消息。

关键配置：

| 项目 | MVP 建议 | 理由 |
|---|---|---|
| `BUZZ_ACP_AGENT_COMMAND` | 已安装 DSH 可执行文件的绝对路径 | 启动标准 ACP 服务 |
| `BUZZ_ACP_AGENT_ARGS` | `--profile,acp` | 此变量按逗号拆分 |
| `BUZZ_ACP_RESPOND_TO` | `allowlist` | 允许指定同事和协作 Agent 在群中发起工作 |
| `BUZZ_ACP_RESPOND_TO_ALLOWLIST` | 同事和协作 Agent 的公钥 | 不能只依赖默认 owner-only |
| `BUZZ_ACP_CHANNELS` | 指定试验群 | 控制监听范围 |
| `BUZZ_ACP_SUBSCRIBE` | 专家 `mentions`，管家可试 `all` | 全量监听本身不含智能筛选 |
| `BUZZ_ACP_SESSION_POLICY` | 专家 `thread`，管家初期 `channel` | 专家任务分线程；管家保留连续群上下文 |
| `BUZZ_ACP_MULTIPLE_EVENT_HANDLING` | `queue` | 避免默认 steer 对 DSH 退化为取消后重发 |
| `BUZZ_ACP_AGENTS` | 每个身份先设 `1` | 这是同一身份的执行进程池大小，不是群成员数 |

上述字段来自 [config.rs](https://github.com/block/buzz/blob/49fcab3324549cba9043b661c4fd0acf0f980a03/crates/buzz-acp/src/config.rs)。会话边界见 [scope.rs](https://github.com/block/buzz/blob/49fcab3324549cba9043b661c4fd0acf0f980a03/crates/buzz-acp/src/scope.rs)。

原桌面的自定义 Harness 注册支持 `id`、`label`、`command`、`args`、`env` 等 JSON 字段，可用来让 DSH 出现在其运行时选择中；这只解决运行时登记，身份、成员关系、模型配置仍要准备。[custom_harnesses.rs](https://github.com/block/buzz/blob/49fcab3324549cba9043b661c4fd0acf0f980a03/desktop/src-tauri/src/managed_agents/custom_harnesses.rs)。

一个已确认的限制：旧桥接器对 DM 单独检查，只接受 owner 或经验证的同所有者 Agent；群聊 allowlist 或 anyone 不会自动开放他人的 DM。如果要做“公司里任何获授权的人都能私聊共享 Agent”，需要新增共享 Agent 的 DM 授权规则。[author_allowed](https://github.com/block/buzz/blob/49fcab3324549cba9043b661c4fd0acf0f980a03/crates/buzz-acp/src/lib.rs#L569)。

## 正式产品路径：新版 buzz-app 增加 DSH 适配器

```text
Buzz 消息与 Agent 身份
         ↓
现有 runner / Attention / 线程路由
         ↓
新增 DSH Agent 类型与授权策略
         ↓
现有共享 AcpProcess / AcpSession
         ↕ ACP：启动会话、提交任务、接收状态、取消
DSH --profile acp
         ↕ HTTP MCP：读群、发消息、@、使用 Buzz 工具
Buzz 现有工具服务（持有并使用 Agent 身份）
```

可复用的新应用源码：

| 代码位置 | 复用方式 |
|---|---|
| `src/bundled/goose/index.ts`、`run.ts` | 参考 Agent 类型登记、配置表单、run / runOnce 的接入方式 |
| `src/features/agent-harness/acp/process.ts` | 复用 stdio JSON-RPC、初始化、HTTP MCP、工具回复处理 |
| `src/features/agent-harness/acp/session.ts` | 复用会话排队、取消、输出与 Buzz 回复去重 |
| `src/features/agent-harness/acp/agent-sessions.ts` | 复用会话池、工作目录、线程绑定；扩展持久恢复 |
| `src/features/agents/runner.ts` | 复用消息去重、自消息过滤、唤醒队列和限流 |
| `src/features/agents/attention.ts` | 复用群事件筛选、Interest、定时监听规则 |
| `src/buzz-mcp/` | 复用聊天与应用工具，不重写消息发送服务 |

适配器建议新增在 `src/bundled/dsh/`，这是建议目录，当前尚未创建实现。需要做：

1. 注册 `dsh` Agent 类型、工作目录、角色说明、模型配置和状态展示。
2. 在插件 manifest 声明 DSH 子进程及所需 host 权限。`host.spawn` 接受声明的进程 ID，不是任意可执行路径。
3. 通过共享 `AcpProcess` 启动 `dsh --profile acp`，挂载已有 HTTP MCP 工具服务。
4. 去掉 Goose 专有 `_goose/unstable/*` 调用。第一版直接使用 DSH 已配置模型；后续按 DSH 实际返回的 configOptions 接 `model` / `reasoning_effort`。
5. 沿用标准提示词回退机制；DSH 没有 Goose 的 system-prompt 扩展。标准链路会把 Buzz 角色说明放入首次提示，不等于 DSH 原生系统角色配置；需要更强固定角色时使用 DSH profile/preset 配置。
6. 接入 `runOnce`，让现有 Attention watches 和 timers 也能唤醒 DSH。
7. 把 Goose 示例中的 `fromOwner` 授权检查扩展为明确的团队 Agent 策略。保留个人 Agent 默认边界，不把所有 Agent 全局开放。

[共享 ACP 进程](https://github.com/block/buzz-app/blob/0b2dfbf9889ea95873f175b216fbb0b5795f104e/src/features/agent-harness/acp/process.ts)、[Goose runtime](https://github.com/block/buzz-app/blob/0b2dfbf9889ea95873f175b216fbb0b5795f104e/src/bundled/goose/runtime.ts)、[Host 进程接口](https://github.com/block/buzz-app/blob/0b2dfbf9889ea95873f175b216fbb0b5795f104e/src/features/host/service.ts)。

Attention 已有独立的 mention / watch 队列、Interest 串行与跨 Interest 并发、作者筛选、定时器及离线补读。监听别人的消息作为数据，和接受别人发起命令是两个权限问题。[Attention 行为](https://github.com/block/buzz-app/blob/0b2dfbf9889ea95873f175b216fbb0b5795f104e/docs/attention-janet-parity.md)。

## 与用户目标逐项对照

| 用户目标 | 已有基础 | 还要做 |
|---|---|---|
| 多个真人在群中交流 | Buzz 的消息、群、身份、@ 体系 | 验证具体 IM 功能与终端要求；不在本轮承诺企业微信全部功能齐备 |
| 创建 Personal Agent 并私聊 | Buzz 的 Agent 创建/身份；DSH 工作会话 | DSH 类型登记，设置与凭证接入 |
| 多个人指挥同一个 Agent | 群消息能到达，旧桥有 allowlist | 新插件增加团队授权；共享 Agent DM 另行处理 |
| 多个独立 Agent 入群 | 每个 Agent 独立身份；消息可显式 @ | 角色配置、同群可见范围、Agent 相互授权 |
| Agent 主动看群 | 新应用 Attention；旧桥 subscribe all | 相关性判断、发言节奏、只在有进展时输出 |
| 多 Agent 分工 | Buzz 显式 @ 和 DSH 执行能力 | 分配/认领/结果/失败的任务规则与状态 |
| 快慢对话 | 多身份、多会话；DSH 会话间可并行 | 让轻量群管家保持空闲，慢任务交专家独立会话 |
| 长任务恢复 | DSH 持久会话及 session/resume | Buzz 会话映射、任务账本、恢复时重新挂 MCP |
| 24 小时在线 | 可独立部署旧 buzz-acp | 新桌面内的本地 Agent 随应用生命周期；服务端托管需单独部署设计 |
| 截图中的电脑预览/登录交互 | DSH 可扩展工具 | 云电脑、浏览器会话、屏幕流和安全输入 UI 是额外产品模块 |

## 第一版建议的协作规则

群里先放三个真正独立的成员：群管家、调研员、写作员。真人可以 @ 任一专家；管家只做识别、拆分、委派、进度答复和汇总。慢任务交出去后结束当前短回合，靠完成消息或定时唤醒继续，不在模型调用里等待。

推荐的产品行为：

1. 真人讨论“下周要做竞品方案”；管家监听到有明确工作，提出或领取任务。
2. 管家 @ 调研员给出目标、交付物、task_id、原线程；专家可直接被其他获授权的人补充需求。
3. 调研员完成后向原线程发结构化结果，再 @ 管家或写作员。`@名字` 的显示文本与真实成员身份一并传递。
4. 写作员接手；管家始终可回答其他人的群内问题、查询进度。
5. 最终结果回原群原线程；已完成任务不被重复结果再次启动。

DSH 内部子 Agent 可以帮助专家完成任务，但不会自动成为 Buzz 的独立群成员。不要把内部 subagent 数量当作产品 Agent 数量。

建议新增一个小型任务账本，先 SQLite 即可；这属于建议设计，不是现成 Buzz 数据结构：

```text
task_id, channel_id, thread_id, requester_pubkey,
assignee_agent_id, status, dsh_session_id,
parent_task_id, last_event_id, result_ref
```

最少实现：待领取 → 执行中 → 等待输入 / 已完成 / 失败 / 已取消；认领需原子操作；重复事件不能重复分派；完成/取消是终止状态。重启后应区分“恢复会话”和“重新执行有副作用的步骤”。如果使用 Buzz 已有 issue/task 作为用户界面，补充这层运行状态映射即可，不必另造完整项目管理系统。

Agent 自消息过滤、队列限流、事件去重已有基础，但无法阻止 A/B 对同一任务互相触发新消息。补充 task_id 去重、每任务派生深度、预算/轮数上限、已完成消息不再派工。初期规则固定，别让所有 Agent 都无条件响应全群。

个人私聊、团队群聊和任务上下文分开。会话键建议包含 Agent、社区、群、线程；团队 Agent 不自动加载所有者私聊记忆。不同工作目录只是组织方式，不是文件访问隔离；正式托管需要执行环境和凭证边界。

## 已确认的接口缺口

**执行中追加消息。** DSH 标准 ACP 每会话只接受一个在途 prompt。其核心 Agent 有 steer/inbox 能力，但该能力没有直接暴露成现有 ACP 的 steering 扩展。第一版排队即可；需要执行中即时改方向时，第二版做受控扩展或 SDK 适配。DSH ACP 的 prompt 也会等待管理的子 Agent 完成，因此仅把工作 spawn 成内部子 Agent，不能保证前台 prompt 立即结束。[ACP 契约](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/acp/acp/README.md)、[Agent 核心接口](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/core/agent/README.md)。

**持久恢复。** DSH 支持 `session/resume`，不支持 `session/load`。新 Buzz 通用 ACP 会话池目前主要保存最近使用时间，关闭/重启后新建会话并补聊天上下文；这不等于恢复 DSH 原执行状态。应保存 thread→sessionId，恢复时重新连接本会话 MCP 服务。不能硬套其他 Harness 的 load 接口。[会话池](https://github.com/block/buzz-app/blob/0b2dfbf9889ea95873f175b216fbb0b5795f104e/src/features/agent-harness/acp/agent-sessions.ts)。

**权限交互。** 当前旧桥和新共享 ACP 客户端都会自动选择允许的 permission 选项。用户想要群里点按钮批准某一步时，需要新增 request_id / session_id 关联与授权人校验。简单演示可先仅配置允许自动运行的低权限工具，不应展示一个实际不会生效的审批开关。[旧实现](https://github.com/block/buzz/blob/49fcab3324549cba9043b661c4fd0acf0f980a03/crates/buzz-acp/src/acp.rs#L2005)、[新实现](https://github.com/block/buzz-app/blob/0b2dfbf9889ea95873f175b216fbb0b5795f104e/src/features/agent-harness/acp/process.ts#L444)。

**运行界面。** DSH ACP 提供提交后的消息、思考和通用工具状态，不提供 DSH 专有 UI 卡片、终端界面和原始 token 流。第一版用 Buzz 已有进度与工具状态展示；截图中的实时云电脑另做。

**协议版本。** 旧 buzz-acp 发起 protocolVersion 2，但保留对 v1 的提示词回退；新 Buzz 共享客户端发起 v1，DSH 返回 v1 并支持 HTTP MCP。静态能力匹配良好，仍需实际握手与工具回传验证。[旧初始化](https://github.com/block/buzz/blob/49fcab3324549cba9043b661c4fd0acf0f980a03/crates/buzz-acp/src/acp.rs#L673)、[DSH 初始化](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/acp/acp/src/index.ts#L179)。

## 验收顺序

1. 单 Agent：初始化、新建会话、接收 @、读上下文、工具执行、发回原群，验证没有重复回复。
2. 两真人三 Agent：每个成员有正确身份；两个真人都能驱动授权 Agent；管家能 @ 专家，专家能回调。
3. 慢任务：专家工作期间管家继续答话；同线程补充消息排队或按明确操作取消，不静默丢失。
4. 主动监听：普通闲聊保持安静；明确任务触发；不会读到未加入的群或泄露个人私聊。
5. 故障恢复：强制断开进程后恢复会话与任务状态，不重复发布和重复执行外部操作。
6. 权限与终止：非授权成员无法派工/批准；任务完成或取消后停止连锁触发。

建议先用旧桥验证步骤 1–2，再把同一 DSH ACP 配置接入新应用适配器，完成步骤 3–6。不要同时长期维护两套协作调度。基础聊天接通属于小改；稳定群体协作属于明确的增量开发；完整企业级 IM 与云电脑属于另外的范围。
