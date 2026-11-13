/**
 * OpenCode Progress Plugin - GUI Bundle (./gui-experimental)
 *
 * Runs in desktop app windows. Renders a floating progress indicator
 * panel in the top-right corner of the screen, showing active and
 * recently completed progress entries from agents.
 *
 * Exports a `setup(context)` function that returns a Preact component.
 * The component reads progress state from the plugin's storage (shared
 * with the progress-mcp-server) and re-renders when entries change.
 *
 * No build step required: uses Preact's h() and hooks directly instead of JSX.
 */

const { h, useState, useEffect } = require('preact');

const STATUS_CONFIG = {
  running: { color: '#3b82f6', label: 'Running', pulse: true },
  done: { color: '#10b981', label: 'Done', pulse: false },
  error: { color: '#ef4444', label: 'Error', pulse: false },
  waiting: { color: '#f59e0b', label: 'Waiting', pulse: true },
};

function readProgressStateFromStorage(apis) {
  try {
    const store = apis.storage?.('progress-plugin', 'progress');
    if (store) {
      const state = store();
      return state.entries || {};
    }
  } catch (e) {}
  return {};
}

function ProgressIndicator(entry) {
  const config = STATUS_CONFIG[entry.status] || STATUS_CONFIG.running;
  const pct = entry.progress != null ? Math.round(entry.progress * 100) : null;
  const elapsed = entry.updatedAt
    ? Math.round((Date.now() - entry.updatedAt) / 1000) + 's ago'
    : '';

  const dotStyle = {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: config.color,
    animation: config.pulse ? 'oc-pulse 2s infinite ease-in-out' : 'none',
    flexShrink: 0,
  };

  const itemStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderRadius: '8px',
    background: 'var(--v2-panel-bg, #ffffff)',
    border: `1px solid ${config.color}30`,
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    marginBottom: '8px',
    fontSize: '13px',
    pointerEvents: 'auto',
    backdropFilter: 'blur(8px)',
  };

  const contentStyle = { flex: 1, minWidth: 0 };

  const titleStyle = {
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: 'var(--v2-fg-fg-deep, #111)',
  };

  const detailStyle = {
    fontSize: '11px',
    opacity: 0.7,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: 'var(--v2-fg-fg-muted, #666)',
    marginTop: '2px',
  };

  const detailElapsedStyle = {
    fontSize: '11px',
    opacity: 0.5,
    color: 'var(--v2-fg-fg-muted, #666)',
    marginTop: '2px',
  };

  const pctStyle = {
    width: '44px',
    textAlign: 'right',
    fontSize: '11px',
    fontWeight: 600,
    color: config.color,
    flexShrink: 0,
  };

  const children = [
    h('div', { class: 'oc-progress-dot', style: dotStyle }),
    h('div', { style: contentStyle }, [
      h('div', { style: titleStyle }, entry.title),
      entry.detail
        ? h('div', { style: detailStyle }, `${entry.detail} (${elapsed})`)
        : elapsed
        ? h('div', { style: detailElapsedStyle }, elapsed)
        : null,
    ]),
  ];

  if (pct != null) {
    children.push(h('div', { style: pctStyle }, `${pct}%`));
  }

  return h('div', { class: 'oc-progress-item', style: itemStyle }, children);
}

function setup(context) {
  const apis = (context && context.apis) || {};

  return function ProgressPanel() {
    const [entries, setEntries] = useState({});

    useEffect(() => {
      let mounted = true;

      function refresh() {
        if (!mounted) return;
        try {
          const next = readProgressStateFromStorage(apis);
          const changed = JSON.stringify(next) !== JSON.stringify(entries);
          if (changed) setEntries(next);
        } catch (e) {}
      }

      refresh();
      const interval = setInterval(refresh, 2000);
      return () => {
        mounted = false;
        clearInterval(interval);
      };
    }, [apis]);

    const items = Object.values(entries).sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
    );

    if (items.length === 0) return null;

    const active = items.filter(
      (e) => e.status === 'running' || e.status === 'waiting'
    );
    const completed = items.filter(
      (e) => e.status === 'done' || e.status === 'error'
    );

    // Inject pulse animation CSS once
    if (typeof document !== 'undefined' && !document.getElementById('oc-progress-styles')) {
      const style = document.createElement('style');
      style.id = 'oc-progress-styles';
      style.textContent = `
        @keyframes oc-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.15); }
        }
        .oc-progress-item {
          animation: oc-slide-in 0.2s ease-out;
        }
        @keyframes oc-slide-in {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }

    const panels = [
      ...active.map((entry) => ProgressIndicator(entry)),
      ...completed.slice(0, 3).map((entry) => ProgressIndicator(entry)),
    ];

    return h(
      'div',
      {
        style: {
          position: 'fixed',
          top: '14px',
          right: '14px',
          zIndex: 2147483647,
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          pointerEvents: 'none',
          width: '320px',
        },
      },
      panels
    );
  };
}

module.exports = { setup };
