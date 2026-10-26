import { TEMPLATES } from "../core/templates";
import { useStore } from "../state/store";
import { Dialog } from "../ui/Dialog";

export function TemplatesDialog({ onClose }: { onClose: () => void }) {
  const replace = useStore((s) => s.replace);
  const select = useStore((s) => s.select);
  return (
    <Dialog title="Start from an example" onClose={onClose} wide>
      <ul className="template-grid">
        {TEMPLATES.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className="template"
              onClick={() => {
                replace(t.design);
                select({ kind: "layer", index: 0 });
                onClose();
              }}
            >
              <span className="template-title">{t.title}</span>
              <span className="template-summary">{t.summary}</span>
              <span className="template-look">{t.look}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
