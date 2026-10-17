import { useEffect, useRef, type ReactNode } from "react";

/** Anchored panel that closes on Escape or an outside press and restores focus. */
export function Popover({
  label,
  onClose,
  children,
  className = "",
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    (node?.querySelector<HTMLElement>("input, button, [tabindex='0']") ?? node)?.focus();
    const outside = (e: PointerEvent) => {
      if (node && !node.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    <div ref={ref} role="dialog" aria-label={label} className={`popover ${className}`} tabIndex={-1}>
      {children}
    </div>
  );
}
