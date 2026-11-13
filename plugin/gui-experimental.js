/**
 * OpenCode Progress Plugin - GUI Bundle (./gui-experimental)
 *
 * Runs in desktop app windows. Renders a floating progress indicator
 * panel in the top-right corner of the screen, showing active and
 * recently completed progress entries from agents.
 *
 * Tree-like dependencies (bootvine-inspired):
 *   Entries with a `parentId` are rendered nested under their parent,
   forming a dependency tree:
 *
 *     ├── build [██████░░░░] 6/10 · compiling SDL2
 *     │   └── link-lib [████░░░░░░] 4/10 · linking libSDL2.a
 *     └── npm-install [██████████] 10/10 · done ✓
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

/**
 * Build a dependency tree from flat entries.
 * Returns root nodes (each with nested children).
 */
function buildTree(entries) {
  const byId = new Map(Object.entries(entries));
  const childrenMap = new Map();

  for (const [id] of byId) {
    childrenMap.set(id, []);
  }

  const roots = [];
  for (const [id, entry] of byId) {
    const parentId = entry.parentId;
    if (parentId && byId.has(parentId)) {
      childrenMap.get(parentId).push(id);
    } else {
      roots.push(id);
    }
  }

  // Sort: most severe status first, then by updatedAt desc
  const statusOrder = { error: 4, running: 3, waiting: 2, done: 1 };
  const sortIds = (a, b) => {
    const ea = byId.get(a);
    const eb = byId.get(b);
    const s = statusOrder[eb.status] - statusOrder[ea.status];
    if (s !== 0) return s;
    return (eb.updatedAt || 0) - (ea.updatedAt || 0);
  };

  for (const [id, childIds] of childrenMap) {
    childIds.sort(sortIds);
  }
  roots.sort(sortIds);

  function buildNode(id) {
    const entry = byId.get(id);
    if (!entry) return null;
    const childIds = childrenMap.get(id) || [];
    return {
      ...entry,
      children: childIds.map(buildNode).filter(Boolean),
    };
  }

  return roots.map(buildNode).filter(Boolean);
}

function ProgressIndicator({ entry, depth, isLast, prefix }) {
  const config = STATUS_CONFIG[entry.status] || STATUS_CONFIG.running;
  const pct = entry.progress != null ? Math.round(entry.progress * 100) : null;
  const elapsed = entry.updatedAt
    ? Math.round((Date.now() - entry.updatedAt) / 1000) + 's ago'
    : '';

  // Tree-drawing characters (bootvine-inspired)
  const connector = isLast ? '└── ' : '├── ';
  const indent = prefix + connector;

  const dotStyle = {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: config.color,
    animation: config.pulse ? 'oc-pulse 2s infinite ease-in-out' : 'none',
    flexShrink: 0,
  };

  // Slightly dim child entries
  const opacity = depth > 0 ? 0.85 : 1;

  const itemStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: depth > 0 ? '6px 10px' : '8px 12px',
    paddingLeft: depth > 0 ? 14 + depth * 16 : 12,
    borderRadius: '8px',
    background: depth > 0 ? 'transparent' : 'var(--v2-panel-bg, #ffffff)',
    border: `1px solid ${config.color}30`,
    boxShadow:
      depth === 0 ? '0 4px 12px rgba(0,0,0,0.1)' : 'none',
    marginBottom: '6px',
    fontSize: '13px',
    pointerEvents: 'auto',
    backdropFilter: depth === 0 ? 'blur(8px)' : 'none',
    opacity,
  };

  const contentStyle = { flex: 1, minWidth: 0 };

  const titleStyle = {
    fontWeight: depth === 0 ? 600 : 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: 'var(--v2-fg-fg-deep, #111)',
    opacity: depth > 0 ? 0.9 : 1,
  };

  const detailStyle = {
    fontSize: '11px',
    opacity: depth > 0 ? 0.6 : 0.7,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: 'var(--v2-fg-fg-muted, #666)',
    marginTop: '2px',
  };

  const detailElapsedStyle = {
    fontSize: '11px',
    opacity: depth > 0 ? 0.4 : 0.5,
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

  const entryEl = h('div', { class: 'oc-progress-item', style: itemStyle }, children);

  // Recursively render children with tree prefix
  const childPrefix = prefix + (isLast ? '    ' : '│   ');
  const childEls = (entry.children || []).map((child, i) =>
    ProgressIndicator({
      entry: child,
      depth: depth + 1,
      isLast: i === (entry.children || []).length - 1,
      prefix: childPrefix,
    })
  );

  return h('div', null, entryEl, ...childEls);
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

    const tree = buildTree(entries);

    if (tree.length === 0) return null;

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

    const panels = tree.map((root, i) =>
      ProgressIndicator({
        entry: root,
        depth: 0,
        isLast: i === tree.length - 1,
        prefix: '',
      })
    );

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
          width: '340px',
        },
      },
      panels
    );
  };
}

module.exports = { setup };
