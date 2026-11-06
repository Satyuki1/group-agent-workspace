# 群体智能

基于 Buzz 和 DeepSeek Harness 的团队聊天与智能体协作应用。成员可在群聊中 @ 智能体发起工作，查看实时进度，并在同一讨论内接收成果。智能体也可在群回复中互相 @，将任务交给同群成员处理，再把结果交回汇总。共享工作区使用 Harness 原生界面。Web 应用支持通过 Chrome 安装。

## 获取源码

需要 Git、Python 3 和 Node.js 24。三个上游版本固定在 [upstream-lock.json](upstream-lock.json)。仓库通过补丁保存集成修改。

```sh
python3 scripts/upstreams.py
python3 scripts/patches.py apply
npm ci
(cd upstream/deepseek-harness && corepack pnpm install --frozen-lockfile && corepack pnpm run build:artifacts)
npm test
```

Web 客户端依赖位于 `upstream/buzz-app`，按其上游说明安装。要连接自己的已部署实例，设置 `BUZZ_TEAM_SERVER` 为 Web 服务地址、`BUZZ_RELAY_URL` 为 Relay 地址、`BUZZ_TEAM_CA` 为部署 CA 的本地文件路径，再运行 `npm run dev`。预览默认监听 `127.0.0.1:1470`。

## 部署

[部署配置](deploy/)包含 Caddy、Buzz Relay、数据库、缓存、媒体存储、Web Host 和隔离的 Harness 工作空间。部署需要 Linux、Docker Compose、可供服务及客户端访问的 IPv4 地址和 DeepSeek API 凭证。

- 在部署机准备 `/mnt/group-agent` 下的挂载目录、服务权限和外部网络 `group-agent-spaces`，参考 Compose 文件和 systemd 单元。新库初始化使用 `compose.initialize.yml` 覆盖，随后按 `scripts/provision-fast-wal.py` 说明配置 WAL 挂载。
- 将 `GROUP_AGENT_HOST` 设为部署机的 IPv4 地址，运行 `scripts/bootstrap-secrets.py` 生成实例专用凭证，另行配置 `secrets/model.env`。模型密钥只保存在部署机上。
- 构建 Team Web 客户端时设置 `BUZZ_TEAM_WEB=1` 和对应的 `BUZZ_RELAY_URL`，将构建产物放在 `upstream/buzz-app/dist`。Harness 构建和运行时镜像由 `scripts/build-runtime-image.py`、`deploy/Dockerfile.runtime` 与运行时服务单元管理。
- HTTPS 入口使用端口 18443，Relay 使用 18444。客户端应信任部署 CA。团队设置位于 `/?team-settings`。

此版本提供部署配置与运维脚本。全新主机的完整部署仍需按环境配置和验证。

## 上游许可

上游 Buzz 与 Buzz App 使用 Apache-2.0，DeepSeek Harness 使用 MIT。补丁保留上游归属，许可文本与通知见 [licenses/](licenses/)。
