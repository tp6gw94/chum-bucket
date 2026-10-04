import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "cn";

const MIN_WIDTH = 320;
const MAX_WIDTH = 960;
const KEYBOARD_STEP = 24;
const COARSE_KEYBOARD_STEP = 64;

function clampWidth(width: number) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

type WidthTransform = (width: number, step: number) => number;

const WIDTH_KEYS: Record<string, WidthTransform> = {
  ArrowLeft: (width, step) => clampWidth(width - step),
  ArrowRight: (width, step) => clampWidth(width + step),
  Home: () => MIN_WIDTH,
  End: () => MAX_WIDTH,
};

function ownTransform(key: string): WidthTransform | undefined {
  if (!Object.hasOwn(WIDTH_KEYS, key)) {
    return undefined;
  }
  return WIDTH_KEYS[key];
}

export function PaneShell({
  label,
  defaultWidth,
  children,
}: {
  label: string;
  defaultWidth: number;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(defaultWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) {
      return;
    }
    const delta = event.clientX - dragRef.current.startX;
    setWidth(clampWidth(dragRef.current.startWidth + delta));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? COARSE_KEYBOARD_STEP : KEYBOARD_STEP;
    const transform = ownTransform(event.key);
    if (!transform) {
      return;
    }
    event.preventDefault();
    setWidth((current) => transform(current, step));
  }

  return (
    <section
      aria-label={label}
      style={{ "--pane-width": `${width}px` } as CSSProperties}
      className={cn(
        "relative flex w-full shrink-0 snap-start flex-col border-l bg-background first:border-l-0",
        "lg:w-[var(--pane-width)]",
      )}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`調整「${label}」寬度`}
        aria-valuenow={Math.round(width)}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
        className={cn(
          "absolute inset-y-0 right-0 hidden w-1.5 cursor-col-resize touch-none select-none",
          "bg-transparent hover:bg-ring/40 focus-visible:bg-ring focus-visible:outline-none lg:block",
        )}
      />
    </section>
  );
}
