# Claude Desktop NAS

在 NAS 上以无头 Docker 容器运行 Anthropic 官方 Linux Claude Desktop，并通过轻量级 Remote IPC Bridge 在浏览器中使用 Chat、Cowork 与可选的 Code/Developer 能力。浏览器看到的是 Claude Desktop 随安装包提供的官方 `ion-dist` 界面；本项目只负责容器化、受限桥接和持久化，不重做消息渲染器。

## 界面预览

### PC 端

<p align="center">
  <img src="docs/screenshots/claudesk-home.png" alt="Claudesk PC 端首页" width="720">
</p>

<p align="center">
  <img src="docs/screenshots/claudesk-developer.png" alt="Claudesk PC 端 Developer 页面" width="720">
</p>

### 移动端

<p align="center">
  <img src="docs/screenshots/chat-mobile.png" alt="Chat 移动端界面" width="280">
  <img src="docs/screenshots/cowork-mobile.png" alt="Cowork 移动端界面" width="280">
  <img src="docs/screenshots/claudesk-mobile.png" alt="Claudesk 移动端首页" width="280">
</p>

## 适用场景

- 在 Linux/NAS 上运行官方 Claude Desktop，而不依赖物理桌面。
- 使用局域网或 Tailnet 浏览器访问 Chat 与 Cowork，并保留 Desktop 的本地会话状态。
- 在可信 HTTPS/Authelia 入口后按需打开 Gateway 设置、Developer、Infrastructure 或 Code 表面。
- 让同一份 `/config` 和 `/workspace` 数据在容器重启后继续可用。

## 工作原理

```mermaid
flowchart LR
  B["浏览器 / PWA"] -->|HTTP 15821 或 HTTPS 反向代理| W["cowork-bridge"]
  W -->|共享网络命名空间，127.0.0.1:9222| A["Remote Preload / IPC adapter"]
  A --> D["官方 Claude Desktop ion-dist"]
  D --> G["Gateway / 本地会话 / Cowork VM"]
  D --> C["/config 会话与设置"]
  W --> X["/workspace 文件与上传"]
```

关键边界：

- `claude-desktop` 运行官方签名 APT 包、Electron/Xvfb 和 Cowork VM。
- `cowork-bridge` 只发布浏览器所需的 HTTP API；两个服务共享 `claude-desktop` 的网络命名空间。
- Bridge 到 Desktop 的方法、路径、文件类型和请求头均采用 allowlist；不接受任意 Electron action 或任意文件路径。
- Chat 与 Cowork 使用同一官方 `LocalAgentModeSessions` 管理器，但按 `sessionType` 隔离；事件通过 `GET /api/events?mode=chat|cowork&sessionId=:id` 推送。

## 浏览器入口

| 入口 | 用途 | 访问边界 |
| --- | --- | --- |
| `http://NAS_IP:15821/` | 局域网/Tailnet 直接访问 Chat、Cowork | 仅可信网络；不继承 Authelia |
| `https://claude-home.172906573.xyz:28443/` | 安装 PWA、跨网络访问 | 由现有 Nginx Proxy Manager + Authelia 保护 |

`15821` 是本 Compose 的唯一公开端口（容器内 `8080`）。HTTPS 入口需要把主机名解析到 NAS，并沿用现有 Authelia 两因素规则。浏览器可以直接使用 HTTP，但标准 PWA 安装和 Service Worker 需要 HTTPS。

## 前置条件

- Linux 主机、Docker Engine 与 Docker Compose v2。
- 可用的 `/dev/kvm` 与 `/dev/vhost-vsock`，并允许当前用户访问 KVM 组。
- 一个外部 Docker 网络 `gateway_net`：

  ```bash
  docker network inspect gateway_net >/dev/null 2>&1 || \
    docker network create gateway_net
  ```

- 可访问 Anthropic 官方 APT 源；首次构建会编译校验固定版本的 `virtiofsd` 1.13.3。
- Gateway 的 URL、API Key、认证方案和模型列表。
- 为 Cowork VM 与持久化数据预留约 25 GB 以上空间。

## 快速开始

```bash
git clone https://github.com/ump45nose/Claudesk.git
cd Claudesk
cp .env.example .env
```

编辑 `.env`，至少填写以下三项（不要把真实密钥提交到 Git）：

```dotenv
CLAUDE_GATEWAY_BASE_URL=http://gateway.example:3001
CLAUDE_GATEWAY_API_KEY=请填入你的密钥
CLAUDE_INFERENCE_MODELS_JSON='[{"name":"claude-sonnet-minimax-m3","labelOverride":"MiniMax M3","anthropicFamilyTier":"sonnet","isFamilyDefault":true}]'
```

准备 seccomp 配置、构建并启动：

```bash
./scripts/prepare-seccomp.sh
docker compose build
docker compose up -d
./scripts/smoke.sh
```

查看状态或停止：

```bash
docker compose ps
docker compose logs -f claude-desktop cowork-bridge
docker compose down
```

镜像固定安装 `CLAUDE_DESKTOP_VERSION` 指定的精确版本，容器重启不会执行 APT 升级。生产机使用
`ops/systemd/claudesk-monthly-update.timer` 在每月 1 日 04:30（Asia/Taipei）构建候选镜像；
只有当前单版本 Renderer 补丁准备和基本冒烟通过后才切换，失败会保留或恢复上一镜像。

## Desktop 2.x 升级

当前固定版本为 **2.9939.4**（2026-10-01 检查官方 stable APT 仓库）。升级已有部署时，
将本机 `.env` 的 `CLAUDE_DESKTOP_VERSION` 改为 `2.9939.4`，确保
`CLAUDE_COWORK_HOST_BASH=0`，然后重新构建并运行现有 smoke scripts。
Desktop 2.x 使用官方原生编辑、rewind 与问题处理；旧版 1.x 的编译代码补丁已移除。
可选 container-host Bash 模式尚不支持 2.x，会在修改安装包前明确拒绝启动。
请在更新前停止 Desktop 并备份持久化 `/config`；新版本可能迁移会话数据。

可在不启动 Electron 的情况下检查官方包的 renderer：

```bash
npm ci --prefix rootfs/opt/claude-cowork-bridge --ignore-scripts
node scripts/desktop-compatibility-smoke.mjs /path/to/extracted/resources/ion-dist
```

该检查覆盖默认模式和 Gateway 设置开关、生成模块语法和包版本边界。
它不能替代 Linux/KVM 主机上的 Chat、Cowork 与实际 Gateway 端到端验证。

### 更新韧性

每月检查只会部署 `config/release.json` 声明的已审查版本。发现更高版本时记录
`awaiting-compatibility-profile` 并保留当前服务；构建参数不能覆盖兼容性声明。
维护者升级时必须检查新官方包、更新版本声明，并运行 compatibility 与 smoke 检查。
包入口与 renderer 使用同一版本声明。Frontend 补丁使用 Acorn AST 按协议比较、
路由跳转和稳定属性识别目标，不依赖 chunk 文件名、局部变量名、空白或引号风格。
只替换必要表达式，保留其他 bundle 字节及模块图；缺失或重复目标会明确拒绝。
原生能力检查也使用语法结构，避免仅因 IME 等表达式重新编译而误判功能缺失。
详见 [Frontend 补丁维护](docs/frontend-patches.md)。

Renderer 在验证全部目标后才发布生成文件，并最后原子更新 manifest 指针；验证失败保留旧文件。
候选检查沿用部署的 Gateway 开关。Desktop 和 bridge 一起构建、切换和恢复；恢复使用
正在运行的原始 image ID，失败或中断触发恢复，恢复失败记录 `rollback-failed`。
镜像恢复不撤销官方程序对持久化会话数据的迁移，升级前仍需备份 `/config`。

`scripts/validate.sh` 包含编译变量漂移、缺失/重复目标、旧 renderer 保留及模拟更新失败测试。
这些测试使用临时目录和模拟 Docker，不修改真实部署；真实 Electron/KVM 验证仍需生产同类主机。

## 配置项

### 必填与基础运行

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COWORK_WEB_PORT` | `15821` | 宿主机公开端口，映射到 Bridge `8080` |
| `COWORK_BRIDGE_INTERNAL_PORT` | `9222` | Desktop 内部 Cowork adapter 端口，仅 loopback |
| `COWORK_UPLOAD_MAX_BYTES` | `1073741824` | Web UI 单次上传（附件、拖入文件夹）的总大小上限，字节数，可带 `K`/`M`/`G` 后缀；文件以原始二进制流式写入 `/workspace/RemoteUploads`，不占内存 |
| `COWORK_REMOTE_READ_ROOTS` | —（仅 `/workspace`） | 已认证的远程下载路由（`GET /api/remote/files/download`）额外可读的根目录，冒号或逗号分隔；`/workspace` 始终允许。路径在 cowork-bridge 容器内解析，宿主机目录还需 bind mount 进容器才可见。列出的路径即可被远程读取，务必配合已认证的 HTTPS 入口 |
| `COWORK_REMOTE_SESSION_FILE_MAX_BYTES` | `10485760` | 文件面板回退读取的大小上限：Desktop 自身的会话读取器对会话目录之外或超过 10 MiB 的文件返回 null（面板显示“Couldn't read this file”），Bridge 改为从上面的可读根目录重新读取；此值即该回退的上限。默认与 Desktop 一致 |
| `CLAUDE_DESKTOP_VERSION` | `2.9939.4` | 构建时固定安装的官方 Desktop 精确版本 |
| `CLAUDE_GATEWAY_BASE_URL` | — | Gateway origin；通常不要附加 `/v1` |
| `CLAUDE_GATEWAY_API_KEY` | — | Gateway 凭据，仅写入 `.env`/受管配置 |
| `CLAUDE_GATEWAY_AUTH_SCHEME` | `bearer` | Gateway 认证方案 |
| `CLAUDE_INFERENCE_MODELS_JSON` | — | Desktop 接受的精确模型 ID JSON 数组 |
| `CLAUDE_HEADLESS` | `1` | 无头启动官方 Desktop |
| `CLAUDE_DISABLE_GPU` | `1` | NAS 环境默认关闭 GPU |

### 远程能力开关

以下能力默认关闭；打开前必须确认入口已由可信 HTTPS/Authelia 或可信 LAN/Tailnet 保护：

| 变量 | 默认值 | 打开后提供 |
| --- | --- | --- |
| `CLAUDE_REMOTE_GATEWAY_SETTINGS` | `0` | 官方第三方推理配置编辑器与 Developer 菜单入口 |
| `CLAUDE_REMOTE_DEVELOPER_ACTIONS` | `0` | MCP/Skill/Plugin 管理、日志/配置查看、调试与 trace/heap 下载等 allowlist 操作 |
| `CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS` | `0` | Projects/Spaces、Artifacts、Memory、Scheduled Tasks 等官方 mutation IPC |
| `CLAUDE_REMOTE_CODE_ACTIONS` | `1` | Code/LocalSessions、终端、权限、MCP 与 `/workspace` 文件操作 |

Code 命令只在 Desktop 容器内执行，默认工作根目录是挂载的 `/workspace`，不会在访问页面的手机或电脑上执行。即使启用高权限开关，Bridge 也不公开远程控制、SSH、云端 teleport、PR mutation 或自动 commit/stash/discard 等方法。

### 资源与网络

`CLAUDE_COWORK_VM_MEMORY_GB`、`CLAUDE_COWORK_VM_CPU_COUNT`、`CLAUDE_COWORK_VM_IDLE_MINUTES` 和 `CLAUDE_COWORK_VM_SCHEDULE_GUARD_MINUTES` 控制 Cowork VM 资源与空闲回收；生产默认值分别为 `2`、`1`、`30`、`10`。`CLAUDE_DESKTOP_MEMORY_LIMIT` 和 `CLAUDE_COWORK_BRIDGE_MEMORY_LIMIT` 默认分别为 `3g` 与 `256m`。

`CLAUDE_EGRESS_ALLOWED_HOSTS_JSON` 可限制 Cowork、Code 和 Plugin CLI 的出站目标。空值不额外放宽策略；`["*"]` 表示交给 NAS 防火墙与上游网络控制的 unrestricted egress。

## 官方远程接口

### 通用官方界面

- `POST /api/remote/ipc`：调用受限的 `claude.web` 方法。
- `POST /api/remote/store`：读写经过字段过滤的 Desktop store。
- `POST /api/remote/settings`：Gateway 编辑器桥接（需显式打开）。
- `GET|PUT /api/account_profile`：受限的账户资料/指令设置。
- `PATCH /api/account/settings`：仅接受 `code_default_transcript_view`（`normal|thinking|verbose`），用于 Code 选项里的“Default transcript view”。
- `/api/bootstrap` 及选定的组织协议路由：转发官方启动请求。

### 服务器工作目录选择

Cowork 与 Code 的 `FileSystem.browseFolder` / `browseFolders` 现在打开网页内的服务器目录选择器，
浏览挂载的 `/workspace`，支持子目录、空目录、多选与取消，返回服务器绝对路径。
它不再上传访问者电脑上的整个目录，也不把所有选择固定为 `/workspace`。
普通文件附件仍使用浏览器文件选择与上传。

`GET /api/remote/folders?path=...` 只列出工作区内的文件夹；拒绝越界路径和指向工作区外的符号链接。
目录确认前再次检查服务器路径。官方 bundle 内确实包含 SSH `FolderBrowserModal`，
但该组件依赖官方 React Query / Intl 环境，当前没有从任意 Cowork/Code 页面调用它的公共入口。
此实现通过 preload 替换现有选目录 API，不新增 frontend bundle 补丁，保留官方信任确认与会话处理。

### Chat 回退与诊断接口

- `GET /api/chat/models`
- `GET|POST /api/chat/sessions`
- `GET /api/chat/sessions/:id` 与 `/transcript`
- `POST /api/chat/sessions/:id/messages` 与 `/stop`
- `PATCH /api/chat/sessions/:id/model` 与 `/title`
- `GET /api/cowork/sessions`
- `GET /api/events?mode=chat|cowork&sessionId=:id`

这些窄接口主要用于烟雾测试、恢复和兼容；浏览器主界面仍使用官方 renderer IPC。Bridge 不直接调用 Inference Gateway，也不复制或修改 Desktop 会话文件。

## 安全边界

- 直接 `15821` 端口没有应用层认证，只应暴露在可信 LAN/Tailnet；公网访问请使用 Authelia 保护的 HTTPS 入口。
- Gateway Key 默认只留在 Desktop 容器与受管配置中，不注入浏览器 bootstrap；跨边界的请求头仅允许 `accept`、`accept-language`、`content-type`。
- Developer、Infrastructure、Code 和 Gateway 编辑采用独立显式开关，默认值为 `0`；各能力内的删除操作由对应能力开关一并授权。
- Bridge 拒绝任意文件路径、通用 Electron action、凭据字段和未 allowlist 的 IPC 方法；trace/heap 与配置文件走不缓存的受限端点。
- 镜像使用 Anthropic 签名 APT 源、固定 digest 的 Rust builder、校验和固定的 `virtiofsd` 1.13.3，以及项目内的窄化 seccomp 规则；容器不使用 `--privileged`、`seccomp=unconfined` 或 `CAP_SYS_ADMIN`。
- 静态 Gateway 模式使用 `--password-store=basic` 以避免 headless 启动卡在 Keyring 解锁；不要把它当作交互式登录凭据的加密持久化方案。

## 验证与故障排查

按从快到慢的顺序运行：

```bash
# 检查容器、版本、KVM/vhost-vsock、网页和 Cowork adapter
./scripts/smoke.sh

# 检查官方 Chat/Cowork 列表、静态资源、SSE 与远程 IPC
./scripts/chat-bridge-smoke.sh

# 只检查健康状态和 Cowork 会话列表
./scripts/cowork-bridge-smoke.sh

# 校验 Docker、安全配置和脚本
./scripts/validate.sh
```

常见问题：

1. **页面打不开**：先确认 `docker compose ps` 中两个服务为 healthy，再从 NAS 本机执行 `curl -fsS http://127.0.0.1:15821/api/health`。
2. **Cowork 不可用**：检查 `/dev/kvm`、`/dev/vhost-vsock` 权限和 `claude-desktop` healthcheck；不要先关闭 seccomp。
3. **模型列表为空**：确认 `CLAUDE_INFERENCE_MODELS_JSON` 是合法 JSON，模型 ID 与 Gateway 实际接受的路由一致。
4. **PWA 无法安装**：HTTP LAN 入口可浏览但不能提供标准 Service Worker；改用 Authelia 保护的 HTTPS 主机名。
5. **配置泄露风险**：不要执行会打印渲染后环境变量的 `docker compose config`，因为其中可能包含 API Key。

## 持久化数据

Compose 默认挂载：

| 容器路径 | NAS 路径 | 内容 |
| --- | --- | --- |
| `/config` | `/vol2/1000/Docker/ClaudeDesktop/config` | Claude Desktop 配置、账户与 Chat/Cowork 会话 |
| `/workspace` | `/vol2/1000/Docker/ClaudeDesktop/workspace` | Code/Cowork 工作区、远程上传与项目文件 |

停止 Claude Desktop 后再对 `/config` 做一致性敏感的备份。Cowork VM 与工作数据可能额外占用约 25 GB，长期运行前请检查存储余量。

## 截图资源

仓库内的截图文件位于 [`docs/screenshots/`](docs/screenshots/)：

- [`docs/screenshots/claudesk-home.png`](docs/screenshots/claudesk-home.png)：PC 端首页。
- [`docs/screenshots/claudesk-developer.png`](docs/screenshots/claudesk-developer.png)：PC 端 Developer 的 Trace/heap 文件页。
- [`docs/screenshots/chat-mobile.png`](docs/screenshots/chat-mobile.png)：Chat 移动端界面。
- [`docs/screenshots/cowork-mobile.png`](docs/screenshots/cowork-mobile.png)：Cowork 移动端界面。
- [`docs/screenshots/claudesk-mobile.png`](docs/screenshots/claudesk-mobile.png)：移动端首页。

README 预览按 PC 端 720px、移动端 280px 展示，避免窄屏截图在页面中占满宽度。截图来自同一 Remote Bridge；敏感数据请在重新截屏前确认已清理。

## 开发与贡献

Bridge 源码在 `bridge/`，Electron 注入包装器在 `bridge-wrapper/`，启动脚本在 `rootfs/`。修改 IPC allowlist 时，必须同时检查外层 Bridge 和 loopback adapter，并在说明中写清楚为什么该方法需要远程暴露。

先运行 `npm ci --prefix rootfs/opt/claude-cowork-bridge --ignore-scripts` 安装补丁解析器与测试依赖。
提交前至少运行 `./scripts/validate.sh` 与相关 smoke script。请不要提交 `.env`、Gateway Key、真实会话数据或 `/workspace` 里的私有文件。

## 许可证与致谢

本仓库当前未附带开源许可证；在加入许可证文件前，默认版权规则适用，公开可见不等于自动授予复制、修改或再发布权。

感谢以下项目：

- [Anthropic Claude Desktop](https://claude.ai/download)：官方客户端与 `ion-dist` 前端。
- [jlesage/docker-baseimage-gui](https://github.com/jlesage/docker-baseimage-gui)：浏览器桌面容器基础镜像。
- [virtio-fs/virtiofsd](https://gitlab.com/virtio-fs/virtiofsd)：Cowork VM 文件共享。
- [moby/profiles](https://github.com/moby/profiles)：seccomp 基础策略。
- [LINUX DO](https://linux.do/)：项目交流社区。

Claude、Claude Desktop 及相关标识是 Anthropic 的商标。本项目仅提供互操作与自托管部署代码。
