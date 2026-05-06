import { expect } from 'chai';
import { createMgidSessionStorage, SESSION_BOUNDARY_MS } from 'libraries/mgidUtils/mgidSessionStorage.js';

describe('mgidUtils: mgidSessionStorage', function () {
  let ls;
  let setLocal;
  let setSession;
  let mgidSession;
  const writeCall = (key) => setLocal.getCalls().find((c) => c.args[0] === key);

  // Fake storage: reads from `ls`; the setLocal spy records writes and mirrors them into `ls`.
  const fakeStorage = {
    getDataFromLocalStorage: (k) => (ls && (k in ls) ? ls[k] : null),
    setDataInLocalStorage: (k, v) => setLocal(k, v),
    getDataFromSessionStorage: () => null,
    setDataInSessionStorage: (k, v) => setSession(k, v),
  };

  before(function () {
    mgidSession = createMgidSessionStorage(fakeStorage);
  });

  beforeEach(function () {
    ls = {};
    setLocal = sinon.spy((k, v) => { ls[k] = v; });
    setSession = sinon.spy();
    mgidSession.reset();
    delete window._mgPvid;
    delete window._mgPvidList;
    delete window._mgPbSessionPages;
  });

  describe('calculatePageSession', function () {
    it('should create a new session when no prior state exists', function () {
      mgidSession.calculatePageSession();

      expect(writeCall('_mgPbSessionId').args[1]).to.match(/^[0-9a-f]+-[0-9a-f]{5}$/);
      expect(writeCall('_mgPbSessionPagesNumber').args[1]).to.equal('1');
      const list = JSON.parse(writeCall('_mgPbSessionsTimeList').args[1]);
      expect(list).to.have.lengthOf(1);
      expect(list[0]).to.be.closeTo(Date.now(), 1000);
    });

    it('should keep sessionId and tail-refresh list when within 30 min', function () {
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      ls._mgPbSessionId = 'sid-existing';
      ls._mgPbSessionPagesNumber = '5';
      ls._mgPbSessionsTimeList = JSON.stringify([tenMinAgo]);
      window._mgPbSessionPages = [window.location.pathname];

      mgidSession.calculatePageSession();

      expect(writeCall('_mgPbSessionId').args[1]).to.equal('sid-existing');
      expect(writeCall('_mgPbSessionPagesNumber').args[1]).to.equal('5');
      const list = JSON.parse(writeCall('_mgPbSessionsTimeList').args[1]);
      expect(list).to.have.lengthOf(1);
      expect(list[0]).to.be.closeTo(Date.now(), 1000);
    });

    it('should start a new session when last activity was > 30 min ago', function () {
      const oldTime = Date.now() - (SESSION_BOUNDARY_MS + 60 * 1000);
      ls._mgPbSessionId = 'sid-old';
      ls._mgPbSessionPagesNumber = '10';
      ls._mgPbSessionsTimeList = JSON.stringify([oldTime]);

      mgidSession.calculatePageSession();

      expect(writeCall('_mgPbSessionId').args[1]).to.not.equal('sid-old');
      expect(writeCall('_mgPbSessionPagesNumber').args[1]).to.equal('1');
      const list = JSON.parse(writeCall('_mgPbSessionsTimeList').args[1]);
      expect(list).to.have.lengthOf(2);
    });

    it('should drop session-start timestamps older than 30 days', function () {
      const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
      const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      ls._mgPbSessionId = 'sid-existing';
      ls._mgPbSessionPagesNumber = '3';
      ls._mgPbSessionsTimeList = JSON.stringify([fortyDaysAgo, tenDaysAgo, fiveMinAgo]);
      window._mgPbSessionPages = [window.location.pathname];

      mgidSession.calculatePageSession();

      const list = JSON.parse(writeCall('_mgPbSessionsTimeList').args[1]);
      expect(list).to.not.include(fortyDaysAgo);
      expect(list).to.include(tenDaysAgo);
      expect(list).to.have.lengthOf(2);
      expect(writeCall('_mgPbSessionId').args[1]).to.equal('sid-existing');
    });

    it('should write the pagePath dedup list to a window global, not persistent storage', function () {
      mgidSession.calculatePageSession();

      expect(setSession.called).to.equal(false);
      expect(window._mgPbSessionPages).to.deep.equal([window.location.pathname]);
    });

    it('should run only once per pagePath; subsequent same-path calls are no-ops', function () {
      mgidSession.calculatePageSession();
      mgidSession.calculatePageSession();
      mgidSession.calculatePageSession();

      const idCalls = setLocal.getCalls().filter((c) => c.args[0] === '_mgPbSessionId');
      expect(idCalls).to.have.lengthOf(1);
    });

    it('should bump sessionPage when window pagePaths is empty and session is within 30 min', function () {
      const recent = Date.now() - 5 * 60 * 1000;
      ls._mgPbSessionId = 'sid-keep';
      ls._mgPbSessionPagesNumber = '7';
      ls._mgPbSessionsTimeList = JSON.stringify([recent]);

      mgidSession.calculatePageSession();

      expect(writeCall('_mgPbSessionPagesNumber').args[1]).to.equal('8');
      expect(writeCall('_mgPbSessionId').args[1]).to.equal('sid-keep');
      expect(window._mgPbSessionPages).to.deep.equal([window.location.pathname]);
    });

    it('should bump sessionPage when current pagePath is not in window pagePaths list', function () {
      const recent = Date.now() - 5 * 60 * 1000;
      ls._mgPbSessionId = 'sid-keep';
      ls._mgPbSessionPagesNumber = '3';
      ls._mgPbSessionsTimeList = JSON.stringify([recent]);
      window._mgPbSessionPages = ['/some/other/path'];

      mgidSession.calculatePageSession();

      expect(writeCall('_mgPbSessionPagesNumber').args[1]).to.equal('4');
      expect(window._mgPbSessionPages).to.deep.equal(['/some/other/path', window.location.pathname]);
    });

    it('should not bump sessionPage when current pagePath is already in window pagePaths list', function () {
      const recent = Date.now() - 5 * 60 * 1000;
      ls._mgPbSessionId = 'sid-keep';
      ls._mgPbSessionPagesNumber = '5';
      ls._mgPbSessionsTimeList = JSON.stringify([recent]);
      window._mgPbSessionPages = [window.location.pathname, '/some/other/path'];

      mgidSession.calculatePageSession();

      expect(writeCall('_mgPbSessionPagesNumber').args[1]).to.equal('5');
      expect(window._mgPbSessionPages).to.deep.equal([window.location.pathname, '/some/other/path']);
    });
  });

  describe('getOrCreatePvid', function () {
    it('should generate a UUIDv4 PVID and cache it on window', function () {
      const pvid = mgidSession.getOrCreatePvid();
      expect(pvid).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(window._mgPvid).to.equal(pvid);
      expect(window._mgPvidList).to.include(window.location.pathname);
    });

    it('should reuse the same PVID for repeated calls on the same pagePath', function () {
      const first = mgidSession.getOrCreatePvid();
      const second = mgidSession.getOrCreatePvid();
      expect(second).to.equal(first);
    });

    it('should reuse PVID set earlier by widget-builder on the same page', function () {
      window._mgPvid = 'wb-pvid-123';
      window._mgPvidList = [window.location.pathname];
      expect(mgidSession.getOrCreatePvid()).to.equal('wb-pvid-123');
    });

    it('should regenerate PVID for a new pagePath', function () {
      window._mgPvid = 'old-pvid';
      window._mgPvidList = ['/some/other/path'];
      const pvid = mgidSession.getOrCreatePvid();
      expect(pvid).to.not.equal('old-pvid');
      expect(pvid).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(window._mgPvidList).to.include(window.location.pathname);
    });

    it('should regenerate PVID when path is in list but _mgPvid is missing', function () {
      window._mgPvidList = [window.location.pathname];
      delete window._mgPvid;
      delete window._mgPbSessionPages;
      const pvid = mgidSession.getOrCreatePvid();
      expect(pvid).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(window._mgPvidList.filter((p) => p === window.location.pathname)).to.have.lengthOf(1);
    });
  });

  describe('trackRender / trackView', function () {
    const bid = { creativeId: '12345_creative_x' };

    it('trackRender should increment r in _mgPbViewrate and start a render-session row when global sid exists', function () {
      ls._mgPbSessionId = 'sid-current';

      mgidSession.trackRender(bid);

      const viewrate = JSON.parse(writeCall('_mgPbViewrate').args[1]);
      expect(viewrate['12345'][0].r).to.equal(1);
      expect(viewrate['12345'][0].v).to.equal(0);

      const rendered = JSON.parse(writeCall('_mgPbRenderedSessions').args[1]);
      expect(rendered['12345'].id).to.equal('sid-current');
      expect(rendered['12345'].page).to.equal(1);
      expect(rendered['12345'].list).to.have.lengthOf(1);
    });

    it('trackView should increment v in _mgPbViewrate', function () {
      mgidSession.trackView(bid);

      const viewrate = JSON.parse(writeCall('_mgPbViewrate').args[1]);
      expect(viewrate['12345'][0].v).to.equal(1);
      expect(viewrate['12345'][0].r).to.equal(0);
    });

    it('should accumulate r and v on the same viewrate row across calls', function () {
      mgidSession.trackRender(bid);
      mgidSession.trackView(bid);
      mgidSession.trackRender(bid);

      const viewrate = JSON.parse(ls._mgPbViewrate);
      expect(viewrate['12345']).to.have.lengthOf(1);
      expect(viewrate['12345'][0].r).to.equal(2);
      expect(viewrate['12345'][0].v).to.equal(1);
    });

    it('should no-op when bid has no creativeId', function () {
      mgidSession.trackRender({});
      mgidSession.trackView({});

      expect(setLocal.called).to.equal(false);
    });

    it('trackRender should not bump page when both sid and pvid are unchanged across calls', function () {
      ls._mgPbSessionId = 'sid-current';
      window._mgPvid = 'pvid-stable';

      mgidSession.trackRender(bid);
      mgidSession.trackRender(bid);
      mgidSession.trackRender(bid);

      const rendered = JSON.parse(ls._mgPbRenderedSessions);
      expect(rendered['12345'].id).to.equal('sid-current');
      expect(rendered['12345'].pvid).to.equal('pvid-stable');
      expect(rendered['12345'].page).to.equal(1);
      expect(rendered['12345'].list).to.have.lengthOf(1);
    });

    it('trackRender should bump page when the global sessionId differs from the widgets last seen sid', function () {
      ls._mgPbSessionId = 'sid-new';
      ls._mgPbRenderedSessions = JSON.stringify({ '12345': { id: 'sid-old', pvid: 'pvid-same', page: 2, list: [Date.now() - 60000] } });
      window._mgPvid = 'pvid-same';

      mgidSession.trackRender(bid);

      const rendered = JSON.parse(writeCall('_mgPbRenderedSessions').args[1]);
      expect(rendered['12345'].id).to.equal('sid-new');
      expect(rendered['12345'].page).to.equal(3);
      expect(rendered['12345'].list).to.have.lengthOf(2);
    });

    it('trackRender should bump page when the pvid differs from the widgets last seen pvid', function () {
      ls._mgPbSessionId = 'sid-same';
      ls._mgPbRenderedSessions = JSON.stringify({ '12345': { id: 'sid-same', pvid: 'pvid-old', page: 4, list: [Date.now() - 60000] } });
      window._mgPvid = 'pvid-new';

      mgidSession.trackRender(bid);

      const rendered = JSON.parse(writeCall('_mgPbRenderedSessions').args[1]);
      expect(rendered['12345'].pvid).to.equal('pvid-new');
      expect(rendered['12345'].page).to.equal(5);
      expect(rendered['12345'].list).to.have.lengthOf(2);
    });

    it('trackRender should drop list entries older than 30 days', function () {
      const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000;
      ls._mgPbSessionId = 'sid-new';
      ls._mgPbRenderedSessions = JSON.stringify({ '12345': { id: 'sid-old', page: 5, list: [ancient, Date.now() - 60000] } });

      mgidSession.trackRender(bid);

      const rendered = JSON.parse(writeCall('_mgPbRenderedSessions').args[1]);
      expect(rendered['12345'].list).to.have.lengthOf(2);
      expect(rendered['12345'].list.every((t) => t > ancient)).to.equal(true);
    });

    it('trackRender should do nothing when no global session id exists', function () {
      mgidSession.trackRender(bid);

      expect(writeCall('_mgPbRenderedSessions')).to.be.undefined;
    });
  });

  describe('pruneViewrate', function () {
    it('should drop rows older than 7 days and keep recent rows regardless of v/r values', function () {
      const now = Date.now();
      const ancient = now - 8 * 24 * 60 * 60 * 1000;
      ls._mgPbViewrate = JSON.stringify({
        'kept-recent-full': [{ id: 'a', st: now, v: 2, r: 3 }],
        'kept-recent-partial': [
          { id: 'b1', st: now, v: 0, r: 1 },
          { id: 'b2', st: now, v: 1, r: 0 },
        ],
        'all-ancient': [{ id: 'c', st: ancient, v: 5, r: 5 }],
        'mixed': [
          { id: 'd-old', st: ancient, v: 2, r: 2 },
          { id: 'd-fresh', st: now, v: 0, r: 1 },
        ],
      });

      mgidSession.pruneViewrate();

      const after = JSON.parse(writeCall('_mgPbViewrate').args[1]);
      expect(after).to.have.all.keys('kept-recent-full', 'kept-recent-partial', 'mixed');
      expect(after['kept-recent-full']).to.have.lengthOf(1);
      expect(after['kept-recent-partial']).to.have.lengthOf(2);
      expect(after['mixed']).to.have.lengthOf(1);
      expect(after['mixed'][0].id).to.equal('d-fresh');
    });

    it('should not write back when there is nothing older than 7 days to drop', function () {
      const now = Date.now();
      ls._mgPbViewrate = JSON.stringify({
        'a': [{ id: 'x', st: now, v: 1, r: 1 }],
        'b': [{ id: 'y', st: now, v: 0, r: 1 }],
      });

      mgidSession.pruneViewrate();

      expect(writeCall('_mgPbViewrate')).to.be.undefined;
    });
  });

  describe('error resilience', function () {
    it('should return null from getWidgetsData when the stored widget JSON is corrupted', function () {
      ls._mgPbViewrate = 'not json';
      ls._mgPbRenderedSessions = '{{not json';

      expect(mgidSession.getWidgetsData()).to.be.null;
    });

    it('should treat corrupted _mgPbSessionsTimeList JSON as empty list', function () {
      ls._mgPbSessionsTimeList = 'broken';

      expect(mgidSession.getSessionInfo().sessionNum).to.equal(0);
      expect(() => mgidSession.calculatePageSession()).to.not.throw();
    });
  });
});
