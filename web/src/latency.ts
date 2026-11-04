/**
 * Playback latency sampling for the WHEP viewer.
 *
 * Every second we ask the RTCPeerConnection for the inbound RTP and candidate-pair
 * reports and derive:
 *   - jitter buffer delay: `jitterBufferDelay / jitterBufferEmittedCount` (seconds → ms),
 *     i.e. how long a decoded frame waited before playout;
 *   - network RTT: `currentRoundTripTime` of the selected candidate pair
 *     (falling back to `remote-inbound-rtp.roundTripTime`).
 *
 * The displayed estimate is `jitterBuffer + RTT`. Sampling is paused while the tab is
 * hidden and must be stopped with the returned cleanup when the viewer leaves the room;
 * both paths clear the sample so no stale number is shown.
 */
export type LatencySample = {
  /** Buffering delay inside the receiver, milliseconds (rounded). */
  jitterMs: number;
  /** Round-trip time to the media server, milliseconds (rounded). */
  rttMs: number;
  /** Estimated glass-to-glass-ish delay: jitter buffer + RTT, milliseconds. */
  totalMs: number;
};

type StatsReport = Map<string, any> | { forEach: (callback: (report: any) => void) => void };

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Read one stats sample; returns null while no usable report exists yet. */
async function readSample(pc: RTCPeerConnection): Promise<LatencySample | null> {
  if (typeof pc.getStats !== 'function') return null;
  const report = (await pc.getStats()) as unknown as StatsReport;
  if (!report || typeof report.forEach !== 'function') return null;

  let videoJitterMs: number | null = null;
  let audioJitterMs: number | null = null;
  let pairRttMs: number | null = null;
  let pairRttPriority = -1;
  let remoteRttMs: number | null = null;

  report.forEach((entry: any) => {
    if (!entry || typeof entry !== 'object') return;
    if (entry.type === 'inbound-rtp' && (entry.kind === 'video' || entry.kind === 'audio')) {
      const delay = finiteNumber(entry.jitterBufferDelay);
      const emitted = finiteNumber(entry.jitterBufferEmittedCount);
      if (delay !== null && emitted !== null && emitted > 0) {
        const value = (delay / emitted) * 1000;
        if (entry.kind === 'video') videoJitterMs = value;
        else audioJitterMs = value;
      }
      return;
    }
    if (entry.type === 'candidate-pair') {
      const rtt = finiteNumber(entry.currentRoundTripTime);
      if (rtt === null || rtt < 0) return;
      // Prefer the nominated/selected pair, then any succeeded pair, then the rest.
      const priority = entry.selected === true || entry.nominated === true || entry.state === 'succeeded' ? 2 : 1;
      if (priority > pairRttPriority) {
        pairRttPriority = priority;
        pairRttMs = rtt * 1000;
      } else if (priority === pairRttPriority && pairRttMs !== null && rtt * 1000 < pairRttMs) {
        pairRttMs = rtt * 1000;
      }
      return;
    }
    if (entry.type === 'remote-inbound-rtp' && remoteRttMs === null) {
      const rtt = finiteNumber(entry.roundTripTime);
      if (rtt !== null && rtt >= 0) remoteRttMs = rtt * 1000;
    }
  });

  const jitterMs = videoJitterMs ?? audioJitterMs;
  const rttMs = pairRttMs ?? remoteRttMs;
  if (jitterMs === null && rttMs === null) return null;
  const jitter = Math.max(0, jitterMs ?? 0);
  const rtt = Math.max(0, rttMs ?? 0);
  return {
    jitterMs: Math.round(jitter),
    rttMs: Math.round(rtt),
    totalMs: Math.round(jitter + rtt),
  };
}

export type LatencyMonitorOptions = {
  /** Sampling interval in milliseconds (default 1000ms). */
  intervalMs?: number;
};

/**
 * Start sampling `pc` once per second. `onSample(null)` is emitted when the tab is
 * hidden or the monitor stops, so the UI can drop the number instead of freezing it.
 * The returned function is idempotent and must be called on leave/unmount.
 */
export function startLatencyMonitor(
  pc: RTCPeerConnection,
  onSample: (sample: LatencySample | null) => void,
  options: LatencyMonitorOptions = {},
): () => void {
  const intervalMs = Math.max(250, options.intervalMs ?? 1000);
  let disposed = false;
  let busy = false;
  let timer: number | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };

  const tick = async () => {
    if (disposed || busy) return;
    if (document.visibilityState !== 'visible') {
      // Hidden tab: stop sampling entirely; the next visibilitychange restarts it.
      clearTimer();
      onSample(null);
      return;
    }
    busy = true;
    try {
      const sample = await readSample(pc);
      if (!disposed) onSample(sample);
    } catch {
      // A closed PeerConnection throws; stop instead of hammering it every second.
      if (!disposed) {
        clearTimer();
        onSample(null);
      }
    } finally {
      busy = false;
    }
  };

  const start = () => {
    clearTimer();
    void tick();
    timer = window.setInterval(() => void tick(), intervalMs);
  };

  const onVisibilityChange = () => {
    if (disposed) return;
    if (document.visibilityState === 'visible') start();
    else {
      clearTimer();
      onSample(null);
    }
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  start();

  return () => {
    if (disposed) return;
    disposed = true;
    clearTimer();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    onSample(null);
  };
}
