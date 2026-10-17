import { useEffect, useState } from "react";
import type { EngineState } from "../engine";
import { useServices } from "../state/context";
import { useStore } from "../state/store";
import { Dialog } from "../ui/Dialog";
import { Segmented } from "../ui/Segmented";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const { hub } = useServices();
  const [engine, setEngine] = useState<EngineState>(hub.state);
  useEffect(() => hub.subscribe(setEngine), [hub]);
  return (
    <Dialog title="Settings" onClose={onClose}>
      <div className="settings">
        <Segmented
          label="Theme"
          value={settings.theme}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={(theme) => update({ theme })}
        />
        <Segmented
          label="Calculation engine"
          value={settings.engine}
          options={[
            { value: "auto", label: "Automatic" },
            { value: "browser", label: "This browser" },
            { value: "server", label: "Local server" },
          ]}
          onChange={(value) => update({ engine: value })}
        />
        <p className="section-note">
          {engine.serverAvailable
            ? "A local RCWA server is running; automatic mode uses it for full calculations."
            : "No local server found. Calculations run in this browser. Start one with scripts/start_local.py for native speed."}
        </p>
        <label className="toggle">
          <input type="checkbox" checked={settings.autoSolve} onChange={(e) => update({ autoSolve: e.target.checked })} />
          Calculate automatically after each edit
        </label>
        <label className="toggle">
          <input type="checkbox" checked={settings.expert} onChange={(e) => update({ expert: e.target.checked })} />
          Show run details (input hashes, solver notes)
        </label>
      </div>
    </Dialog>
  );
}
