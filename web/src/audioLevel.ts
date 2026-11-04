/**
 * Microphone / remote-audio level metering.
 *
 * One shared `AudioContext` is created lazily and reused by every meter so a
 * mesh voice room with several remote peers does not hit the browser's
 * per-page AudioContext limit. A meter is a cheap AnalyserNode wrapper:
 * `read()` returns a smoothed RMS level in the 0..1 range and `stop()`
 * disconnects its nodes (the shared context stays alive for the next meter).
 */
import { useEffect, useState } from 'react';

type AudioContextCtor = typeof AudioContext;

let sharedContext: AudioContext | null = null;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = window.AudioContext || (window as any).webkitAudioContext;
  return typeof ctor === 'function' ? ctor : null;
}

function getAudioContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  if (!sharedContext || sharedContext.state === 'closed') {
    try {
      sharedContext = new Ctor();
    } catch {
      sharedContext = null;
      return null;
    }
  }
  if (sharedContext.state === 'suspended') void sharedContext.resume().catch(() => undefined);
  return sharedContext;
}

export type LevelMeter = {
  /** Current level, 0..1. */
  read: () => number;
  /** Disconnect the analyser; safe to call more than once. */
  stop: () => void;
};

/** Create a level meter for a MediaStream (null stream / no audio tracks → null). */
export function createLevelMeter(stream: MediaStream | null): LevelMeter | null {
  if (!stream || stream.getAudioTracks().length === 0) return null;
  const context = getAudioContext();
  if (!context) return null;
  let source: MediaStreamAudioSourceNode;
  try {
    source = context.createMediaStreamSource(stream);
  } catch {
    return null;
  }
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.55;
  const samples = new Uint8Array(analyser.fftSize);
  let stopped = false;
  try {
    source.connect(analyser);
  } catch {
    return null;
  }
  return {
    read() {
      if (stopped) return 0;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const value = (samples[index] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / samples.length);
      // Speech RMS is small; scale it so a normal voice fills most of the bar.
      return Math.min(1, rms * 4.5);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { source.disconnect(); } catch { /* already disconnected */ }
      try { analyser.disconnect(); } catch { /* already disconnected */ }
    },
  };
}

/** 0..100 integer for width/aria-value meters. */
export function levelPercent(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.round(Math.min(1, Math.max(0, level)) * 100);
}

/** dB label used next to the studio microphone meter (-60 dB floor). */
export function levelDb(level: number): string {
  if (!Number.isFinite(level) || level <= 0.001) return '-60';
  return String(Math.max(-60, Math.round(20 * Math.log10(level))));
}

/**
 * React hook: smoothed level for `stream` sampled at ~12 fps. Returns 0 when
 * `active` is false or the stream has no audio track.
 */
export function useLevelMeter(stream: MediaStream | null, active = true): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream || !active) {
      setLevel(0);
      return;
    }
    const meter = createLevelMeter(stream);
    if (!meter) {
      setLevel(0);
      return;
    }
    let handle = 0;
    let last = 0;
    const tick = (now: number) => {
      handle = window.requestAnimationFrame(tick);
      if (now - last < 80) return;
      last = now;
      setLevel(meter.read());
    };
    handle = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(handle);
      meter.stop();
      setLevel(0);
    };
  }, [stream, active]);
  return level;
}
