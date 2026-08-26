#!/usr/bin/env python3.13
"""Programmatically author the real componentTree/materials/repetitionSystems for the
NVIDIA Jetson AGX Xavier SoM sculpt spec, merged onto the scaffold produced by
new_sculpt_spec.py. Run with python3.13 (stdlib only)."""
import json
from pathlib import Path

SPEC_PATH = Path("/Users/alonlinder/jetson-xavier-3d/object-sculpt-spec.json")
spec = json.loads(SPEC_PATH.read_text())

# ---------------------------------------------------------------------------
# Board footprint (relative units). Board measured wider on the connector edge,
# taller along the standoff axis, per images 8/9/10/11. Thickness INFERRED (no
# edge/profile reference exists) as a thin multilayer-PCB slab -- flagged.
BOARD_W = 1.0     # X
BOARD_H = 1.36    # Y (taller, portrait)
BOARD_T = 0.045   # Z thickness -- INFERRED, not measured

def box(w, h, d):
    return {"width": w, "height": h, "depth": d, "units": "relative", "confidence": 0.55}

def xform(pos, rot=(0, 0, 0), scale=(1, 1, 1)):
    return {"position": list(pos), "rotation": list(rot), "scale": list(scale)}

def action_profile(role, pivot=(0, 0, 0), collider_scale=(1, 1, 1), breakable=False, fracture_group="root"):
    return {
        "animationRole": role,
        "pivot": {"mode": "center", "localPosition": list(pivot), "axis": [0, 1, 0], "confidence": 0.6},
        "transformChannels": {
            "translate": True, "rotate": True, "scale": True,
            "bend": False, "twist": False, "detach": True,
            "visibility": True, "materialState": True,
        },
        "sockets": [],
        "collider": {"type": "box", "offset": [0, 0, 0], "scale": list(collider_scale), "isTrigger": False,
                      "notes": "Simplified box proxy for runtime physics/hit-testing; not the visual mesh."},
        "constraints": [],
        "destruction": {
            "breakable": breakable, "fractureGroup": fracture_group, "seamRefs": [],
            "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base",
        },
    }

def component(id_, name, level, role, primitive, dims, pos, material, parent,
              topology_class="assembled-solid", topology_rationale="Discrete rigid molded/plated part with flat or simply-curved faces.",
              importance=0.6, confidence=0.7, action_role="static-part", local_features=None,
              material_layers=None, evidence_refs=("full-object",), rot=(0, 0, 0), scale=(1, 1, 1),
              attachment=None, fidelity_tier="structural"):
    return {
        "id": id_, "name": name, "level": level, "role": role, "importance": importance,
        "confidence": confidence, "primitive": primitive, "topologyClass": topology_class,
        "topologyRationale": topology_rationale,
        "geometryDescriptor": {
            "topologyIntent": "hard-surface blockout with bevel-ready edges",
            "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2},
            "deformationStack": [], "uvStrategy": "generated procedural coordinates",
            "normalStrategy": "vertex normals from generated geometry",
        },
        "parent": parent, "attachment": attachment,
        "dimensions": box(*dims),
        "transform": xform(pos, rot, scale),
        "actionProfile": action_profile(action_role, pivot=(0, 0, 0)),
        "material": material, "materialLayers": material_layers or [material],
        "deformations": [], "joints": [], "seams": [],
        "localFeatures": local_features or [],
        "surfaceDetail": {
            "macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0,
            "normalPattern": "", "displacementPattern": "", "occlusionPattern": "",
            "edgeWearPattern": "", "notes": "",
        },
        "evidenceRefs": list(evidence_refs), "details": [], "fidelityTier": fidelity_tier,
    }

components = []

# --- ROOT: board substrate slab -------------------------------------------------
components.append(component(
    "root", "NVIDIA Jetson AGX Xavier SoM", "macro", "body", "box",
    (BOARD_W, BOARD_H, BOARD_T), (0, 0, 0), "board-solder-mask", None,
    topology_rationale="Rigid multilayer PCB -- flat panel with simply-curved edge chamfer; genuinely box-shaped.",
    importance=1.0, confidence=0.6, action_role="root",
    local_features=[
        {"id": "board-thickness-inferred", "kind": "geometry-caveat",
         "description": "No true edge/profile reference image exists; thickness (0.045 rel) is INFERRED from typical rigid multilayer-PCB SoM proportions, not measured.",
         "evidenceRef": "full-object"},
    ],
))

# --- Macro group: SoC package ---------------------------------------------------
components.append(component(
    "soc-package", "SoC Die Package", "macro", "electronic-package", "box",
    (0.34, 0.30, 0.028), (0.0, 0.03, BOARD_T / 2 + 0.014), "soc-substrate", "root",
    topology_rationale="Flip-chip BGA package: flat rigid footprint with a raised overmold lid -- genuinely box-shaped.",
    importance=0.95, confidence=0.75, action_role="highlightable-component",
))
components.append(component(
    "soc-substrate-patch", "SoC Substrate Patch", "meso", "electronic-package-face", "box",
    (0.30, 0.26, 0.004), (0.0, 0.0, 0.016), "soc-substrate", "soc-package",
    topology_rationale="Thin flat exposed substrate ring around the overmold lid.",
    importance=0.5, confidence=0.7,
    local_features=[
        {"id": "soc-lid-fiducial-dots", "kind": "micro-feature",
         "description": "Small dot fiducials near two diagonal corners of the substrate patch (observed in 8.png/11.png).",
         "evidenceRef": "full-object"},
    ],
))
components.append(component(
    "soc-overmold-lid", "SoC Overmold Marking Block", "meso", "electronic-package-face", "box",
    (0.22, 0.16, 0.006), (0.0, -0.01, 0.02), "ic-overmold-dark", "soc-package",
    topology_rationale="Flat raised plaque on the package face; no text baked per requirement.",
    importance=0.55, confidence=0.75,
))

# --- Macro group: VRM bank (8 inductors + 16 caps) -------------------------------
components.append(component(
    "vrm-bank", "VRM Power Stage", "macro", "electronic-assembly", "box",
    (BOARD_W - 0.06, 0.30, 0.006), (0.0, BOARD_H / 2 - 0.20, BOARD_T / 2 + 0.003), "board-solder-mask", "root",
    topology_rationale="Thin backing/pivot plate for the VRM inductor+capacitor bank; genuinely box-shaped.",
    importance=0.85, confidence=0.7, action_role="highlightable-component",
))
N_IND = 8
ind_span = BOARD_W - 0.10
for i in range(N_IND):
    x = -ind_span / 2 + ind_span * (i + 0.5) / N_IND
    components.append(component(
        f"vrm-inductor-{i+1}", f"VRM Inductor {i+1}", "meso", "passive-component", "box",
        (ind_span / N_IND * 0.82, 0.11, 0.045), (x, 0.07, 0.0225), "vrm-inductor-body", "vrm-bank",
        topology_rationale="Molded rounded-rectangular inductor block -- assembled-solid.",
        importance=0.5, confidence=0.75,
        local_features=[{"id": f"vrm-inductor-{i+1}-top-marking", "kind": "material-local-override",
                          "description": "Darker top-marking region on the molded body (no text baked).",
                          "evidenceRef": "full-object"}] if i == 0 else [],
    ))
N_CAP_COLS = 8
N_CAP_ROWS = 2
cap_span = BOARD_W - 0.10
for r in range(N_CAP_ROWS):
    for c in range(N_CAP_COLS):
        idx = r * N_CAP_COLS + c + 1
        x = -cap_span / 2 + cap_span * (c + 0.5) / N_CAP_COLS
        y = -0.02 - r * 0.055
        components.append(component(
            f"vrm-cap-{idx}", f"VRM Capacitor {idx}", "meso", "passive-component", "box",
            (cap_span / N_CAP_COLS * 0.78, 0.045, 0.03), (x, y, 0.015), "vrm-cap-body", "vrm-bank",
            topology_rationale="Molded polymer capacitor block -- assembled-solid.",
            importance=0.4, confidence=0.75,
        ))

# --- Macro group: memory / PMIC cluster -----------------------------------------
components.append(component(
    "memory-pmic-cluster", "Memory / PMIC Package Cluster", "macro", "electronic-assembly", "box",
    (BOARD_W - 0.06, 0.55, 0.006), (0.0, -0.05, BOARD_T / 2 + 0.003), "board-solder-mask", "root",
    topology_rationale="Thin backing/pivot plate for the flanking memory/PMIC IC packages.",
    importance=0.75, confidence=0.65, action_role="highlightable-component",
))
mem_positions = [
    ("left-1", (-0.42, 0.18)), ("left-2", (-0.42, 0.02)), ("left-3", (-0.42, -0.14)),
    ("right-1", (0.42, 0.14)), ("right-2", (0.42, -0.02)),
    ("bottom-1", (-0.27, -0.34)), ("bottom-2", (-0.09, -0.34)),
    ("bottom-3", (0.09, -0.34)), ("bottom-4", (0.27, -0.34)),
]
for tag, (x, y) in mem_positions:
    components.append(component(
        f"memory-pmic-{tag}", f"Memory/PMIC Package ({tag})", "micro", "electronic-package", "box",
        (0.15, 0.11, 0.02), (x, y, 0.01), "ic-overmold-dark", "memory-pmic-cluster",
        topology_rationale="Small molded IC package -- assembled-solid.",
        importance=0.45, confidence=0.65,
    ))

# --- Macro group: edge connector -------------------------------------------------
components.append(component(
    "edge-connector", "Card-Edge Mezzanine Connector", "macro", "electronic-connector", "box",
    (0.62, 0.14, 0.05), (0.0, BOARD_H / 2 - 0.16, -(BOARD_T / 2 + 0.025)), "connector-housing", "root",
    topology_rationale="Rigid molded connector housing protruding from the board back face -- assembled-solid.",
    importance=0.9, confidence=0.7, action_role="highlightable-component",
    rot=(0, 0, 0),
))
N_ROWS = 8
row_span = 0.11
for i in range(N_ROWS):
    y = -row_span / 2 + row_span * (i + 0.5) / N_ROWS
    components.append(component(
        f"edge-connector-contact-row-{i+1}", f"Connector Contact Row {i+1}", "meso", "electronic-contact", "box",
        (0.56, row_span / N_ROWS * 0.7, 0.01), (0.0, y, 0.03), "connector-gold-contact", "edge-connector",
        topology_rationale="Instanced-in-effect row of gold-plated contacts approximated as one ridge bar per row (exact per-pin count is foreshortened in the reference; see unknownsToResolveBeforeImplementation).",
        importance=0.45, confidence=0.55,
    ))

# --- Macro group: mounting standoffs --------------------------------------------
components.append(component(
    "mounting-standoffs", "Mounting Standoffs", "macro", "electronic-hardware", "box",
    (0.02, 0.02, 0.001), (0.0, 0.0, BOARD_T / 2 + 0.0005), "board-solder-mask", "root",
    topology_rationale="Near-zero-footprint organizational pivot for the 4 standoff bosses (each standoff is independently placed).",
    importance=0.8, confidence=0.6, action_role="highlightable-component",
))
standoff_positions = [(-0.28, 0.10), (0.28, 0.10), (-0.28, -0.22), (0.28, -0.22)]
for i, (x, y) in enumerate(standoff_positions):
    components.append(component(
        f"mounting-standoff-{i+1}", f"Mounting Standoff {i+1}", "meso", "electronic-hardware", "cylinder",
        (0.16, 0.16, 0.02), (x, y, -(BOARD_T / 2 + 0.01)), "standoff-copper-ring", "mounting-standoffs",
        topology_rationale="Raised cylindrical boss with a concentric copper ring pad and through-hole -- assembled-solid.",
        importance=0.55, confidence=0.75,
        local_features=[{"id": f"mounting-standoff-{i+1}-through-hole", "kind": "geometry",
                          "description": "Central through-hole from back face to front face.",
                          "evidenceRef": "full-object"}],
    ))

# --- Edge heatspreader (perimeter copper band) ----------------------------------
components.append(component(
    "edge-heatspreader", "Copper Edge Heatspreader Band", "meso", "structural-frame", "box",
    (BOARD_W, BOARD_H, BOARD_T * 0.6), (0, 0, 0), "copper-edge", "root",
    topology_rationale="Thin perimeter frame band flush with the board edge; approximated as a slightly larger box behind the solder-mask slab so only the border shows (frame extrude would be more accurate but this stays within the triangle budget).",
    importance=0.5, confidence=0.55,
    local_features=[
        {"id": "perimeter-through-hole-pattern", "kind": "material-local-override",
         "description": "Ring of small through-holes/vias around the full perimeter is represented as a normal/AO local override on copper-edge material rather than modeled geometry (surface-relief tier per surface_topology.md -- does not affect silhouette).",
         "evidenceRef": "full-object"},
    ],
))

spec["componentTree"] = components

# ---------------------------------------------------------------------------
# Materials
def material(id_, name, base_color, secondary, metalness, roughness, notes, resolution=1024):
    return {
        "id": id_, "name": name, "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation",
        "baseColor": base_color, "color": base_color,
        "albedo": {"dominant": base_color, "secondary": secondary,
                   "samplingNotes": "Image-observed local color zone; not a single averaged color."},
        "colorVariation": {"palette": [base_color] + secondary, "pattern": "mottled", "amplitude": 0.12, "heightCorrelation": 0.25},
        "textureResolution": resolution,
        "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8,
                               "texelDensityIntent": "Stable object-scale detail; no stretching across instances."},
        "surfaceFrequencyBands": [
            {"id": "macro", "frequency": 1.5, "amplitude": 0.3, "role": "broad color/height breakup"},
            {"id": "meso", "frequency": 10.0, "amplitude": 0.18, "role": "molding seams, pad edges, ridge relief"},
            {"id": "micro", "frequency": 48.0, "amplitude": 0.06, "role": "grazing-light highlight breakup"},
        ],
        "roughness": {"base": roughness, "variation": 0.08, "map": "independent-procedural-field",
                       "localResponse": "higher roughness in cavities/seams, lower on plated/polished edges"},
        "metalness": {"base": metalness, "variation": 0.05},
        "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.3, "scale": 20.0, "space": "tangent"},
        "bump": {"pattern": "molding-seam" if metalness < 0.3 else "none", "amplitude": 0.05 if metalness < 0.3 else 0.0, "scale": 6.0},
        "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": False},
        "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.3, "notes": "Darken package/board seams and connector housing cavity."},
        "wear": {"edgeWear": 0.05, "scratches": [], "chips": []},
        "dirt": {"amount": 0.05, "cavityBias": 0.2, "color": "#2A241C"},
        "localOverrides": [],
        "shaderNotes": [
            "MeshStandardMaterial with independent albedo/roughness/normal/AO channels; albedo never aliased into roughness.",
            "No baked text/logo textures per explicit requirement -- identity carried by named Object3D hierarchy only.",
        ],
        "notes": notes,
    }

materials = [
    material("board-solder-mask", "Board Solder Mask", "#141414", ["#0A0A0A", "#1E1E1E"], 0.0, 0.72,
             "Matte near-black dielectric solder mask, front and back faces (8,9,10,11.png)."),
    material("soc-substrate", "SoC Substrate Patch", "#1F6B6B", ["#144D4D", "#2E8A8A"], 0.0, 0.5,
             "Teal/cyan fine-stipple substrate patch surrounding the SoC overmold lid; stipple is procedural micro-relief, no text."),
    material("ic-overmold-dark", "IC Overmold (Dark)", "#232323", ["#1A1A1A", "#2E2E2E"], 0.0, 0.55,
             "Dark gray-black molded package body used for the SoC lid and all memory/PMIC packages; no marking text baked."),
    material("vrm-inductor-body", "VRM Inductor Body", "#B79B6B", ["#9C8256", "#C9AE82"], 0.0, 0.6,
             "Tan/beige molded ceramic-like inductor body (8x row, 'R22'-class in reference, text not baked)."),
    material("vrm-cap-body", "VRM Capacitor Body", "#26221E", ["#1C1916", "#322C26"], 0.0, 0.45,
             "Charcoal molded polymer capacitor body (2x8 bank, '330'-class in reference, text not baked)."),
    material("connector-housing", "Connector Insulator Housing", "#0D0D0D", ["#050505", "#161616"], 0.0, 0.8,
             "Black plastic insulator housing of the card-edge mezzanine connector (9,10.png)."),
    material("connector-gold-contact", "Connector Gold Contact", "#C9A227", ["#A9860F", "#E0BB4C"], 0.9, 0.25,
             "Gold-plated contact rows inside the connector housing; approximated as one ridge bar per row (~8 rows)."),
    material("standoff-copper-ring", "Standoff Copper Ring", "#B5651D", ["#8A4B14", "#D98A3D"], 0.85, 0.35,
             "Copper-plated concentric ring pad around each of the 4 mounting-standoff through-holes."),
    material("copper-edge", "Copper Edge Heatspreader", "#B5651D", ["#8A4B14", "#D98A3D"], 0.85, 0.35,
             "Copper-hued metallic perimeter band visible on both faces; carries the perimeter-through-hole normal/AO local override."),
]
spec["materials"] = materials

# ---------------------------------------------------------------------------
# repetitionSystems -- documented as "already built individually" (elementComponentIds)
# since the generator's InstancedMesh emitter is radial-only and these are linear/grid
# arrangements; recorded here so the quality contract's repetition-system requirement
# is satisfied by real evidence, not invented instancing that would misplace parts.
spec["repetitionSystems"] = [
    {
        "id": "vrm-inductor-row", "parent": "vrm-bank", "level": "meso",
        "count": N_IND, "primitive": "box", "material": "vrm-inductor-body",
        "instanceScale": [0.1, 0.11, 0.045],
        "placement": {"mode": "linear-row", "axis": [1, 0, 0], "radius": 0.0, "startAngleDeg": 0},
        "elementComponentIds": [f"vrm-inductor-{i+1}" for i in range(N_IND)],
        "notes": "Linear 1x8 row; built as individually-positioned componentTree entries (see elementComponentIds) because the generator's InstancedMesh path only supports radial placement, which would misshape a straight row.",
    },
    {
        "id": "vrm-cap-bank", "parent": "vrm-bank", "level": "meso",
        "count": N_CAP_COLS * N_CAP_ROWS, "primitive": "box", "material": "vrm-cap-body",
        "instanceScale": [0.09, 0.045, 0.03],
        "placement": {"mode": "linear-grid", "axis": [1, 0, 0], "radius": 0.0, "startAngleDeg": 0},
        "elementComponentIds": [f"vrm-cap-{i+1}" for i in range(N_CAP_COLS * N_CAP_ROWS)],
        "notes": "2x8 grid; built as individually-positioned componentTree entries for the same radial-only-generator reason as vrm-inductor-row.",
    },
    {
        "id": "edge-connector-contact-rows", "parent": "edge-connector", "level": "meso",
        "count": N_ROWS, "primitive": "box", "material": "connector-gold-contact",
        "instanceScale": [0.56, 0.012, 0.01],
        "placement": {"mode": "linear-row", "axis": [0, 1, 0], "radius": 0.0, "startAngleDeg": 0},
        "elementComponentIds": [f"edge-connector-contact-row-{i+1}" for i in range(N_ROWS)],
        "notes": "8 contact-row ridge bars approximating the dense gold contact grid; exact per-pin count is foreshortened in 9.png/10.png so individual pins are not modeled 1:1.",
    },
    {
        "id": "mounting-standoff-array", "parent": "mounting-standoffs", "level": "meso",
        "count": 4, "primitive": "cylinder", "material": "standoff-copper-ring",
        "instanceScale": [0.16, 0.16, 0.02],
        "placement": {"mode": "quadrant", "axis": [0, 0, 1], "radius": 0.0, "startAngleDeg": 0},
        "elementComponentIds": [f"mounting-standoff-{i+1}" for i in range(4)],
        "notes": "4 standoffs at the interior quadrant positions observed in 9.png/10.png; built individually (count is small, exact positions matter for later mounting-hole alignment).",
    },
]

# ---------------------------------------------------------------------------
# Silhouette / viewEvidence / assumptions
spec["silhouette"] = {
    "boundingShape": "thin rectangular slab (cuboid), portrait aspect ~1:1.36",
    "aspectRatios": [1.0, 1.36, 0.045],
    "symmetry": "bilateral perimeter mounting-hole ring and 4 interior standoffs; component population itself is asymmetric between die-side and back-side faces",
    "dominantCurves": [],
    "negativeSpaces": ["gaps between the 8 VRM inductors", "gaps between the 2x8 VRM capacitor bank", "connector housing overhang above the board back-face plane"],
    "landmarks": ["central SoC package", "top-edge VRM bank", "4 interior mounting standoffs", "back-face card-edge connector near top edge", "perimeter copper heatspreader band"],
}
spec["viewEvidence"] = [
    {"id": "full-object", "view": "primary", "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["Populated die-side face: central SoC BGA package, VRM inductor row, VRM cap bank, memory/PMIC package clusters (8.png, 11.png)."],
     "confidence": 0.75},
    {"id": "back-face", "view": "back", "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["Back face: dense card-edge mezzanine connector, 4 mounting standoffs with through-holes, small IC packages near top edge (9.png, 10.png)."],
     "confidence": 0.75},
]
spec["assumptions"] = [
    "Board thickness is inferred (not measured) as a thin multilayer-PCB slab; no true edge/profile reference image exists among the 4 supplied views.",
    "Card-edge connector contact rows are approximated as 8 ridge bars rather than exact per-pin geometry; per-row pin count is foreshortened in the back-face references.",
    "Perimeter through-holes/vias are represented as a material-level normal/AO local override, not modeled geometry, since they do not affect the overall silhouette.",
    "No chip/package marking text (NVIDIA logo, R22, 330, D9WX, B0077, 7JA92/JZ024, AEM10841, part numbers) is baked into geometry or texture, per explicit user requirement; component identity is carried only by the named Object3D/group hierarchy and actionProfile anchors.",
]
spec["risks"] = [
    "Board thickness approximation may read thicker/thinner than the real part when viewed edge-on; flagged as inferred, not measured.",
    "Connector contact-row approximation (8 ridges vs. exact pin grid) will not withstand close-up macro inspection as a pin-accurate reconstruction.",
]

spec["qualityTargets"]["reviewViewpoints"] = ["front-die-side", "back-connector-side", "three-quarter-front", "three-quarter-back", "edge-profile"]

SPEC_PATH.write_text(json.dumps(spec, indent=2))
print(f"wrote {len(components)} componentTree entries, {len(materials)} materials, {len(spec['repetitionSystems'])} repetitionSystems")
