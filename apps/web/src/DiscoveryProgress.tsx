import type { CapabilityObservation } from '@waleed/contracts';
import type { ManagedConnector } from './ConnectorList.js';
import { discoveryProgress } from './discovery-progress.js';

// How far the automatic tool discovery of the eligible connectors has come.
// The bar is hidden while no connector is eligible for the discovery.
export function DiscoveryProgress({
  connectors,
  observations,
}: {
  connectors: ManagedConnector[];
  observations: CapabilityObservation[];
}) {
  const progress = discoveryProgress(connectors, observations);
  if (progress.eligible === 0) return null;
  const complete = progress.settled === progress.eligible;
  return (
    <div
      className={`discovery-progress ${complete ? 'is-complete' : 'is-loading'}`}
      data-testid="discovery-progress"
    >
      <div className="discovery-progress-text">
        {complete
          ? `Tools loaded · ${progress.eligible} connectors · ${progress.tools} tools`
          : `Loading tools · ${progress.settled} of ${progress.eligible} connectors · ${progress.percent} %`}
        {complete && progress.needsAttention > 0 && (
          <> · {progress.needsAttention} need attention</>
        )}
      </div>
      <div
        className="discovery-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-label="Tool loading progress"
      >
        <div
          className="discovery-progress-fill"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      {/* The text line above is not a live region: it would announce every
          tick. Only the start and the end of the discovery are announced. */}
      <p className="sr-only" role="status">
        {complete
          ? `Tool loading finished. ${progress.eligible} connectors, ${progress.tools} tools.`
          : 'Tool loading started.'}
      </p>
    </div>
  );
}
