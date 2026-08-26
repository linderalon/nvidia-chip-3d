#!/usr/bin/env python3.13
import json, re
from pathlib import Path

WS = Path("/Users/alonlinder/jetson-xavier-3d")
SPEC_PATH = WS / "object-sculpt-spec.json"
spec = json.loads(SPEC_PATH.read_text())

def hex_to_rgba(hex_color, alpha=1.0):
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r}, {g}, {b}, {alpha})"

materials_by_id = {m["id"]: m for m in spec["materials"]}
material_class = {
    "board-solder-mask": "plastic",
    "soc-substrate": "ceramic",
    "ic-overmold-dark": "plastic",
    "vrm-inductor-body": "ceramic",
    "vrm-cap-body": "plastic",
    "connector-housing": "plastic",
    "connector-gold-contact": "metal",
    "standoff-copper-ring": "metal",
    "copper-edge": "metal",
}

# --- 1. colorMaterialRecipe on every component ------------------------------
for comp in spec["componentTree"]:
    mat_id = comp.get("material")
    mat = materials_by_id.get(mat_id)
    if not mat:
        continue
    dominant_hex = mat["albedo"]["dominant"]
    secondary_hex = mat["albedo"]["secondary"][0] if mat["albedo"]["secondary"] else dominant_hex
    comp["colorMaterialRecipe"] = {
        "dominantAlbedo": hex_to_rgba(dominant_hex),
        "secondaryAlbedo": hex_to_rgba(secondary_hex),
        "materialClass": material_class.get(mat_id, "unknown"),
        "materialClassConfidence": 0.7,
    }

# --- 2. attachment contracts for components that trip ATTACHMENT_ROLES/PRIMITIVES ---
def set_attachment(comp, parent_id, socket, local_start, local_end, contact_type,
                    embed_depth=0.01, gap_tolerance=0.004):
    comp["attachment"] = {
        "parentId": parent_id,
        "parentSocket": socket,
        "localStart": list(local_start),
        "localEnd": list(local_end),
        "contactType": contact_type,
        "embedDepth": embed_depth,
        "gapTolerance": gap_tolerance,
        "contactNormal": [0, 0, 1],
    }

by_id = {c["id"]: c for c in spec["componentTree"]}

set_attachment(
    by_id["edge-connector"], "root", "board-back-face-top-edge",
    (0.0, 0.62, -0.03), (0.0, 0.62, -0.075), "flush-mount", embed_depth=0.015, gap_tolerance=0.004,
)
for i in range(1, 9):
    cid = f"edge-connector-contact-row-{i}"
    if cid in by_id:
        set_attachment(
            by_id[cid], "edge-connector", "connector-housing-row-slot",
            (-0.28, 0.0, 0.02), (0.28, 0.0, 0.02), "embedded", embed_depth=0.006, gap_tolerance=0.002,
        )
for i in range(1, 5):
    cid = f"mounting-standoff-{i}"
    if cid in by_id:
        set_attachment(
            by_id[cid], "root", "board-standoff-boss",
            (0.0, 0.0, -0.02), (0.0, 0.0, 0.02), "embedded", embed_depth=0.012, gap_tolerance=0.003,
        )

# --- 3. lightingFromPhoto -----------------------------------------------------
spec["lightingFromPhoto"] = [
    {"role": "key", "direction": [-0.4, 0.75, 0.55], "color": "#FFF4E0", "intensity": 1.0,
     "notes": "Soft overhead-left key matching the studio-lit product renders (8,9,10,11.png)."},
    {"role": "fill", "direction": [0.6, 0.2, 0.7], "color": "#CFE0FF", "intensity": 0.35,
     "notes": "Cool fill from camera-right to lift shadow side without flattening the copper/gold specular response."},
    {"role": "rim-or-environment", "direction": [0.0, -0.3, -1.0], "color": "#FFFFFF", "intensity": 0.25,
     "notes": "Low-intensity environment reflection to read metalness on copper edge band and gold contacts."},
    {"role": "ambient", "direction": [0, 1, 0], "color": "#404040", "intensity": 0.4,
     "notes": "Neutral ambient/hemisphere term so recessed areas (between inductors/caps) are not pure black."},
]

# --- 4. featureReviewTargets: replace generic starters with real subsystems --
spec["featureReviewTargets"] = [
    {"id": "soc-die-identity", "name": "SoC die package silhouette and substrate/lid split",
     "tier": "critical", "passIds": ["structural-pass", "form-refinement"], "minimumScore": 0.8,
     "mustPass": True, "componentRefs": ["soc-package", "soc-substrate-patch", "soc-overmold-lid"],
     "evidenceRefs": ["full-object"]},
    {"id": "vrm-bank-repetition", "name": "VRM inductor row (8) + capacitor bank (2x8) repetition density and pitch",
     "tier": "critical", "passIds": ["structural-pass", "form-refinement"], "minimumScore": 0.75,
     "mustPass": True, "componentRefs": ["vrm-bank"], "evidenceRefs": ["full-object"]},
    {"id": "memory-pmic-cluster-placement", "name": "Memory/PMIC package cluster flanking and below the SoC",
     "tier": "important", "passIds": ["structural-pass"], "minimumScore": 0.65,
     "mustPass": False, "componentRefs": ["memory-pmic-cluster"], "evidenceRefs": ["full-object"]},
    {"id": "edge-connector-structure", "name": "Card-edge mezzanine connector housing + contact-row density",
     "tier": "critical", "passIds": ["structural-pass", "material-pass"], "minimumScore": 0.75,
     "mustPass": True, "componentRefs": ["edge-connector"], "evidenceRefs": ["back-face"]},
    {"id": "mounting-standoffs-placement", "name": "4 mounting standoffs at interior quadrant positions",
     "tier": "important", "passIds": ["structural-pass"], "minimumScore": 0.65,
     "mustPass": False, "componentRefs": ["mounting-standoffs"], "evidenceRefs": ["back-face"]},
]

# --- 5. resolve unknowns: accepted as documented approximations (see assumptions) --
spec["preSpecAssessment"]["unknownsToResolveBeforeImplementation"] = []

# --- 6. detailInventory.details: pull the real 16-entry inventory ------------
di = json.loads((WS / "di.json").read_text())
spec["preSpecAssessment"]["detailInventory"]["details"] = di["detailInventory"]["details"]

SPEC_PATH.write_text(json.dumps(spec, indent=2))
print("patched colorMaterialRecipe, attachment, lightingFromPhoto, featureReviewTargets, unknowns, detailInventory")
