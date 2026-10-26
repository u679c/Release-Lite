# Release Lite

基于 Flask、SQLite 和原生 JavaScript 的轻量发布管理台，在一台服务器上管理项目进程、Git 代码更新、运行日志和 tmux 终端，并提供飞书多维表格的需求与 bug 工作台。

项目没有前端构建步骤；HTML、CSS 和 JavaScript 直接由 Flask 提供。

## 功能

| 模块 | 能力 |
| --- | --- |
| 首页 | CPU、内存、磁盘、网络流量、设备信息和项目运行概况；内存压力趋势图；需求与 Bug 关注卡片 |
| 项目管理 | 创建、编辑、删除管理配置，按名称和运行环境筛选，启动、停止和重启项目 |
| 运行环境 | Python 虚拟环境及 pip 依赖、NVM 中已安装的 Node.js 版本、通用 Shell 命令 |
| 子项目 | 配置多个子项目，通过启动命令中的 `{{project}}` 选择运行目标 |
| 代码更新 | 拉取指定分支、执行钩子、重启服务、查看更新记录、回退到成功记录的 Git revision |
| Webhook | 按分支触发自动更新，可校验 GitHub `X-Hub-Signature-256` 签名 |
| 进程维护 | 汇总进程树资源和监听端口；为意外退出的项目自动重启 |
| 日志管理 | 查看、清空日志，按项目和类型筛选，按大小排序、分页及批量删除日志文件 |
| 交互终端 | 使用 xterm.js 和 Socket.IO 连接 tmux，调整字号、行列数和窗口大小 |
| 需求管理 | 创建时间筛选、组合条件、项目 tab、按版本分组、需求树及单页多选提测 |
| bug 管理 | 按阶段查看、单条或批量更新状态、讨论群创建与关联、图片和视频附件预览 |
| 筛选配置 | 服务端保存各页面筛选条件，以及每分钟自动同步设置 |

## 环境要求

- Python 3.11，安装依赖时使用 `pip3.11`。
- macOS 或 Linux。项目使用 `pty`、`fcntl`、Unix 进程组及 tmux，不支持原生 Windows 运行。
- `tmux`：启动项目、更新 Node.js 依赖和交互终端都需要它。
- `git`：用于 Git 项目的代码更新与回退。
- 可用的 Shell。使用 `$SHELL`，未设置时回退到 `/bin/zsh`；Linux 可按实际环境设置 `SHELL=/bin/bash`。
- 按需安装被管理项目所需的 Python、Node.js、包管理器等运行工具。
- 使用需求与 bug 模块时，还需要在运行面板的服务器用户下安装、登录并授权 `lark-cli`。

Python 依赖见 [requirements.txt](requirements.txt)，包含 Flask、Flask-SocketIO、psutil 和 simple-websocket。

## 安装与启动

在项目根目录执行：

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip3.11 install -r requirements.txt
python3.11 app.py
```

默认监听 `0.0.0.0:22993`，本机访问 `http://127.0.0.1:22993`。首次运行会自动创建 `data/`、SQLite 数据表和所需目录；已有数据库会补充缺失的配置字段。

面板应以单个服务进程运行，通过 `app.py` 启动。进程监控线程在这个入口启动，部署队列、依赖任务和终端连接状态也保存在当前进程中。

页面样式依赖 CDN 上的 Bootstrap 5.3.3 和 Bootstrap Icons 1.11.3。Socket.IO、xterm.js、FitAddon 和 Viewer.js 使用仓库内的静态资源。离线环境需要另外处理 Bootstrap 的资源访问。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `22993` | 面板监听端口 |
| `RELEASE_LITE_SECRET` | 启动时随机生成 | Flask `SECRET_KEY`；需要固定时在启动前设置 |
| `RELEASE_LITE_BROWSE_ROOTS` | `/srv`、`/opt`、`/var/www`、当前用户主目录 | 目录选择器允许浏览的根目录；仅保留实际存在的目录，以 `os.pathsep` 分隔，macOS/Linux 为 `:` |
| `RELEASE_LITE_LARK_CLI` | `lark-cli` | 飞书 CLI 可执行文件路径或命令名 |
| `NVM_DIR` | `~/.nvm` | 从 `versions/node/` 中发现已安装 Node.js 版本 |
| `SHELL` | `/bin/zsh` | tmux pane 使用的 Shell，命令通过 `-lc` 执行 |

示例：

```bash
export PORT=22993
export RELEASE_LITE_BROWSE_ROOTS=/srv/apps:/opt/projects
export SHELL=/bin/bash
.venv/bin/python app.py
```

目录浏览范围只约束目录选择器。项目保存时检查目录是否存在，不以此变量限制所有命令的工作目录。

面板当前没有内置登录或用户权限系统，命令和文件操作以服务进程的系统用户身份执行。部署到共享环境时，应通过访问受控的网络或带认证的反向代理提供访问；反向代理需支持 Socket.IO 的 WebSocket 升级。

## 项目管理使用说明

### 创建项目

1. 打开「项目管理」，点击「新建项目」。
2. 填写项目名称、服务器上的项目绝对路径和启动命令。
3. 选择运行环境；现有代码仓库需要提前放到服务器上，面板不负责首次克隆。
4. 按需选择「非 Git 项目」、配置分支、子项目、环境变量和高级钩子。
5. 保存后，在列表或详情页执行启动、停止、重启、更新代码等操作。

「发现目录脚本」会列出根目录中的 `.sh` 文件、部分 `.py` 文件，以及 `package.json` 的 scripts；选择后填入启动命令。

### 运行环境

- **Python**：配置 Python 命令、虚拟环境目录和依赖文件。路径可相对项目根目录。代码更新时，如果虚拟环境不存在会创建它，勾选自动安装依赖后会执行该环境的 pip。单独点击「启动」只使用已有环境，不执行安装。
- **Node.js**：可选 NVM 中已安装的版本，未指定时使用系统 `PATH`。选择的版本会作用于启动命令和依赖更新命令。更新依赖需要先停止项目，完成后手动启动。
- **通用命令行**：直接执行配置的启动命令，适用于 Shell、Docker、Java 等已有运行方式。

项目环境变量使用每行一个 `KEY=value` 的形式，空行和以 `#` 开头的行会被忽略。

### 子项目

启用后，每行填写一个子项目，第一段是替换参数，后续文字是可选展示名称：

```text
api Backend API
web Web App
worker
```

启动命令示例：

```bash
pnpm --filter {{project}} start
```

启动时会将 `{{project}}` 替换为选中的第一段参数。重启或自动重启会沿用已记录的选择。

### Git 更新与回退

普通代码更新的顺序是：

1. `git fetch --prune origin`。
2. 切换配置分支，执行 `git pull --ff-only origin <branch>`。
3. Python 项目准备虚拟环境，并按配置安装依赖。
4. 执行「更新代码前钩子」。
5. 停止旧服务。
6. 执行「更新代码后钩子」。
7. 启动服务，记录状态和 revision。

这里的「前钩子」发生在 Git 拉取和 Python 环境准备之后、停止旧服务之前。

回退会获取远端分支及 tag，然后以 detached HEAD 检出成功记录中的 revision，再继续环境准备、钩子和重启流程。它只回退代码，不回退数据库、依赖文件外部状态或用户数据。

开启自动重启后，面板每 20 秒检查一次：只有记录为预期运行、实际进程已经退出的项目才会重启；手动停止后不会自动启动。

删除项目会停止其服务并删除管理配置，不删除项目源文件；已有日志和历史记录保留。

### Webhook

Git 项目保存后，可在详情页「日志」tab 查看地址：

```text
POST /webhook/<project_id>/<secret>
```

开启「收到 webhook 后自动更新代码」后才会触发更新。如果 payload 提供 `ref`，必须匹配配置分支名或 `refs/heads/<branch>`；没有 `ref` 时按配置分支执行。

配置 GitHub webhook 签名密钥后，服务会校验 `X-Hub-Signature-256`。Webhook 地址中的 secret 也需要保密。

### 日志与终端

运行日志、代码更新日志和依赖更新日志保存在 `data/logs/`。单次查看最多返回末尾 100000 个字符；「代码更新日志」指最新一次更新记录的日志。

终端连接项目已经运行的 tmux 会话，或正在执行的依赖更新会话。离开终端页面会断开浏览器连接，项目会话继续在后台运行。关闭 tmux 项目会话会停止该项目。

常用 tmux 操作：先按 `Ctrl-b`，再按 `%` 纵向分屏、`"` 横向分屏。面板字号和 bug 工作台分栏比例保存在当前浏览器的 `localStorage` 中。

## 飞书需求与 bug 模块

### 接入配置

该模块目前连接固定的业务多维表格，入口、Base token、表、视图和字段 ID 定义在 [issue_management/service.py](issue_management/service.py) 的 `SOURCE_URL`、`BASE_TOKEN`、`TABLES` 和 `PARENT_FIELDS` 中。接入其他表格时需要根据真实字段结构调整映射，不是只替换页面链接。

所有 CLI 调用都使用 `--as user`，因此登录身份和权限取决于运行面板的系统用户。可先检查：

```bash
lark-cli auth status --json --verify
```

同步需要访问相关表格；提测和状态更新需要记录写权限；创建需求或 bug 讨论群需要 `im:chat:create_by_user` 权限。bug 群使用创建人与处理人作为成员来源；父需求群使用父需求及全部子需求的产品、开发、测试、设计人员，去重后邀请，超过 50 人时分批邀请，还需 `im:chat.members:write_only` 权限。附件预览需要 CLI 可以读取对应附件。

未配置飞书时，项目发布管理功能仍可独立使用；飞书模块会显示同步错误。

### 同步、筛选与状态操作

- 默认创建时间范围为北京时间最近两个月，包含起止日期。
- 首页的「需求与 Bug 关注」沿用「需求与 bug 管理」总览的创建日期、搜索和组合筛选条件，展示今日待提测、逾期未提测、3 天内待提测（含今天）及待处理 Bug，需求和 Bug 各按优先级、截止日期取前 3 条。待提测清单只展示父需求：开启需求管理的关联展示配置时，将命中的子需求归并到父需求并去重；关闭时只展示直接命中的父需求。同一页面会话中沿用当前总览筛选；首次打开首页读取总览已保存的配置。首页每 30 秒读取一次本地摘要，不自动发起飞书同步；缓存未覆盖当前日期范围时显示提示。点击指标或清单会携带相同筛选，并沿用需求页保存的父子展示及排序设置。
- 同步读取需求或 bug 的源记录并刷新本地缓存，失败时保留上次成功的数据；同步不会更改飞书已保存视图的筛选配置。
- 总览的「本周发布日历」在同步需求时，独立从需求总表读取发布日期在本周（周一至周日）的记录，按发布日期、项目和版本汇总；不受页面的创建时间、人员、项目、版本、状态等筛选影响。已提测、测试完成的需求仍纳入发布安排。跨周后需重新同步本周发布数据。
- 普通筛选在本地快照上进行，支持「所有 / 任一」条件和「包含 / 不包含」多选值；每页最多配置 50 条条件。
- 筛选条件按页面存储在服务器，访问同一服务的浏览器共享这些设置。日期范围不保存；通过 URL 传入的临时筛选也不覆盖已保存配置。
- 需求筛选弹窗提供「排序字段：版本 / 优先级」与「排列顺序：正序 / 倒序」两个下拉框，配置保存在服务器，总览跳转也沿用需求页已保存的排序设置。按版本排序时以版本分组，版本号采用自然排序，未填写版本的「其他版本」组置顶，列表显示优先级列；按优先级排序时以优先级分组，列表将该列替换为版本。每页最多 10 个分组，父子需求的展开、补充展示及整组勾选保持可用。原「按版本倒序」配置自动迁移到新的版本倒序设置。
- 需求优先级只在本地维护，使用 `P0 / P1 / P2 / P3`，默认「未设置」，完全忽略飞书需求优先级字段。正序为 `P0 → P3`，倒序为 `P3 → P0`，未设置的分组始终在最后。四个等级依次使用红、橙、蓝、绿色。在需求详情弹窗中选择后自动保存，同一父子关联组（含兄弟需求）统一更新；之后同步飞书数据不会覆盖本地优先级。数据独立保存在 `data/issues/requirement-priorities.json`，无需向飞书写入。
- 需求管理支持单页多选，搜索框右侧的「提测」只将当前页勾选的记录更新为「测试中」。点击提测时检查状态：仅「产品设计中」「需求待评审」「待开发」「开发中」「开发完成」可提测，选中记录中存在其他状态时提示并拦截整次提测；后端写入前也会重新检查源记录状态。版本复选框可全选或取消该版本全部记录，部分选中时显示半选；勾选或取消父记录会同步操作当前页的后代，取消子记录不取消父记录，记录复选框没有半选状态。翻页或切换筛选会清空选择。
- bug 每页 30 条，可切换全部、待处理、已修复待发布、已修复阶段；单条与批量写入支持「处理中」「已修复待发布」「已修复」。写入前会检查当前状态，写入后读回确认。
- 需求列表将设计人员和设计稿合并在「设计」列，上方显示人员，下方显示「打开设计稿」。父需求的「群聊」列支持创建群聊或打开已有群聊，群聊关联到需求表的「讨论组」字段。
- 创建讨论群后会关联对应父需求或 bug；父需求建群时递归收集全部子需求的相关人员，不受当前页面或筛选限制。如果成员邀请或群聊关联失败，恢复记录会帮助后续操作复用已建群，避免重复创建。
- 图片和视频按需下载到本地附件缓存。图片支持 Viewer.js 预览，视频能否播放取决于浏览器对文件格式的支持。
- 勾选 `Auto` 后，当前页面每分钟尝试同步。总览的开关联动需求和 bug 两个页面，两者设置不同时显示半选状态。

需求与 bug 的逾期判断使用北京时间。需求取预计结束时间；bug 优先取预计修复完成时间，未填时取截止日期。未填写状态的记录不计入未结项统计。

## 目录结构

```text
.
├── app.py                         # Flask 入口、项目管理、进程、日志、Webhook、终端
├── system_metrics.py              # 主机网络、磁盘及内存指标采集
├── requirements.txt               # Python 依赖
├── templates/
│   ├── index.html                 # 应用外壳、页面入口和脚本加载顺序
│   └── pages/                     # 首页、项目、操作记录、终端、日志和详情模板
├── static/
│   ├── common.js                  # 共享 JSON 请求与 HTML 转义
│   ├── app.js                     # 路由、发布管理页面和终端交互
│   ├── memory-monitor.js          # 内存压力图与采样历史
│   ├── project-forms.js           # 项目配置表单的 HTML 渲染
│   ├── home-issues.js             # 首页需求与 Bug 关注摘要
│   ├── home-issues.css            # 首页关注卡片样式
│   ├── style.css                  # 全局布局与发布管理样式
│   ├── favicon.png
│   └── vendor/                    # 本地第三方资源及已附带的说明、许可文件
├── issue_management/
│   ├── __init__.py                # Blueprint 与接口错误映射
│   ├── service.py                 # 飞书适配、同步、查询、状态操作和附件缓存
│   ├── conditions.py              # 组合筛选条件校验与匹配
│   ├── hierarchy.py               # 需求树分组
│   ├── dashboard.py               # 提测看板统计与跳转筛选
│   ├── home.py                    # 首页关注指标与优先处理队列
│   ├── priorities.py              # 本地优先级存储与父子关联组联动
│   ├── preferences.py             # 共享筛选条件与自动同步设置
│   ├── storage.py                 # 原子写入 JSON
│   ├── templates/issue_management/page.html
│   └── static/
│       ├── issues.js              # 需求与 bug 页面交互
│       ├── dashboard.js           # 看板卡片、日历和图表渲染
│       ├── issues.css             # 需求与 bug 样式
│       ├── filter-controls.js     # 可搜索下拉控件
│       └── condition-builder.js   # 组合条件编辑器
└── data/                          # 自动生成，不纳入版本控制
    ├── release_lite.db            # 项目配置、进程状态、更新历史和操作记录
    ├── logs/                      # 项目日志及依赖更新的临时结果文件
    └── issues/
        ├── snapshot.json          # 飞书数据快照
        ├── preferences.json       # 各页面共享配置
        ├── requirement-priorities.json # 本地需求优先级
        ├── preferences.lock       # 配置写入锁
        ├── attachments/           # 图片与视频附件缓存
        └── discussions/           # 讨论群创建与关联的恢复记录、锁文件
```

## 主要接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/overview`、`/api/system/memory` | 项目概况与系统指标 |
| `GET / POST` | `/api/projects` | 列出项目、创建或更新配置；更新时 body 带 `id` |
| `DELETE` | `/api/projects/<id>` | 删除管理配置并停止服务 |
| `POST` | `/api/projects/<id>/action/<action>` | `start`、`stop`、`restart`、`deploy`、`update-dependencies` |
| `GET` | `/api/node-versions`、`/api/directories` | NVM 版本和服务器目录 |
| `POST` | `/api/discover-scripts` | 发现指定目录的脚本 |
| `GET` | `/api/projects/<id>/scripts` | 发现已有项目目录的脚本 |
| `GET` | `/api/projects/<id>/logs/<kind>`、`/api/projects/<id>/logs/summary` | 日志正文与大小；`kind` 为 `runtime`、`deploy` 或 `dependencies` |
| `POST` | `/api/projects/<id>/logs/<kind>/clear` | 清空对应日志 |
| `GET` | `/api/projects/<id>/deployments` | 最近 50 条更新记录 |
| `POST` | `/api/projects/<id>/rollback/<deployment_id>` | 回退到成功记录的 revision |
| `GET` | `/api/storage/logs` | 日志文件筛选、排序和分页 |
| `POST` | `/api/storage/logs/delete` | 删除 body 中 `names` 指定的受管日志 |
| `GET` | `/api/operations` | 最近 100 条操作记录 |
| `GET / DELETE` | `/api/tmux/sessions`、`/api/tmux/sessions/<name>` | 列出或关闭受管 tmux 会话 |
| `POST` | `/webhook/<id>/<secret>` | Git 自动更新入口 |
| `GET` | `/api/issues/data` | 需求与 bug 数据、统计、筛选选项 |
| `POST` | `/api/issues/sync` | 主动刷新指定范围的缓存 |
| `GET / PUT / PATCH` | `/api/issues/preferences/<kind>` | 读取或保存页面配置；`PATCH` 仅更新 `auto_sync` |
| `POST` | `/api/issues/requirements/submit-testing` | 按 `records` 中的 `id`、`expected_status` 批量提测勾选的需求 |
| `POST` | `/api/issues/bugs/<record_id>/status`、`/api/issues/bugs/status` | 单条或批量修改 bug 状态 |
| `POST` | `/api/issues/bugs/<record_id>/discussion` | 创建或恢复关联讨论群 |
| `POST` | `/api/issues/requirements/<record_id>/discussion` | 为父需求创建群聊，邀请父需求及全部子需求相关人员，并关联讨论组 |
| `GET` | `/api/issues/bugs/<record_id>/attachments/<file_token>` | 下载或读取本地附件缓存 |

飞书接口的页面类型 `kind` 为 `overview`、`requirements` 或 `bugs`。参数校验错误返回 `400`，记录操作冲突返回 `409`，CLI 同步或写入错误返回 `502`。

终端使用 Socket.IO 事件：客户端发送 `terminal_open`、`terminal_input`、`terminal_resize`；服务器发送 `terminal_ready`、`terminal_output`、`terminal_error` 和 `terminal_closed`。

## 数据维护与排查

备份时先停止面板，再保存整个 `data/` 目录。SQLite 中包含项目环境变量和 webhook 密钥；需求快照、筛选配置及讨论群恢复记录也位于该目录。被管理项目的代码、数据库和其他业务文件需要单独备份。

不要在讨论群创建或关联结果尚未确认时随意删除 `data/issues/discussions/`，否则可能丢失复用已创建群的依据。

| 现象 | 检查方向 |
| --- | --- |
| 提示未安装 tmux | 在运行面板的同一用户及 `PATH` 下检查 `tmux -V` |
| Node.js 版本列表为空 | 检查 `NVM_DIR` 及 `versions/node/<version>/bin/node` 是否存在；面板不会自动安装 Node.js |
| 目录不能浏览 | 检查目录是否存在、服务用户是否有权限、是否位于允许浏览的根目录内 |
| 启动后立即停止 | 查看运行日志，确认启动命令、工作目录、环境和端口；启动命令应保持前台运行 |
| 更新代码失败 | 检查 Git 凭证、远端分支、本地未提交修改和是否可以快进合并，再看对应更新日志 |
| 飞书提示权限或登录问题 | 在服务器同一用户下检查 CLI 身份、授权、表格访问权限及字段映射 |
| 终端连接失败 | 检查项目或依赖任务是否仍在运行、对应 tmux 会话是否存在，以及反向代理是否支持 WebSocket |
| 页面缺少样式或图标 | 检查 Bootstrap CDN 的访问；其他前端组件从本地 `static/vendor/` 加载 |

## 开发与检查

修改模板或静态文件后刷新页面即可。`common.js` 需先于各页面脚本加载；需求模块通过 `IssueManagement.open(kind, parameters)` 与主路由连接。

默认只做轻量静态检查，不运行构建、编译或打包命令。JavaScript 可使用 `node --check <file>` 检查语法；Python 可通过 `ast.parse` 检查源码语法。第三方资源保留原有文件与许可说明，业务样式不要直接写入 vendor 文件。
