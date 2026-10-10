import { enableInertialCamera } from '@dsanchez31/cesium-sgp4-viewer';
import type { Viewer } from 'cesium';
import { useCallback, useState } from 'react';

import { createViewer, trackToolbarHeight } from '../../../shared/viewer';

/**
 * Creates a Cesium viewer in the element the returned ref is attached to, and
 * destroys it when the element goes away. The viewer owns a WebGL context:
 * one per mount, released on unmount.
 */
export const useViewer = () => {
  const [viewer, setViewer] = useState<Viewer | null>(null);

  const ref = useCallback((container: HTMLDivElement | null) => {
    if (!container) return;
    const created = createViewer(container);
    const releaseCamera = enableInertialCamera(created.scene);
    const releaseToolbar = trackToolbarHeight();
    setViewer(created);
    return () => {
      releaseToolbar();
      releaseCamera();
      created.destroy();
      setViewer(null);
    };
  }, []);

  return [ref, viewer] as const;
};
