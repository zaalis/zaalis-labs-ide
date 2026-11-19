'use strict';

// Original Zaalis tools. Each request is self-contained: no Python module or
// pip dependency has to be installed in Blender. Nothing runs at require time.
const COMMON = String.raw`
import bpy, bmesh, os, json, math, uuid, hashlib, array, time
from mathutils import Vector

def _z_objects(names=None, limit=500):
    names = params.get('objects') if names is None else names
    if names is not None:
        if not names or len(names) != len(set(names)):
            raise ValueError('Provide a non-empty list of unique object names')
        objects = []
        for name in names:
            obj = bpy.context.scene.objects.get(name)
            if obj is None: raise ValueError('Object not in current scene: ' + str(name))
            objects.append(obj)
    else: objects = list(bpy.context.scene.objects)
    if len(objects) > limit: raise ValueError('Too many objects; specify objects (maximum %d)' % limit)
    return objects

def _z_editable(objects):
    if bpy.context.mode != 'OBJECT': raise ValueError('Object mode is required')
    for obj in objects:
        if not obj.is_editable: raise ValueError('Linked/read-only object: ' + obj.name)

def _z_bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return ([min(p[i] for p in points) for i in range(3)], [max(p[i] for p in points) for i in range(3)])

def _z_mesh(obj, depsgraph):
    evaluated = obj.evaluated_get(depsgraph)
    return evaluated, evaluated.to_mesh()

def _z_value(value):
    if value is None or isinstance(value, (str, bool, int)): return value
    if isinstance(value, float): return round(value, 6) if math.isfinite(value) else str(value)
    if hasattr(value, 'name_full'): return value.name_full
    if hasattr(value, 'keys'):
        try: return {k: _z_value(value[k]) for k in value.keys()}
        except TypeError: pass
    if hasattr(value, 'bl_rna'): return _z_properties(value)
    try: return [_z_value(v) for v in value]
    except TypeError: return str(value)

def _z_properties(block):
    values = {}
    for prop in block.bl_rna.properties:
        if prop.identifier in ('rna_type', 'execution_time') or prop.type == 'COLLECTION': continue
        try: values[prop.identifier] = _z_value(getattr(block, prop.identifier))
        except (AttributeError, TypeError, ValueError): continue
    return values

def _z_graph(tree, seen=None):
    if tree is None: return None
    seen = set() if seen is None else seen
    if tree.name_full in seen: return {'reference': tree.name_full}
    if len(seen) > 32 or len(tree.nodes) > 1000: raise ValueError('Node graph snapshot budget exceeded')
    seen.add(tree.name_full)
    nodes = []
    for node in tree.nodes:
        nodes.append({'name': node.name, 'type': node.bl_idname, 'properties': _z_properties(node),
                      'inputs': [(s.identifier, _z_value(s.default_value)) for s in node.inputs if hasattr(s, 'default_value')],
                      'group': _z_graph(getattr(node, 'node_tree', None), seen)})
    return {'nodes': nodes, 'interface': [_z_properties(item) for item in tree.interface.items_tree],
            'links': [(l.from_node.name, l.from_socket.identifier, l.to_node.name, l.to_socket.identifier) for l in tree.links]}

def _z_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True).encode()).hexdigest()

def _z_custom(block):
    try: return {k: _z_value(block[k]) for k in block.keys()}
    except TypeError: return {}

def _z_state(objects):
    bpy.context.view_layer.update()
    if sum(len(o.data.vertices) for o in objects if o.type == 'MESH') > 2000000:
        raise ValueError('Snapshot vertex budget exceeded; restrict objects')
    rows = {}
    for obj in objects:
        row = {'type': obj.type, 'matrix': [round(v, 6) for r in obj.matrix_world for v in r],
               'dimensions': [round(v, 6) for v in obj.dimensions],
               'materials': [s.material.name if s.material else None for s in obj.material_slots],
               'modifiers': [{'name': m.name, 'settings': _z_properties(m),
                              'custom': _z_custom(m),
                              'node_hash': _z_hash(_z_graph(getattr(m, 'node_group', None)))} for m in obj.modifiers],
               'material_hashes': {s.material.name: _z_hash({'color': list(s.material.diffuse_color), 'graph': _z_graph(s.material.node_tree)}) for s in obj.material_slots if s.material},
               'collections': sorted(c.name for c in obj.users_collection),
               'hide_render': obj.hide_render, 'hide_viewport': obj.hide_viewport,
               'parent': obj.parent.name if obj.parent else None}
        if obj.type == 'MESH':
            mesh = obj.data
            if len(mesh.vertices) > 2000000: raise ValueError('Snapshot mesh budget exceeded: ' + obj.name)
            coords = array.array('f', [0.0]) * (len(mesh.vertices) * 3)
            mesh.vertices.foreach_get('co', coords)
            indices = array.array('i', [0]) * len(mesh.loops)
            mesh.loops.foreach_get('vertex_index', indices)
            sizes = array.array('i', [0]) * len(mesh.polygons)
            mesh.polygons.foreach_get('loop_total', sizes)
            row.update(vertices=len(mesh.vertices), polygons=len(mesh.polygons),
                       geometry_hash=hashlib.sha256(coords.tobytes()+indices.tobytes()+sizes.tobytes()).hexdigest())
        rows[obj.name] = row
    return {'scene': bpy.context.scene.name, 'file': bpy.data.filepath, 'objects': rows}

def _z_checkpoint_dir():
    # Test runner supplies an isolated root without touching user preferences.
    root = os.environ.get('ZAALIS_BLENDER_CHECKPOINT_DIR') or os.path.join(bpy.utils.user_resource('CONFIG'), 'zaalis-checkpoints')
    os.makedirs(root, exist_ok=True)
    return root

def _z_checkpoint_path(identifier):
    if not isinstance(identifier, str) or len(identifier) != 32 or any(c not in '0123456789abcdef' for c in identifier):
        raise ValueError('Invalid checkpoint id')
    return os.path.join(_z_checkpoint_dir(), identifier + '.blend')
`;

const AUDIT = String.raw`
objects = _z_objects()
profile = params.get('profile', 'general')
if profile not in ('general', 'game', 'print'): raise ValueError('Unknown audit profile')
budget = int(params.get('triangle_budget', 100000))
if budget < 1: raise ValueError('triangle_budget must be positive')
dg = bpy.context.evaluated_depsgraph_get()
rows, issues, total = [], [], 0
for obj in objects:
    if obj.type != 'MESH': continue
    evaluated, mesh = _z_mesh(obj, dg)
    try:
        if len(mesh.vertices) > 2000000: raise ValueError('Mesh budget exceeded: ' + obj.name)
        mesh.calc_loop_triangles()
        triangles = len(mesh.loop_triangles)
        total += triangles
        bm = bmesh.new()
        try:
            bm.from_mesh(mesh)
            boundary = sum(e.is_boundary for e in bm.edges)
            nonmanifold = sum(not e.is_manifold for e in bm.edges)
            loose = sum(not v.link_edges for v in bm.verts)
            degenerate = sum(f.calc_area() < 1e-12 for f in bm.faces)
        finally: bm.free()
        row = {'object': obj.name, 'triangles': triangles, 'vertices': len(mesh.vertices),
               'boundary_edges': boundary, 'non_manifold_edges': nonmanifold,
               'loose_vertices': loose, 'degenerate_faces': degenerate, 'uv_layers': len(mesh.uv_layers)}
        rows.append(row)
        def issue(code, severity, value, advice):
            issues.append({'object': obj.name, 'code': code, 'severity': severity, 'value': value, 'advice': advice})
        if triangles > budget: issue('triangle_budget', 'warning', triangles, 'Consider instances or a lower-detail variant; measure visual impact')
        if degenerate: issue('degenerate_faces', 'warning', degenerate, 'Inspect zero-area faces before cleanup')
        if loose: issue('loose_vertices', 'warning', loose, 'Inspect disconnected vertices')
        if nonmanifold: issue('non_manifold', 'error' if profile == 'print' else 'info', nonmanifold, 'Open surfaces can be intentional; a closed print mesh should be manifold')
        if profile == 'game' and not mesh.uv_layers: issue('missing_uv', 'warning', 0, 'Add UVs if the target material needs image textures')
        if any(abs(s-1) > 1e-5 for s in obj.scale): issue('unapplied_scale', 'info', list(obj.scale), 'Check modifier, rig and export requirements before applying scale')
        if obj.matrix_world.determinant() < 0: issue('mirrored_transform', 'warning', True, 'Check orientation and target importer handling')
        if any(slot.material is None for slot in obj.material_slots): issue('empty_material_slot', 'warning', True, 'Assign or remove unused empty slots')
    finally: evaluated.to_mesh_clear()
missing = []
for image in bpy.data.images:
    if image.source == 'FILE' and not image.packed_file and image.filepath:
        resolved = bpy.path.abspath(image.filepath, library=image.library)
        if not os.path.exists(resolved): missing.append({'image': image.name, 'path': resolved})
result = {'profile': profile, 'evaluated_meshes': rows, 'total_triangles': total,
          'issues': sorted(issues, key=lambda x: {'error': 0, 'warning': 1, 'info': 2}[x['severity']]),
          'missing_images': missing, 'modified': False,
          'limitations': 'Topology counts do not detect self-intersections or prove printability. UV overlap and normal consistency are not tested.'}
`;

const SNAPSHOT = String.raw`
name = params.get('name', '')
if not isinstance(name, str) or not name.strip() or len(name) > 100: raise ValueError('Snapshot name required (1-100 characters)')
store = bpy.app.driver_namespace.setdefault('_zaalis_snapshots', {})
if name in store and not params.get('replace', False): raise ValueError('Snapshot exists; choose a new name or set replace=true')
if len(store) >= 20 and name not in store: raise ValueError('20 snapshots maximum per session')
state = _z_state(_z_objects())
state['whole_scene'] = params.get('objects') is None
store[name] = state
result = {'name': name, 'snapshot': state, 'lifetime': 'Current Blender session; reloading a file may clear snapshots'}
`;

const COMPARE = String.raw`
baseline = bpy.app.driver_namespace.get('_zaalis_snapshots', {}).get(params.get('snapshot'))
if baseline is None: raise ValueError('Unknown snapshot; create scene_snapshot first')
names = None if baseline['whole_scene'] else [n for n in baseline['objects'] if n in bpy.context.scene.objects]
current = _z_state(_z_objects(names) if names else ([] if names == [] else _z_objects()))
before, after = baseline['objects'], current['objects']
if current['scene'] != baseline['scene']: raise ValueError('Snapshot belongs to another scene: ' + baseline['scene'])
changed = []
for name in sorted(set(before) & set(after)):
    fields = {key: {'before': before[name].get(key), 'after': after[name].get(key)} for key in set(before[name]) | set(after[name]) if before[name].get(key) != after[name].get(key)}
    if fields: changed.append({'object': name, 'fields': fields})
checks = []
for expected in params.get('expectations', []):
    name = expected['name']
    obj = bpy.context.scene.objects.get(name)
    tolerance = float(expected.get('tolerance', 0.001))
    if tolerance < 0 or not math.isfinite(tolerance): raise ValueError('Invalid tolerance')
    checks.append({'object': name, 'criterion': 'exists', 'passed': obj is not None})
    if obj is None: continue
    if 'dimensions' in expected:
        target = expected['dimensions']
        if len(target) != 3: raise ValueError('dimensions needs three numbers')
        checks.append({'object': name, 'criterion': 'dimensions', 'expected': target, 'actual': list(obj.dimensions), 'passed': all(abs(obj.dimensions[i]-target[i]) <= tolerance for i in range(3))})
    if 'material' in expected:
        checks.append({'object': name, 'criterion': 'material', 'passed': expected['material'] in [s.material.name for s in obj.material_slots if s.material]})
    if 'max_triangles' in expected:
        if obj.type != 'MESH': checks.append({'object': name, 'criterion': 'max_triangles', 'passed': False})
        else:
            ev, mesh = _z_mesh(obj, bpy.context.evaluated_depsgraph_get())
            try:
                mesh.calc_loop_triangles()
                checks.append({'object': name, 'criterion': 'max_triangles', 'actual': len(mesh.loop_triangles), 'passed': len(mesh.loop_triangles) <= expected['max_triangles']})
            finally: ev.to_mesh_clear()
result = {'snapshot': params['snapshot'], 'added': sorted(set(after)-set(before)), 'removed': sorted(set(before)-set(after)),
          'changed': changed, 'checks': checks, 'passed': all(c['passed'] for c in checks) if checks else None,
          'limitations': 'Checks base mesh coordinates/topology, transforms, material graphs, modifier RNA/settings and Geometry Nodes inputs. Does not compare animation curves, external texture pixels, all geometry attributes or aesthetic quality. Use render/screenshot too.'}
`;

const CHECKPOINT = String.raw`
action = params.get('action', 'list')
root = _z_checkpoint_dir()
if action == 'create':
    name = str(params.get('name', '')).strip()
    if not name or len(name) > 100: raise ValueError('Checkpoint name required (1-100 characters)')
    if bpy.context.mode != 'OBJECT': raise ValueError('Switch to Object mode before checkpoint')
    identifier = uuid.uuid4().hex
    path = _z_checkpoint_path(identifier)
    original = bpy.data.filepath
    status = bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, check_existing=False)
    if 'FINISHED' not in status: raise RuntimeError('Checkpoint save failed')
    info = {'id': identifier, 'name': name, 'created': time.time(), 'original': original, 'size_bytes': os.path.getsize(path)}
    with open(path + '.json', 'x', encoding='utf8') as handle: json.dump(info, handle)
    result = {**info, 'path': path, 'active_file': bpy.data.filepath}
elif action == 'list':
    rows = []
    for filename in os.listdir(root):
        if not filename.endswith('.blend.json'): continue
        try:
            with open(os.path.join(root, filename), encoding='utf8') as handle: info = json.load(handle)
            path = _z_checkpoint_path(info['id'])
            if os.path.isfile(path): rows.append(info)
        except (ValueError, KeyError, OSError): continue
    result = {'checkpoints': sorted(rows, key=lambda r: r['created'], reverse=True)[:100], 'directory': root}
elif action == 'restore':
    path = _z_checkpoint_path(params.get('id'))
    if not os.path.isfile(path): raise ValueError('Checkpoint not found')
    if params.get('restore') is not True: raise ValueError('restore=true is required; opening the checkpoint replaces the open scene')
    if bpy.data.is_dirty and not params.get('discard_changes', False): raise ValueError('Unsaved changes: create a checkpoint first or explicitly set discard_changes=true')
    status = bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, use_scripts=False)
    if 'FINISHED' not in status: raise RuntimeError('Restore failed')
    result = {'restored': params['id'], 'active_file': bpy.data.filepath, 'note': 'Restored copy is now active; use Save As to choose the project destination'}
else: raise ValueError('Unknown checkpoint action')
`;

const PERFORMANCE = String.raw`
objects = _z_objects()
dg = bpy.context.evaluated_depsgraph_get()
rows, total = [], 0
for obj in objects:
    if obj.type != 'MESH': continue
    started = time.perf_counter()
    ev, mesh = _z_mesh(obj, dg)
    try:
        mesh.calc_loop_triangles()
        tris = len(mesh.loop_triangles)
        total += tris
        rows.append({'object': obj.name, 'triangles': tris, 'base_vertices': len(obj.data.vertices),
                     'evaluated_vertices': len(mesh.vertices), 'mesh_users': obj.data.users,
                     'evaluation_read_ms': round((time.perf_counter()-started)*1000, 3),
                     'modifiers': [{'name': m.name, 'type': m.type, 'execution_time_ms': round(getattr(m, 'execution_time', 0)*1000, 3)} for m in obj.modifiers]})
    finally: ev.to_mesh_clear()
textures = [{'image': im.name, 'dimensions': list(im.size), 'channels': im.channels,
             'estimated_uncompressed_bytes': im.size[0]*im.size[1]*im.channels*(4 if im.is_float else 1)} for im in bpy.data.images if im.source != 'VIEWER']
result = {'total_triangles': total, 'objects': sorted(rows, key=lambda r: -r['triangles']),
          'textures': sorted(textures, key=lambda r: -r['estimated_uncompressed_bytes']),
          'estimated_texture_bytes': sum(r['estimated_uncompressed_bytes'] for r in textures),
          'recommendations': ['Use linked meshes/instances for repeated assets', 'Inspect highest triangle counts and modifier expansion before decimation', 'Match texture resolution to visible detail'],
          'limitations': 'Memory is an estimate excluding mipmaps/compression/driver overhead. Timings read cached evaluated meshes; they are not FPS or a cold evaluation benchmark.'}
`;

const PLACE = String.raw`
objects = _z_objects()
_z_editable(objects)
action = params.get('action')
axis = params.get('axis', 'X')
if axis not in ('X', 'Y', 'Z'): raise ValueError('axis must be X, Y or Z')
index = 'XYZ'.index(axis)
bpy.context.view_layer.update()
planned = []
if action == 'align':
    value = float(params.get('value', 0))
    if not math.isfinite(value): raise ValueError('Invalid value')
    for obj in objects:
        matrix = obj.matrix_world.copy()
        matrix.translation[index] = value
        planned.append((obj, matrix))
elif action == 'distribute':
    gap = float(params.get('gap', 0))
    cursor = float(params.get('value', 0))
    if not math.isfinite(gap) or not math.isfinite(cursor) or gap < 0: raise ValueError('Finite nonnegative gap required')
    # Input order defines order. World bounding boxes give edge-to-edge gaps.
    for obj in objects:
        low, high = _z_bounds(obj)
        matrix = obj.matrix_world.copy()
        matrix.translation[index] += cursor-low[index]
        planned.append((obj, matrix))
        cursor += high[index]-low[index]+gap
elif action == 'drop':
    from mathutils.bvhtree import BVHTree
    target = bpy.context.scene.objects.get(params.get('surface', ''))
    if target is None or target.type != 'MESH' or target in objects: raise ValueError('Provide a separate mesh surface')
    offset = float(params.get('gap', 0))
    if not math.isfinite(offset) or offset < 0: raise ValueError('Nonnegative offset required')
    ev, mesh = _z_mesh(target, bpy.context.evaluated_depsgraph_get())
    try:
        verts = [ev.matrix_world @ v.co for v in mesh.vertices]
        tree = BVHTree.FromPolygons(verts, [list(p.vertices) for p in mesh.polygons])
        top = max((v.z for v in verts), default=0)
        for obj in objects:
            low, high = _z_bounds(obj)
            # Samples the bounding-box centre and corners. This is a vertical
            # placement helper, not rigid-body settling or arbitrary packing.
            xs, ys = (low[0], (low[0]+high[0])/2, high[0]), (low[1], (low[1]+high[1])/2, high[1])
            heights = []
            for x in xs:
                for y in ys:
                    hit = tree.ray_cast(Vector((x, y, max(top, high[2])+1)), Vector((0,0,-1)))
                    if hit[0] is not None: heights.append(hit[0].z)
            if not heights: raise ValueError('No surface under ' + obj.name)
            matrix = obj.matrix_world.copy()
            matrix.translation.z += max(heights)-low[2]+offset
            planned.append((obj, matrix))
    finally: ev.to_mesh_clear()
else: raise ValueError('action must be align, distribute or drop')
if params.get('apply', False):
    # Parent first so selected children receive their requested world matrix.
    def depth(obj):
        count = 0
        while obj.parent: count += 1; obj = obj.parent
        return count
    ordered = sorted(planned, key=lambda pair: depth(pair[0]))
    original = {obj.name: obj.matrix_world.copy() for obj, _ in ordered}
    try:
        for obj, matrix in ordered:
            obj.matrix_world = matrix
            bpy.context.view_layer.update()
        if any(abs(obj.matrix_world[i][j]-matrix[i][j]) > 1e-4 for obj, matrix in ordered for i in range(4) for j in range(4)):
            raise ValueError('Constraints or drivers prevent the requested placement; transforms restored')
    except Exception:
        for obj, _ in ordered:
            obj.matrix_world = original[obj.name]
            bpy.context.view_layer.update()
        raise
result = {'applied': bool(params.get('apply', False)), 'action': action,
          'placements': [{'object': obj.name, 'world_location': list(matrix.translation)} for obj, matrix in planned]}
`;

const COLLISIONS = String.raw`
from mathutils.bvhtree import BVHTree
objects = [o for o in _z_objects(limit=100) if o.type == 'MESH']
dg = bpy.context.evaluated_depsgraph_get()
trees, bounds = {}, {}
polygon_total = 0
for obj in objects:
    ev, mesh = _z_mesh(obj, dg)
    try:
        if len(mesh.polygons) > 500000: raise ValueError('Collision mesh budget exceeded: ' + obj.name)
        polygon_total += len(mesh.polygons)
        if polygon_total > 2000000: raise ValueError('Collision polygon budget exceeded; restrict objects')
        verts = [ev.matrix_world @ v.co for v in mesh.vertices]
        if not verts: continue
        bounds[obj.name] = ([min(v[i] for v in verts) for i in range(3)], [max(v[i] for v in verts) for i in range(3)])
        trees[obj.name] = BVHTree.FromPolygons(verts, [list(p.vertices) for p in mesh.polygons])
    finally: ev.to_mesh_clear()
pairs = []
for i, obj in enumerate(objects):
    if obj.name not in trees: continue
    for other in objects[i+1:]:
        if other.name not in trees: continue
        a, b = bounds[obj.name], bounds[other.name]
        if not all(a[0][k] <= b[1][k] and b[0][k] <= a[1][k] for k in range(3)): continue
        overlap = trees[obj.name].overlap(trees[other.name])
        pairs.append({'objects': [obj.name, other.name], 'bounding_boxes_overlap': True,
                      'surface_intersection': bool(overlap), 'intersecting_face_pairs': len(overlap)})
result = {'pairs': pairs, 'mesh_count': len(trees),
          'limitations': 'Surface intersections only. Full containment without surface contact is not detected; overlapping bounds alone are not a collision.'}
`;

const EXPORT = String.raw`
objects = _z_objects()
meshes = [o for o in objects if o.type == 'MESH']
profile = params.get('profile', 'gltf')
profiles = {'gltf': {'format': 'glb', 'axis': 'Y up (exporter conversion)'},
            'roblox': {'format': 'fbx', 'axis': '-Z forward, Y up; verify Studio import units'},
            'unreal': {'format': 'fbx', 'axis': '-Y forward, Z up; verify importer units'}}
if profile not in profiles: raise ValueError('Unknown export profile')
issues = []
if not meshes: issues.append({'severity': 'error', 'code': 'no_meshes'})
for obj in objects:
    if obj.type not in ('MESH', 'EMPTY', 'ARMATURE'): issues.append({'object': obj.name, 'severity': 'error', 'code': 'unsupported_object_type'})
    if obj.type == 'MESH' and not obj.data.uv_layers: issues.append({'object': obj.name, 'severity': 'warning', 'code': 'missing_uv'})
    if obj.type == 'MESH' and not obj.data.polygons: issues.append({'object': obj.name, 'severity': 'error', 'code': 'empty_mesh'})
    if any(abs(s-1)>1e-5 for s in obj.scale): issues.append({'object': obj.name, 'severity': 'warning', 'code': 'unapplied_scale'})
    if obj.parent and obj.parent not in objects: issues.append({'object': obj.name, 'severity': 'warning', 'code': 'parent_not_exported'})
for obj in meshes:
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.node_tree: continue
        for node in mat.node_tree.nodes:
            image = getattr(node, 'image', None)
            if image and image.source == 'FILE' and not image.packed_file and not os.path.exists(bpy.path.abspath(image.filepath, library=image.library)):
                issues.append({'object': obj.name, 'severity': 'error', 'code': 'missing_texture', 'image': image.name})
result = {'profile': profile, 'settings': profiles[profile], 'objects': [o.name for o in objects], 'issues': issues,
          'scene_unit_scale': bpy.context.scene.unit_settings.scale_length, 'exported': False,
          'limitations': 'Export preset is a starting point, not target-engine certification. Procedural shaders need baking; rig and animation compatibility require target import testing.'}
if params.get('export', False):
    if any(i['severity'] == 'error' for i in issues): raise ValueError('Export blocked: ' + json.dumps(issues))
    _z_editable(objects)
    if any(o.name not in bpy.context.view_layer.objects or not o.visible_get() or o.hide_select for o in objects): raise ValueError('Export objects must be visible and selectable in the active view layer')
    path = params.get('path', '')
    extension = '.glb' if profile == 'gltf' else '.fbx'
    if not os.path.isabs(path) or not path.lower().endswith(extension): raise ValueError('Absolute ' + extension + ' path required')
    if os.path.exists(path): raise ValueError('Destination already exists; choose a new filename')
    if not os.path.isdir(os.path.dirname(path)): raise ValueError('Destination directory does not exist')
    selected = list(bpy.context.selected_objects)
    active = bpy.context.view_layer.objects.active
    try:
        for obj in selected: obj.select_set(False)
        for obj in objects: obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if profile == 'gltf': status = bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_animations=False)
        else:
            status = bpy.ops.export_scene.fbx(filepath=path, use_selection=True, object_types={'MESH','EMPTY','ARMATURE'},
                        axis_forward='-Z' if profile == 'roblox' else '-Y', axis_up='Y' if profile == 'roblox' else 'Z',
                        apply_unit_scale=True, add_leaf_bones=False, bake_anim=False, path_mode='COPY', embed_textures=True)
        if 'FINISHED' not in status or not os.path.isfile(path): raise RuntimeError('Exporter did not produce a file')
    finally:
        for obj in objects: obj.select_set(False)
        for obj in selected: obj.select_set(True)
        bpy.context.view_layer.objects.active = active
    result.update(exported=True, path=path, size_bytes=os.path.getsize(path))
`;

const MATERIAL = String.raw`
objects = _z_objects()
_z_editable(objects)
if any(o.type != 'MESH' or not o.data.is_editable for o in objects): raise ValueError('Editable mesh objects required')
name = str(params.get('name', '')).strip()
if not name or name in bpy.data.materials: raise ValueError('Provide a new material name')
color = params.get('color', [0.5,0.5,0.5,1])
if len(color) != 4 or any(not math.isfinite(float(v)) or not 0 <= v <= 1 for v in color): raise ValueError('color must contain four values in [0,1] (linear RGBA)')
roughness, metallic = float(params.get('roughness', 0.5)), float(params.get('metallic', 0))
if any(not math.isfinite(v) or not 0 <= v <= 1 for v in (roughness, metallic)): raise ValueError('roughness and metallic must be in [0,1]')
material = bpy.data.materials.new(name)
try:
    material.use_nodes = True
    shader = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = color
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    material.diffuse_color = color
    for obj in objects:
        # Copy shared mesh data so non-target objects never acquire this slot.
        if obj.data.users > 1: obj.data = obj.data.copy()
        obj.data.materials.append(material)
        slot = len(obj.data.materials)-1
        for polygon in obj.data.polygons: polygon.material_index = slot
finally:
    if material.users == 0: bpy.data.materials.remove(material)
result = {'material': name, 'objects': [o.name for o in objects], 'shader': 'Principled BSDF',
          'controls': {'color': color, 'roughness': roughness, 'metallic': metallic}}
`;

const NODES = String.raw`
objects = _z_objects()
_z_editable(objects)
if any(o.type != 'MESH' for o in objects): raise ValueError('Mesh objects required')
name = str(params.get('name', '')).strip()
if not name or name in bpy.data.node_groups: raise ValueError('Provide a new node group name')
count = int(params.get('count', 5))
spacing = params.get('spacing', [2,0,0])
if not 1 <= count <= 10000 or len(spacing) != 3 or any(not math.isfinite(float(v)) for v in spacing): raise ValueError('Count must be 1-10000; spacing needs three finite numbers')
group = bpy.data.node_groups.new(name, 'GeometryNodeTree')
group['_zaalis_template'] = 'linear_repeat_v1'
created = []
try:
    group.interface.new_socket(name='Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    group.interface.new_socket(name='Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    socket = group.interface.new_socket(name='Count', in_out='INPUT', socket_type='NodeSocketInt')
    socket.default_value, socket.min_value, socket.max_value = count, 1, 10000
    socket = group.interface.new_socket(name='Spacing', in_out='INPUT', socket_type='NodeSocketVector')
    socket.default_value = spacing
    nodes, links = group.nodes, group.links
    inputs, output = nodes.new('NodeGroupInput'), nodes.new('NodeGroupOutput')
    line = nodes.new('GeometryNodeMeshLine')
    line.mode = 'OFFSET'
    instance = nodes.new('GeometryNodeInstanceOnPoints')
    realize = nodes.new('GeometryNodeRealizeInstances')
    links.new(inputs.outputs['Count'], line.inputs['Count'])
    links.new(inputs.outputs['Spacing'], line.inputs['Offset'])
    links.new(line.outputs['Mesh'], instance.inputs['Points'])
    links.new(inputs.outputs['Geometry'], instance.inputs['Instance'])
    links.new(instance.outputs['Instances'], realize.inputs['Geometry'])
    links.new(realize.outputs['Geometry'], output.inputs['Geometry'])
    for i, node in enumerate((inputs, line, instance, realize, output)): node.location = (i*220, 0)
    for obj in objects:
        modifier = obj.modifiers.new(name, 'NODES')
        created.append((obj, modifier))
        modifier.node_group = group
except Exception:
    for obj, modifier in created: obj.modifiers.remove(modifier)
    bpy.data.node_groups.remove(group)
    raise
result = {'node_group': name, 'objects': [o.name for o in objects], 'template': 'linear_repeat',
          'controls': {'Count': count, 'Spacing': spacing}, 'nodes': len(group.nodes), 'links': len(group.links)}
`;

const UPDATE_NODES = String.raw`
objects = _z_objects()
_z_editable(objects)
values = {}
if 'count' in params: values['Count'] = params['count']
if 'spacing' in params: values['Spacing'] = params['spacing']
if not values: raise ValueError('Provide count or spacing')
targets = []
for obj in objects:
    modifier = obj.modifiers.get(params['modifier'])
    if modifier is None or modifier.type != 'NODES' or modifier.node_group is None or modifier.node_group.get('_zaalis_template') != 'linear_repeat_v1':
        raise ValueError('Named Zaalis linear repeat modifier not found on ' + obj.name)
    sockets = {i.name: i.identifier for i in modifier.node_group.interface.items_tree if i.item_type == 'SOCKET' and i.in_out == 'INPUT'}
    if any(name not in sockets for name in values): raise ValueError('Repeat interface has been changed')
    for name in values:
        identifier = sockets[name]
        if hasattr(modifier, 'properties'):
            socket = getattr(modifier.properties.inputs, identifier)
            if not hasattr(socket, 'value'): raise ValueError('Unsupported socket API')
            targets.append((obj, socket, 'value', values[name]))
        else: targets.append((obj, modifier, identifier, values[name]))
for obj, target, key, value in targets:
    if key == 'value': target.value = value
    else: target[key] = value
    obj.update_tag()
bpy.context.view_layer.update()
result = {'objects': [o.name for o in objects], 'modifier': params['modifier'], 'controls': values}
`;

const schema = (properties, required = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
const str = { type: 'string', minLength: 1 };
const bool = { type: 'boolean' };
const number = { type: 'number' };
const vector = { type: 'array', items: number, minItems: 3, maxItems: 3 };
const objects = { type: 'array', items: str, minItems: 1, maxItems: 500, uniqueItems: true };
const tool = (name, description, code, properties, required = [], mutates = false) => ({ name, description, code: COMMON + code, inputSchema: schema(properties, required), mutates });

const TOOLS = [
  tool('scene_audit', 'Diagnostic mesuré des maillages évalués : triangles, topologie, UV, échelle et images manquantes. Profils general/game/print. Lecture seule ; les surfaces ouvertes peuvent être voulues.', AUDIT,
    { objects, profile: { enum: ['general', 'game', 'print'], type: 'string' }, triangle_budget: { type: 'integer', minimum: 1 } }),
  tool('scene_snapshot', 'Mémorise un état nommé en session : géométrie de base, transformations, dimensions, graphes de matériaux, modificateurs et Geometry Nodes. Lecture seule. 20 états maximum ; ne remplace pas une sauvegarde.', SNAPSHOT,
    { objects, name: str, replace: bool }, ['name']),
  tool('verify_changes', 'Compare la scène à un scene_snapshot : géométrie, graphes de matériaux, modificateurs, transformations. Vérifie dimensions, matériau ou budget triangles attendus. La qualité esthétique exige aussi screenshot/render.', COMPARE,
    { snapshot: str, expectations: { type: 'array', maxItems: 500, items: schema({ name: str, dimensions: vector, material: str, max_triangles: { type: 'integer', minimum: 0 }, tolerance: { type: 'number', minimum: 0 } }, ['name']) } }, ['snapshot']),
  tool('checkpoint', 'Crée/liste/restaure des copies .blend nommées persistantes. create sauvegarde une copie sans changer le fichier actif. restore requiert restore=true et discard_changes=true si modifications non sauvées ; la copie restaurée devient le fichier actif.', CHECKPOINT,
    { action: { type: 'string', enum: ['create', 'list', 'restore'] }, name: str, id: str, restore: bool, discard_changes: bool }),
  tool('performance_report', 'Classe les objets par triangles évalués et les textures par estimation mémoire ; montre expansion des modificateurs et temps de lecture. Ne mesure ni FPS ni gain de performance garanti.', PERFORMANCE, { objects }),
  tool('place_objects', 'Prévisualise (apply=false par défaut) ou applique alignement des origines, distribution avec espacement des boîtes monde, ou dépose verticale sur surface avec 9 rayons. Ordre donné conservé ; pas une simulation physique.', PLACE,
    { objects, action: { type: 'string', enum: ['align', 'distribute', 'drop'] }, axis: { type: 'string', enum: ['X', 'Y', 'Z'] }, value: number, gap: { type: 'number', minimum: 0 }, surface: str, apply: bool }, ['objects', 'action'], true),
  tool('detect_intersections', 'Détecte les intersections des surfaces évaluées via BVH en coordonnées monde. Lecture seule, 100 objets maximum ; ne détecte pas le confinement complet sans contact de surface.', COLLISIONS,
    { objects: { ...objects, maxItems: 100 } }),
  tool('export_asset', 'Analyse puis, uniquement avec export=true, exporte la sélection explicite : GLB ou FBX Roblox/Unreal. Refuse les fichiers existants, restaure la sélection. Sans animation. Les profils exigent une validation dans le moteur cible.', EXPORT,
    { objects, profile: { type: 'string', enum: ['gltf', 'roblox', 'unreal'] }, export: bool, path: str }, ['objects']),
  tool('create_pbr_material', 'Crée un matériau Principled BSDF réglable (RGBA linéaire, rugosité, métal) et l’assigne aux faces des maillages explicites. Conserve les anciens matériaux et isole les maillages partagés.', MATERIAL,
    { objects, name: str, color: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: 4, maxItems: 4 }, roughness: { type: 'number', minimum: 0, maximum: 1 }, metallic: { type: 'number', minimum: 0, maximum: 1 } }, ['objects', 'name'], true),
  tool('create_geometry_repeat', 'Construit un vrai groupe Geometry Nodes de répétition linéaire, appliqué aux maillages explicites. Count et Spacing restent réglables dans le modificateur. Crée un groupe neuf, sans écraser l’existant.', NODES,
    { objects, name: str, count: { type: 'integer', minimum: 1, maximum: 10000 }, spacing: vector }, ['objects', 'name'], true),
  tool('update_geometry_repeat', 'Modifie Count et/ou Spacing sur des modificateurs de répétition créés par Zaalis, sans changer les autres objets utilisant le groupe. Compatible avec les API Geometry Nodes de Blender 5.2 et 5.3.', UPDATE_NODES,
    { objects, modifier: str, count: { type: 'integer', minimum: 1, maximum: 10000 }, spacing: vector }, ['objects', 'modifier'], true),
];

module.exports = { TOOLS };
