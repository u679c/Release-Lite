# Release Lite

一个运行在服务器上的轻量项目发布与进程管理面板。它使用 Python、Flask 和 SQLite，不依赖 Redis 或外部数据库。

## 安装与启动

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export RELEASE_LITE_SECRET='请替换为随机长字符串'
export RELEASE_LITE_BROWSE_ROOTS='/srv/apps:/opt/projects'
python app.py
```

默认监听 `0.0.0.0:8080`，首次访问 `http://服务器地址:8080`。生产环境建议放在 Nginx/Caddy 反向代理之后，并通过 systemd 或 supervisor 守护本面板本身。

## 基本使用

1. 在「项目」中新建项目，填写服务器上的**绝对路径**、Git 分支和启动命令。
2. 若项目有脚本，可从项目根目录发现的 `.sh`、`.py`、`package.json` scripts 中选择，也可以直接写命令。命令均在项目根目录执行。
3. 填写部署前/后钩子以及环境变量（`KEY=value`，每行一个）。
4. 保存后可启动、停止、重启、部署或回退到历史发布版本。

## Python 运行环境

目前运行环境仅支持 Python。可在项目配置中填写 Python 命令、虚拟环境目录（默认 `.venv`）和 pip 依赖文件（默认 `requirements.txt`）。执行「更新代码」时，系统会在虚拟环境不存在时自动创建它；勾选自动安装依赖后，会执行 `pip install -r requirements.txt`。项目启动时会优先使用该虚拟环境。

项目目录选择器只允许浏览 `RELEASE_LITE_BROWSE_ROOTS` 指定的目录。多个根目录使用系统路径分隔符（Linux/macOS 为 `:`）连接；未设置时默认允许 `/srv`、`/opt`、`/var/www` 和当前用户家目录。

## Webhook 自动部署

每个项目保存后都会生成一个 webhook 地址：

```
POST /webhook/<项目ID>/<Webhook 密钥>
```

将其配置为 GitHub/GitLab 的 push webhook。开启「Webhook 自动部署」后，收到请求即会排队部署；请求体中的 `ref` 若不匹配当前分支会被忽略。对于 GitHub，可选填项目 Webhook 密钥以校验 `X-Hub-Signature-256`。

## 安全提醒

- 此程序会执行你为项目配置的 shell 命令，仅应暴露在受信任网络或 VPN 后，并在反向代理层加认证。
- 运行面板的用户必须有读取项目目录、执行脚本以及管理对应进程的权限。
- 不要把 `.env`、Token 或数据库文件提交到仓库；SQLite 数据库默认在 `data/release_lite.db`。

## 自动恢复

在项目中打开「异常停止后自动重启」。后台每 20 秒检查一次已启动项目；发现进程退出会尝试启动，并写入操作日志。
