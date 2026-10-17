import type { ProposalReview } from "../core/proposal";
import { useStore } from "../state/store";
import { Dialog } from "../ui/Dialog";

/** Review an imported dimension proposal before applying it as one undo step. */
export function ProposalDialog({ review, onClose }: { review: ProposalReview; onClose: () => void }) {
  const edit = useStore((s) => s.edit);
  const notify = useStore((s) => s.notify);
  return (
    <Dialog title="Review proposed changes" onClose={onClose}>
      {review.diff.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Input</th>
                <th scope="col">Now</th>
                <th scope="col">Proposed</th>
              </tr>
            </thead>
            <tbody>
              {review.diff.map((d) => (
                <tr key={d.path}>
                  <th scope="row">{d.path}</th>
                  <td>{Object.is(d.before, -0) ? "-0" : d.before}</td>
                  <td>{Object.is(d.after, -0) ? "-0" : d.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-note">This proposal changes nothing.</p>
      )}
      {review.reported.length > 0 && (
        <>
          <p className="section-note">Notes in the file (not verified here):</p>
          <ul className="details">
            {review.reported.map((d, i) => (
              <li key={i}>
                {d.severity}: {d.message}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="section-note">Only dimensions can change. Applying does not calculate by itself; the usual preview and full calculation follow.</p>
      <div className="analysis-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!review.diff.length}
          onClick={() => {
            edit(() => review.candidate);
            notify(`Applied ${review.diff.length} proposed ${review.diff.length === 1 ? "change" : "changes"}.`);
            onClose();
          }}
        >
          Apply changes
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
