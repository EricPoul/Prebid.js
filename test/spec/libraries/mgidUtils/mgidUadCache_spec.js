import { expect } from 'chai';
import { createMgidUadCache } from 'libraries/mgidUtils/mgidUadCache.js';

describe('mgidUtils: mgidUadCache', function () {
  const ORIGINAL_UAD = window.navigator.userAgentData;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const setUserAgentData = (value) => window.navigator.__defineGetter__('userAgentData', () => value);

  afterEach(function () {
    setUserAgentData(ORIGINAL_UAD);
  });

  describe('prewarm: high-entropy fetch + persist to _mgPbUadCache', function () {
    it('persists high-entropy hints to _mgPbUadCache when getHighEntropyValues resolves', async function () {
      let persisted = null;
      const fakeStorage = {
        getDataFromLocalStorage: () => null,
        setDataInLocalStorage: (k, v) => { if (k === '_mgPbUadCache') persisted = v; },
      };
      setUserAgentData({
        brands: [],
        mobile: false,
        platform: 'Android',
        getHighEntropyValues: () => Promise.resolve({
          architecture: 'arm',
          bitness: '64',
          model: 'Pixel 9',
          platformVersion: '14',
          fullVersionList: [{ brand: 'Chrome', version: '149.0.0.0' }],
          wow64: false,
        }),
      });

      createMgidUadCache(fakeStorage); // prewarm() fires getHighEntropyValues at construction
      await flush();

      expect(persisted, '_mgPbUadCache should be written').to.be.a('string');
      const obj = JSON.parse(persisted);
      expect(obj.architecture).to.equal('arm');
      expect(obj.bitness).to.equal('64');
      expect(obj.model).to.equal('Pixel 9');
      expect(obj.platformVersion).to.equal('14');
    });

    it('does not throw or persist when getHighEntropyValues rejects', async function () {
      let writeCount = 0;
      const fakeStorage = {
        getDataFromLocalStorage: () => null,
        setDataInLocalStorage: () => { writeCount += 1; },
      };
      setUserAgentData({
        brands: [],
        mobile: false,
        platform: 'Android',
        getHighEntropyValues: () => Promise.reject(new Error('denied')),
      });

      expect(() => createMgidUadCache(fakeStorage)).to.not.throw();
      await flush();
      expect(writeCount).to.equal(0);
    });
  });

  describe('warm-start: cache seeded from localStorage on factory creation', function () {
    it('should expose previously persisted high-entropy fields (architecture, bitness, model) on the first buildSUA call', function () {
      const cached = JSON.stringify({ architecture: 'arm', bitness: '64', model: 'Pixel 9' });
      const fakeStorage = {
        getDataFromLocalStorage: (k) => (k === '_mgPbUadCache' ? cached : null),
        setDataInLocalStorage: () => {},
      };
      const uad = createMgidUadCache(fakeStorage);
      setUserAgentData(undefined);

      const sua = uad.buildSUA(undefined);
      expect(sua.architecture).to.equal('arm');
      expect(sua.bitness).to.equal('64');
      expect(sua.model).to.equal('Pixel 9');
    });

    it('should not emit any high-entropy fields when localStorage has no prior cache entry', function () {
      const fakeStorage = {
        getDataFromLocalStorage: () => null,
        setDataInLocalStorage: () => {},
      };
      const uad = createMgidUadCache(fakeStorage);
      setUserAgentData(undefined);

      const sua = uad.buildSUA(undefined);
      expect(sua).to.not.have.property('architecture');
      expect(sua).to.not.have.property('bitness');
      expect(sua).to.not.have.property('model');
    });

    it('should ignore corrupted JSON in _mgPbUadCache and leave cache empty', function () {
      const fakeStorage = {
        getDataFromLocalStorage: (k) => (k === '_mgPbUadCache' ? '{not-valid' : null),
        setDataInLocalStorage: () => {},
      };
      const uad = createMgidUadCache(fakeStorage);
      setUserAgentData(undefined);

      const sua = uad.buildSUA(undefined);
      expect(sua).to.not.have.property('architecture');
      expect(sua).to.not.have.property('bitness');
    });
  });
});
