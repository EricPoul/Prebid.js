import {
  isArray,
  isPlainObject,
  isStr,
} from '../../src/utils.js';
import { parseUserAgentDetailed } from '../userAgentUtils/detailed.js';

/**
 * @typedef {Object} MgidUadCache
 * @property {(existing?: Object) => Object} buildSUA  Build an ORTB device.sua object merging existing FPD + cached + sync UAD.
 * @property {() => void} reset  Test-only: clear in-memory cache.
 */

const LS_KEY_UAD = '_mgPbUadCache';

/**
 * Build a UA Client Hints cache + SUA builder facade bound to a Prebid storage manager.
 *
 * @param {Object} storage  Prebid storage manager (typically from getStorageManager).
 * @returns {MgidUadCache}
 */
export function createMgidUadCache(storage) {
  // Cache only holds values that are expensive to obtain (async high-entropy hints
  // from getHighEntropyValues). Sync fields (brands, mobile, platform) are read
  // from navigator.userAgentData at request time.
  let cache = null;

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

  function getUAD() {
    if (typeof navigator === 'undefined') {
      return null;
    }
    return navigator.userAgentData;
  }

  function loadCacheFromStorage() {
    const raw = getLocal(LS_KEY_UAD);
    if (!raw) {
      return;
    }
    try {
      const stored = JSON.parse(raw);
      if (isPlainObject(stored)) {
        cache = stored;
      }
    } catch (e) {}
  }

  function prewarm() {
    // 1. Warm-start cache from LS (previous page-load's high-entropy values).
    loadCacheFromStorage();

    // 2. Fetch fresh high-entropy hints and persist on resolve.
    const uad = getUAD();
    if (!uad || typeof uad.getHighEntropyValues !== 'function') {
      return;
    }
    uad.getHighEntropyValues([
      'architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64',
    ])
      .then((v) => {
        cache = { ...(cache || {}), ...v };
        setLocal(LS_KEY_UAD, JSON.stringify(cache));
      })
      .catch(() => {});
  }

  function readSyncSnapshot() {
    const uad = getUAD();
    if (uad) {
      return {
        brands: uad.brands,
        mobile: uad.mobile,
        platform: uad.platform,
      };
    }
    const info = parseUserAgentDetailed();
    if (!info) {
      return null;
    }
    let brandEntry = [];
    if (info.browser) {
      brandEntry = [{ brand: info.browser, version: info.browserv || '' }];
    }
    return {
      brands: brandEntry,
      mobile: info.devicetype === 4 || info.devicetype === 5,
      platform: info.os || '',
      platformVersion: info.osv || '',
      fullVersionList: brandEntry,
    };
  }

  function buildSUA(existing) {
    if (cache === null) {
      loadCacheFromStorage();
    }
    const sync = readSyncSnapshot();
    let merged = null;
    if (sync) {
      merged = { ...sync, ...(cache || {}) };
    } else if (cache) {
      merged = cache;
    }
    let sua;
    if (isPlainObject(existing)) {
      sua = { ...existing };
    } else {
      sua = {};
    }
    if (!merged) {
      return sua;
    }
    if (typeof merged.mobile === 'boolean') {
      sua.mobile = merged.mobile ? 1 : 0;
    }
    if (isArray(merged.fullVersionList) && merged.fullVersionList.length > 0) {
      sua.browsers = merged.fullVersionList.map((b) => ({
        brand: b.brand,
        version: b.version.split('.'),
      }));
    } else if (isArray(merged.brands) && merged.brands.length > 0) {
      sua.browsers = merged.brands.map((b) => ({
        brand: b.brand,
        version: [b.version],
      }));
    }
    if (isStr(merged.platform) && merged.platform) {
      if (!isPlainObject(sua.platform)) {
        sua.platform = {};
      }
      sua.platform.brand = merged.platform;
    }
    if (isPlainObject(sua.platform) && merged.platformVersion) {
      sua.platform.version = merged.platformVersion.split('.');
    }
    if (merged.architecture) {
      sua.architecture = merged.architecture;
    }
    if (merged.bitness) {
      sua.bitness = merged.bitness;
    }
    if (merged.model) {
      sua.model = merged.model;
    }
    return sua;
  }

  function reset() {
    cache = null;
  }

  prewarm();

  return {
    buildSUA,
    reset,
  };
}
