import { useEffect, useState } from "react";
import { deleteSaved, listSaved, saveDesign, type SavedDesign } from "../state/library";
import { useStore } from "../state/store";
import { Dialog } from "../ui/Dialog";

export function LibraryDialog({ onClose }: { onClose: () => void }) {
  const design = useStore((s) => s.design);
  const full = useStore((s) => s.full);
  const key = useStore((s) => s.key);
  const replace = useStore((s) => s.replace);
  const overlays = useStore((s) => s.overlays);
  const toggleOverlay = useStore((s) => s.toggleOverlay);
  const notify = useStore((s) => s.notify);
  const [items, setItems] = useState<SavedDesign[] | null>(null);
  const refresh = () => void listSaved().then(setItems);
  useEffect(refresh, []);
  const current = full?.key === key ? full.result : null;
  return (
    <Dialog title="Saved designs" onClose={onClose} wide>
      <div className="library-save">
        <p>
          Saved in this browser only. {current ? "The current spectrum is saved with it." : "No up-to-date spectrum will be saved."}
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            await saveDesign(design, current);
            notify(`Saved “${design.name}”`);
            refresh();
          }}
        >
          Save current design
        </button>
      </div>
      {items === null ? (
        <p className="empty-note">Loading…</p>
      ) : !items.length ? (
        <p className="empty-note">Nothing saved yet. Saved designs can be reopened or overlaid on the spectrum.</p>
      ) : (
        <ul className="library-list">
          {items.map((item) => {
            const shown = overlays.some((o) => o.id === item.id);
            return (
              <li key={item.id}>
                <div>
                  <div className="library-name">{item.name}</div>
                  <div className="library-meta">
                    {new Date(item.savedAt).toLocaleString()} · {item.design.layers.length} layers
                    {item.result ? " · with spectrum" : ""}
                  </div>
                </div>
                <div className="library-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      replace(item.design, item.result);
                      onClose();
                    }}
                  >
                    Open
                  </button>
                  {item.result && (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      aria-pressed={shown}
                      onClick={() => toggleOverlay({ id: item.id, label: item.name, result: item.result! })}
                    >
                      {shown ? "Hide overlay" : "Overlay"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-quiet danger"
                    onClick={async () => {
                      await deleteSaved(item.id);
                      refresh();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
