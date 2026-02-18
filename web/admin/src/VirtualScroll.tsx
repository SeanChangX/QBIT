import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';

const OVERSCAN = 4;
const VIRTUAL_LIST_HEIGHT = 400;
const LIST_ROW_HEIGHT = 56;
const BAN_ROW_HEIGHT = 48;

interface VirtualListProps {
  itemCount: number;
  itemHeight: number;
  containerHeight: number;
  children: (index: number) => ReactNode;
  empty?: ReactNode;
}

export function VirtualList({
  itemCount,
  itemHeight,
  containerHeight,
  children,
  empty,
}: VirtualListProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const rafRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) setScrollTop(el.scrollTop);
      rafRef.current = null;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (itemCount === 0) {
    return (
      <div className="admin-virtual-empty admin-scroll-list">
        {empty ?? <div className="empty-msg">No items</div>}
      </div>
    );
  }

  const totalHeight = itemCount * itemHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - OVERSCAN);
  const visibleCount = Math.ceil(containerHeight / itemHeight) + 2 * OVERSCAN;
  const endIndex = Math.min(itemCount, startIndex + visibleCount);

  const items: ReactNode[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    items.push(
      <div
        key={i}
        className="admin-virtual-row"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: i * itemHeight,
          height: itemHeight,
          boxSizing: 'border-box',
        }}
      >
        {children(i)}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="admin-virtual-list admin-scroll-list"
      style={{ height: containerHeight, overflow: 'auto' }}
      onScroll={handleScroll}
    >
      <div style={{ position: 'relative', height: totalHeight, minHeight: 1 }}>
        {items}
      </div>
    </div>
  );
}

export const VIRTUAL_CONTAINER_HEIGHT = VIRTUAL_LIST_HEIGHT;
export const VIRTUAL_LIST_ROW_HEIGHT = LIST_ROW_HEIGHT;
export const VIRTUAL_BAN_ROW_HEIGHT = BAN_ROW_HEIGHT;
