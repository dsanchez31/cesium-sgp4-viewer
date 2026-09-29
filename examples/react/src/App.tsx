import { parseTleCatalog, type Satellite, type TleCatalog } from '@dsanchez31/cesium-sgp4-viewer';
import { Cartographic } from 'cesium';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { scrubTo } from '../../shared/clock';
import { searchPredicate } from '../../shared/format';
import { setFramesPerSecond, setLighting } from '../../shared/viewer';
import { Details } from './components/Details';
import { Timeline } from './components/Timeline';
import { Toolbar } from './components/Toolbar';
import { Transport } from './components/Transport';
import { useClockState } from './hooks/useClockState';
import { type LayerSettings, useSatelliteLayer } from './hooks/useSatelliteLayer';
import { useViewer } from './hooks/useViewer';

const INITIAL_SETTINGS: LayerSettings = {
  orbits: false,
  labels: 'hover',
  regimes: null,
  query: '',
};

const fetchCatalog = async (): Promise<TleCatalog> => {
  const response = await fetch(`${import.meta.env.BASE_URL}tle.txt`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseTleCatalog(await response.text());
};

export const App = () => {
  const [globeRef, viewer] = useViewer();
  const clock = useClockState(viewer);
  const [catalog, setCatalog] = useState<TleCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [is3D, setIs3D] = useState(true);
  const [isLit, setIsLit] = useState(false);
  const [isFpsShown, setIsFpsShown] = useState(false);

  useEffect(() => {
    fetchCatalog().then(setCatalog, (error: unknown) => {
      setLoadError(`Could not load tle.txt: ${String(error)}`);
    });
  }, []);

  const { layerRef, selected, status, error } = useSatelliteLayer(
    viewer,
    catalog?.satellites ?? null,
    settings,
  );

  // Counted here rather than read off the layer, so rendering stays pure.
  const visibleCount = useMemo(() => {
    if (!catalog) return 0;
    const matches = searchPredicate(settings.query);
    const { regimes } = settings;
    return catalog.satellites.filter(
      (s) => (!regimes || regimes.includes(s.regime)) && (!matches || matches(s)),
    ).length;
  }, [catalog, settings]);

  const altitudeOf = useCallback(
    (satellite: Satellite) => {
      const position = layerRef.current?.positionOf(satellite.noradId);
      return position ? Cartographic.fromCartesian(position).height : undefined;
    },
    [layerRef],
  );

  const onModeChange = (next: boolean) => {
    if (!viewer) return;
    if (next) viewer.scene.morphTo3D(0.8);
    else viewer.scene.morphTo2D(0.8);
    setIs3D(next);
  };

  const onLightingChange = (next: boolean) => {
    if (!viewer) return;
    setLighting(viewer, next);
    setIsLit(next);
  };

  const onFpsChange = (next: boolean) => {
    if (!viewer) return;
    setFramesPerSecond(viewer, next);
    setIsFpsShown(next);
  };

  const onFile = (file: File) => {
    file.text().then(
      (text) => setCatalog(parseTleCatalog(text)),
      (reason: unknown) => setLoadError(`Could not read ${file.name}: ${String(reason)}`),
    );
  };

  const stats = (() => {
    if (loadError) return loadError;
    if (error) return `Propagation failed: ${error.message}`;
    if (!catalog) return 'Loading…';
    const parts = [
      `${visibleCount.toLocaleString('en-US')} / ${catalog.satellites.length.toLocaleString('en-US')} satellites`,
    ];
    if (catalog.rejected.length > 0) parts.push(`${catalog.rejected.length} TLE rejected`);
    if (status && status.failed > 0) parts.push(`${status.failed} not propagable`);
    return parts.join(' · ');
  })();

  return (
    <>
      <div id="globe" ref={globeRef} />
      <Toolbar
        settings={settings}
        onSettingsChange={setSettings}
        is3D={is3D}
        onModeChange={onModeChange}
        isLit={isLit}
        onLightingChange={onLightingChange}
        isFpsShown={isFpsShown}
        onFpsChange={onFpsChange}
        onFile={onFile}
        stats={stats}
      />
      {viewer && selected && (
        <Details
          viewer={viewer}
          satellite={selected}
          altitudeOf={altitudeOf}
          onClose={() => layerRef.current?.select(null)}
        />
      )}
      {viewer && clock && (
        <footer className="panel transport">
          <Transport viewer={viewer} clock={clock} />
          <Timeline ms={clock.ms} onScrub={(ms) => scrubTo(viewer, ms)} />
        </footer>
      )}
    </>
  );
};
