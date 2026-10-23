from flask import Blueprint, current_app, jsonify, request, send_file

from .service import IssueBusyError, IssueService, SyncError, parse_date_range
from .preferences import PreferenceStore


blueprint = Blueprint(
    "issue_management",
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/issue-management/static",
)


def init_app(app, data_dir):
    app.extensions["issue_management"] = IssueService(data_dir / "issues")
    app.extensions["issue_preferences"] = PreferenceStore(data_dir / "issues")
    app.register_blueprint(blueprint)


@blueprint.errorhandler(ValueError)
def invalid_request(exc):
    return jsonify(error=str(exc)), 400


@blueprint.errorhandler(IssueBusyError)
def issue_busy(exc):
    return jsonify(error=str(exc)), 409


@blueprint.errorhandler(SyncError)
def sync_failed(exc):
    response = jsonify(error=str(exc))
    response.headers["Cache-Control"] = "no-store"
    return response, 502


@blueprint.get("/api/issues/home-summary")
def issue_home_summary():
    preferences = current_app.extensions["issue_preferences"]
    saved = preferences.access("overview")
    requirements = preferences.access("requirements")
    filters = {"q": saved["filters"].get("q", ""), "condition_filter": saved["condition_filter"]}
    if request.args.get("condition_filter") is not None:
        filters = request.args.to_dict()
        if "project" in request.args:
            filters["project"] = request.args.getlist("project")
    else:
        for key in ("created_from", "created_to"):
            if key in request.args:
                filters[key] = request.args[key]
    response = jsonify(
        current_app.extensions["issue_management"].home_summary(
            filters, include_family=requirements["filters"].get("include_family") == "1"
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@blueprint.get("/api/issues/data")
def issue_data():
    service = current_app.extensions["issue_management"]
    kind = request.args.get("kind", "overview")
    if kind not in ("overview", "requirements", "bugs"):
        return jsonify(error="不支持的页面类型"), 400
    try:
        page = max(1, int(request.args.get("page", 1)))
    except ValueError:
        return jsonify(error="页码必须是整数"), 400
    return jsonify(service.query(kind, request.args, page))


@blueprint.post("/api/issues/sync")
def issue_sync():
    # 仅刷新本地缓存，不向飞书写入任何记录或视图配置。
    service = current_app.extensions["issue_management"]
    kind = request.args.get("kind", "overview")
    if kind not in ("overview", "requirements", "bugs"):
        return jsonify(error="不支持的同步范围"), 400
    date_range = parse_date_range(request.args)
    include_family = kind == "requirements" and request.args.get("include_family") == "1"
    service.start_sync(
        date_range, force=True, include_requirement_context=include_family, kind=kind
    )
    return jsonify(service.status(date_range, include_family, kind))


@blueprint.put("/api/issues/requirements/<record_id>/priority")
def update_requirement_priority(record_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="需求优先级参数格式不正确"), 400
    return jsonify(
        current_app.extensions["issue_management"].set_requirement_priority(
            record_id, payload.get("priority")
        )
    )


@blueprint.post("/api/issues/requirements/submit-testing")
def submit_requirements():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="提测参数格式不正确"), 400
    return jsonify(
        current_app.extensions["issue_management"].submit_requirements(payload.get("records"))
    )


@blueprint.post("/api/issues/bugs/<record_id>/status")
def update_bug_status(record_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="状态更新参数格式不正确"), 400
    return jsonify(
        current_app.extensions["issue_management"].update_bug_status(
            record_id,
            payload.get("status"),
            payload.get("expected_status"),
        )
    )


@blueprint.post("/api/issues/bugs/status")
def update_bug_statuses():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="状态更新参数格式不正确"), 400
    return jsonify(
        current_app.extensions["issue_management"].update_bug_statuses(
            payload.get("records"),
            payload.get("status"),
        )
    )


@blueprint.post("/api/issues/bugs/<record_id>/discussion")
def create_bug_discussion(record_id):
    return jsonify(current_app.extensions["issue_management"].create_bug_discussion(record_id))


@blueprint.post("/api/issues/requirements/<record_id>/discussion")
def create_requirement_discussion(record_id):
    return jsonify(
        current_app.extensions["issue_management"].create_requirement_discussion(record_id)
    )


@blueprint.get("/api/issues/bugs/<record_id>/attachments/<file_token>")
def bug_attachment(record_id, file_token):
    try:
        path, mime_type = current_app.extensions["issue_management"].attachment(
            record_id, file_token
        )
        response = send_file(
            path, mimetype=mime_type, download_name=path.name, conditional=True, max_age=300
        )
        response.headers["Cache-Control"] = "private, max-age=300"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response
    except FileNotFoundError as exc:
        response = jsonify(error=str(exc))
        response.headers["Cache-Control"] = "no-store"
        return response, 404


@blueprint.route("/api/issues/preferences/<kind>", methods=["GET", "PUT", "PATCH"])
def issue_preferences(kind):
    if kind not in ("overview", "requirements", "bugs"):
        return jsonify(error="不支持的页面类型"), 400
    payload = request.get_json(silent=True) if request.method in ("PUT", "PATCH") else None
    if request.method in ("PUT", "PATCH") and not isinstance(payload, dict):
        return jsonify(error="页面配置格式不正确"), 400
    try:
        return jsonify(
            current_app.extensions["issue_preferences"].access(
                kind, payload, patch=request.method == "PATCH"
            )
        )
    except OSError:
        return jsonify(error="服务器无法读取或保存筛选条件，请重试"), 503
