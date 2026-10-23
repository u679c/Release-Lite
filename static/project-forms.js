/* Pure project configuration markup; interaction stays in app.js. */
window.ProjectForms = (() => {
  const esc = ReleaseLite.escapeHtml;
  function runtimeConfig(project) {
    return `<section id="runtimeConfig" class="runtime-config">` +
      `<div class="runtime-config-grid">` +
      `<label>运行环境` +
      `<select id="runtime" onchange="toggleRuntimeConfig()"><option value="python" ${project.runtime === "python" ? "selected" : ""}>Python</option><option value="node" ${project.runtime === "node" ? "selected" : ""}>Node.js</option><option value="generic" ${project.runtime === "generic" ? "selected" : ""}>通用命令行</option>` +
      `</select>` +
      `</label>` +
      `<div id="nodeRuntimeFields">` +
      `<label>Node.js 版本` +
      `<select id="node_version"><option value="${esc(project.node_version || "")}">${esc(project.node_version || "系统默认")}</option>` +
      `</select>` +
      `</label>` +
      `<label>更新依赖命令` +
      `<input id="node_dependency_command" value="${esc(project.node_dependency_command || "")}" placeholder="例如：pnpm install --frozen-lockfile">` +
      `</label>` +
      `</div>` +
      `<div id="pythonRuntimeFields">` +
      `<label>Python 命令` +
      `<input id="python_executable" value="${esc(project.python_executable || "python3")}" placeholder="python3">` +
      `</label>` +
      `<label>虚拟环境目录` +
      `<input id="venv_path" value="${esc(project.venv_path || ".venv")}" placeholder=".venv">` +
      `<span class="hint">相对项目目录</span>` +
      `</label>` +
      `<label>pip 依赖文件` +
      `<input id="requirements_file" value="${esc(project.requirements_file || "requirements.txt")}" placeholder="requirements.txt">` +
      `<span class="hint">相对项目目录</span>` +
      `</label>` +
      `<label class="check">` +
      `<input id="auto_install_dependencies" type="checkbox" ${project.auto_install_dependencies ? "checked" : ""}> 更新代码时自动安装 pip 依赖` +
      `</label>` +
      `</div><p id="genericRuntimeHint" class="hint">使用自定义启动命令</p>` +
      `</div>` +
      `</section>`;
  }
  function configForm(p, isNew) {
    const v = k => esc(p[k] || "");
    const subprojectsConfig = `<label class="check">` +
      `<input id="subprojects_enabled" type="checkbox" ${p.subprojects_enabled ? "checked" : ""} onchange="toggleSubprojectsConfig()"> 启用子项目` +
      `</label>` +
      `<label id="subprojectsField">子项目配置 ` +
      `<span class="hint">每行一个：命令 [显示名称]；启动命令可用 {{project}}</span>` +
      `<textarea id="subprojects" placeholder="kp 知识包后台&#10;bs 书架&#10;ss">${v("subprojects")}</textarea>` +
      `</label>`;
    const advancedConfig = `<details class="advanced-config">` +
      `<summary>高级配置` +
      `</summary>` +
      `<div class="advanced-config-content">` +
      `<label>停止命令（可选）` +
      `<input id="stop_command" placeholder="例如：docker compose down" value="${v("stop_command")}">` +
      `</label>` +
      `<div class="form-grid">` +
      `<label class="git-config-field">更新代码前执行` +
      `<textarea id="pre_deploy_hook" placeholder="例如：npm ci">${v("pre_deploy_hook")}</textarea>` +
      `</label>` +
      `<label class="git-config-field">更新代码后执行` +
      `<textarea id="post_deploy_hook" placeholder="例如：npm run build">${v("post_deploy_hook")}</textarea>` +
      `</label>` +
      `</div>` +
      `<label>环境变量 ` +
      `<span class="hint">每行 KEY=value</span>` +
      `<textarea id="env_vars" placeholder="PORT=3000&#10;NODE_ENV=production">${v("env_vars")}</textarea>` +
      `</label>` +
      `<label class="git-config-field">GitHub webhook 签名密钥（可选）` +
      `<input id="git_webhook_secret" type="password" value="${v("git_webhook_secret")}">` +
      `</label>` +
      `<label class="check git-config-field">` +
      `<input id="auto_deploy" type="checkbox" ${p.auto_deploy ? "checked" : ""}> 收到 webhook 后自动更新代码` +
      `</label>` +
      `</div>` +
      `</details>`;
    const autoRestartConfig = `<div class="check-row"><label class="check"><input id="auto_restart" type="checkbox" ${p.auto_restart ? "checked" : ""}> 异常退出后自动重启</label></div>`;
    return `<form id="projectForm" class="config-form" onsubmit="saveProject(event)">` +
      `<input id="id" type="hidden" value="${v("id")}">` +
      `<label class="check non-git-mode">` +
      `<input id="non_git" type="checkbox" ${p.is_git ? "" : "checked"} onchange="toggleGitProject()"> 非 Git 项目` +
      `</label>` +
      `<div class="form-grid">` +
      `<label>项目名称` +
      `<input id="name" required value="${v("name")}">` +
      `</label>` +
      `<label class="git-config-field">Git 分支` +
      `<input id="branch" value="${v("branch") || "main"}">` +
      `</label>` +
      `</div>` +
      `<label>项目目录（绝对路径）` +
      `<input id="root_path" required placeholder="/srv/apps/example" value="${v("root_path")}">` +
      `</label>` +
      `<button id="directoryBrowseButton" class="btn btn-outline-secondary btn-sm directory-browse-button" type="button" onclick="browseDirectories($('#root_path').value.trim())">` +
      `<i class="bi bi-folder2-open"></i> 选择目录` +
      `</button>${runtimeConfig(p)}<label>启动命令 ` +
      `<span class="hint">在项目目录中执行；子项目可用 {{project}}</span>` +
      `<input id="start_command" required placeholder="例如：pnpm --filter {{project}} start" value="${v("start_command")}">` +
      `</label>` +
      `<div id="scriptsDiscovery" class="scripts">` +
      `<button type="button" onclick="loadScripts()">查找启动脚本` +
      `</button>` +
      `<select id="scriptSelect" onchange="useScript()"><option value="">选择启动脚本（可选）</option>` +
      `</select>` +
      `</div>${subprojectsConfig}${advancedConfig}${autoRestartConfig}<footer>` +
      `<button type="button" onclick="showPage('projects')">取消` +
      `</button>` +
      `<button class="primary" type="submit">${isNew ? "创建项目" : "保存配置"}</button>` +
      `</footer>` +
      `</form>`;
  }
  return {
    render: configForm
  };
})();
