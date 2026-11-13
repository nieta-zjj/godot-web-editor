@tool
extends EditorPlugin
## godot-web-editor 페이지와 Godot 웹 에디터를 연결하는 브리지.
##
## 페이지(JavaScript)가 window.__godotBridgeCall(json) 으로 요청을 보내면
## 이 플러그인이 Godot 에디터 API로 처리하고 window.__godotBridgeResolve(json) 으로 응답한다.
## 웹 에디터가 아닌 환경(데스크톱 Godot 등)에서는 아무 동작도 하지 않는다.

const BRIDGE_VERSION := 3
const RUNNER_SCENE := "res://addons/web_editor_bridge/runner/runner.tscn"
const RUNNER_CONFIG := "res://.godot/gwe_runner.json"
const IGNORED_DIRS := [".godot", ".git", ".import"]

## 웹 에디터에서는 이 설정들의 기본값이 "gl_compatibility"라서, project.godot을 저장할 때 해당 줄을 지워 버린다.
## 그러면 데스크톱 Godot(기본값 forward_plus / mobile)에서 열 때 렌더러가 바뀌므로,
## 데스크톱 기본값을 "초기값"으로 알려 주어 값이 항상 파일에 남도록 한다.
const DESKTOP_DEFAULTS := {
	"rendering/renderer/rendering_method": "forward_plus",
	"rendering/renderer/rendering_method.mobile": "mobile",
}

var _window: JavaScriptObject
var _call_cb: JavaScriptObject


func _enter_tree() -> void:
	if not OS.has_feature("web"):
		return
	# 외부(동기화/AI)에서 바뀐 스크립트를 묻지 않고 다시 불러오도록 설정
	var settings := EditorInterface.get_editor_settings()
	settings.set_setting("text_editor/behavior/files/auto_reload_scripts_on_external_change", true)
	_keep_renderer_settings()
	_window = JavaScriptBridge.get_interface("window")
	_call_cb = JavaScriptBridge.create_callback(_on_call)
	_window.__godotBridgeCall = _call_cb
	if _window.__godotBridgeReady:
		_window.__godotBridgeReady(BRIDGE_VERSION)


func _keep_renderer_settings() -> void:
	var before := FileAccess.get_file_as_string("res://project.godot")
	for key in DESKTOP_DEFAULTS:
		ProjectSettings.set_initial_value(key, DESKTOP_DEFAULTS[key])
	ProjectSettings.save()
	if FileAccess.get_file_as_string("res://project.godot") != before:
		print("[web_editor_bridge] project.godot에 렌더러 설정을 명시했습니다 (데스크톱 Godot과 같은 렌더러 유지)")


func _exit_tree() -> void:
	if _window:
		_window.__godotBridgeCall = null
		if _window.__godotBridgeGone:
			_window.__godotBridgeGone()
	_call_cb = null
	_window = null


func _on_call(args: Array) -> void:
	var req = JSON.parse_string(str(args[0]))
	if typeof(req) != TYPE_DICTIONARY:
		return
	var id = req.get("id", 0)
	var params: Dictionary = req.get("params", {}) if typeof(req.get("params")) == TYPE_DICTIONARY else {}
	var result = null
	var error := ""
	match str(req.get("method", "")):
		"ping":
			result = {"version": BRIDGE_VERSION, "godot": Engine.get_version_info().string}
		"list_files":
			result = _list_files(str(params.get("dir", "")), bool(params.get("include_cache", false)))
		"file_manifest":
			result = _file_manifest()
		"runtime_files":
			while EditorInterface.get_resource_filesystem().is_scanning():
				await get_tree().process_frame
			result = _list_files("", true)
		"read_file":
			result = _read_file(str(params.get("path", "")), str(params.get("encoding", "utf8")))
		"write_files":
			result = _write_files(params.get("files", []))
		"delete_files":
			result = _delete_files(params.get("paths", []))
		"rescan":
			EditorInterface.get_resource_filesystem().scan()
			result = true
		"save_all":
			EditorInterface.save_all_scenes()
			result = true
		"get_state":
			result = _get_state()
		"open_scene":
			var p := _res_path(str(params.get("path", "")))
			if p.is_empty() or not FileAccess.file_exists(p):
				error = "scene not found: %s" % params.get("path", "")
			else:
				EditorInterface.open_scene_from_path(p)
				result = true
		"play":
			var scene := str(params.get("scene", ""))
			if scene == "":
				EditorInterface.play_main_scene()
			elif scene == "current":
				EditorInterface.play_current_scene()
			else:
				EditorInterface.play_custom_scene(_res_path(scene))
			result = true
		"stop":
			EditorInterface.stop_playing_scene()
			result = true
		"prepare_runner":
			# 테스트/스크립트 검사 준비: 설정을 .godot/(커밋 안 됨)에 쓰고 열린 씬을 저장한다.
			# 페이지는 nonce가 IndexedDB에 저장된 것을 확인한 뒤 play_runner를 부른다 (게임은 IndexedDB에서 파일을 읽으므로)
			var cfg := FileAccess.open(RUNNER_CONFIG, FileAccess.WRITE)
			if cfg == null:
				error = "runner config write failed: %s" % FileAccess.get_open_error()
			elif not FileAccess.file_exists(RUNNER_SCENE):
				error = "runner scene not found: %s" % RUNNER_SCENE
			else:
				EditorInterface.save_all_scenes()
				cfg.store_string(JSON.stringify({"mode": str(params.get("mode", "test")), "filter": str(params.get("filter", "")), "nonce": str(params.get("nonce", ""))}))
				cfg.close()
				result = true
		"play_runner":
			if EditorInterface.is_playing_scene():
				EditorInterface.stop_playing_scene()
			EditorInterface.play_custom_scene(RUNNER_SCENE)
			result = true
		"set_main_screen":
			var screen := str(params.get("name", "2D"))
			if not screen in ["2D", "3D", "Script", "Game", "AssetLib"]:
				error = "unknown main screen: %s" % screen
			else:
				EditorInterface.set_main_screen_editor(screen)
				result = true
		"screenshot":
			result = await _screenshot(int(params.get("max_width", 1280)))
		_:
			error = "unknown method: %s" % req.get("method", "")
	if result is Dictionary and result.has("__error"):
		error = result["__error"]
		result = null
	_respond(id, result, error)


func _respond(id, result, error: String) -> void:
	if _window and _window.__godotBridgeResolve:
		_window.__godotBridgeResolve(JSON.stringify({"id": id, "result": result, "error": error}))


## "scenes/main.tscn" 또는 "res://scenes/main.tscn" -> "res://scenes/main.tscn". 프로젝트 밖 경로는 거부.
func _res_path(path: String) -> String:
	var p := path.strip_edges().replace("\\", "/")
	if p.begins_with("res://"):
		p = p.substr(6)
	p = p.lstrip("/")
	if p.is_empty() or p.split("/").has(".."):
		return ""
	return "res://" + p


func _list_files(dir: String, include_cache: bool = false) -> Array:
	var out := []
	var start := "res://" if dir == "" else _res_path(dir)
	if start != "":
		_walk(start, out, include_cache)
	return out


func _file_manifest() -> Array:
	var files := _list_files("")
	for file in files:
		file["hash"] = FileAccess.get_sha256("res://" + file.path)
	return files


func _walk(dir: String, out: Array, include_cache: bool) -> void:
	var d := DirAccess.open(dir)
	if d == null:
		return
	d.include_hidden = true
	for sub in d.get_directories():
		if sub == ".git" or (not include_cache and sub in IGNORED_DIRS):
			continue
		_walk(dir.path_join(sub), out, include_cache)
	for f in d.get_files():
		var full := dir.path_join(f)
		var fa := FileAccess.open(full, FileAccess.READ)
		var size := fa.get_length() if fa else -1
		out.append({"path": full.substr(6), "size": size, "mtime": FileAccess.get_modified_time(full)})


func _read_file(path: String, encoding: String):
	var p := _res_path(path)
	if p == "" or not FileAccess.file_exists(p):
		return {"__error": "file not found: %s" % path}
	var bytes := FileAccess.get_file_as_bytes(p)
	if encoding == "base64":
		return {"path": p.substr(6), "encoding": "base64", "content": Marshalls.raw_to_base64(bytes)}
	return {"path": p.substr(6), "encoding": "utf8", "content": bytes.get_string_from_utf8()}


func _write_files(files) -> Dictionary:
	var written := []
	var errors := []
	for f in files:
		var p := _res_path(str(f.get("path", "")))
		if p == "":
			errors.append("invalid path: %s" % f.get("path", ""))
			continue
		DirAccess.make_dir_recursive_absolute(p.get_base_dir())
		var bytes: PackedByteArray
		if str(f.get("encoding", "utf8")) == "base64":
			bytes = Marshalls.base64_to_raw(str(f.get("content", "")))
		else:
			bytes = str(f.get("content", "")).to_utf8_buffer()
		var fa := FileAccess.open(p, FileAccess.WRITE)
		if fa == null:
			errors.append("cannot write %s: %s" % [p, error_string(FileAccess.get_open_error())])
			continue
		fa.store_buffer(bytes)
		fa.close()
		written.append(p)
	_after_external_change(written)
	return {"written": written.map(func(p): return p.substr(6)), "errors": errors}


func _delete_files(paths) -> Dictionary:
	var deleted := []
	var errors := []
	for raw in paths:
		var p := _res_path(str(raw))
		if p == "" or not FileAccess.file_exists(p):
			errors.append("not found: %s" % raw)
			continue
		var err := DirAccess.remove_absolute(ProjectSettings.globalize_path(p))
		if err == OK:
			deleted.append(p)
		else:
			errors.append("cannot delete %s: %s" % [p, error_string(err)])
	_after_external_change([])
	return {"deleted": deleted.map(func(p): return p.substr(6)), "errors": errors}


## 외부에서 바뀐 파일을 에디터에 반영: 파일 시스템 재검색, 열린 씬/스크립트 다시 불러오기
func _after_external_change(changed: Array) -> void:
	var efs := EditorInterface.get_resource_filesystem()
	for p in changed:
		efs.update_file(p)
	efs.scan()
	var open_scenes := EditorInterface.get_open_scenes()
	for p in changed:
		if p in open_scenes:
			EditorInterface.reload_scene_from_path(p)
	# 스크립트 편집기는 창 포커스가 돌아올 때 디스크 변경을 확인한다(auto_reload 설정이 켜져 있으면 묻지 않고 다시 불러옴).
	if not changed.is_empty():
		EditorInterface.get_script_editor().notification(Node.NOTIFICATION_APPLICATION_FOCUS_IN)


func _get_state() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var selected := []
	for n in EditorInterface.get_selection().get_selected_nodes():
		selected.append(str(root.get_path_to(n)) if root else n.name)
	return {
		"current_scene": root.scene_file_path.substr(6) if root else "",
		"open_scenes": Array(EditorInterface.get_open_scenes()).map(func(p): return p.substr(6)),
		"selected_nodes": selected,
		"playing": EditorInterface.is_playing_scene(),
		"main_scene": str(ProjectSettings.get_setting("application/run/main_scene", "")).trim_prefix("res://"),
	}


func _screenshot(max_width: int):
	# 에디터는 변화가 없으면 다시 그리지 않으므로(저전력 모드) 다음 프레임을 기다리지 않고 마지막 프레임을 사용한다.
	var img := EditorInterface.get_base_control().get_viewport().get_texture().get_image()
	if img == null:
		return {"__error": "screenshot failed"}
	if max_width > 0 and img.get_width() > max_width:
		img.resize(max_width, int(img.get_height() * float(max_width) / img.get_width()), Image.INTERPOLATE_BILINEAR)
	return {"mime_type": "image/png", "width": img.get_width(), "height": img.get_height(),
		"data": Marshalls.raw_to_base64(img.save_png_to_buffer())}
