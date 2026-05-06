import {
  generateUUID,
  isArray,
  isNumber,
  isPlainObject,
  isStr,
} from '../../src/utils.js';

/**
 * @typedef {Object} MgidSessionInfo
 * @property {string} sid           Current session id (empty string if none).
 * @property {number|null} sessionPage  Number of unique pagePaths in current session (null if absent).
 * @property {number} sessionsWeek  Count of session starts in the last 7 days.
 * @property {number} sessionNum    Total session starts retained (last 30 days).
 * @property {number|null} timeBetweenSessions  Minutes between the last two session starts (null if < 2 sessions).
 */

/**
 * @typedef {Object} MgidWidgetEntry
 * @property {string} sid             Last session id this widget appeared in.
 * @property {number} [session_page]  Cumulative distinct sessions widget rendered in.
 * @property {number} [session_num]   Distinct sessions in last 30 days.
 * @property {number} [sessions_1w]   Distinct sessions in last 7 days.
 * @property {string} [viewrate_1w]   "v,r" string of accumulated views and renders, last 7 days.
 */

/**
 * @typedef {Object} MgidSessionStorage
 * @property {() => void} calculatePageSession
 * @property {() => MgidSessionInfo} getSessionInfo
 * @property {() => string} getOrCreatePvid
 * @property {() => Object<string, MgidWidgetEntry>|null} getWidgetsData
 * @property {(bid: Object) => void} trackRender
 * @property {(bid: Object) => void} trackView
 * @property {() => void} pruneViewrate
 * @property {() => void} reset
 */

export const SESSION_BOUNDARY_MS = 30 * 60 * 1000; // 30 minutes
export const SESSION_WEEK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const LS_KEY_SESSION_ID = '_mgPbSessionId';
const LS_KEY_SESSION_PAGE = '_mgPbSessionPagesNumber';
const LS_KEY_SESSIONS_LIST = '_mgPbSessionsTimeList';
const LS_KEY_VIEWRATE = '_mgPbViewrate';
const LS_KEY_RENDERED_SESSIONS = '_mgPbRenderedSessions';
const WIN_KEY_SESSION_PAGES = '_mgPbSessionPages';

/**
 * Build a session/PVID/viewrate/render-tracking facade bound to a Prebid storage manager.
 *
 * @param {Object} storage  Prebid storage manager (typically from getStorageManager).
 * @returns {MgidSessionStorage}
 */
export function createMgidSessionStorage(storage) {
  const currentViewrateId = ('0000000000' + Math.round(Math.random() * 10000000000).toString(16)).slice(-10);
  let lastCalculatedPath = null;

  function getLocal(key) {
    try {
      return storage.getDataFromLocalStorage(key);
    } catch (e) {
      return null;
    }
  }

  function setLocal(key, val) {
    try {
      return storage.setDataInLocalStorage(key, val);
    } catch (e) {
      return null;
    }
  }

  function readPagePaths() {
    if (isArray(window[WIN_KEY_SESSION_PAGES])) {
      return [...window[WIN_KEY_SESSION_PAGES]];
    }
    return [];
  }

  function writePagePaths(paths) {
    window[WIN_KEY_SESSION_PAGES] = paths;
  }

  function getPagePath() {
    try {
      return (window.location && window.location.pathname) || '';
    } catch (e) {
      return '';
    }
  }

  function generateSessionId() {
    return Math.round(Date.now() / 1000).toString(16) + '-' +
      ('00000' + Math.round(Math.random() * 100000).toString(16)).slice(-5);
  }

  function getOrCreatePvid() {
    const pagePath = getPagePath();
    if (!isArray(window._mgPvidList)) {
      window._mgPvidList = [];
    }
    const pathSeen = window._mgPvidList.indexOf(pagePath) !== -1;
    const pvidMissing = !isStr(window._mgPvid) || window._mgPvid.length === 0;
    if (!pathSeen || pvidMissing) {
      window._mgPvid = generateUUID();
      if (!pathSeen) {
        window._mgPvidList.push(pagePath);
      }
    }
    return window._mgPvid;
  }

  function getWidgetIdFromBid(bid) {
    const creativeId = bid && bid.creativeId;
    if (!isStr(creativeId) || creativeId.length === 0) {
      return '';
    }
    return creativeId.split('_')[0] || '';
  }

  function calculatePageSession() {
    const pagePath = getPagePath();
    if (lastCalculatedPath === pagePath) {
      return;
    }
    lastCalculatedPath = pagePath;

    const now = Date.now();

    let list = [];
    try {
      const raw = JSON.parse(getLocal(LS_KEY_SESSIONS_LIST) || '[]');
      if (isArray(raw)) {
        list = raw.filter((t) => isNumber(t) && (now - t) < SESSION_EXPIRATION_MS);
      }
    } catch (e) {}

    let sessionPage = parseInt(getLocal(LS_KEY_SESSION_PAGE), 10);
    if (isNaN(sessionPage) || sessionPage < 0) {
      sessionPage = 0;
    }

    let pagePaths = readPagePaths();

    const isNewPagePath = pagePaths.indexOf(pagePath) === -1;
    if (isNewPagePath) {
      pagePaths.push(pagePath);
      sessionPage = sessionPage + 1;
    }

    let sessionId = getLocal(LS_KEY_SESSION_ID);
    const withinSession = list.length > 0 && (now - list[list.length - 1]) < SESSION_BOUNDARY_MS;

    if (list.length > 0) {
      if (withinSession) {
        list[list.length - 1] = now;
        if (!isStr(sessionId) || sessionId.length === 0) {
          sessionId = generateSessionId();
        }
      } else {
        sessionId = generateSessionId();
        list.push(now);
        pagePaths = [pagePath];
        sessionPage = 1;
      }
    } else {
      sessionId = generateSessionId();
      list = [now];
      pagePaths = [pagePath];
      sessionPage = 1;
    }

    writePagePaths(pagePaths);
    setLocal(LS_KEY_SESSION_ID, sessionId);
    setLocal(LS_KEY_SESSION_PAGE, String(sessionPage));
    setLocal(LS_KEY_SESSIONS_LIST, JSON.stringify(list));
  }

  function getSessionInfo() {
    const sid = getLocal(LS_KEY_SESSION_ID) || '';
    const sessionPage = parseInt(getLocal(LS_KEY_SESSION_PAGE), 10);
    let sessionsList = [];
    try {
      const raw = JSON.parse(getLocal(LS_KEY_SESSIONS_LIST) || '[]');
      if (isArray(raw)) {
        sessionsList = raw;
      }
    } catch (e) {}
    const now = Date.now();
    const sessionsWeek = sessionsList.filter((t) => isNumber(t) && (now - t) < SESSION_WEEK_MS).length;
    let timeBetweenSessions = null;
    if (sessionsList.length >= 2) {
      const last = sessionsList[sessionsList.length - 1];
      const prev = sessionsList[sessionsList.length - 2];
      timeBetweenSessions = Math.floor((last - prev) / 60000);
    }
    let sessionPageOut = null;
    if (!isNaN(sessionPage) && sessionPage > 0) {
      sessionPageOut = sessionPage;
    }
    return {
      sid,
      sessionPage: sessionPageOut,
      sessionsWeek,
      sessionNum: sessionsList.length,
      timeBetweenSessions,
    };
  }

  function readRenderedSessions() {
    try {
      const raw = getLocal(LS_KEY_RENDERED_SESSIONS);
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        return {};
      }
      return parsed;
    } catch (e) {
      return {};
    }
  }

  function recordRender(bid) {
    const widgetId = getWidgetIdFromBid(bid);
    if (!widgetId) {
      return;
    }
    const now = Date.now();
    const currentSid = getLocal(LS_KEY_SESSION_ID) || '';
    if (!currentSid) {
      return;
    }
    const currentPvid = isStr(window._mgPvid) ? window._mgPvid : '';
    const all = readRenderedSessions();
    let entry;
    if (isPlainObject(all[widgetId])) {
      entry = { ...all[widgetId] };
    } else {
      entry = { id: '', pvid: '', page: 0, list: [] };
    }
    let list = [];
    if (isArray(entry.list)) {
      list = entry.list.filter((t) => isNumber(t) && (now - t) < SESSION_EXPIRATION_MS);
    }
    const isNewContext = entry.id !== currentSid || entry.pvid !== currentPvid;
    if (isNewContext) {
      entry.id = currentSid;
      entry.pvid = currentPvid;
      entry.page = (Number(entry.page) || 0) + 1;
      list.push(now);
    }
    entry.list = list;
    all[widgetId] = entry;
    setLocal(LS_KEY_RENDERED_SESSIONS, JSON.stringify(all));
  }

  function readViewrates() {
    try {
      const raw = getLocal(LS_KEY_VIEWRATE);
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        return {};
      }
      return parsed;
    } catch (e) {
      return {};
    }
  }

  function filterViewrate(list) {
    if (!isArray(list)) {
      return [];
    }
    const now = Date.now();
    return list.filter((vr) => isPlainObject(vr) && isNumber(vr.st) && (now - vr.st) < SESSION_WEEK_MS);
  }

  function recordViewrate(widgetId, field) {
    if (!widgetId) {
      return;
    }
    const all = readViewrates();
    const list = filterViewrate(all[widgetId]);
    let current = list.find((vr) => vr.id === currentViewrateId);
    if (!current) {
      current = { id: currentViewrateId, st: Date.now(), v: 0, r: 0 };
      list.push(current);
    }
    current[field] = (Number(current[field]) || 0) + 1;
    all[widgetId] = list;
    setLocal(LS_KEY_VIEWRATE, JSON.stringify(all));
  }

  function getWidgetsData() {
    const rendered = readRenderedSessions();
    const viewrates = readViewrates();
    const widgetIds = Array.from(new Set([...Object.keys(rendered), ...Object.keys(viewrates)]));
    if (widgetIds.length === 0) {
      return null;
    }
    const now = Date.now();
    const widgets = {};
    for (const widgetId of widgetIds) {
      let entry;
      if (isPlainObject(rendered[widgetId])) {
        entry = rendered[widgetId];
      } else {
        entry = { id: '', page: 0, list: [] };
      }
      let list = [];
      if (isArray(entry.list)) {
        list = entry.list.filter((t) => isNumber(t) && (now - t) < SESSION_EXPIRATION_MS);
      }
      const widgetData = {};
      const page = Number(entry.page) || 0;
      if (page > 0) {
        widgetData.session_page = page;
      }
      if (list.length > 0) {
        widgetData.session_num = list.length;
        const weekCount = list.filter((t) => (now - t) < SESSION_WEEK_MS).length;
        if (weekCount > 0) {
          widgetData.sessions_1w = weekCount;
        }
      }
      if (isStr(entry.id) && entry.id.length > 0) {
        widgetData.sid = entry.id;
      }
      const viewrate = filterViewrate(viewrates[widgetId]);
      if (viewrate.length > 0) {
        let v = 0;
        let r = 0;
        for (const vr of viewrate) {
          v += Number(vr.v) || 0;
          r += Number(vr.r) || 0;
        }
        if (v > 0 && r > 0) {
          widgetData.viewrate_1w = `${v},${r}`;
        }
      }
      if (Object.keys(widgetData).length > 0) {
        widgets[widgetId] = widgetData;
      }
    }
    if (Object.keys(widgets).length === 0) {
      return null;
    }
    return widgets;
  }

  function trackRender(bid) {
    recordRender(bid);
    recordViewrate(getWidgetIdFromBid(bid), 'r');
  }

  function trackView(bid) {
    recordViewrate(getWidgetIdFromBid(bid), 'v');
  }

  function pruneViewrate() {
    const all = readViewrates();
    let changed = false;
    const now = Date.now();
    for (const widgetId of Object.keys(all)) {
      const rows = all[widgetId];
      if (!isArray(rows)) {
        delete all[widgetId];
        changed = true;
        continue;
      }
      const kept = rows.filter((vr) => isPlainObject(vr) && isNumber(vr.st) && (now - vr.st) < SESSION_WEEK_MS);
      if (kept.length === 0) {
        delete all[widgetId];
        changed = true;
      } else if (kept.length !== rows.length) {
        all[widgetId] = kept;
        changed = true;
      }
    }
    if (changed) {
      setLocal(LS_KEY_VIEWRATE, JSON.stringify(all));
    }
  }

  function reset() {
    lastCalculatedPath = null;
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', pruneViewrate);
  }

  return {
    calculatePageSession,
    getSessionInfo,
    getOrCreatePvid,
    getWidgetsData,
    trackRender,
    trackView,
    pruneViewrate,
    reset,
  };
}
