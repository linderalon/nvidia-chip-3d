# Layered Image Analysis — NVIDIA Jetson AGX Xavier SoM (4 references: 8,9,10,11.png)

## Layer 1 — Identification
Work type: populated rigid PCB System-on-Module (SoM), NVIDIA Jetson AGX Xavier class carrier board.
Classification: electronic assembly / mechanical-electrical composite object. primaryDomain: object.
Confidence: 0.9 (die-side SoC package + card-edge mezzanine connector + standoff layout are
consistent with a Jetson-family SoM carrier).

## Layer 2 — Form & silhouette
Bounding volume: thin rectangular slab (cuboid), portrait aspect. Bilateral symmetry in the
perimeter mounting-hole ring and the 4 interior standoffs; component population is asymmetric
(populated top face vs connector-dominated back face). Shape language: geometric/panel, with
box-like populated protrusions on both faces.

## Layer 3 — Macro -> meso -> micro
- Macro: board substrate slab; populated (die) face; connector (back) face.
- Meso: SoC BGA package (central, teal substrate visible around a black lid marking block);
  VRM inductor row (8 blocks, "R22"-class); VRM capacitor bank (2 rows x 8, "330"-class);
  memory/PMIC package cluster (multiple dark molded ICs flanking/below the SoC); card-edge
  mezzanine connector (back face, ~8 contact rows); 4 mounting standoffs with through-holes
  (back face, interior quadrants); copper heatspreader edge frame (perimeter, both faces).
- Micro: individual inductor bodies, individual cap bodies, individual small IC packages,
  perimeter through-holes/vias (~15-20 per edge), concentric copper rings around the 4 big
  standoff holes, fine passive clusters on the back face flanking the connector, small dot
  fiducials on the SoC lid.

## Layer 4 — Spatial relationships
- SoC package: embedded-in board substrate, center, front face, flush-mounted (BGA reflow).
- VRM inductor row: attached-to board top edge, above SoC, front face.
- VRM cap rows: attached-to board, between inductor row and SoC, flush-with board, front face.
- Memory/PMIC packages: flanking SoC left/right and below, front face.
- Card-edge connector: attached-to board back face near top edge, protrudes above board plane
  (mates as a board-to-board mezzanine, contact face upward/outward).
- Mounting standoffs: embedded-in board, back face, 4 interior positions, through-hole down to
  front face (hole visible on both faces in refs).
- Copper heatspreader ring: attached-to board perimeter edge, flush with edge, visible on both
  faces as a border band.

## Layer 5 — Materials & surface (PBR)
- Board solder mask (front+back): near-black, matte, roughness ~0.75, metalness 0.
- Copper heatspreader/edge band + standoff rings: copper hue, metalness ~0.85, roughness ~0.35.
- SoC substrate patch: teal/cyan, fine stipple micro-relief (procedural noise only, no baked
  text), roughness ~0.5, metalness 0; separate overmold marking block on top: flat dark plaque,
  roughness ~0.55, metalness 0 (rendered as an unlabeled dark block, no text).
- VRM inductors: tan/beige molded body, matte, roughness ~0.6, metalness 0.
- VRM caps: charcoal polymer body, satin, roughness ~0.45, metalness 0.
- Small ICs (memory/PMIC cluster): dark gray-black molded package, roughness ~0.55, metalness 0.
- Card-edge connector contacts: gold-plated, metalness ~0.9, roughness ~0.25; housing: black
  insulator plastic, roughness ~0.8, metalness 0.
- Perimeter through-hole rims / fastener bosses: silver-toned plated metal, metalness ~0.7,
  roughness ~0.4.

## Layer 6 — Color & finish
Board: near-black, low value/saturation, matte. Copper: warm orange-brown, mid value,
satin-to-semi-gloss depending on edge lighting. SoC teal patch: cyan-teal, mid-low value, fine
stipple. Gold contacts: warm gold, mid-high value, semi-gloss. Passive bodies: tan (inductors)
vs charcoal (caps/ICs), matte-satin.

## Layer 7 — Identity-defining features (shape/placement only — NOT rendered as readable text)
- Central SoC package silhouette + lid parting line — distinct named group, no baked marking text.
- 8x inductor row — repeated/instanced rounded-rect blocks with chamfered corners.
- 2x8 cap bank — repeated/instanced smaller rect blocks.
- Memory/PMIC cluster — several distinct package footprints flanking/below SoC.
- Card-edge connector — 8 contact rows, back face, near top edge — instanced pin/contact array.
- 4 mounting standoffs — through-hole + concentric copper ring pad, back-face interior quadrants.
- Copper edge heatspreader ring — full perimeter band.
- Perimeter through-holes/vias ringing the board edge.
Per explicit requirement: all visible chip markings (NVIDIA logo text, "R22", "330", "D9WX",
"B0077", "7JA92/JZ024", "AEM10841", part numbers) are observed but intentionally NOT baked into
geometry or texture. Component identity is carried only by named Object3D/group hierarchy and
action anchors, for a later UI layer to hover/click-highlight.

## Layer 8 — Uncertainty & single-image limits
- No true edge/profile view exists. Board thickness is INFERRED (not measured) as a thin
  multilayer-PCB slab; flagged explicitly as approximate in the spec and final report.
- Exact contact-pin count of the card-edge connector is partially foreshortened in 9.png/10.png;
  approximated as ~8 rows x N instanced contacts rather than an exact pin-for-pin count.
- No absolute mm dimensions are measurable from photos alone; proportions are inferred from
  cross-referencing standoff/hole alignment between die-side (8,11) and back-side (9,10) images.
- Back-face fine passive clusters (small clusters flanking the connector and near the standoffs)
  are approximated as a low-relief procedural micro-detail field rather than individually modeled
  per discrete part.

## Suitability verdict (validation_rubric.md)
PASS — one obvious target object, occupies frame, strong silhouette (rectangular board +
connector protrusion), major materials visible (solder mask, copper, gold contacts, IC molding),
hidden side (edge/thickness) reasonably inferable as a thin flat slab, target approximable with
procedural primitives (boxes, rounded boxes, instanced arrays).
