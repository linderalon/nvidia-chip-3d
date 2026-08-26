// Avatar tutor integration — wires a live Kaltura Agentic Avatar to the 3D
// viewer's component-selection flow via Kaltura's hosted Unisphere "embeds"
// loader, using the `genieAvatar` embed (superseding an earlier `genieChat`
// draft — see below for why). Deliberately kept separate from
// main.ts/createJetsonXavierModel.ts: this file owns nothing about the 3D
// scene, only the avatar embed + when/what it's told to say.
//
// Why `genieAvatar`, not `genieChat`: the user wanted a visible avatar face
// that's ready without an extra manual panel-open step. `genieChat`'s
// floater() only opens a text/CTA panel — the actual avatar face only shows
// once a live call is started. `genieAvatar`'s `headFloater()` visual is a
// draggable floating avatar HEAD that auto-connects on mount (per
// https://docs.kaltura.com/embeds/documentations/genie-avatar/getting-started,
// fetched live and read in full), which is exactly the "face is up and
// ready" behavior asked for.
//
// Docs-verified API surface used here (all fetched live from the URL above,
// not guessed):
//   - `embeds.workspace({ apis: [{ name: 'genieAvatar', settings: {...} }], session })`
//     — settings live INSIDE the `apis` array entry for this embed (different
//     shape from `genieChat`, which took no `settings` there).
//   - `settings.openingPhrase` — "Phrase sent to the agent on connection to
//     encourage it to start speaking." This only fires once, at the
//     workspace's own connect — it is NOT a per-message trigger.
//   - `apis.genieAvatar.headFloater(options?)` → `{ isChatPanelOpen,
//     setChatPanelOpen, remove }`. Auto-connects on mount.
//   - `apis.genieAvatar.connectionStatus.onChanges(cb)` — observable,
//     values 'connecting'|'connected'|'disconnected'|'disconnecting'|'error'
//     per the docs (empirically the pre-connect initial value was the
//     UNDOCUMENTED 'notConnected' — handled defensively below).
//   - `apis.genieAvatar.updateDynamicVariables(vars)` — same
//     silent-context-only semantics as the SDK's own request_vars; does not
//     itself trigger speech.
//   - `apis.genieAvatar.askViaText(text)` — "Sends a text message to the AI
//     agent." This is the documented mid-session speech TRIGGER, and it lives
//     on the persistent `apis.genieAvatar` object — no reconnect/workspace
//     teardown needed to use it again. This supersedes an earlier proposal
//     to tear down and recreate the whole workspace per click (to get a
//     fresh `openingPhrase`): askViaText is the actual designed-for-this
//     mechanism and needs no reconnect at all.
//
// IMPORTANT — could not fully verify live end-to-end in this environment:
// mounting headFloater() in the sandboxed browser used for testing failed at
// getUserMedia with NotAllowedError (mic permission denied by the sandbox,
// not by any code/config here), which took connectionStatus straight to
// 'error' before a real conversation could start — so `askViaText`'s actual
// live speech-triggering behavior is implemented per the docs but UNVERIFIED
// end-to-end. This is almost certainly also a strong candidate for why the
// real user saw "not working": headFloater auto-connects and needs mic
// access immediately, with no visible UI here for a denied/missing mic
// beyond the (currently unsurfaced) 'error' connectionStatus — see
// `onConnectionError` below, added specifically so a real failure is at
// least visible instead of silent.

import { COMPONENT_INFO } from './componentInfo';

const LOADER_URL = 'https://unisphere.nvp1.ovp.kaltura.com/v1/loader/index.esm.js';

// Public, non-secret identifiers (see prior integration report) — NEVER put
// an admin secret in this file.
const PARTNER_ID = 6512152;
const WIDGET_ID = '1_18s9tzmw';

type ConnectionStatus = 'notConnected' | 'connecting' | 'connected' | 'disconnected' | 'disconnecting' | 'error';

type GenieAvatarApis = {
  headFloater: (options?: Record<string, unknown>) => {
    isChatPanelOpen: { getData(): boolean; onChanges(cb: (v: boolean) => void): () => void };
    setChatPanelOpen: (open: boolean) => void;
    remove: () => void;
  };
  connectionStatus: { getData(): ConnectionStatus; onChanges(cb: (s: ConnectionStatus) => void): () => void };
  connect: (options?: Record<string, unknown>) => void;
  disconnect: () => void;
  reconnect: () => void;
  updateDynamicVariables: (vars: Record<string, unknown>) => void;
  askViaText: (text: string) => void;
};

const infoById = new Map(COMPONENT_INFO.map((c) => [c.id, c]));

let genieAvatar: GenieAvatarApis | null = null;
let initPromise: Promise<GenieAvatarApis> | null = null;

// ─────────────────────────── visible status affordance ───────────────────────────
// A small, always-rendered indicator so "avatar tutor is here but not yet
// connected" and "connection failed" are never indistinguishable from
// "nothing rendered at all" — that ambiguity is exactly what confused the
// first real user. Rendered immediately at module load (NOT gated on a
// click), but purely a static placeholder: it does not itself connect
// anything, so it carries none of the auto-connect billing concern that
// keeps `ensureConnected()` lazy. Intentionally unstyled/minimal — the
// visual design layer is being iterated on separately; this is a functional
// placeholder, easy to restyle later.
type StatusState = 'idle' | 'connecting' | 'connected' | 'error';

function mountStatusIndicator() {
  const root = document.createElement('div');
  root.id = 'avatar-tutor-status';
  Object.assign(root.style, {
    position: 'fixed',
    bottom: '16px',
    right: '16px',
    zIndex: '9999',
    maxWidth: '260px',
    padding: '8px 12px',
    borderRadius: '8px',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '13px',
    lineHeight: '1.4',
    color: '#f4f6f5',
    background: '#16191c',
    border: '1px solid rgba(255,255,255,0.25)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
  });
  root.textContent = 'Avatar tutor — click a component to talk';
  document.body.appendChild(root);

  function setState(state: StatusState, message?: string) {
    root.dataset.state = state;
    const borderColor = { idle: 'rgba(255,255,255,0.25)', connecting: '#e0b400', connected: '#76b900', error: '#c0392b' }[state];
    root.style.borderColor = borderColor;
    root.textContent =
      message ??
      {
        idle: 'Avatar tutor — click a component to talk',
        connecting: 'Avatar tutor — connecting…',
        connected: 'Avatar tutor — connected',
        error: "Couldn't connect the avatar — check microphone permission for this page",
      }[state];
  }

  return { setState };
}

const statusIndicator = mountStatusIndicator();

/**
 * Loads the embed + mounts the head-floater visual ONCE, lazily on the
 * FIRST component click (not eagerly at page load) — headFloater
 * auto-connects on mount, which is a REAL live avatar call. Mounting it
 * eagerly at page load would start (and bill) a call every time this page
 * is merely opened, before the visitor has expressed any intent. This is a
 * deliberate deviation from the "mount once at page load" pattern used for
 * the earlier `genieChat` floater (which did NOT auto-connect) — flagging
 * it clearly since it's a real behavioral/cost tradeoff.
 */
async function ensureConnected(): Promise<GenieAvatarApis> {
  if (genieAvatar) return genieAvatar;
  if (initPromise) return initPromise;

  statusIndicator.setState('connecting');

  initPromise = (async () => {
    try {
      const mod = await import(/* @vite-ignore */ LOADER_URL);
      const { apis } = await mod.embeds.workspace({
        apis: [
          {
            name: 'genieAvatar',
            settings: {
              openingPhrase:
                'Greet the user briefly and let them know they can click any component on the 3D model to have you explain it.',
              captions: { enable: true },
              theme: { type: 'light' },
            },
          },
        ],
        session: { widgetId: WIDGET_ID, partnerId: PARTNER_ID },
      });

      genieAvatar = apis.genieAvatar as GenieAvatarApis;

      genieAvatar.connectionStatus.onChanges((status) => {
        if (status === 'error') {
          // Surfaced because headFloater's auto-connect can fail silently
          // (e.g. denied/missing mic permission) with no built-in UI for it.
          const message = "Couldn't connect the avatar — check microphone permission for this page";
          console.error(
            '[avatarTutor] genieAvatar connection entered "error" status — most likely a denied or ' +
            'unavailable microphone permission (headFloater requires mic access to connect). Check the ' +
            "browser's mic permission for this page."
          );
          statusIndicator.setState('error', message);
        } else if (status === 'connecting') {
          statusIndicator.setState('connecting');
        } else if (status === 'connected') {
          // The real headFloater UI takes over from here — collapse our
          // placeholder to a small "connected" pill rather than fighting it
          // for attention.
          statusIndicator.setState('connected');
        } else {
          statusIndicator.setState('idle');
        }
      });

      genieAvatar.headFloater();
      return genieAvatar;
    } catch (err) {
      statusIndicator.setState('error', `Couldn't load the avatar — ${(err as Error).message || err}`);
      initPromise = null; // allow a retry on the next explainComponent() call
      throw err;
    }
  })();

  return initPromise;
}

/** Resolves once connectionStatus reaches 'connected', or rejects on 'error'/timeout. */
function waitUntilConnected(apis: GenieAvatarApis, timeoutMs = 15000): Promise<void> {
  const current = apis.connectionStatus.getData();
  if (current === 'connected') return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`avatar connection timed out after ${timeoutMs}ms (last status: ${apis.connectionStatus.getData()})`));
    }, timeoutMs);
    const unsubscribe = apis.connectionStatus.onChanges((status) => {
      if (status === 'connected') {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      } else if (status === 'error') {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error('avatar connection failed (connectionStatus: error)'));
      }
    });
  });
}

/**
 * Called from main.ts's toggleSelected(id) whenever a component becomes the
 * SELECTED one (not on deselect). Persists the selection into the avatar's
 * dynamic-variable context, then uses askViaText() to trigger a fresh, live
 * explanation of that specific component — no reconnect/workspace teardown
 * needed, since askViaText is the documented mid-session speech trigger.
 */
export async function explainComponent(id: string): Promise<void> {
  const info = infoById.get(id);
  if (!info) return;

  try {
    const apis = await ensureConnected();
    await waitUntilConnected(apis);

    apis.updateDynamicVariables({
      selectedComponentId: info.id,
      selectedComponentTitle: info.title,
      selectedComponentRole: info.role,
    });

    const brief = info.bullets.join(' ');
    apis.askViaText(
      `The user just selected the "${info.title}" component (${info.role}) on the 3D model. ` +
      `Explain it to them in 2-3 sentences, grounded in these facts: ${brief}`
    );
  } catch (err) {
    console.error('[avatarTutor] explainComponent failed', err);
    // Covers cases connectionStatus's own 'error' listener might not (e.g. a
    // timeout stuck in 'connecting', or the workspace/import failing before
    // any connectionStatus ever fires) — never leave the indicator silent.
    statusIndicator.setState('error', "Couldn't connect the avatar — check microphone permission for this page");
  }
}
