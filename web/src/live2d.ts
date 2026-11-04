/**
 * Live2D "看板娘" loader.
 *
 * Rendering uses pixi.js 6 + pixi-live2d-display (Cubism 4 entry). Both are
 * loaded lazily through dynamic `import()` so the main bundle stays small, and
 * the Cubism Core runtime is injected from a public CDN because it is not
 * redistributable. No model files are bundled with the web app.
 */
import { useSyncExternalStore } from 'react';
import type { Application } from 'pixi.js';

export type Live2DPhase = 'idle' | 'core' | 'model' | 'ready' | 'error';

export type Live2DState = {
  phase: Live2DPhase;
  /** Human readable status / error message shown next to the loader. */
  message: string;
  /** URL of the currently loaded (or last attempted) model. */
  modelUrl: string;
  hasModel: boolean;
  visible: boolean;
};

const INITIAL_STATE: Live2DState = {
  phase: 'idle',
  message: '输入 .model3.json 地址后点击「加载看板娘」（模型从网络加载，不内置任何模型）',
  modelUrl: '',
  hasModel: false,
  visible: true,
};

let state: Live2DState = INITIAL_STATE;
const listeners = new Set<() => void>();

function setState(patch: Partial<Live2DState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    try { listener(); } catch { /* a broken subscriber must not break the loader */ }
  }
}

export function getLive2DState(): Live2DState {
  return state;
}

export function subscribeLive2D(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLive2DState(): Live2DState {
  return useSyncExternalStore(subscribeLive2D, getLive2DState, getLive2DState);
}

/** Cubism Core (not redistributable) is fetched from CDNs at runtime. */
const CUBISM_CORE_URLS = [
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
  'https://unpkg.com/live2dcubismcore@1.0.0/live2dcubismcore.min.js',
];

type Live2DRuntime = {
  app: Application;
  model: any;
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  resizeObserver: ResizeObserver | null;
  windowResize: () => void;
  layout: () => void;
};

let runtime: Live2DRuntime | null = null;
let corePromise: Promise<void> | null = null;
let loading = false;

function hasCubismCore(): boolean {
  return typeof (window as any).Live2DCubismCore !== 'undefined' && !!(window as any).Live2DCubismCore;
}

function loadScript(url: string, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const selector = `script[data-live2d-core="${url}"]`;
    const existing = document.querySelector<HTMLScriptElement>(selector);
    if (existing?.dataset.loaded === '1') { resolve(); return; }
    const script = existing ?? document.createElement('script');
    script.src = url;
    script.async = true;
    script.dataset.live2dCore = url;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (error) {
        script.remove();
        reject(error);
      } else {
        script.dataset.loaded = '1';
        resolve();
      }
    };
    const timer = window.setTimeout(() => finish(new Error('加载超时')), timeoutMs);
    script.onload = () => finish();
    script.onerror = () => finish(new Error('脚本加载失败'));
    if (!existing) document.head.appendChild(script);
  });
}

async function ensureCubismCore(): Promise<void> {
  if (hasCubismCore()) return;
  if (!corePromise) {
    corePromise = (async () => {
      const failures: string[] = [];
      for (const url of CUBISM_CORE_URLS) {
        try {
          await loadScript(url);
        } catch {
          failures.push(url);
          continue;
        }
        if (hasCubismCore()) return;
        failures.push(url);
      }
      throw new Error(
        'Cubism Core 加载失败：无法从 CDN 获取 live2dcubismcore.js。'
        + '请检查网络 / 广告拦截插件，或换一个能访问 cubism.live2d.com 的网络后重试。',
      );
    })();
  }
  try {
    await corePromise;
  } catch (error) {
    corePromise = null;
    throw error;
  }
}

/** Accept only http(s) or same-origin paths that point at a Cubism 3+ model. */
export function normalizeModelUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('请输入 Live2D 模型地址（以 .model3.json 结尾）');
  let url: URL;
  try {
    url = new URL(value, window.location.href);
  } catch {
    throw new Error('模型地址格式不正确，请填写完整的 http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('模型地址必须是 http(s) 链接或以 / 开头的站内路径');
  }
  if (!/\.model3\.json$/i.test(url.pathname)) {
    throw new Error('模型地址应以 .model3.json 结尾（例如 https://example.com/model/model3.json）');
  }
  return url.href;
}

function modelLabel(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    const file = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
    return file;
  } catch {
    return '模型';
  }
}

function describeLoadError(error: unknown): string {
  const name = String((error as any)?.name || '');
  const raw = String((error as any)?.message || error || '');
  if (/Cubism Core/i.test(raw)) return raw;
  if (/WebGL|context/i.test(raw)) {
    return '加载 Live2D 失败：当前浏览器无法创建 WebGL 上下文（可能是硬件加速被禁用），请开启浏览器硬件加速后重试。';
  }
  const detail = (raw || name).replace(/[.。\s]+$/, '').slice(0, 120);
  if (/NetworkError|Failed to fetch|fetch|404|Load|缺省|missing|texture/i.test(`${name} ${raw}`)) {
    return `模型加载失败：无法读取 .model3.json 或其贴图/动作文件（${detail || '网络错误'}）。`
      + '请确认地址可访问、文件完整，并且允许跨域（CORS）；远程模型需服务器返回 Access-Control-Allow-Origin。';
  }
  return `模型加载失败：${detail || '未知错误'}。请检查模型地址、贴图/动作文件是否完整，以及 CDN 是否允许跨域。`;
}

function layoutRuntime(current: Live2DRuntime) {
  const host = current.host;
  if (!host || !current.app) return;
  const width = Math.max(200, Math.round(host.clientWidth));
  const height = Math.max(200, Math.round(host.clientHeight));
  try {
    current.app.renderer.resize(width, height);
    const model = current.model;
    const modelWidth = Number(model?.width) || 0;
    const modelHeight = Number(model?.height) || 0;
    if (modelWidth > 0 && modelHeight > 0) {
      const scale = Math.min(width / modelWidth, height / modelHeight) * 1.02;
      model.scale.set(scale);
      try {
        if (model.anchor?.set) model.anchor.set(0.5, 1);
        else if (model.pivot?.set) model.pivot.set(modelWidth / 2, modelHeight);
      } catch { /* anchor/pivot are optional */ }
      model.x = width / 2;
      model.y = height - Math.max(2, Math.round(height * 0.01));
    }
  } catch {
    // A destroyed renderer can throw during teardown; ignore.
  }
}

function scheduleLayout(current: Live2DRuntime) {
  current.layout();
}

function destroyRuntime() {
  const current = runtime;
  runtime = null;
  if (!current) return;
  try { current.resizeObserver?.disconnect(); } catch { /* ignore */ }
  window.removeEventListener('resize', current.windowResize);
  try { current.model?.destroy?.({ children: true }); } catch { /* already destroyed */ }
  try { current.app?.destroy?.(true); } catch { /* already destroyed */ }
  if (current.canvas?.parentNode) current.canvas.parentNode.removeChild(current.canvas);
}

/**
 * Load a `.model3.json` model into `host`. Never throws: failures are reported
 * through the Live2D state so the panel can show a readable error instead of
 * crashing the page.
 */
export async function loadLive2D(host: HTMLElement | null, rawUrl: string): Promise<void> {
  if (!host) return;
  if (loading) return;
  let url: string;
  try {
    url = normalizeModelUrl(rawUrl);
  } catch (error) {
    setState({ phase: 'error', message: (error as Error).message, hasModel: !!runtime, visible: state.visible });
    return;
  }
  loading = true;
  let app: Application | null = null;
  try {
    setState({ phase: 'core', message: '正在从 CDN 加载 Cubism Core…', modelUrl: url, visible: state.visible });
    await ensureCubismCore();
    setState({ phase: 'model', message: `Cubism Core 就绪，正在加载 ${modelLabel(url)}…`, modelUrl: url });
    const [pixi, live2d] = await Promise.all([
      import('pixi.js'),
      import('pixi-live2d-display/cubism4'),
    ]);
    destroyRuntime();
    const width = Math.max(200, Math.round(host.clientWidth) || 480);
    const height = Math.max(200, Math.round(host.clientHeight) || 360);
    // Force a WebGL1 context. Some browsers/drivers (and SwiftShader-based
    // headless runs) create a WebGL2 context that pixi 6 / Cubism cannot link,
    // which otherwise leaves a white canvas behind a "ready" state.
    const glCanvas = document.createElement('canvas');
    const gl = glCanvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('无法创建 WebGL 上下文');
    app = new pixi.Application({
      view: glCanvas,
      context: gl as any,
      width,
      height,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      powerPreference: 'high-performance',
      // The publish overlay reads this canvas every frame via drawImage().
      preserveDrawingBuffer: true,
    });
    const canvas = app.view as HTMLCanvasElement;
    canvas.className = 'live2d-canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = state.visible ? 'block' : 'none';
    canvas.setAttribute('aria-label', 'Live2D 看板娘画布');
    host.replaceChildren(canvas);

    const model = await live2d.Live2DModel.from(url, {
      autoInteract: false,
      autoUpdate: true,
      motionPreload: live2d.MotionPreloadStrategy?.IDLE,
    });
    app.stage.addChild(model);

    const current: Live2DRuntime = {
      app,
      model,
      host,
      canvas,
      resizeObserver: null,
      windowResize: () => scheduleLayout(current),
      layout: () => layoutRuntime(current),
    };
    runtime = current;
    current.layout();
    try {
      current.resizeObserver = new ResizeObserver(() => current.layout());
      current.resizeObserver.observe(host);
    } catch {
      current.resizeObserver = null;
    }
    window.addEventListener('resize', current.windowResize);
    setState({
      phase: 'ready',
      message: `模型已加载：${modelLabel(url)}（${Math.round(Number(model.width) || 0)}×${Math.round(Number(model.height) || 0)}）`,
      hasModel: true,
      visible: state.visible,
      modelUrl: url,
    });
  } catch (error) {
    if (app) {
      try { app.destroy(true); } catch { /* already destroyed */ }
    }
    runtime = null;
    try { host.replaceChildren(); } catch { /* host unmounted */ }
    setState({
      phase: 'error',
      message: describeLoadError(error),
      hasModel: false,
      modelUrl: url,
    });
  } finally {
    loading = false;
  }
}

/** Re-attach the existing canvas when the panel is mounted again. */
export function attachLive2DPanel(host: HTMLElement | null): void {
  if (!host) return;
  if (runtime) {
    runtime.host = host;
    if (runtime.canvas.parentElement !== host) host.replaceChildren(runtime.canvas);
    runtime.layout();
  }
}

export function setLive2DVisible(visible: boolean): void {
  setState({ visible });
  if (runtime) runtime.canvas.style.display = visible ? 'block' : 'none';
}

export function getLive2DCanvas(): HTMLCanvasElement | null {
  return runtime?.canvas ?? null;
}

/**
 * Render one Live2D frame synchronously and return the canvas. Used by the
 * WHIP overlay compositor right before `drawImage()` so a WebGL buffer that was
 * already composited cannot show up blank.
 */
export function renderLive2DToCanvas(): HTMLCanvasElement | null {
  const current = runtime;
  if (!current) return null;
  try {
    current.app.renderer.render(current.app.stage);
  } catch {
    // Model may be mid-load or already destroyed; the overlay handles null.
  }
  return current.canvas;
}

export function hasLive2DModel(): boolean {
  return !!runtime;
}

export function unloadLive2D(): void {
  destroyRuntime();
  setState({ phase: 'idle', hasModel: false, message: '已卸载看板娘，可重新输入模型地址加载' });
}

export function getLive2DModelUrl(): string {
  return state.modelUrl;
}
