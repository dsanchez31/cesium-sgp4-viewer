import type { LabelMode } from '@dsanchez31/cesium-sgp4-viewer';

import type { LayerSettings } from '../hooks/useSatelliteLayer';
import { RegimeFilter } from './RegimeFilter';

interface ToolbarProps {
  settings: LayerSettings;
  onSettingsChange: (settings: LayerSettings) => void;
  is3D: boolean;
  onModeChange: (is3D: boolean) => void;
  isLit: boolean;
  onLightingChange: (isLit: boolean) => void;
  isFpsShown: boolean;
  onFpsChange: (isFpsShown: boolean) => void;
  onFile: (file: File) => void;
  stats: string;
}

/** Search, regime filter, projection, orbits, labels and file loading. */
export const Toolbar = ({
  settings,
  onSettingsChange,
  is3D,
  onModeChange,
  isLit,
  onLightingChange,
  isFpsShown,
  onFpsChange,
  onFile,
  stats,
}: ToolbarProps) => {
  const update = (patch: Partial<LayerSettings>) => onSettingsChange({ ...settings, ...patch });

  return (
    <header className="panel toolbar">
      <input
        type="search"
        placeholder="Name or NORAD ID"
        aria-label="Search satellites"
        value={settings.query}
        onChange={(event) => update({ query: event.target.value })}
      />
      <RegimeFilter value={settings.regimes} onChange={(regimes) => update({ regimes })} />
      <div className="group" role="group" aria-label="Projection">
        <button type="button" aria-pressed={is3D} onClick={() => onModeChange(true)}>
          3D
        </button>
        <button type="button" aria-pressed={!is3D} onClick={() => onModeChange(false)}>
          2D
        </button>
      </div>
      <button
        type="button"
        aria-pressed={settings.orbits}
        onClick={() => update({ orbits: !settings.orbits })}
      >
        Orbits
      </button>
      <button type="button" aria-pressed={isLit} onClick={() => onLightingChange(!isLit)}>
        Lighting
      </button>
      <button type="button" aria-pressed={isFpsShown} onClick={() => onFpsChange(!isFpsShown)}>
        FPS
      </button>
      <label className="select">
        Labels
        <select
          value={settings.labels}
          onChange={(event) => update({ labels: event.target.value as LabelMode })}
        >
          <option value="none">None</option>
          <option value="hover">Hover</option>
          <option value="all">All</option>
        </select>
      </label>
      <label className="file">
        Load TLEs…
        <input
          type="file"
          accept=".txt,.tle,.3le,text/plain"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFile(file);
          }}
        />
      </label>
      <output className="stats">{stats}</output>
    </header>
  );
};
