/**
 * OpenCode Progress — Native Status Shims
 *
 * Injects a compact progress summary next to the desktop app's native
 * "Working" / "Thinking" status text. The native indicator is not exposed
 * through a plugin API (it is derived from session status + streaming), so
 * this works at the DOM level and is intentionally defensive: if it cannot
 * find an anchor it silently does nothing.
 *
 * Works two ways:
 *   1. CommonJS:  const { createStatusShim } = require('./status-shim')
 *   2. Browser:   <script src="http://localhost:8765/status-shim.js"></script>
 *      (auto-installs and polls http://localhost:8765/api/progress)
 *
 * This file is also served by progress-gui-server.js at /status-shim.js.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OCProgressStatusShim = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var BAR_WIDTH = 10;
  var STATUS_ORDER = { error: 4, running: 3, waiting: 2, done: 1 };

  function bar(pct) {
    var n = Math.max(0, Math.min(1, pct == null ? 0 : pct));
    var filled = Math.round(n * BAR_WIDTH);
    var out = '';
    for (var i = 0; i < BAR_WIDTH; i++) out += i < filled ? '█' : '░';
    return out;
  }

  function buildTree(entries) {
    var byId = new Map(Object.entries(entries || {}));
    var children = new Map();
    byId.forEach(function (_v, id) {
      children.set(id, []);
    });
    var roots = [];
    byId.forEach(function (entry, id) {
      var pid = entry.parentId;
      if (pid && byId.has(pid)) children.get(pid).push(id);
      else roots.push(id);
    });
    var cmp = function (a, b) {
      var ea = byId.get(a);
      var eb = byId.get(b);
      var s = (STATUS_ORDER[eb.status] || 0) - (STATUS_ORDER[ea.status] || 0);
      if (s !== 0) return s;
      return (eb.updatedAt || 0) - (ea.updatedAt || 0);
    };
    children.forEach(function (arr) {
      arr.sort(cmp);
    });
    roots.sort(cmp);
    function node(id) {
      var e = byId.get(id);
      if (!e) return null;
      return Object.assign({}, e, {
        children: (children.get(id) || []).map(node).filter(Boolean),
      });
    }
    return roots.map(node).filter(Boolean);
  }

  function aggregate(n) {
    if (n.children && n.children.length) {
      var kids = n.children.map(aggregate);
      var statuses = kids.map(function (k) {
        return k.status;
      });
      if (statuses.indexOf('error') !== -1) n.status = 'error';
      else if (statuses.indexOf('running') !== -1) n.status = 'running';
      else if (statuses.indexOf('waiting') !== -1) n.status = 'waiting';
      else if (
        statuses.every(function (s) {
          return s === 'done';
        })
      )
        n.status = 'done';

      var ps = kids
        .map(function (k) {
          return k.progress;
        })
        .filter(function (p) {
          return p != null;
        });
      if (n.progress == null && ps.length) {
        n.progress =
          ps.reduce(function (a, b) {
            return a + b;
          }, 0) / ps.length;
      }
      var activeKids = kids.filter(function (k) {
        return k.status === 'running' || k.status === 'waiting' || k.status === 'error';
      });
      n._activeChild = activeKids[0];
    }
    return n;
  }

  function label(n) {
    var t = n.title || n.id;
    if (n._activeChild) {
      t += ' → ' + (n._activeChild.title || n._activeChild.id);
    }
    return t;
  }

  /**
   * Turn progress entries into a compact one-line summary.
   * Returns '' when nothing is active.
   */
  function summarize(entries, maxItems) {
    if (maxItems == null) maxItems = 2;
    var tree = buildTree(entries).map(aggregate);
    var active = tree.filter(function (n) {
      return n.status === 'running' || n.status === 'waiting' || n.status === 'error';
    });
    if (!active.length) return '';
    return active
      .slice(0, maxItems)
      .map(function (n) {
        var pct = n.progress == null ? 0 : n.progress;
        var done = Math.round(pct * BAR_WIDTH);
        return '[' + bar(pct) + '] ' + done + '/' + BAR_WIDTH + ' · ' + label(n);
      })
      .join('  ·  ');
  }

  var DEFAULT_ANCHORS = [
    // Timeline / composer "Working" / "Thinking" shimmer (most specific)
    '[data-component="text-shimmer"][data-active="true"]',
    // Sidebar inbox "Working" section
    '[data-slot="sidebar-inbox-working"] [data-component="text-shimmer"]',
    '[data-slot="sidebar-inbox-working"]',
    // Per-tab status dot/label
    '[data-slot="tab-status"]',
  ];

  function createStatusShim(options) {
    options = options || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return { dispose: function () {}, refresh: function () {} };

    var getEntries = options.getEntries || function () {
      return {};
    };
    var intervalMs = options.intervalMs || options.refreshMs || 1000;
    var selectors = options.anchorSelectors || DEFAULT_ANCHORS;
    var shimByAnchor = new Map();
    var timer = null;
    var observer = null;
    var applying = false;

    function findAnchors() {
      var set = new Set();
      for (var i = 0; i < selectors.length; i++) {
        var found;
        try {
          found = doc.querySelectorAll(selectors[i]);
        } catch (e) {
          found = [];
        }
        for (var j = 0; j < found.length; j++) set.add(found[j]);
      }
      return Array.from(set);
    }

    function makeShim() {
      var el = doc.createElement('span');
      el.setAttribute('data-oc-progress-shim', '');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText =
        'margin-inline-start:6px;font-size:11px;font-weight:600;opacity:.85;' +
        'white-space:nowrap;font-variant-numeric:tabular-nums;';
      return el;
    }

    function apply() {
      if (applying) return;
      applying = true;
      try {
        var text = summarize(getEntries());
        var anchors = findAnchors();
        var seen = new Set();

        for (var i = 0; i < anchors.length; i++) {
          var anchor = anchors[i];
          seen.add(anchor);
          var el = shimByAnchor.get(anchor);
          if (!el || !el.isConnected) {
            el = makeShim();
            if (anchor.insertAdjacentElement) {
              anchor.insertAdjacentElement('afterend', el);
            } else if (anchor.parentNode) {
              anchor.parentNode.insertBefore(el, anchor.nextSibling);
            } else {
              continue;
            }
            shimByAnchor.set(anchor, el);
          }
          el.textContent = text ? '· ' + text : '';
          el.style.display = text ? '' : 'none';
        }

        // Drop shims whose anchor disappeared
        shimByAnchor.forEach(function (el, anchor) {
          if (!seen.has(anchor) || !anchor.isConnected) {
            el.remove();
            shimByAnchor.delete(anchor);
          }
        });
      } finally {
        applying = false;
      }
    }

    function schedule() {
      if (observer) observer.disconnect();
      apply();
      if (observer) {
        observer.observe(doc.documentElement, { childList: true, subtree: true });
      }
    }

    var pending = null;
    function onMutation() {
      if (pending) return;
      pending = (typeof setTimeout === 'function' ? setTimeout : function (f) { f(); })(
        function () {
          pending = null;
          schedule();
        },
        200
      );
    }

    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(onMutation);
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    }

    timer = setInterval(schedule, intervalMs);
    schedule();

    return {
      refresh: schedule,
      dispose: function () {
        if (timer) clearInterval(timer);
        if (observer) observer.disconnect();
        if (pending && typeof clearTimeout === 'function') clearTimeout(pending);
        shimByAnchor.forEach(function (el) {
          el.remove();
        });
        shimByAnchor.clear();
      },
    };
  }

  // Browser auto-install when loaded as a plain <script> from the GUI server.
  if (typeof window !== 'undefined' && typeof module === 'undefined') {
    if (!window.__ocProgressStatusShim) {
      var entriesRef = { current: {} };
      var url = window.OC_PROGRESS_URL || 'http://localhost:8765/api/progress';
      var intervalMs =
        typeof window.OC_PROGRESS_REFRESH_MS === 'number' && window.OC_PROGRESS_REFRESH_MS >= 100
          ? window.OC_PROGRESS_REFRESH_MS
          : 1000;

      function poll() {
        try {
          fetch(url, { cache: 'no-store' })
            .then(function (r) {
              return r.ok ? r.json() : null;
            })
            .then(function (d) {
              if (d && d.entries) entriesRef.current = d.entries;
            })
            .catch(function () {});
        } catch (e) {}
      }

      poll();
      setInterval(poll, intervalMs);

      window.__ocProgressStatusShim = createStatusShim({
        getEntries: function () {
          return entriesRef.current;
        },
      });
    }
  }

  return { createStatusShim: createStatusShim, summarize: summarize, bar: bar };
});
