# NVIDIA Jetson AGX Xavier — Interactive 3D Training Model

An interactive, procedurally-built Three.js model of the NVIDIA Jetson AGX Xavier compute module,
built for engineer training: rotate the real module, click any populated zone (SoC, VRM bank,
memory/PMIC cluster, edge connector, mounting standoffs) to read an engineering explanation, and
hear it explained aloud by a live Kaltura Agentic Avatar with a real face.

Branded to match the NVIDIA Academy course-page style (see the reference screenshot workflow this
was built against).

## Stack

- **Three.js** — procedurally generated geometry/materials (no downloaded meshes; built via the
  `img2threejs` skill's staged sculpt pipeline from 4 reference photos)
- **Vite + TypeScript** — dev server / build
- **Kaltura Unisphere "Genie Avatar" embed** — the live, speaking avatar layer (see below)

## Running it

```bash
npm install
npm run dev
```

Open the printed `localhost` URL. Click **3D Model** in the tab bar, then click any component —
on the model itself or in the left sidebar — to see its description and hear the avatar explain it.

## Project structure

```
index.html                   Page shell — nav, hero, tabs, sidebar/viewer layout (NVIDIA-branded)
src/main.ts                  Three.js scene setup, camera, hover/click highlighting, sidebar wiring
src/createJetsonXavierModel.ts  Generated procedural model factory (do not hand-edit — see below)
src/componentInfo.ts         The 5 components' titles/roles/description bullets (sidebar content)
src/avatarTutor.ts           *** The avatar integration — see "How the avatar layer works" below ***
object-sculpt-spec.json      The img2threejs sculpt spec the model factory was generated from
.img2threejs/state.json      img2threejs pipeline state (pass history, gates passed)
renders/                     Screenshot evidence captured during the build's verification passes
```

`src/createJetsonXavierModel.ts` is **generated code** from the `img2threejs` skill's pass pipeline
(blockout → structural → form → material → surface passes, each gated by a render + comparison
against the reference photos). If you want to change the model's geometry/materials, edit
`object-sculpt-spec.json` and regenerate — don't hand-edit the generated factory, since the spec is
the source of truth for reconstruction decisions.

## How the avatar layer works

This is the part worth understanding in detail, since it's a separate system bolted onto the 3D
viewer rather than part of the model itself.

### What it is

The avatar is **not** part of the Three.js scene. It's Kaltura's own hosted **Genie Avatar** widget
(a "Unisphere embed"), loaded at runtime straight from Kaltura's CDN and mounted as its own DOM
overlay on top of the page. `src/avatarTutor.ts` is the entire integration — it owns nothing about
the 3D scene, and `main.ts`/`createJetsonXavierModel.ts` know nothing about the avatar beyond one
function call.

### The embed mechanism

```js
const { embeds } = await import('https://unisphere.nvp1.ovp.kaltura.com/v1/loader/index.esm.js');
const { apis } = await embeds.workspace({
  apis: [{ name: 'genieAvatar', settings: { openingPhrase: '...' } }],
  session: { widgetId: '1_18s9tzmw', partnerId: 6512152 },
});
apis.genieAvatar.headFloater({ connect: { dynamicVariables: {...} } });
```

- `partnerId` + `widgetId` are **public, non-secret** identifiers (Kaltura's equivalent of a public
  client id) — safe to ship in browser source. **No admin secret is ever used or needed** for this
  integration; there is no backend/token-mint server involved.
- `headFloater()` is the specific visual mode used: a draggable floating avatar **head** that
  **auto-connects on mount** — this is what gives it a real face immediately, as opposed to
  Kaltura's other `genieChat` embed, which only opens a text panel until a call is manually started.
- The workspace/floater is mounted **lazily**, on the user's first component click — not eagerly at
  page load — specifically so opening the page never silently starts (and bills) a live avatar call
  before the user has expressed any intent.

### How a click becomes speech

There are two distinct API calls involved, and the distinction matters:

1. **`apis.genieAvatar.updateDynamicVariables({ selectedComponentId, selectedComponentTitle, selectedComponentRole })`**
   — pushes the clicked component's identity into the agent's context. This is **silent** — it does
   not itself make the avatar talk, it just makes the information available for the agent's next turn.
   This is the `request_vars`-equivalent mechanism the integration was originally asked to use for
   persistence ("let it know where in the model you clicked so it persists until next time you update").
2. **`apis.genieAvatar.askViaText(text)`** — sends an actual message to the agent on the
   already-connected session, which is what **triggers** the spoken explanation. No reconnect, no
   workspace teardown, no repeated `appInit` — it reuses the live connection established on the
   first click.

`src/main.ts`'s `toggleSelected(id)` calls `explainComponent(id)` from `avatarTutor.ts` exactly once,
on every *new* component selection (not on deselect). `explainComponent` does the
`updateDynamicVariables` + `askViaText` pair described above.

### Why this API and not a lower-level SDK

Kaltura also publishes a first-party `@kaltura/intelligent-agents` SDK (raw WebRTC session class,
`Management`/`KalturaAvatarSession`) that would require a custom backend holding an admin secret to
mint session tokens. That path was explored and abandoned in favor of the hosted `genieAvatar` embed
once it was confirmed working end-to-end against a real account — it needs no backend at all, since
the widget mints its own anonymous session from the public `partnerId`/`widgetId`. **This project
does not use `@kaltura/intelligent-agents` anywhere** — only the hosted Unisphere embed.

### Known constraints

- **Microphone permission is required.** `headFloater` needs live mic access to connect a real
  voice call. If your browser denies or has not yet granted mic access for the page, the connection
  fails — check the address bar's site-permissions icon and allow microphone access, then reload.
- There is a small, always-visible status indicator (bottom-right) that shows
  `idle → connecting → connected/error`, specifically so a failed connection is visible instead of
  looking like nothing happened.
- Changing which agent/persona speaks (e.g. giving it a different visual style or opening line) is
  configured on the Kaltura account side (the `widgetId`'s underlying agent config), not in this
  codebase — `avatarTutor.ts` only controls *when* it's told to speak and *what context* it has.

## Design notes

- The 3D model's component hierarchy (`runtime.nodes` in the generated factory) is what both the
  hover/click highlighting **and** the avatar integration key off of — `soc-package`, `vrm-bank`,
  `memory-pmic-cluster`, `edge-connector`, `mounting-standoffs`. No text/logos are baked into the
  model's geometry or textures for *labeling* purposes; identity comes from this named hierarchy.
  (Surface *markings* like "R22"/"330"/the NVIDIA die logo are a separate, deliberate fidelity
  choice — real photo-projected textures — not UI labels.)
- Per-component descriptions in the sidebar are an accordion: only the clicked component's text is
  expanded at a time.
