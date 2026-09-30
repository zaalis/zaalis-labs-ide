'use strict';

// The tools the agent gets for Blender (see blender-connector.js for how they
// reach it). Most are a piece of Python run inside the open Blender through
// its MCP add-on: `params` holds the tool's arguments and the value left in
// `result` is what the agent receives. A result may list `_images` (files
// written by Blender): the connector turns them into images the model sees.
//
// Beyond scene inspection and Python execution, the set covers what an
// assistant needs to work like a person at the screen: seeing the viewport
// (screenshots, renders), knowing the file (saved state, missing files,
// libraries, datablocks), reading node trees, looking the Python API up live
// in the running Blender (always the right version), moving the interface to
// what it is talking about, undoing its own mistakes, and inspecting another
// .blend file without opening it.

// Shared by the tools that need Blender's interface or write images.
const HELPERS = String.raw`
import bpy, os, tempfile, uuid

def _zaalis_window():
    wm = bpy.context.window_manager
    if wm is None or not wm.windows:
        raise RuntimeError("Aucune fenêtre Blender : cet outil demande Blender ouvert avec son interface.")
    return wm.windows[0]

def _zaalis_area(win, kind):
    areas = [a for a in win.screen.areas if a.type == kind]
    return max(areas, key=lambda a: a.width * a.height) if areas else None

def _zaalis_region(area):
    return next((r for r in area.regions if r.type == 'WINDOW'), None)

def _zaalis_temp(extension):
    return os.path.join(tempfile.gettempdir(), "zaalis_blender_" + uuid.uuid4().hex + extension)

def _zaalis_export(source, max_size):
    # Downscaled JPEG copy of an image file, without touching the scene.
    image = bpy.data.images.load(source, check_existing=False)
    try:
        width, height = image.size
        longest = max(width, height)
        if longest > max_size:
            image.scale(max(1, round(width * max_size / longest)), max(1, round(height * max_size / longest)))
        out = _zaalis_temp(".jpg")
        image.file_format = 'JPEG'
        image.save(filepath=out, quality=85)
        return out, [image.size[0], image.size[1]], [width, height]
    finally:
        bpy.data.images.remove(image)
`;

const SUMMARY_CODE = String.raw`
import bpy
scene = bpy.context.scene
counts = {}
for obj in scene.objects:
    counts[obj.type] = counts.get(obj.type, 0) + 1
view_layer = bpy.context.view_layer
active = view_layer.objects.active
result = {
    "blender": bpy.app.version_string,
    "file": bpy.data.filepath or None, "unsaved_changes": bool(bpy.data.is_dirty),
    "scene": scene.name, "scenes": [s.name for s in bpy.data.scenes],
    "frame": {"current": scene.frame_current, "start": scene.frame_start, "end": scene.frame_end, "fps": scene.render.fps},
    "render": {"engine": scene.render.engine, "resolution": [scene.render.resolution_x, scene.render.resolution_y], "percentage": scene.render.resolution_percentage},
    "units": scene.unit_settings.system, "mode": bpy.context.mode,
    "objects": {"total": len(scene.objects), "by_type": counts},
    "active_object": active.name if active else None,
    "selected": [o.name for o in view_layer.objects if o.select_get()][:50],
    "collections": [c.name for c in bpy.data.collections][:100],
    "camera": scene.camera.name if scene.camera else None,
    "world": scene.world.name if scene.world else None,
    "materials": len(bpy.data.materials), "images": len(bpy.data.images),
    "workspaces": [w.name for w in bpy.data.workspaces],
}
`;

const LIST_CODE = String.raw`
import bpy
kind = str(params.get("type") or "").upper()
needle = str(params.get("name_contains") or "").lower()
limit = max(1, min(int(params.get("limit") or 100), 500))
rows = []
matched = 0
for obj in bpy.context.scene.objects:
    if kind and obj.type != kind: continue
    if needle and needle not in obj.name.lower(): continue
    matched += 1
    if len(rows) >= limit: continue
    rows.append({
        "name": obj.name, "type": obj.type,
        "location": [round(v, 4) for v in obj.location],
        "dimensions": [round(v, 4) for v in obj.dimensions],
        "parent": obj.parent.name if obj.parent else None,
        "collections": [c.name for c in obj.users_collection],
        "visible": bool(obj.visible_get()),
        "materials": [s.material.name for s in obj.material_slots if s.material],
        "modifiers": [m.type for m in obj.modifiers],
    })
result = {"matched": matched, "returned": len(rows), "objects": rows}
`;

const DETAILS_CODE = String.raw`
import bpy
def _value(v):
    if isinstance(v, (bool, int, str)) or v is None: return v
    if isinstance(v, float): return round(v, 5)
    try: return [_value(x) for x in v]
    except TypeError: return str(v)[:200]
name = str(params.get("name") or "")
obj = bpy.data.objects.get(name)
if obj is None:
    result = {"error": "Aucun objet nommé " + repr(name), "objects": [o.name for o in bpy.data.objects][:100]}
else:
    info = {
        "name": obj.name, "type": obj.type,
        "location": [round(v, 5) for v in obj.location],
        "rotation_euler": [round(v, 5) for v in obj.rotation_euler],
        "scale": [round(v, 5) for v in obj.scale],
        "dimensions": [round(v, 5) for v in obj.dimensions],
        "parent": obj.parent.name if obj.parent else None,
        "children": [c.name for c in obj.children][:100],
        "collections": [c.name for c in obj.users_collection],
        "visible": bool(obj.visible_get()), "hide_render": bool(obj.hide_render),
        "materials": [s.material.name if s.material else None for s in obj.material_slots],
        "custom_properties": {k: str(obj[k])[:200] for k in obj.keys() if not k.startswith("_")},
        "animated": obj.animation_data is not None and obj.animation_data.action is not None,
    }
    modifiers = []
    for m in obj.modifiers:
        entry = {"name": m.name, "type": m.type, "show_viewport": bool(m.show_viewport), "show_render": bool(m.show_render)}
        settings = {}
        for p in m.bl_rna.properties:
            if p.identifier in ("rna_type", "name", "type", "show_viewport", "show_render", "show_in_editmode", "show_on_cage", "show_expanded", "is_active", "is_override_data", "use_pin_to_last", "persistent_uid", "execution_time"): continue
            if p.type in ("POINTER", "COLLECTION"):
                target = getattr(m, p.identifier, None)
                if p.type == "POINTER" and target is not None and hasattr(target, "name"): settings[p.identifier] = target.name
                continue
            try: settings[p.identifier] = _value(getattr(m, p.identifier))
            except Exception: pass
        entry["settings"] = settings
        if m.type == "NODES" and getattr(m, "node_group", None) is not None: entry["node_group"] = m.node_group.name
        modifiers.append(entry)
    info["modifiers"] = modifiers
    constraints = [{"name": c.name, "type": c.type, "target": getattr(getattr(c, "target", None), "name", None)} for c in obj.constraints]
    if constraints: info["constraints"] = constraints
    data = obj.data
    if obj.type == "MESH" and data is not None:
        info["mesh"] = {"name": data.name, "vertices": len(data.vertices), "edges": len(data.edges), "polygons": len(data.polygons), "uv_layers": [u.name for u in data.uv_layers], "shape_keys": len(data.shape_keys.key_blocks) if data.shape_keys else 0, "attributes": [a.name for a in data.attributes][:50]}
        depsgraph = bpy.context.evaluated_depsgraph_get()
        evaluated = obj.evaluated_get(depsgraph)
        try:
            mesh = evaluated.to_mesh()
            info["evaluated_mesh"] = {"vertices": len(mesh.vertices), "polygons": len(mesh.polygons)}
            evaluated.to_mesh_clear()
        except Exception:
            pass
    elif obj.type == "CAMERA" and data is not None:
        info["camera"] = {"type": data.type, "lens": round(data.lens, 3), "clip": [round(data.clip_start, 4), round(data.clip_end, 3)]}
    elif obj.type == "LIGHT" and data is not None:
        info["light"] = {"type": data.type, "energy": round(data.energy, 3), "color": [round(v, 4) for v in data.color]}
    result = info
`;

const SCREENSHOT_CODE = String.raw`
target = str(params.get("target") or "viewport").lower()
max_size = max(400, min(int(params.get("max_size") or 1600), 2560))
win = _zaalis_window()
raw = _zaalis_temp(".png")
if target == "window":
    with bpy.context.temp_override(window=win):
        bpy.ops.screen.screenshot(filepath=raw, check_existing=False)
else:
    area = _zaalis_area(win, "VIEW_3D") or max(win.screen.areas, key=lambda a: a.width * a.height)
    with bpy.context.temp_override(window=win, area=area):
        bpy.ops.screen.screenshot_area(filepath=raw, check_existing=False)
try:
    out, size, original = _zaalis_export(raw, max_size)
finally:
    if os.path.exists(raw): os.remove(raw)
result = {"target": "window" if target == "window" else "viewport", "image_size": size, "screen_size": original, "workspace": win.workspace.name, "_images": [out]}
`;

const RENDER_CODE = String.raw`
import time
mode = str(params.get("mode") or "viewport").lower()
max_size = max(400, min(int(params.get("max_size") or 1600), 2560))
scene = bpy.context.scene
percent = params.get("resolution_percent")
previous = scene.render.resolution_percentage
started = time.time()
try:
    if percent is not None:
        scene.render.resolution_percentage = max(1, min(int(percent), 100))
    if mode == "final":
        bpy.ops.render.render(write_still=False)
    else:
        win = _zaalis_window()
        area = _zaalis_area(win, "VIEW_3D")
        if area is None:
            raise RuntimeError("Aucune vue 3D ouverte pour un rendu de la fenêtre.")
        from_camera = bool(params.get("from_camera")) and scene.camera is not None
        with bpy.context.temp_override(window=win, area=area, region=_zaalis_region(area)):
            bpy.ops.render.opengl(write_still=False, view_context=not from_camera)
finally:
    if percent is not None:
        scene.render.resolution_percentage = previous
seconds = round(time.time() - started, 2)
render_result = bpy.data.images.get("Render Result")
if render_result is None:
    raise RuntimeError("Blender n’a produit aucune image.")
raw = _zaalis_temp(".png")
render_result.save_render(raw, scene=scene)
try:
    out, size, original = _zaalis_export(raw, max_size)
finally:
    if os.path.exists(raw): os.remove(raw)
result = {"mode": "final" if mode == "final" else "viewport", "engine": scene.render.engine, "seconds": seconds, "render_size": original, "image_size": size, "camera": scene.camera.name if scene.camera else None, "_images": [out]}
`;

const FILE_INFO_CODE = String.raw`
import bpy, os, datetime
path = bpy.data.filepath
info = {"file": path or None, "saved_once": bool(path), "unsaved_changes": bool(bpy.data.is_dirty), "blender": bpy.app.version_string, "file_version": list(bpy.data.version), "relative_paths": bool(bpy.context.preferences.filepaths.use_relative_paths), "compress": bool(bpy.context.preferences.filepaths.use_file_compression)}
if path and os.path.exists(path):
    stat = os.stat(path)
    info["size_bytes"] = stat.st_size
    info["modified"] = datetime.datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")
    info["age_seconds"] = int(datetime.datetime.now().timestamp() - stat.st_mtime)
    info["backups"] = [path + str(i) for i in range(1, 33) if os.path.exists(path + str(i))]
result = info
`;

const MISSING_CODE = String.raw`
import bpy, os
missing = []
checked = 0
for collection in ("images", "libraries", "sounds", "fonts", "movieclips", "volumes", "cache_files"):
    for block in getattr(bpy.data, collection, []):
        path = getattr(block, "filepath", "") or ""
        if not path or path == "<builtin>": continue
        if collection == "images" and (block.packed_file is not None or block.source in ("GENERATED", "VIEWER")): continue
        checked += 1
        resolved = bpy.path.abspath(path, library=getattr(block, "library", None))
        if "<UDIM>" in path or "<UVTILE>" in path: continue
        if not os.path.exists(resolved):
            missing.append({"type": collection, "name": block.name, "filepath": path, "resolved": resolved, "users": getattr(block, "users", None)})
result = {"checked": checked, "missing_count": len(missing), "missing": missing[:300]}
`;

const LIBRARIES_CODE = String.raw`
import bpy, os
libraries = []
for library in bpy.data.libraries:
    resolved = bpy.path.abspath(library.filepath)
    linked = {}
    for collection in ("objects", "collections", "meshes", "materials", "node_groups", "images", "actions", "armatures", "worlds", "scenes"):
        count = sum(1 for block in getattr(bpy.data, collection) if getattr(block, "library", None) == library)
        if count: linked[collection] = count
    libraries.append({"name": library.name, "filepath": library.filepath, "resolved": resolved, "exists": os.path.exists(resolved), "parent": library.parent.name if library.parent else None, "linked": linked})
result = {"count": len(libraries), "libraries": libraries}
`;

const DATABLOCKS_CODE = String.raw`
import bpy
with_names = bool(params.get("names"))
summary = {}
for name in dir(bpy.data):
    if name.startswith("_"): continue
    collection = getattr(bpy.data, name, None)
    if name == "all_ids" or not isinstance(collection, bpy.types.bpy_prop_collection) or not len(collection): continue
    entry = {"count": len(collection)}
    orphans = [b.name for b in collection if getattr(b, "users", 1) == 0 and not getattr(b, "use_fake_user", False)]
    linked = sum(1 for b in collection if getattr(b, "library", None) is not None)
    if orphans: entry["orphans"] = len(orphans)
    if linked: entry["linked"] = linked
    if with_names: entry["names"] = [b.name for b in collection][:60]
    summary[name] = entry
result = {"datablocks": summary}
`;

const NODE_TREE_CODE = String.raw`
import bpy
def _value(v):
    if isinstance(v, (bool, int, str)) or v is None: return v
    if isinstance(v, float): return round(v, 4)
    if hasattr(v, "name") and hasattr(v, "bl_rna"): return v.name
    try: return [_value(x) for x in v][:16]
    except TypeError: return str(v)[:120]
def _socket(s):
    entry = {"name": s.name, "type": s.type, "linked": bool(s.is_linked)}
    if not s.is_linked and hasattr(s, "default_value"):
        try: entry["value"] = _value(s.default_value)
        except Exception: pass
    return entry
tree = None
label = ""
if params.get("material"):
    material = bpy.data.materials.get(params["material"])
    tree = material.node_tree if material else None
    label = "matériau " + str(params["material"])
elif params.get("node_group"):
    tree = bpy.data.node_groups.get(params["node_group"])
    label = "groupe " + str(params["node_group"])
elif params.get("world"):
    world = bpy.context.scene.world
    tree = world.node_tree if world else None
    label = "monde"
elif params.get("compositor"):
    tree = getattr(bpy.context.scene, "compositing_node_group", None) or getattr(bpy.context.scene, "node_tree", None)
    label = "compositing"
if tree is None:
    available = {"materials": [m.name for m in bpy.data.materials if m.node_tree][:100], "node_groups": [g.name for g in bpy.data.node_groups][:100]}
    obj = bpy.data.objects.get(str(params.get("object") or ""))
    if obj is not None:
        available["object_materials"] = [s.material.name for s in obj.material_slots if s.material]
        available["object_geometry_nodes"] = [m.node_group.name for m in obj.modifiers if m.type == "NODES" and m.node_group]
    result = {"error": "Précisez material, node_group, world ou compositor." if not params.get("object") and not (params.get("material") or params.get("node_group")) else "Arbre de nœuds introuvable.", "available": available}
else:
    limit = max(1, min(int(params.get("limit") or 200), 400))
    nodes = []
    for node in list(tree.nodes)[:limit]:
        entry = {"name": node.name, "type": node.bl_idname, "location": [round(node.location.x), round(node.location.y)]}
        if node.label: entry["label"] = node.label
        if getattr(node, "node_tree", None) is not None: entry["group"] = node.node_tree.name
        entry["inputs"] = [_socket(s) for s in node.inputs if s.enabled][:40]
        entry["outputs"] = [s.name for s in node.outputs if s.enabled][:20]
        nodes.append(entry)
    links = [{"from": l.from_node.name + "." + l.from_socket.name, "to": l.to_node.name + "." + l.to_socket.name} for l in tree.links][:600]
    result = {"tree": tree.name, "of": label, "type": tree.bl_idname, "node_count": len(tree.nodes), "nodes": nodes, "links": links}
`;

const API_SEARCH_CODE = String.raw`
import bpy
words = [w for w in str(params.get("query") or "").lower().split() if w]
kind = str(params.get("kind") or "all").lower()
limit = max(1, min(int(params.get("limit") or 25), 100))
hits = []
def _consider(path, name, description, weight):
    text = (path + " " + (name or "") + " " + (description or "")).lower()
    if all(w in text for w in words):
        score = weight + sum(3 for w in words if w in path.lower())
        hits.append((score, {"path": path, "name": name, "description": (description or "")[:240]}))
if words:
    if kind in ("all", "operators"):
        for module_name in dir(bpy.ops):
            if module_name.startswith("_"): continue
            module = getattr(bpy.ops, module_name)
            for op_name in dir(module):
                if op_name.startswith("_"): continue
                try: rna = getattr(module, op_name).get_rna_type()
                except Exception: continue
                _consider("bpy.ops." + module_name + "." + op_name, rna.name, rna.description, 1)
    if kind in ("all", "types"):
        for type_name in dir(bpy.types):
            rna = getattr(getattr(bpy.types, type_name, None), "bl_rna", None)
            if rna is None: continue
            _consider("bpy.types." + type_name, rna.name, rna.description, 2)
    if kind in ("all", "properties"):
        for type_name in ("Object", "Scene", "RenderSettings", "Mesh", "Material", "Camera", "Light", "World", "Image", "Modifier", "Node", "View3DShading", "ToolSettings", "Preferences"):
            rna = getattr(getattr(bpy.types, type_name, None), "bl_rna", None)
            if rna is None: continue
            for prop in rna.properties:
                _consider("bpy.types." + type_name + "." + prop.identifier, prop.name, prop.description, 0)
hits.sort(key=lambda item: -item[0])
result = {"query": " ".join(words), "count": len(hits), "results": [h for _, h in hits[:limit]], "hint": "api_docs donne le détail d’un chemin."}
`;

const API_DOCS_CODE = String.raw`
import bpy, fnmatch
def _prop(p):
    entry = {"name": p.identifier, "type": p.type, "description": p.description}
    if p.is_readonly: entry["readonly"] = True
    if p.type == "ENUM":
        entry["items"] = [i.identifier for i in p.enum_items][:60]
        if getattr(p, "is_enum_flag", False): entry["flag"] = True
        else:
            try: entry["default"] = p.default
            except Exception: pass
    elif p.type in ("POINTER", "COLLECTION"):
        entry["of"] = p.fixed_type.identifier if p.fixed_type else None
    else:
        length = getattr(p, "array_length", 0)
        try: entry["default"] = list(p.default_array) if length else p.default
        except Exception: pass
        if length: entry["length"] = length
        if p.type in ("INT", "FLOAT"):
            entry["range"] = [p.hard_min, p.hard_max]
        if p.subtype not in ("NONE", "", None): entry["subtype"] = p.subtype
    return entry
def _manual(path):
    try:
        for prefix, mapping in bpy.utils.manual_map():
            for pattern, url in mapping:
                if fnmatch.fnmatchcase(path, pattern): return prefix + url
    except Exception:
        return None
    return None
path = str(params.get("path") or "").strip()
if path.startswith("bpy.ops."):
    parts = path.split(".")
    if len(parts) != 4:
        raise ValueError("Chemin d’opérateur attendu : bpy.ops.<module>.<opérateur>")
    rna = getattr(getattr(bpy.ops, parts[2]), parts[3]).get_rna_type()
    result = {"kind": "operator", "path": path, "name": rna.name, "description": rna.description, "parameters": [_prop(p) for p in rna.properties if p.identifier != "rna_type"], "manual": _manual(path)}
else:
    name = path[len("bpy.types."):] if path.startswith("bpy.types.") else path
    type_name, _, member = name.partition(".")
    cls = getattr(bpy.types, type_name, None)
    if cls is None or not hasattr(cls, "bl_rna"):
        raise ValueError("Type introuvable : " + path + " (api_search aide à trouver le bon chemin)")
    rna = cls.bl_rna
    if member:
        prop = rna.properties.get(member)
        function = rna.functions.get(member)
        if prop is not None: result = {"kind": "property", "path": path, **_prop(prop), "manual": _manual("bpy.types." + name)}
        elif function is not None: result = {"kind": "function", "path": path, "description": function.description, "parameters": [_prop(p) for p in function.parameters]}
        else: raise ValueError(type_name + " n’a pas de membre " + member)
    else:
        result = {"kind": "type", "path": "bpy.types." + type_name, "name": rna.name, "description": rna.description, "base": rna.base.identifier if rna.base else None,
                  "properties": [_prop(p) for p in rna.properties if p.identifier != "rna_type"][:250],
                  "functions": [{"name": f.identifier, "description": f.description, "parameters": [p.identifier for p in f.parameters]} for f in rna.functions][:120],
                  "manual": _manual("bpy.types." + type_name)}
`;

const FOCUS_CODE = String.raw`
name = str(params.get("name") or "")
obj = bpy.data.objects.get(name)
if obj is None:
    raise ValueError("Aucun objet nommé " + repr(name))
win = _zaalis_window()
view_layer = bpy.context.view_layer
changed_from = None
if bpy.context.mode != "OBJECT" and view_layer.objects.active is not None:
    changed_from = bpy.context.mode
    with bpy.context.temp_override(window=win):
        bpy.ops.object.mode_set(mode="OBJECT")
for other in view_layer.objects:
    if other.select_get(): other.select_set(False)
if obj.name not in view_layer.objects:
    raise ValueError(obj.name + " n’est pas dans la couche de vue active (collection exclue ?)")
obj.hide_set(False)
obj.select_set(True)
view_layer.objects.active = obj
framed = False
if params.get("frame", True):
    area = _zaalis_area(win, "VIEW_3D")
    if area is not None:
        with bpy.context.temp_override(window=win, area=area, region=_zaalis_region(area)):
            bpy.ops.view3d.view_selected()
        framed = True
result = {"active": obj.name, "framed": framed, "mode_changed_from": changed_from}
`;

const WORKSPACE_CODE = String.raw`
name = str(params.get("name") or "")
win = _zaalis_window()
workspace = bpy.data.workspaces.get(name)
if workspace is None:
    raise ValueError("Espace de travail introuvable : " + repr(name) + ". Disponibles : " + ", ".join(w.name for w in bpy.data.workspaces))
win.workspace = workspace
result = {"workspace": workspace.name}
`;

const PROPERTIES_CODE = String.raw`
tab = str(params.get("tab") or "").upper().strip()
tab = {"MODIFIERS": "MODIFIER", "CONSTRAINTS": "CONSTRAINT", "OBJECT_DATA": "DATA", "MATERIALS": "MATERIAL", "TEXTURES": "TEXTURE", "BONES": "BONE"}.get(tab, tab)
win = _zaalis_window()
area = _zaalis_area(win, "PROPERTIES")
if area is None:
    raise RuntimeError("Aucun éditeur de propriétés dans l’espace de travail actuel.")
space = area.spaces.active
try:
    space.context = tab
    result = {"tab": space.context}
except TypeError as error:
    # The available tabs depend on the active object: Blender lists them.
    message = str(error)
    result = {"error": "Onglet indisponible pour la sélection actuelle : " + tab, "available": message[message.find("("):] if "(" in message else message}
`;

const UNDO_CODE = String.raw`
steps = max(1, min(int(params.get("steps") or 1), 20))
win = _zaalis_window()
done = 0
for _ in range(steps):
    with bpy.context.temp_override(window=win):
        if not bpy.ops.ed.undo.poll(): break
        if "FINISHED" not in bpy.ops.ed.undo(): break
    done += 1
result = {"undone": done, "requested": steps}
`;

// Appended to the tools that change the scene: one step in Blender's undo
// history per agent action (code run from the add-on records none on its own),
// so `undo` — or Ctrl+Z — takes it back.
const UNDO_PUSH = (label) => String.raw`
try:
    import bpy as _zaalis_bpy
    _zaalis_wm = _zaalis_bpy.context.window_manager
    if _zaalis_wm is not None and _zaalis_wm.windows:
        with _zaalis_bpy.context.temp_override(window=_zaalis_wm.windows[0]):
            _zaalis_bpy.ops.ed.undo_push(message="IA zaalis : ${label}")
except Exception:
    pass
`;

// The summaries a windowless Blender computes for inspect_blend_file.
const FILE_SUMMARIES = { file: FILE_INFO_CODE, datablocks: DATABLOCKS_CODE, missing_files: MISSING_CODE, libraries: LIBRARIES_CODE };

const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

const TOOLS = [
  { name: 'scene_summary', code: SUMMARY_CODE, inputSchema: object({}),
    description: 'Vue d’ensemble du fichier ouvert : fichier et état de sauvegarde, scène, images, moteur de rendu, objets par type, objet actif, sélection, collections, espaces de travail. À appeler en premier.' },
  { name: 'list_objects', code: LIST_CODE, inputSchema: object({ type: { type: 'string' }, name_contains: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
    description: 'Liste les objets de la scène (nom, type, position, dimensions, parent, collections, matériaux, modificateurs). Filtres facultatifs : type Blender (MESH, LIGHT, CAMERA, EMPTY, CURVE…) et morceau de nom.' },
  { name: 'object_details', code: DETAILS_CODE, inputSchema: object({ name: { type: 'string' } }, ['name']),
    description: 'Détail d’un objet par son nom exact : transformations, hiérarchie, matériaux, modificateurs avec tous leurs réglages, contraintes, propriétés personnalisées, maillage avant et après modificateurs, caméra ou lumière.' },
  { name: 'screenshot', code: SCREENSHOT_CODE, helpers: true, images: true, inputSchema: object({ target: { type: 'string', enum: ['viewport', 'window'] }, max_size: { type: 'integer', minimum: 400, maximum: 2560 } }),
    description: 'Capture d’écran montrée au modèle : la vue 3D (viewport, défaut) ou toute la fenêtre de Blender (window). Pour voir le résultat d’une action. Demande Blender ouvert avec son interface.' },
  { name: 'render', code: RENDER_CODE, helpers: true, images: true, inputSchema: object({ mode: { type: 'string', enum: ['viewport', 'final'] }, from_camera: { type: 'boolean' }, resolution_percent: { type: 'integer', minimum: 1, maximum: 100 }, max_size: { type: 'integer', minimum: 400, maximum: 2560 } }),
    description: 'Rendu montré au modèle. viewport (défaut) : rendu rapide de la vue 3D, ou depuis la caméra de la scène avec from_camera. final : vrai rendu avec le moteur de la scène — peut bloquer Blender longtemps, préviens l’utilisateur. resolution_percent change la résolution le temps du rendu.' },
  { name: 'file_info', code: FILE_INFO_CODE, inputSchema: object({}),
    description: 'Fichier .blend ouvert : chemin, modifications non enregistrées, taille, date, sauvegardes .blend1…, version, réglages de chemins.' },
  { name: 'missing_files', code: MISSING_CODE, inputSchema: object({}),
    description: 'Fichiers externes introuvables (textures, bibliothèques liées, sons, polices, vidéos, volumes, caches) avec leur chemin résolu.' },
  { name: 'linked_libraries', code: LIBRARIES_CODE, inputSchema: object({}),
    description: 'Bibliothèques .blend liées : chemin, présence sur le disque, bibliothèque parente, nombre de données liées par type.' },
  { name: 'datablocks', code: DATABLOCKS_CODE, inputSchema: object({ names: { type: 'boolean' } }),
    description: 'Inventaire de toutes les données du fichier par type (objets, maillages, matériaux, groupes de nœuds, images, actions…) avec les données orphelines et liées. names=true ajoute leurs noms.' },
  { name: 'node_tree', code: NODE_TREE_CODE, inputSchema: object({ material: { type: 'string' }, node_group: { type: 'string' }, world: { type: 'boolean' }, compositor: { type: 'boolean' }, object: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 400 } }),
    description: 'Nœuds et liens d’un matériau, d’un groupe de nœuds (dont Geometry Nodes), du monde ou du compositing, avec les valeurs des entrées non reliées. Avec object seul : liste les arbres utilisés par cet objet.' },
  { name: 'api_search', code: API_SEARCH_CODE, inputSchema: object({ query: { type: 'string' }, kind: { type: 'string', enum: ['all', 'operators', 'types', 'properties'] }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['query']),
    description: 'Recherche dans l’API Python du Blender ouvert (sa version exacte) : opérateurs bpy.ops, types bpy.types et propriétés courantes, par mots-clés. À utiliser avant d’écrire du code dont tu n’es pas sûr.' },
  { name: 'api_docs', code: API_DOCS_CODE, inputSchema: object({ path: { type: 'string' } }, ['path']),
    description: 'Documentation d’un élément de l’API, lue dans le Blender ouvert : bpy.ops.<module>.<op> (paramètres, valeurs par défaut, choix possibles), bpy.types.<Type> (propriétés, fonctions) ou bpy.types.<Type>.<membre>, avec le lien vers le manuel.' },
  { name: 'focus_object', code: FOCUS_CODE + UNDO_PUSH('focus_object'), helpers: true, inputSchema: object({ name: { type: 'string' }, frame: { type: 'boolean' } }, ['name']),
    description: 'Sélectionne un objet, le rend actif et le cadre dans la vue 3D (frame=false pour ne pas bouger la vue). Repasse en mode Objet si besoin.' },
  { name: 'switch_workspace', code: WORKSPACE_CODE, helpers: true, inputSchema: object({ name: { type: 'string' } }, ['name']),
    description: 'Affiche un espace de travail de Blender (Layout, Modeling, Shading, Animation, Rendering, Geometry Nodes…).' },
  { name: 'show_properties', code: PROPERTIES_CODE, helpers: true, inputSchema: object({ tab: { type: 'string' } }, ['tab']),
    description: 'Ouvre un onglet de l’éditeur de propriétés : TOOL, RENDER, OUTPUT, VIEW_LAYER, SCENE, WORLD, COLLECTION, OBJECT, MODIFIER, PARTICLES, PHYSICS, CONSTRAINT, DATA, MATERIAL, TEXTURE (selon l’objet actif).' },
  { name: 'undo', code: UNDO_CODE, helpers: true, inputSchema: object({ steps: { type: 'integer', minimum: 1, maximum: 20 } }),
    description: 'Annule les dernières étapes de l’historique de Blender (1 par défaut, 20 au plus) : chaque appel à execute_python ou focus_object en est une. Pour revenir sur une action ratée.' },
  { name: 'execute_python', raw: true, after: UNDO_PUSH('execute_python'), inputSchema: object({ code: { type: 'string' } }, ['code']),
    description: 'Exécute du code Python dans Blender (module bpy), sur le fil principal. Pour renvoyer une valeur, l’affecter à la variable `result` (dictionnaire sérialisable en JSON). Ce qui est imprimé avec print() est renvoyé aussi. Sert à tout ce que les autres outils ne font pas : créer, modifier, animer, enregistrer.' },
  { name: 'inspect_blend_file', local: true, inputSchema: object({ path: { type: 'string' } }, ['path']),
    description: 'Analyse un autre fichier .blend sans l’ouvrir dans Blender (un Blender sans fenêtre le lit, ses scripts désactivés) : état du fichier, inventaire des données, fichiers manquants, bibliothèques liées. Chemin absolu requis.' },
];

module.exports = { TOOLS, HELPERS, FILE_SUMMARIES };
