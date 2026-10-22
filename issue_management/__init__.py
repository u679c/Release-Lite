from flask import Blueprint, current_app, jsonify, request, send_file

from .service import IssueBusyError, IssueService, SyncError, parse_date_range
from .preferences import PreferenceStore


blueprint = Blueprint(
    "issue_management", __name__, template_folder="templates",
    static_folder="static", static_url_path="/issue-management/static",
)


def init_app(app, data_dir):
    app.extensions["issue_management"] = IssueService(data_dir / "issues")
    app.extensions["issue_preferences"] = PreferenceStore(data_dir / "issues")
    app.register_blueprint(blueprint)


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
    try:
        return jsonify(service.query(kind, request.args, page))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400


@blueprint.post("/api/issues/sync")
def issue_sync():
    # 仅刷新本地缓存，不向飞书写入任何记录或视图配置。
    service = current_app.extensions["issue_management"]
    kind = request.args.get("kind", "overview")
    if kind not in ("overview", "requirements", "bugs"):
        return jsonify(error="不支持的同步范围"), 400
    try:
        date_range = parse_date_range(request.args)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    include_family = kind == "requirements" and request.args.get("include_family") == "1"
    service.start_sync(date_range, force=True, include_requirement_context=include_family, kind=kind)
    return jsonify(service.status(date_range, include_family, kind))


@blueprint.post("/api/issues/requirements/<record_id>/submit-testing")
def submit_requirement(record_id):
    try:
        return jsonify(current_app.extensions["issue_management"].submit_requirement(record_id))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    except IssueBusyError as exc:
        return jsonify(error=str(exc)), 409
    except SyncError as exc:
        return jsonify(error=str(exc)), 502


@blueprint.post("/api/issues/bugs/<record_id>/status")
def update_bug_status(record_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="状态更新参数格式不正确"), 400
    try:
        return jsonify(current_app.extensions["issue_management"].update_bug_status(
            record_id, payload.get("status"), payload.get("expected_status"),
        ))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    except IssueBusyError as exc:
        return jsonify(error=str(exc)), 409
    except SyncError as exc:
        return jsonify(error=str(exc)), 502


@blueprint.post("/api/issues/bugs/status")
def update_bug_statuses():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="状态更新参数格式不正确"), 400
    try:
        return jsonify(current_app.extensions["issue_management"].update_bug_statuses(
            payload.get("records"), payload.get("status"),
        ))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    except IssueBusyError as exc:
        return jsonify(error=str(exc)), 409
    except SyncError as exc:
        return jsonify(error=str(exc)), 502


@blueprint.post("/api/issues/bugs/<record_id>/discussion")
def create_bug_discussion(record_id):
    try:
        return jsonify(current_app.extensions["issue_management"].create_bug_discussion(record_id))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    except IssueBusyError as exc:
        return jsonify(error=str(exc)), 409
    except SyncError as exc:
        return jsonify(error=str(exc)), 502


@blueprint.get("/api/issues/bugs/<record_id>/attachments/<file_token>")
def bug_attachment(record_id, file_token):
    try:
        path, mime_type = current_app.extensions["issue_management"].attachment(record_id, file_token)
        response = send_file(path, mimetype=mime_type, download_name=path.name, conditional=True, max_age=300)
        response.headers["Cache-Control"] = "private, max-age=300"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response
    except FileNotFoundError as exc:
        response = jsonify(error=str(exc))
        response.headers["Cache-Control"] = "no-store"
        return response, 404
    except SyncError as exc:
        response = jsonify(error=str(exc))
        response.headers["Cache-Control"] = "no-store"
        return response, 502


@blueprint.route("/api/issues/preferences/<kind>", methods=["GET", "PUT", "PATCH"])
def issue_preferences(kind):
    if kind not in ("overview", "requirements", "bugs"):
        return jsonify(error="不支持的页面类型"), 400
    payload = request.get_json(silent=True) if request.method in ("PUT", "PATCH") else None
    if request.method in ("PUT", "PATCH") and not isinstance(payload, dict):
        return jsonify(error="页面配置格式不正确"), 400
    try:
        return jsonify(current_app.extensions["issue_preferences"].access(kind, payload, patch=request.method == "PATCH"))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    except OSError:
        return jsonify(error="服务器无法读取或保存筛选条件，请重试"), 503
