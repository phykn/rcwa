import { useEffect, useRef, type ReactNode } from "react";

/** Native modal dialog: focus containment, Escape and backdrop close come free. */
export function Dialog({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal?.();
    return () => opener?.focus?.();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? " dialog-wide" : ""}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close">
          Close
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
