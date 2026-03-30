/**
 * store.js — Versioned state management
 * Handles localStorage with schema migrations.
 * Never silently corrupts on schema change.
 */

const STORE_VERSION = 3;
const STORE_KEY = 'juma_crm_v3';

/** @type {CRMState} */
const defaultState = {
  _version: STORE_VERSION,
  pipeline: [],
  pState: {},
  scheduled: [],
  actLog: [],
  settings: {
    gmailUser: '',
    gmailAccessToken: '',
    gmailRefreshToken: '',
    gmailTokenExpiry: 0,
    airtableBaseId: '',
    airtableTableId: '',
    appSecret: '',
  },
};

// ── Migrations: v1→v2→v3 ─────────────────────────────────────
const migrations = {
  1: (s) => {
    // v1 had cfg.airtableKey — move to settings
    if (s.cfg) {
      s.settings = s.settings || {};
      s.settings.airtableBaseId  = s.cfg.airtableBaseId  || '';
      s.settings.airtableTableId = s.cfg.airtableTableId || '';
      s.settings.gmailUser       = s.cfg.gmailUser        || '';
      delete s.cfg;
    }
    return { ...s, _version: 2 };
  },
  2: (s) => {
    // v2: normalize pState — ensure every entry has required fields
    const pState = s.pState || {};
    Object.keys(pState).forEach(id => {
      pState[id] = {
        status:    'new',
        notes:     '',
        priority:  2,
        emails:    [],
        activity:  [],
        ...pState[id],
      };
    });
    return { ...s, pState, _version: 3 };
  },
};

function migrate(raw) {
  let state = raw;
  const from = state._version || 1;

  for (let v = from; v < STORE_VERSION; v++) {
    if (migrations[v]) {
      try {
        state = migrations[v](state);
        console.info(`[Store] Migrated v${v} → v${v + 1}`);
      } catch (err) {
        console.error(`[Store] Migration v${v} failed:`, err);
        return null; // trigger fresh state
      }
    }
  }
  return state;
}

// ── Public API ────────────────────────────────────────────────
export function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return structuredClone(defaultState);

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return structuredClone(defaultState);

    // Version match — no migration needed
    if (parsed._version === STORE_VERSION) return parsed;

    // Needs migration
    const migrated = migrate(parsed);
    if (!migrated) {
      console.warn('[Store] Migration failed — starting fresh. Backup saved to juma_crm_backup.');
      localStorage.setItem('juma_crm_backup', raw);
      return structuredClone(defaultState);
    }

    // Save migrated state immediately
    saveState(migrated);
    return migrated;
  } catch (err) {
    console.error('[Store] Load error:', err);
    return structuredClone(defaultState);
  }
}

export function saveState(state) {
  try {
    // Guard: don't save if pipeline is empty and pState has data (corruption signal)
    if (state.pipeline.length === 0 && Object.keys(state.pState).length > 50) {
      console.error('[Store] Refusing to save: pipeline empty but pState has data — possible corruption.');
      return false;
    }

    const serialized = JSON.stringify(state);

    // Guard: localStorage quota
    if (serialized.length > 4 * 1024 * 1024) { // 4MB soft cap (5MB hard limit)
      console.warn('[Store] State exceeds 4MB — trimming actLog.');
      const trimmed = {
        ...state,
        actLog: state.actLog.slice(-200), // keep last 200 log entries
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
      return true;
    }

    localStorage.setItem(STORE_KEY, serialized);
    return true;
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      console.error('[Store] localStorage full — trimming actLog and retrying.');
      try {
        const trimmed = { ...state, actLog: state.actLog.slice(-50) };
        localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
        return true;
      } catch {
        return false;
      }
    }
    console.error('[Store] Save error:', err);
    return false;
  }
}

export function exportBackup(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `juma-crm-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importBackup(jsonString) {
  try {
    const parsed = JSON.parse(jsonString);
    if (!parsed.pipeline || !parsed.pState) {
      throw new Error('Invalid backup format');
    }
    const migrated = migrate({ ...parsed, _version: parsed._version || 1 });
    return migrated || null;
  } catch (err) {
    console.error('[Store] Import error:', err);
    return null;
  }
}

export { defaultState };
