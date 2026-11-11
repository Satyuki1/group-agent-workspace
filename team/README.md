# DS Bot Team

团队成员使用 Web 或桌面端加入同一个服务，私聊、建群并邀请服务器 Agent。Agent 的执行与聊天服务分别运行。

## 本地运行

需要 Node.js 24.9+ 和 Docker Compose。在仓库的 `team/` 目录执行：

```sh
cp .env.example .env
```

在 `.env` 中为 `IM_DB_PASSWORD` 和 `IM_RUNNER_SECRET` 分别填入随机值。数据库密码使用 URL 安全的字符，例如随机十六进制。启动：

```sh
docker compose up -d --build im
docker compose exec -it im sh -c 'printf "管理员密码（至少 12 字符）: " >&2; stty -echo; IFS= read -r value; stty echo; printf "\n" >&2; printf "%s" "$value" | node server/admin.ts admin "管理员"'
```

访问 http://127.0.0.1:3090，使用刚创建的账号登录。在「设置」生成邀请链接，由管理员交给同事。邀请和重置链接有效期为 24 小时，使用一次后失效。

如果 Docker 提示默认地址池已用完，可在 `compose.override.yml` 中为 `networks.default.ipam.config` 指定一个宿主机未占用的子网，例如 `[{ subnet: 10.254.219.0/24 }]`。

内部部署时用 TLS 反向代理将团队的 HTTPS 域名转发到本机 3090，并启用 WebSocket Upgrade。将 `IM_ORIGIN` 设置为这个 HTTPS origin。桌面安装包第一次打开时填写同一个地址。反向代理应允许 50 MB 的上传以及相应的 multipart 开销。


启动 DS Bot Web 时设置 `DS_BOT_TEAM_WEB_ORIGIN=http://127.0.0.1:3090`。团队 IM 设置 `IM_PERSONAL_WORKSPACE_ORIGIN=http://127.0.0.1:3081` 和 `IM_PERSONAL_WORKSPACE_OWNER`（本机所有者的 IM 登录名）。打开原版 DS Bot Web，在左侧「通讯录」登录 IM 账号。点同事打开私聊，已有私聊和群聊在左侧会话列表。使用原版「新建」菜单中的「新建团队群聊」选择同事和 Agent。DS Bot 的创建 Agent、连接器、能力与工具、电脑操控都使用原版界面。群主可以邀请自己的个人 Agent。群里 @ 它后，由 Agent 所有者确认。执行期间保持 DS Bot 网页打开，群任务使用独立的本机会话，当前支持文本。电脑操控需要相应的系统授权。其他成员可通过团队服务的 3090 网页加入聊天。

## Agent 与 Super Agent

```sh
docker compose --profile build-worker build worker-image
docker compose --profile agent up -d --build runner
```

在部署环境设置 `DEEPSEEK_API_KEY`，可用 `DEEPSEEK_BASE_URL` 配置 Anthropic Messages 兼容端点。在团队设置中创建 Agent，填写 DSH 模型 ID，例如 `deepseek-official/deepseek-flash`，实际可用 ID 由部署的 DSH 模型配置决定。

群主可以加入 Agent。使用输入框的 `@` 菜单点名，或引用回复 Agent 的消息，任务会异步执行。打开 Agent 的文件处理权限后，可读取已授权的文本附件、接收受支持的图片、生成文本文件并在群内申请分享。单个文本工具输入上限为 512 KB，每次任务附件总量上限为 64 MB。Agent 的工作目录按会话绑定隔离。

Super Agent 使用单独的 OpenAI Chat Completions 兼容端点，配置 `IM_ROUTER_BASE_URL`、`IM_ROUTER_API_KEY`，再在管理员设置中保存分类模型 ID。群主开启后，分类只处理普通人类消息。超时或无法分类时保持安静。

Runner 调度器需要 Docker socket 来启动隔离容器。Agent 工作容器仅获得各自的数据卷和模型连接配置。为每个绑定保留的卷名以 `dsbot-team-binding-` 开头。

## 开发、打包与检查

```sh
npm ci
npm run check
npm run build
npm run desktop
npm run package -- --mac zip --arm64 --publish never
npm run package -- --win nsis --x64 --publish never
```

开发版桌面端允许连接本机 HTTP。安装包使用 HTTPS；macOS 和 Windows 的分发签名由部署方配置。仓库中的 Team IM 工作流包含对应平台的打包任务。

```sh
IM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:35432/postgres npm test
```

测试数据库使用临时 schema。指定 `IM_TEST_CHROME` 和 `IM_TEST_ELECTRON` 可运行真实客户端测试，指定 `IM_TEST_WORKER_IMAGE` 可测试 DSH 流式回复、文件生成与审批。再设置 `IM_TEST_MODEL_URL` 为容器可访问的模拟模型端点，可验证群聊到 Runner 的完整链路。Linux Docker 可使用 `IM_TEST_DOCKER_NETWORK=host IM_TEST_DOCKER_HOST=127.0.0.1` 访问测试模型。

## 备份与恢复

先停止 `im` 和 `runner`，使用 `docker compose exec -T db pg_dump -U team -Fc team > team.dump` 备份数据库，同时备份 Compose 的 `attachments` 卷。需要保留 Agent 执行历史时，一并备份绑定卷。备份文件包含团队消息和账号数据，应限制读取权限。

恢复到空部署时先启动数据库，用 `pg_restore -U team -d team` 恢复数据库，再恢复附件卷和对应的绑定卷，最后启动 IM 和 Runner。`/healthz` 检查进程存活，`/readyz` 检查数据库可用性，管理员可查询 `/api/im/v1/admin/health` 与分类记录。
