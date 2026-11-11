// Context menu: one at a time, shown at the pointer, closed by a pick, Escape or a click elsewhere.

import { useEffect, useRef, useSyncExternalStore } from 'react';

export interface MenuItem {
  label: string;
  disabled?: boolean;
  /** Draw a separator above this item. */
  separator?: boolean;
  run(): void;
}

let current: { x: number; y: number; items: MenuItem[] } | null = null;
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  current = { x, y, items };
  changed();
}

export function hideMenu(): void {
  if (!current) return;
  current = null;
  changed();
}

/** Renders the open menu. Mount once, at the app root. */
export function MenuHost() {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  const ref = useRef<HTMLDivElement>(null);
  const menu = current;

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && ref.current?.contains(e.target as Node)) return;
      hideMenu();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('blur', hideMenu);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('blur', hideMenu);
    };
  }, [menu]);

  // Keep the menu inside the window.
  useEffect(() => {
    const el = ref.current;
    if (!el || !menu) return;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4))}px`;
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.preventDefault()}>
      {menu.items.map((item, index) => (
        <div key={index}>
          {item.separator && <div className="context-menu-separator" />}
          <button
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              hideMenu();
              item.run();
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
