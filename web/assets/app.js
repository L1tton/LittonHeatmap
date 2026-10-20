/* global maplibregl */
/**
 * 路线总和图
 * - GPX files are parsed in the browser and stored in IndexedDB.
 * - 行者 sync is handled by /api/sync (cookie only lives for that request).
 */
import { wgs84ToGcj02, gcj02ToWgs84 } from './geo.js';
import { gpxFileToFeatures } from './gpx.js';
import { saveDataset, loadDataset, clearDataset } from './store.js';

const TRACK = '#d81e06';
const TRACK_COLORS = [
  { hex: '#d81e06', name: '红色' },
  { hex: '#cc7319', name: '橙色' },
  { hex: '#ccae19', name: '金色' },
  { hex: '#19ccbd', name: '青色' },
  { hex: '#1964cc', name: '蓝色' },
  { hex: '#3719cc', name: '靛色' },
  { hex: '#a019cc', name: '紫色' },
  { hex: '#cc1982', name: '品红' },
];
const TRACK_COLOR_KEY = 'trailmap.trackColor';
const PAPER = '#f3efe7';
const DEBUG = new URLSearchParams(location.search).has('debug');
const WALLPAPER_MODE = true;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const NAME_KEY = 'trailmap.name';
const BASE_KEY = 'trailmap.base';
const LABELS_KEY = 'trailmap.labels';
const ROAD_DENSITY_KEY = 'trailmap.roadDensity';
const ROAD_OPACITY_KEY = 'trailmap.roadOpacity';
const WALLPAPER_CLEARED_KEY = 'trailmap.wallpaper.cleared';
const ROAD_TILEJSON = 'https://tiles.openfreemap.org/planet';
const MOTORWAY_ROAD_CLASSES = [
  'motorway',
  'trunk',
  'motorway_link',
  'trunk_link',
];
const PRIMARY_ROAD_CLASSES = [
  'primary',
  'secondary',
  'primary_link',
  'secondary_link',
];
const TERTIARY_ROAD_CLASSES = ['tertiary', 'tertiary_link'];
const MINOR_ROAD_CLASSES = ['minor', 'service', 'track', 'path', 'raceway'];

function vectorBaseLayerSpecs(theme = 'dark') {
  const colors =
    theme === 'light'
      ? {
          landcover: '#dbe7d2',
          landuse: '#efe9de',
          park: '#cfe3c5',
          water: '#b7dbe8',
          waterway: '#84b8cc',
        }
      : {
          landcover: '#1a2620',
          landuse: '#1c2632',
          park: '#1e3328',
          water: '#0d2a3a',
          waterway: '#1b4a63',
        };
  return [
    {
      id: 'base-landcover',
      type: 'fill',
      'source-layer': 'landcover',
      paint: { 'fill-color': colors.landcover, 'fill-opacity': 0.9 },
    },
    {
      id: 'base-landuse',
      type: 'fill',
      'source-layer': 'landuse',
      paint: { 'fill-color': colors.landuse, 'fill-opacity': 0.9 },
    },
    {
      id: 'base-park',
      type: 'fill',
      'source-layer': 'park',
      paint: { 'fill-color': colors.park, 'fill-opacity': 0.9 },
    },
    {
      id: 'base-water',
      type: 'fill',
      'source-layer': 'water',
      paint: { 'fill-color': colors.water },
    },
    {
      id: 'base-waterway',
      type: 'line',
      'source-layer': 'waterway',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colors.waterway,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 12, 2.2],
        'line-opacity': 0.9,
      },
    },
  ];
}

function tdtTiles(layer) {
  return [`api/tdt/${layer}/{z}/{y}/{x}`];
}

function roadWidthExpression() {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    6,
    ['match', ['get', 'class'],
      ['motorway', 'trunk', 'motorway_link', 'trunk_link'], 1.1,
      ['primary', 'primary_link'], 0.9,
      ['secondary', 'secondary_link'], 0.75,
      ['tertiary', 'tertiary_link'], 0.6,
      0.4,
    ],
    12,
    ['match', ['get', 'class'],
      ['motorway', 'trunk', 'motorway_link', 'trunk_link'], 3.2,
      ['primary', 'primary_link'], 2.6,
      ['secondary', 'secondary_link'], 2.0,
      ['tertiary', 'tertiary_link'], 1.6,
      1.0,
    ],
    16,
    ['match', ['get', 'class'],
      ['motorway', 'trunk', 'motorway_link', 'trunk_link'], 6,
      ['primary', 'primary_link'], 5,
      ['secondary', 'secondary_link'], 4,
      ['tertiary', 'tertiary_link'], 3,
      2,
    ],
  ];
}

function roadLayerSpec(id, def, classes, minzoom, opacity = 0.92) {
  return {
    id,
    type: 'line',
    source: 'roads',
    'source-layer': 'transportation',
    minzoom,
    filter: ['match', ['get', 'class'], classes, true, false],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': def.roads,
      'line-width': roadWidthExpression(),
      'line-opacity': opacity,
    },
  };
}

const BASEMAPS = {
  satellite: {
    label: '卫星',
    datum: 'gcj02',
    credit: '影像 © 高德地图',
    maxzoom: 18,
    opacity: 0.9,
    tiles: [1, 2, 3, 4].map(
      (s) => `https://webst0${s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}`,
    ),
  },
  light: {
    label: '浅色',
    datum: 'wgs84',
    credit: '底图 © OpenStreetMap contributors / OpenFreeMap',
    maxzoom: 14,
    opacity: 1,
    bg: '#f5f1e8',
    vectorBase: true,
    vectorTheme: 'light',
    roads: '#6f6558',
  },
  dark: {
    label: '深色',
    datum: 'wgs84',
    credit: '底图 © OpenStreetMap contributors / OpenFreeMap',
    maxzoom: 14,
    opacity: 1,
    bg: '#0b1220',
    vectorBase: true,
    vectorTheme: 'dark',
    roads: '#9aa6b2',
  },
  terrain: {
    label: '地形',
    datum: 'wgs84',
    credit: '底图 © 天地图 · 道路 © OpenStreetMap contributors / OpenFreeMap',
    maxzoom: 14,
    opacity: 0.45,
    bg: '#0b1220',
    tiles: tdtTiles('ter_w'),
    labels: tdtTiles('cta_w'),
    roads: '#9aa6b2',
    paint: {
      'raster-brightness-min': 0,
      'raster-brightness-max': 1,
      'raster-saturation': -0.15,
      'raster-contrast': 0.05,
    },
    labelPaint: {
      'raster-brightness-min': 0.72,
      'raster-brightness-max': 1,
      'raster-contrast': 0.1,
    },
  },
  none: {
    label: '无底图',
    datum: 'wgs84',
    credit: '无底图',
    maxzoom: 18,
    opacity: 1,
    tiles: null,
  },
};

const state = {
  manifest: null,
  features: [],
  byYear: new Map(),
  collections: {},
  year: 'all',
  base: 'dark',
  datum: 'wgs84',
  tiandituEnabled: false,
  showLabels: false,
  roadDensity: 100,
  roadOpacity: 92,
  opacity: 0.3,
  name: '我的轨迹',
  customName: false,
  trackColor: TRACK,
  source: null,
  updatedAt: null,
  mapReady: false,
  dataReady: false,
  exportBusy: false,
  syncBusy: false,
  syncAbort: null,
  syncRangeLabel: '',
  importAbort: false,
  autoOpacity: true,
  widthScale: 1,
  mapInteractive: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  panel: $('#panel'),
  panelToggle: $('#panelToggle'),
  panelLauncher: $('#panelLauncher'),
  wallpaperZoom: $('#wallpaperZoom'),
  wallpaperZoomIn: $('#wallpaperZoomIn'),
  wallpaperZoomOut: $('#wallpaperZoomOut'),
  nameInput: $('#nameInput'),
  rangeText: $('#rangeText'),
  statCount: $('#statCount'),
  statDistance: $('#statDistance'),
  statYears: $('#statYears'),
  yearControl: $('#yearControl'),
  yearSelect: $('#yearSelect'),
  baseButtons: $('#baseButtons'),
  colorPalette: $('#colorPalette'),
  labelToggle: $('#labelToggle'),
  showLabels: $('#showLabels'),
  roadDensityControl: $('#roadDensityControl'),
  roadDensity: $('#roadDensity'),
  roadDensityValue: $('#roadDensityValue'),
  roadOpacityControl: $('#roadOpacityControl'),
  roadOpacity: $('#roadOpacity'),
  roadOpacityValue: $('#roadOpacityValue'),
  opacity: $('#opacity'),
  opacityValue: $('#opacityValue'),
  fitBtn: $('#fitBtn'),
  exportBtn: $('#exportBtn'),
  importBtn: $('#importBtn'),
  wallpaperResetBtn: $('#wallpaperResetBtn'),
  wallpaperClearBtn: $('#wallpaperClearBtn'),
  syncBtn: $('#syncBtn'),
  clearBtn: $('#clearBtn'),
  onboarding: $('#onboarding'),
  onboardImport: $('#onboardImport'),
  onboardSync: $('#onboardSync'),
  onboardExample: $('#onboardExample'),
  gpxInput: $('#gpxInput'),
  dropOverlay: $('#dropOverlay'),
  attribution: $('#attribution'),
  loading: $('#loading'),
  spinner: $('#spinner'),
  loadingText: $('#loadingText'),
  loadingSub: $('#loadingSub'),
  exportModal: $('#exportModal'),
  exportClose: $('#exportClose'),
  exportCancel: $('#exportCancel'),
  exportConfirm: $('#exportConfirm'),
  exportHeader: $('#exportHeader'),
  exportSizeHint: $('#exportSizeHint'),
  updatedText: $('#updatedText'),
  wallpaperClock: $('#wallpaperClock'),
  clockGrip: $('#clockGrip'),
  clockTime: $('#clockTime'),
  clockDate: $('#clockDate'),
  clockWeekday: $('#clockWeekday'),
  syncModal: $('#syncModal'),
  syncIntro: $('#syncIntro'),
  syncProgress: $('#syncProgress'),
  syncClose: $('#syncClose'),
  syncCancel: $('#syncCancel'),
  syncStart: $('#syncStart'),
  syncStop: $('#syncStop'),
  syncConsent: $('#syncConsent'),
  cookieInput: $('#cookieInput'),
  syncImportAlt: $('#syncImportAlt'),
  syncStatus: $('#syncStatus'),
  syncBar: $('#syncBar'),
  syncLog: $('#syncLog'),
  importModal: $('#importModal'),
  importStatus: $('#importStatus'),
  importBar: $('#importBar'),
  importLog: $('#importLog'),
  importClose: $('#importClose'),
  toast: $('#toast'),
};

let toastTimer = null;
function toast(message, duration = 3600) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, duration);
}

const CLOCK_MONTHS = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
];
const CLOCK_WEEKDAYS = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];
let clockTimer = null;

function updateWallpaperClock() {
  if (!els.clockTime || !els.clockDate || !els.clockWeekday) return;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;
  const date = `${CLOCK_MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const weekday = CLOCK_WEEKDAYS[now.getDay()];
  if (els.clockTime.textContent !== time) els.clockTime.textContent = time;
  if (els.clockDate.textContent !== date) els.clockDate.textContent = date;
  if (els.clockWeekday.textContent !== weekday) els.clockWeekday.textContent = weekday;
  els.wallpaperClock?.classList.add('is-ready');
}

function startWallpaperClock() {
  if (!WALLPAPER_MODE || clockTimer) return;
  updateWallpaperClock();
  clockTimer = window.setInterval(updateWallpaperClock, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateWallpaperClock();
  });
}

const CLOCK_POS_KEY = 'trailmap.wallpaper.clockPos';
let clockDrag = null;

function applyClockPosition(left, top, { persist = false } = {}) {
  const margin = 12;
  const width = els.wallpaperClock.offsetWidth || 420;
  const height = els.wallpaperClock.offsetHeight || 200;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  const x = Math.round(Math.min(Math.max(margin, left), maxLeft));
  const y = Math.round(Math.min(Math.max(margin, top), maxTop));
  els.wallpaperClock.style.left = `${x}px`;
  els.wallpaperClock.style.top = `${y}px`;
  els.wallpaperClock.style.right = 'auto';
  els.wallpaperClock.style.bottom = 'auto';
  els.wallpaperClock.style.transform = 'none';
  if (persist) {
    try {
      localStorage.setItem(CLOCK_POS_KEY, JSON.stringify({ left: x, top: y }));
    } catch {
      /* ignore */
    }
  }
}

function resetClockPosition() {
  els.wallpaperClock.style.left = '';
  els.wallpaperClock.style.top = '';
  els.wallpaperClock.style.right = '';
  els.wallpaperClock.style.bottom = '';
  els.wallpaperClock.style.transform = '';
  try {
    localStorage.removeItem(CLOCK_POS_KEY);
  } catch {
    /* ignore */
  }
}

function initClockDrag() {
  if (!els.wallpaperClock || !els.clockGrip) return;
  els.wallpaperClock.title = '拖动左上角把手移动时间，双击复位';

  els.clockGrip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = els.wallpaperClock.getBoundingClientRect();
    clockDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    els.wallpaperClock.classList.add('is-dragging');
    try {
      els.clockGrip.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    const onMove = (moveEvent) => {
      if (!clockDrag || moveEvent.pointerId !== clockDrag.pointerId) return;
      const dx = moveEvent.clientX - clockDrag.startX;
      const dy = moveEvent.clientY - clockDrag.startY;
      if (!clockDrag.moved && Math.hypot(dx, dy) < 4) return;
      clockDrag.moved = true;
      moveEvent.preventDefault();
      applyClockPosition(clockDrag.left + dx, clockDrag.top + dy, { persist: false });
    };
    const finish = (upEvent) => {
      if (!clockDrag || upEvent.pointerId !== clockDrag.pointerId) return;
      const wasMoved = clockDrag.moved;
      clockDrag = null;
      els.wallpaperClock.classList.remove('is-dragging');
      try {
        els.clockGrip.releasePointerCapture(upEvent.pointerId);
      } catch {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (wasMoved) {
        const finalRect = els.wallpaperClock.getBoundingClientRect();
        applyClockPosition(finalRect.left, finalRect.top, { persist: true });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });

  els.clockGrip.addEventListener('dblclick', resetClockPosition);
}

(function restoreClockPosition() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(CLOCK_POS_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
    applyClockPosition(saved.left, saved.top);
  }
})();

initClockDrag();

function fmtInt(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function fmtKm(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('zh-CN', { maximumFractionDigits: n < 100 ? 1 : 0 });
}

function fmtDate(dateString) {
  if (!dateString) return '—';
  return String(dateString).replaceAll('-', '.');
}

function dateRangeOf(features, { compact = false } = {}) {
  if (!features.length) return '—';
  let first = features[0].properties.date;
  let last = features[0].properties.date;
  for (const f of features) {
    const d = f.properties.date;
    if (d < first) first = d;
    if (d > last) last = d;
  }
  if (first === last) return fmtDate(first);
  if (compact && first.slice(0, 7) !== last.slice(0, 7)) {
    return `${fmtDate(first).slice(0, 7)} — ${fmtDate(last).slice(0, 7)}`;
  }
  if (first.slice(0, 4) === last.slice(0, 4)) {
    return `${fmtDate(first)} — ${fmtDate(last).slice(5)}`;
  }
  return `${fmtDate(first)} — ${fmtDate(last)}`;
}

function formatDuration(minutes) {
  const m = Math.round(Number(minutes) || 0);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

// Low zoom = small scale = wide area: keep the lines thin so dense areas
// stay readable instead of merging into one solid patch.
const TRACK_WIDTH_STOPS = [3, 0.7, 6, 1.0, 8, 1.5, 10, 1.9, 12, 2.4, 16, 3.4];
const GLOW_WIDTH_STOPS = [3, 0.8, 6, 1.2, 8, 1.6, 10, 2.2, 12, 3.0, 16, 5.5];

function widthExpression(stops, scale = 1) {
  const scaled = [];
  for (let i = 0; i < stops.length; i += 2) {
    scaled.push(stops[i], Math.round(stops[i + 1] * scale * 10) / 10);
  }
  return ['interpolate', ['linear'], ['zoom'], ...scaled];
}

/* ------------------------------------------------------------------ */
/* Map                                                                 */
/* ------------------------------------------------------------------ */

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      tracks: { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': PAPER },
      },
      {
        id: 'track-glow',
        type: 'line',
        source: 'tracks',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': TRACK,
          'line-width': widthExpression(GLOW_WIDTH_STOPS),
          'line-opacity': 0.14,
          'line-blur': 1.2,
        },
      },
      {
        id: 'track-line',
        type: 'line',
        source: 'tracks',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': TRACK,
          'line-width': widthExpression(TRACK_WIDTH_STOPS),
          'line-opacity': 0.55,
        },
      },
    ],
  },
  center: [116.4, 34.5],
  zoom: 4,
  minZoom: 2,
  maxZoom: 18,
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  attributionControl: false,
  preserveDrawingBuffer: true,
  fadeDuration: 120,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');

// Drag-pan is handled by our own pointer code so it also works inside
// Wallpaper Engine's embedded browser.
map.dragPan.disable();

const MAP_HANDLERS = [
  map.scrollZoom,
  map.boxZoom,
  map.doubleClickZoom,
  map.touchZoomRotate,
  map.keyboard,
];

function setMapInteractive(interactive) {
  if (state.mapInteractive === interactive) return;
  state.mapInteractive = interactive;
  document.body.classList.toggle('map-interactive', interactive);
  for (const handler of MAP_HANDLERS) {
    if (!handler) continue;
    if (interactive) handler.enable();
    else handler.disable();
  }
  els.wallpaperZoom.hidden = !interactive;
  const canvas = map.getCanvas();
  if (canvas) canvas.style.cursor = interactive ? 'grab' : 'default';
}

function zoomMapBy(delta) {
  if (!state.mapInteractive) return;
  map.zoomTo(map.getZoom() + delta, { duration: 220, essential: true });
}

let suppressMapClick = false;
let mapPan = null;

function initWallpaperMapPan() {
  const canvas = map.getCanvas();
  if (!canvas) return;

  canvas.addEventListener('pointerdown', (event) => {
    if (!state.mapInteractive || event.button !== 0) return;
    mapPan = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
    canvas.style.cursor = 'grabbing';
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    const onMove = (moveEvent) => {
      if (!mapPan || moveEvent.pointerId !== mapPan.pointerId) return;
      const dx = moveEvent.clientX - mapPan.lastX;
      const dy = moveEvent.clientY - mapPan.lastY;
      mapPan.lastX = moveEvent.clientX;
      mapPan.lastY = moveEvent.clientY;
      if (!mapPan.moved && Math.hypot(dx, dy) < 2) return;
      mapPan.moved = true;
      suppressMapClick = true;
      map.panBy([-dx, -dy], { duration: 0 });
    };
    const finish = (upEvent) => {
      if (!mapPan || upEvent.pointerId !== mapPan.pointerId) return;
      mapPan = null;
      canvas.style.cursor = state.mapInteractive ? 'grab' : 'default';
      try {
        canvas.releasePointerCapture(upEvent.pointerId);
      } catch {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.setTimeout(() => {
        suppressMapClick = false;
      }, 120);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });
}

initWallpaperMapPan();

// Wallpaper Engine may route wheel input outside MapLibre's canvas listener.
// Capture wheel over map-like areas so zoom also works in the wallpaper host.
document.addEventListener(
  'wheel',
  (event) => {
    if (!state.mapInteractive) return;
    if (
      event.target instanceof Element &&
      event.target.closest('.panel, .wallpaper-clock, .panel-launcher, .wallpaper-zoom, .modal-backdrop')
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    zoomMapBy(event.deltaY < 0 ? 0.35 : -0.35);
  },
  { passive: false, capture: true },
);

// Exposed only in ?debug=1 for local end-to-end checks.
if (DEBUG) {
  window.__trailMap = map;
  window.__trailState = state;
  window.__trailSetName = setName;
  window.__trailApplyDataset = applyDataset;
  window.__trailNextExportName = nextExportName;
}

const mapLoaded = new Promise((resolve, reject) => {
  map.once('load', () => {
    state.mapReady = true;
    resolve();
  });
  const timer = setTimeout(() => {
    if (!state.mapReady) reject(new Error('地图初始化超时，请确认浏览器支持 WebGL'));
  }, 20000);
  map.on('load', () => clearTimeout(timer));
});

map.on('error', (event) => {
  const msg = event && event.error ? event.error.message : '未知地图错误';
  if (!/Failed to fetch|AJAXError|NetworkError/i.test(msg)) console.warn('[map]', msg);
});

/* ------------------------------------------------------------------ */
/* Dataset lifecycle                                                   */
/* ------------------------------------------------------------------ */

function normalizeFeature(feature) {
  if (!feature || feature.type !== 'Feature' || !feature.geometry) return null;
  if (feature.geometry.type !== 'LineString') return null;
  const coordinates = feature.geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const properties = feature.properties || {};
  let date = String(properties.date || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
    const start = properties.start ? new Date(properties.start) : null;
    date = start && !Number.isNaN(start.getTime())
      ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
      : '1970-01-01';
  }
  properties.date = date.slice(0, 10);
  properties.year = Number(properties.year) || Number(date.slice(0, 4)) || 1970;
  properties.title = String(properties.title || '未命名轨迹').slice(0, 90);
  properties.distanceKm = Number(properties.distanceKm) || 0;
  properties.durationMin = Number(properties.durationMin) || 0;
  return { ...feature, properties };
}

function buildManifest(features, { user, source, generatedAt } = {}) {
  const years = new Map();
  let distanceKm = 0;
  let points = 0;
  let firstDate = features[0]?.properties.date || null;
  let lastDate = firstDate;
  for (const feature of features) {
    const p = feature.properties;
    distanceKm += p.distanceKm;
    points += feature.geometry.coordinates.length;
    if (p.date < firstDate) firstDate = p.date;
    if (p.date > lastDate) lastDate = p.date;
    if (!years.has(p.year)) years.set(p.year, { year: p.year, count: 0, distanceKm: 0 });
    const entry = years.get(p.year);
    entry.count++;
    entry.distanceKm += p.distanceKm;
  }
  return {
    user: user || { name: state.name },
    generatedAt: generatedAt || new Date().toISOString(),
    source: source || 'gpx',
    datum: 'wgs84',
    stats: {
      activities: features.length,
      distanceKm: Math.round(distanceKm * 10) / 10,
      firstDate,
      lastDate,
      years: [...years.keys()].sort((a, b) => a - b),
      points,
    },
    years: [...years.values()]
      .map((entry) => ({ ...entry, distanceKm: Math.round(entry.distanceKm * 10) / 10 }))
      .sort((a, b) => a.year - b.year),
  };
}

function sourceLabel(source) {
  const labels = {
    xingzhe: '行者同步',
    file: '文件导入',
    gpx: 'GPX 导入',
    fit: 'FIT 导入',
    demo: '示例数据',
    mixed: '文件 + 行者',
  };
  return labels[source] || '本地数据';
}

function updateDocumentTitle() {
  document.title = `${state.name} · 路线总和图`;
}

function saveName() {
  try {
    localStorage.setItem(NAME_KEY, state.name);
  } catch {
    /* ignore */
  }
}

function setName(value, { custom = false, persist = true } = {}) {
  const cleaned = String(value || '').trim().slice(0, 24) || '我的轨迹';
  state.name = cleaned;
  state.customName = custom;
  els.nameInput.value = cleaned;
  if (persist) saveName();
  updateDocumentTitle();
}

function setYearOptions() {
  const entries = [...state.byYear.entries()]
    .map(([year, list]) => ({ year, count: list.length }))
    .sort((a, b) => b.year - a.year);
  els.yearControl.hidden = entries.length <= 1;
  els.yearSelect.innerHTML =
    '<option value="all">全部年份</option>' +
    entries.map((entry) => `<option value="${entry.year}">${entry.year}（${entry.count}）</option>`).join('');
  if (state.year !== 'all' && !entries.some((entry) => String(entry.year) === String(state.year))) {
    state.year = 'all';
  }
  els.yearSelect.value = state.year;
}

function updateDataUI() {
  const stats = state.manifest?.stats;
  els.rangeText.textContent = dateRangeOf(state.features, { compact: true });
  els.statCount.textContent = fmtInt(stats?.activities ?? state.features.length);
  els.statDistance.textContent = fmtKm(stats?.distanceKm ?? 0);
  els.statYears.textContent = String(stats?.years?.length ?? state.byYear.size);
  setYearOptions();
  els.exportBtn.disabled = false;
  els.fitBtn.disabled = false;
  els.clearBtn.hidden = false;
  els.onboarding.hidden = true;

  const updated = state.updatedAt ? new Date(state.updatedAt).toLocaleDateString('zh-CN') : '';
  els.updatedText.textContent = `${sourceLabel(state.source)}${updated ? ` · ${updated}` : ''}`;
  updateAttribution();
}

function showEmptyUI() {
  state.dataReady = false;
  state.manifest = null;
  state.features = [];
  state.byYear = new Map();
  state.collections = {};
  state.source = null;
  state.updatedAt = null;
  state.year = 'all';
  state.widthScale = 1;
  updateTrackWidths();
  els.rangeText.textContent = '导入 GPX / FIT 或同步行者，开始生成';
  els.statCount.textContent = '—';
  els.statDistance.textContent = '—';
  els.statYears.textContent = '—';
  els.yearControl.hidden = true;
  els.exportBtn.disabled = true;
  els.fitBtn.disabled = true;
  els.clearBtn.hidden = true;
  els.onboarding.hidden = false;
  els.updatedText.textContent = '数据只保存在你的浏览器';
  els.syncBar.style.width = '0%';
  const src = map.getSource('tracks');
  if (src) src.setData(EMPTY_FC);
  updateAttribution();
  updateDocumentTitle();
}

async function applyDataset(dataset, { persist = true, fit = true, source, displayName } = {}) {
  const input = Array.isArray(dataset.features) ? dataset.features : [];
  const features = input.map(normalizeFeature).filter(Boolean);
  if (features.length === 0) throw new Error('没有可用的轨迹');

  features.sort((a, b) =>
    String(a.properties.start || a.properties.date).localeCompare(String(b.properties.start || b.properties.date)),
  );
  state.features = features;
  state.byYear = new Map();
  for (const feature of features) {
    const year = feature.properties.year;
    if (!state.byYear.has(year)) state.byYear.set(year, []);
    state.byYear.get(year).push(feature);
  }
  state.source = source || dataset.source || dataset.manifest?.source || 'gpx';
  state.manifest = dataset.manifest || buildManifest(features, { user: dataset.user, source: state.source });
  state.manifest.source = state.source;
  state.updatedAt = state.manifest.generatedAt || new Date().toISOString();
  state.collections = { wgs84: { type: 'FeatureCollection', features } };
  state.dataReady = true;
  state.year = 'all';
  state.widthScale = features.length < 10 ? 1.9 : features.length < 40 ? 1.45 : 1;
  updateTrackWidths();

  const userName =
    displayName ||
    (!state.customName ? dataset.user?.name || dataset.manifest?.user?.name : null);
  if (userName) {
    setName(userName, { custom: false, persist: Boolean(displayName) });
  }

  if (state.autoOpacity) {
    const recommended = features.length < 60 ? 55 : features.length < 300 ? 48 : 35;
    els.opacity.value = String(recommended);
    applyOpacity(recommended);
  }

  updateDataUI();
  const src = map.getSource('tracks');
  if (src) src.setData(getCollection(state.datum));
  applyYear('all', { fit: false });
  if (fit) fitAll(0);

  if (persist) {
    saveDataset({
      manifest: state.manifest,
      features,
      source: state.source,
      user: { name: state.name },
    }).catch((err) => {
      console.warn('[store]', err);
      toast('浏览器本地存储不可用，刷新后数据会丢失', 5000);
    });
  }
}

async function loadExample() {
  if (state.dataReady) {
    const ok = window.confirm('加载示例会替换当前地图上的轨迹（不会删除已保存的导入数据），继续吗？');
    if (!ok) return;
  }
  try {
    els.loading.hidden = false;
    els.loading.classList.remove('is-hidden');
    els.spinner.style.display = '';
    els.loadingText.textContent = '正在加载示例…';
    els.loadingSub.textContent = 'L1tton 的行者记录';
    const manifestRes = await fetch('data/manifest.json', { cache: 'no-store' });
    if (!manifestRes.ok) throw new Error('示例数据不存在');
    const manifest = await manifestRes.json();
    const years = (manifest.years || []).filter((entry) => entry.file && entry.count > 0);
    const results = await Promise.all(
      years.map(async (entry) => {
        const res = await fetch(`data/${entry.file}`, { cache: 'no-store' });
        return res.ok ? res.json() : null;
      }),
    );
    const features = results.flatMap((collection) =>
      collection && Array.isArray(collection.features) ? collection.features : [],
    );
    await applyDataset({ manifest, features, user: manifest.user, source: 'demo' }, { persist: false });
    setName('L1tton', { custom: false, persist: false });
    toast('已加载示例数据');
  } catch (err) {
    console.error('[example]', err);
    toast(`示例加载失败：${err.message}`, 5000);
  } finally {
    hideLoading();
  }
}

async function clearData() {
  if (!state.dataReady) return;
  const ok = window.confirm('清空当前地图上的所有轨迹？浏览器里保存的这份数据也会被删除。');
  if (!ok) return;
  try {
    await clearDataset();
  } catch (err) {
    console.warn('[store]', err);
  }
  showEmptyUI();
  if (!state.customName) setName('我的轨迹', { custom: false, persist: false });
  map.jumpTo({ center: [104, 35], zoom: 3.4 });
  toast('已清空');
}

async function clearWallpaperRoute() {
  try {
    await clearDataset();
    localStorage.setItem(WALLPAPER_CLEARED_KEY, '1');
  } catch (err) {
    console.warn('[wallpaper] clear route failed', err);
  }
  showEmptyUI();
  if (!state.customName) setName('我的轨迹', { custom: false, persist: false });
  map.jumpTo({ center: [104, 35], zoom: 3.4 });
}

function getCollection(datum) {
  if (state.collections[datum]) return state.collections[datum];
  const base = state.collections.wgs84 || { type: 'FeatureCollection', features: [] };
  const features = base.features.map((f) => ({
    type: 'Feature',
    properties: f.properties,
    geometry: {
      type: 'LineString',
      coordinates: f.geometry.coordinates.map(([lng, lat]) => wgs84ToGcj02(lng, lat)),
    },
  }));
  const collection = { type: 'FeatureCollection', features };
  state.collections[datum] = collection;
  return collection;
}

function filteredFeaturesForDatum() {
  const year = state.year === 'all' ? null : Number(state.year);
  const list = getCollection(state.datum).features;
  return year ? list.filter((f) => f.properties.year === year) : list;
}

function boundsOf(features) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const f of features) {
    for (const [lng, lat] of f.geometry.coordinates) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLng)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

function mapPadding() {
  if (els.panel.hidden) {
    return window.innerWidth <= 720
      ? { top: 22, bottom: 64, left: 22, right: 22 }
      : { top: 56, bottom: 56, left: 22, right: 22 };
  }

  // 全览只参考面板的初始尺寸，不跟随面板被拖到哪。
  if (window.innerWidth <= 720) {
    const top = Math.min(
      Math.max(96, 10 + els.panel.offsetHeight + 18),
      Math.round(window.innerHeight * 0.68),
    );
    return { top, bottom: 64, left: 22, right: 22 };
  }
  return { top: 56, bottom: 56, left: 360, right: 56 };
}

function fitFeatures(features, duration = 0) {
  const bounds = boundsOf(features);
  if (!bounds) return;
  try {
    map.fitBounds(bounds, {
      padding: mapPadding(),
      maxZoom: 13,
      duration,
      essential: true,
    });
  } catch (err) {
    console.warn('[fit]', err);
  }
}

function fitAll(duration = 600) {
  if (!state.dataReady) return;
  fitFeatures(filteredFeaturesForDatum(), duration);
}

/* ------------------------------------------------------------------ */
/* Basemap + datum                                                     */
/* ------------------------------------------------------------------ */

function applyBasemap(id, { preserveView = true, persist = true } = {}) {
  const def = BASEMAPS[id] || BASEMAPS.dark || BASEMAPS.light;
  if (map.getLayer('background')) {
    map.setPaintProperty('background', 'background-color', def.bg || PAPER);
  }
  for (const id of ['base-waterway', 'base-water', 'base-park', 'base-landuse', 'base-landcover']) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource('basemap-vector')) map.removeSource('basemap-vector');
  for (const id of ['roads-minor', 'roads-tertiary', 'roads-primary', 'roads-motorway']) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource('roads')) map.removeSource('roads');
  if (map.getLayer('basemap-labels')) map.removeLayer('basemap-labels');
  if (map.getSource('basemap-labels')) map.removeSource('basemap-labels');
  if (map.getLayer('basemap')) map.removeLayer('basemap');
  if (map.getSource('basemap')) map.removeSource('basemap');

  if (def.tiles) {
    map.addSource('basemap', {
      type: 'raster',
      tiles: def.tiles,
      tileSize: 256,
      maxzoom: def.maxzoom,
    });
    map.addLayer(
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
        paint: { 'raster-opacity': def.opacity ?? 0.9, ...(def.paint || {}) },
      },
      'track-glow',
    );
  }

  if (def.vectorBase) {
    map.addSource('basemap-vector', {
      type: 'vector',
      url: ROAD_TILEJSON,
    });
    for (const spec of vectorBaseLayerSpecs(def.vectorTheme)) {
      map.addLayer({ ...spec, source: 'basemap-vector' }, 'track-glow');
    }
  }

  if (def.roads) {
    map.addSource('roads', {
      type: 'vector',
      url: ROAD_TILEJSON,
    });
    const roadOpacity = id === 'dark' || id === 'light' ? state.roadOpacity / 100 : 0.92;
    map.addLayer(
      roadLayerSpec('roads-motorway', def, MOTORWAY_ROAD_CLASSES, 4, roadOpacity),
      'track-glow',
    );
    map.addLayer(
      roadLayerSpec('roads-primary', def, PRIMARY_ROAD_CLASSES, 9, roadOpacity),
      'track-glow',
    );
    map.addLayer(
      roadLayerSpec('roads-tertiary', def, TERTIARY_ROAD_CLASSES, 11, roadOpacity),
      'track-glow',
    );
    map.addLayer(
      roadLayerSpec('roads-minor', def, MINOR_ROAD_CLASSES, 13, roadOpacity),
      'track-glow',
    );
  }

  if (def.labels) {
    map.addSource('basemap-labels', {
      type: 'raster',
      tiles: def.labels,
      tileSize: 256,
      maxzoom: def.maxzoom,
    });
    map.addLayer(
      {
        id: 'basemap-labels',
        type: 'raster',
        source: 'basemap-labels',
        layout: { visibility: state.showLabels ? 'visible' : 'none' },
        paint: { 'raster-opacity': 1, ...(def.labelPaint || {}) },
      },
      'track-glow',
    );
  }

  state.base = id;
  updateLabelToggle();
  updateRoadDensityUI();
  if (persist) {
    try {
      localStorage.setItem(BASE_KEY, id);
    } catch {
      /* ignore */
    }
  }
  updateAttribution();
  updateBaseButtons();
  setDatum(def.datum, { preserveView });
}

function setDatum(datum, { preserveView = true } = {}) {
  if (datum === state.datum) return;
  const center = map.getCenter();
  const collection = getCollection(datum);
  const src = map.getSource('tracks');
  if (src && state.dataReady) src.setData(collection);
  state.datum = datum;

  if (preserveView) {
    const converted =
      datum === 'gcj02'
        ? wgs84ToGcj02(center.lng, center.lat)
        : gcj02ToWgs84(center.lng, center.lat);
    map.jumpTo({ center: converted });
  }
}

function trackCredit() {
  if (!state.source || state.source === 'file' || state.source === 'gpx' || state.source === 'fit') {
    return '轨迹 © 本人';
  }
  if (state.source === 'mixed') return '轨迹 © 本人 / 行者';
  return '轨迹 © 行者 imxingzhe.com';
}

function updateAttribution() {
  const def = BASEMAPS[state.base] || BASEMAPS.dark;
  els.attribution.textContent = `${trackCredit()} · ${def.credit}`;
}

function updateBaseButtons() {
  $$('.base-btn').forEach((button) => {
    const active = button.dataset.base === state.base;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function updateAvailableBasemaps() {
  $$('.base-btn').forEach((button) => {
    if (button.dataset.base === 'terrain') {
      button.hidden = !state.tiandituEnabled;
    } else if (button.dataset.base === 'dark') {
      button.hidden = !BASEMAPS.dark;
    }
  });
}

function updateLabelToggle() {
  const available = state.tiandituEnabled && Boolean(BASEMAPS[state.base]?.labels);
  els.labelToggle.hidden = !available;
  els.showLabels.checked = Boolean(state.showLabels);
}

function roadVisibilityForDensity(density) {
  return {
    'roads-motorway': density > 0,
    'roads-primary': density >= 25,
    'roads-tertiary': density >= 50,
    'roads-minor': density >= 75,
  };
}

function applyRoadDensity() {
  const visibility = roadVisibilityForDensity(state.roadDensity);
  for (const [id, visible] of Object.entries(visibility)) {
    try {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      }
    } catch {
      /* style not ready yet */
    }
  }
}

function applyRoadOpacity() {
  if (state.base !== 'dark' && state.base !== 'light') return;
  const opacity = state.roadOpacity / 100;
  for (const id of ['roads-motorway', 'roads-primary', 'roads-tertiary', 'roads-minor']) {
    try {
      if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', opacity);
    } catch {
      /* style not ready yet */
    }
  }
}

function updateRoadDensityUI() {
  const active = state.base === 'dark' || state.base === 'light';
  els.roadDensityControl.hidden = !active;
  els.roadOpacityControl.hidden = !active;
  if (!active) return;
  els.roadDensity.value = String(state.roadDensity);
  els.roadDensityValue.textContent = `${state.roadDensity}%`;
  els.roadOpacity.value = String(state.roadOpacity);
  els.roadOpacityValue.textContent = `${state.roadOpacity}%`;
  applyRoadDensity();
  applyRoadOpacity();
}

/* ------------------------------------------------------------------ */
/* Stats + filtering                                                   */
/* ------------------------------------------------------------------ */

function updateStats(features) {
  if (!state.dataReady) return;
  const count = features.length;
  let km = 0;
  const years = new Set();
  for (const f of features) {
    km += Number(f.properties.distanceKm) || 0;
    years.add(f.properties.year);
  }
  els.statCount.textContent = fmtInt(count);
  els.statDistance.textContent = fmtKm(km);
  els.statYears.textContent = String(years.size);
}

function applyFilter() {
  const expression =
    state.year === 'all' ? null : ['==', ['get', 'year'], Number(state.year)];
  for (const layer of ['track-line', 'track-glow']) {
    if (map.getLayer(layer)) map.setFilter(layer, expression);
  }
  updateStats(filteredFeaturesForDatum());
}

function applyYear(value, { fit = true, animate = true } = {}) {
  state.year = value;
  els.yearSelect.value = value;
  applyFilter();
  if (fit && state.dataReady) fitFeatures(filteredFeaturesForDatum(), animate ? 650 : 0);
}

function applyOpacity(percent) {
  const value = Number(percent);
  const opacity = value / 100;
  state.opacity = opacity;
  if (map.getLayer('track-line')) map.setPaintProperty('track-line', 'line-opacity', opacity);
  if (map.getLayer('track-glow'))
    map.setPaintProperty('track-glow', 'line-opacity', Math.min(0.18, opacity * 0.3));
  els.opacityValue.textContent = `${value}%`;
}

function updateTrackWidths() {
  const scale = state.widthScale || 1;
  if (map.getLayer('track-line')) {
    map.setPaintProperty('track-line', 'line-width', widthExpression(TRACK_WIDTH_STOPS, scale));
  }
  if (map.getLayer('track-glow')) {
    map.setPaintProperty('track-glow', 'line-width', widthExpression(GLOW_WIDTH_STOPS, scale));
  }
}

function hexToRgba(hex, alpha) {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function syncColorButtons() {
  $$('.color-swatch').forEach((button) => {
    const active = button.dataset.color === state.trackColor;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function applyTrackColor(hex, { persist = true } = {}) {
  const color = TRACK_COLORS.some((entry) => entry.hex === hex) ? hex : TRACK;
  state.trackColor = color;
  try {
    if (map.getLayer('track-line')) map.setPaintProperty('track-line', 'line-color', color);
    if (map.getLayer('track-glow')) map.setPaintProperty('track-glow', 'line-color', color);
  } catch {
    /* style not ready yet */
  }
  document.documentElement.style.setProperty('--track-color', color);
  document.documentElement.style.setProperty('--track-color-soft', hexToRgba(color, 0.16));
  syncColorButtons();
  if (persist) {
    try {
      localStorage.setItem(TRACK_COLOR_KEY, color);
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Popup                                                               */
/* ------------------------------------------------------------------ */

let activePopup = null;

map.on('click', 'track-line', (event) => {
  if (!state.mapInteractive || suppressMapClick) return;
  const feature = event.features && event.features[0];
  if (!feature) return;
  const p = feature.properties;
  const node = document.createElement('div');
  const date = document.createElement('div');
  date.className = 'p-date';
  date.textContent = fmtDate(p.date);
  const title = document.createElement('div');
  title.className = 'p-title';
  title.textContent = p.title || '未命名记录';
  const meta = document.createElement('div');
  meta.className = 'p-meta';
  meta.textContent = `${Number(p.distanceKm || 0).toFixed(1)} km${
    p.durationMin ? ` · ${formatDuration(p.durationMin)}` : ''
  }`;
  node.append(date, title, meta);
  if (activePopup) activePopup.remove();
  activePopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: true,
    className: 'trail-popup',
    offset: 10,
    maxWidth: '260px',
  })
    .setLngLat(event.lngLat)
    .setDOMContent(node)
    .addTo(map);
});

map.on('mouseenter', 'track-line', () => {
  if (!state.mapInteractive) return;
  map.getCanvas().style.cursor = 'pointer';
});
map.on('mouseleave', 'track-line', () => {
  map.getCanvas().style.cursor = state.mapInteractive ? 'grab' : 'default';
});

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const EXPORT_QUALITIES = {
  standard: 3000,
  high: 4800,
  ultra: 7200,
  poster: 9600,
};
const EXPORT_RATIOS = {
  '1:1': 1,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
};
const MAX_EXPORT_PIXELS = 60_000_000;

function checkedValue(name, fallback) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || fallback;
}

function naturalMapRatio(features) {
  const bounds = boundsOf(features);
  if (!bounds) return 4 / 3;
  const width = Math.max(1e-9, ((bounds[1][0] - bounds[0][0]) * Math.PI) / 180);
  const height = Math.max(1e-9, mercatorY(bounds[1][1]) - mercatorY(bounds[0][1]));
  return width / height;
}

function computeExportLayout({ scope, ratioValue, qualityValue, withHeader, features }) {
  const longEdge = EXPORT_QUALITIES[qualityValue] || EXPORT_QUALITIES.high;
  let ratio = EXPORT_RATIOS[ratioValue];
  if (!ratio) {
    if (scope === 'view') {
      const container = map.getContainer();
      ratio = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
    } else {
      ratio = naturalMapRatio(features);
    }
  }
  ratio = Math.max(0.1, Math.min(10, ratio));

  let finalW;
  let finalH;
  if (ratio >= 1) {
    finalW = longEdge;
    finalH = Math.max(1, Math.round(longEdge / ratio));
  } else {
    finalH = longEdge;
    finalW = Math.max(1, Math.round(longEdge * ratio));
  }

  let capped = false;
  if (finalW * finalH > MAX_EXPORT_PIXELS) {
    const scale = Math.sqrt(MAX_EXPORT_PIXELS / (finalW * finalH));
    finalW = Math.max(1, Math.floor(finalW * scale));
    finalH = Math.max(1, Math.floor(finalH * scale));
    capped = true;
  }

  const headerHeight = withHeader ? Math.round(finalH * 0.075) : 0;
  const footerHeight = Math.round(finalH * 0.022);
  let mapH = finalH - headerHeight - footerHeight;
  if (mapH < 240) {
    mapH = 240;
    finalH = mapH + headerHeight + footerHeight;
  }
  const fontScale = Math.max(1, finalH / 1200);

  return {
    finalW,
    finalH,
    mapW: finalW,
    mapH,
    headerHeight,
    footerHeight,
    fontScale,
    ratio,
    capped,
  };
}

function updateExportHint() {
  if (!els.exportSizeHint) return;
  const features = filteredFeaturesForDatum();
  if (!features.length) {
    els.exportSizeHint.textContent = '当前筛选没有轨迹';
    return;
  }
  const scope = checkedValue('exportScope', 'all');
  const ratio = checkedValue('exportRatio', 'auto');
  const quality = checkedValue('exportQuality', 'high');
  const layout = computeExportLayout({
    scope,
    ratioValue: ratio,
    qualityValue: quality,
    withHeader: els.exportHeader.checked,
    features,
  });
  const ratioLabel = ratio === 'auto' ? '自动比例' : ratio;
  els.exportSizeHint.textContent =
    `${scope === 'all' ? '全部轨迹' : '当前视图'} · ${ratioLabel} · ` +
    `约 ${layout.finalW} × ${layout.finalH} px` +
    (layout.capped ? '（已限制在 6000 万像素内）' : '');
}

function openExport() {
  if (!state.dataReady) {
    toast('轨迹还没有加载完成');
    return;
  }
  els.exportModal.hidden = false;
  els.exportConfirm.disabled = false;
  els.exportConfirm.textContent = '导出 PNG';
  updateExportHint();
  $('#exportClose').focus();
}

function closeExport() {
  if (state.exportBusy) return;
  els.exportModal.hidden = true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildExportStyle(baseId, collection, { lineScale = 1 } = {}) {
  const def = BASEMAPS[baseId] || BASEMAPS.dark;
  const sources = {
    tracks: { type: 'geojson', data: collection },
  };
  const layers = [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': def.bg || PAPER },
    },
  ];
  if (def.tiles) {
    sources.basemap = {
      type: 'raster',
      tiles: def.tiles,
      tileSize: 256,
      maxzoom: def.maxzoom,
    };
    layers.push({
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
      paint: { 'raster-opacity': def.opacity ?? 0.9, ...(def.paint || {}) },
    });
  }
  if (def.vectorBase) {
    sources['basemap-vector'] = {
      type: 'vector',
      url: ROAD_TILEJSON,
    };
    for (const spec of vectorBaseLayerSpecs(def.vectorTheme)) {
      layers.push({ ...spec, source: 'basemap-vector' });
    }
  }
  if (def.roads) {
    sources.roads = {
      type: 'vector',
      url: ROAD_TILEJSON,
    };
    const roadTiers = [
      ['roads-motorway', MOTORWAY_ROAD_CLASSES, 4],
      ['roads-primary', PRIMARY_ROAD_CLASSES, 9],
      ['roads-tertiary', TERTIARY_ROAD_CLASSES, 11],
      ['roads-minor', MINOR_ROAD_CLASSES, 13],
    ];
    const roadVisibility = roadVisibilityForDensity(
      baseId === 'dark' || baseId === 'light' ? state.roadDensity : 100,
    );
    const roadOpacity = baseId === 'dark' || baseId === 'light' ? state.roadOpacity / 100 : 0.92;
    for (const [id, classes, minzoom] of roadTiers) {
      if (roadVisibility[id]) {
        layers.push(roadLayerSpec(id, def, classes, minzoom, roadOpacity));
      }
    }
  }
  if (def.labels && state.showLabels) {
    sources['basemap-labels'] = {
      type: 'raster',
      tiles: def.labels,
      tileSize: 256,
      maxzoom: def.maxzoom,
    };
    layers.push({
      id: 'basemap-labels',
      type: 'raster',
      source: 'basemap-labels',
      paint: { 'raster-opacity': 1, ...(def.labelPaint || {}) },
    });
  }
  layers.push(
    {
      id: 'track-glow',
      type: 'line',
      source: 'tracks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': state.trackColor,
        'line-width': widthExpression(GLOW_WIDTH_STOPS, lineScale),
        'line-opacity': Math.min(0.18, state.opacity * 0.3),
        'line-blur': 1.2,
      },
    },
    {
      id: 'track-line',
      type: 'line',
      source: 'tracks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': state.trackColor,
        'line-width': widthExpression(TRACK_WIDTH_STOPS, lineScale),
        'line-opacity': state.opacity,
      },
    },
  );
  return { version: 8, sources, layers };
}

function mercatorY(lat) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

async function renderHiddenMap({ bounds, outW, outH, padding = 60, maxZoom = 14, lineScale = 1, features }) {
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-14000px;top:0;width:${outW}px;height:${outH}px;pointer-events:none;`;
  document.body.appendChild(holder);

  const exportMap = new maplibregl.Map({
    container: holder,
    style: buildExportStyle(
      state.base,
      { type: 'FeatureCollection', features },
      { lineScale },
    ),
    center: [0, 0],
    zoom: 2,
    interactive: false,
    attributionControl: false,
    preserveDrawingBuffer: true,
    fadeDuration: 0,
    pixelRatio: 1,
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('导出地图渲染超时')), 45000);
      exportMap.once('load', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    exportMap.fitBounds(bounds, { padding, animate: false, maxZoom });
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = setTimeout(finish, 30000);
      exportMap.once('idle', () => {
        clearTimeout(timer);
        finish();
      });
    });
    await sleep(700);

    const sourceCanvas = exportMap.getCanvas();
    const copy = document.createElement('canvas');
    copy.width = outW;
    copy.height = outH;
    const ctx = copy.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0, outW, outH);
    return copy;
  } finally {
    exportMap.remove();
    holder.remove();
  }
}

async function renderFullMap(features, { ratio = 'auto', quality = 'high', withHeader = true } = {}) {
  const bounds = boundsOf(features);
  if (!bounds) throw new Error('当前没有轨迹可以导出');
  const layout = computeExportLayout({
    scope: 'all',
    ratioValue: ratio,
    qualityValue: quality,
    withHeader,
    features,
  });

  return renderHiddenMap({
    bounds,
    outW: layout.mapW,
    outH: layout.mapH,
    padding: 60,
    maxZoom: 14,
    lineScale:
      Math.max(1.2, Math.max(layout.mapW, layout.mapH) / 1800) * (state.widthScale || 1),
    features,
  });
}

async function renderViewMap(features, { ratio = 'auto', quality = 'high', withHeader = true } = {}) {
  const container = map.getContainer();
  const cw = Math.max(1, container.clientWidth);
  const ch = Math.max(1, container.clientHeight);
  const layout = computeExportLayout({
    scope: 'view',
    ratioValue: ratio,
    qualityValue: quality,
    withHeader,
    features,
  });
  return renderHiddenMap({
    bounds: map.getBounds().toArray(),
    outW: layout.mapW,
    outH: layout.mapH,
    padding: 0,
    maxZoom: 18,
    lineScale: Math.max(1, layout.mapW / cw, layout.mapH / ch) * (state.widthScale || 1),
    features,
  });
}

function composeImage(mapCanvas, { withHeader, features, layout } = {}) {
  const fallbackScale = Math.max(1, mapCanvas.width / 2200);
  const headerHeight = withHeader
    ? layout?.headerHeight ?? Math.round(96 * fallbackScale)
    : 0;
  const footerHeight = layout?.footerHeight ?? Math.round(30 * fallbackScale);
  const scale = layout?.fontScale ?? fallbackScale;
  const canvas = document.createElement('canvas');
  canvas.width = mapCanvas.width;
  canvas.height = headerHeight + mapCanvas.height + footerHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fffdf9';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (withHeader) {
    const title = state.name;
    ctx.fillStyle = '#1b1b1f';
    ctx.font = `700 ${Math.round(27 * scale)}px "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(title, Math.round(32 * scale), Math.round(43 * scale));

    let km = 0;
    for (const f of features) km += Number(f.properties.distanceKm) || 0;
    ctx.fillStyle = '#726c63';
    ctx.font = `${Math.round(13 * scale)}px "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`;
    ctx.fillText(
      `路线总和图 · ${dateRangeOf(features)} · ${fmtInt(features.length)} 条记录 · ${fmtKm(km)} 公里`,
      Math.round(32 * scale),
      Math.round(69 * scale),
    );

    ctx.fillStyle = '#9a9389';
    ctx.font = `${Math.round(11 * scale)}px "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText('route atlas', canvas.width - Math.round(32 * scale), Math.round(40 * scale));
    ctx.fillStyle = '#e9e2d7';
    const lineHeight = Math.max(1, Math.round(scale * 0.7));
    ctx.fillRect(0, headerHeight - lineHeight, canvas.width, lineHeight);
  }

  ctx.drawImage(mapCanvas, 0, headerHeight);

  const def = BASEMAPS[state.base] || BASEMAPS.dark;
  ctx.fillStyle = '#fffdf9';
  ctx.fillRect(0, headerHeight + mapCanvas.height, canvas.width, footerHeight);
  ctx.fillStyle = '#8b847a';
  ctx.font = `${Math.round(10 * scale)}px "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(
    trackCredit(),
    Math.round(32 * scale),
    headerHeight + mapCanvas.height + Math.round(19 * scale),
  );
  ctx.textAlign = 'right';
  ctx.fillText(
    def.credit,
    canvas.width - Math.round(32 * scale),
    headerHeight + mapCanvas.height + Math.round(19 * scale),
  );

  return canvas;
}

let memoryExportSerial = 0;

function nextExportName() {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  let serial;
  try {
    const raw = localStorage.getItem('trailmap.exportSeq');
    const saved = raw ? JSON.parse(raw) : null;
    const previous = saved && saved.date === date ? Number(saved.seq) || 0 : 0;
    serial = (previous % 9999) + 1;
    localStorage.setItem('trailmap.exportSeq', JSON.stringify({ date, seq: serial }));
  } catch {
    memoryExportSerial = (memoryExportSerial % 9999) + 1;
    serial = memoryExportSerial;
  }
  const slug =
    state.name
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'trail-map';
  return `${slug}-${date}-${String(serial).padStart(4, '0')}.png`;
}

function downloadCanvas(canvas) {
  return new Promise((resolve, reject) => {
    function downloadBlob(result) {
      const url = URL.createObjectURL(result);
      const link = document.createElement('a');
      link.href = url;
      link.download = nextExportName();
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      resolve();
    }
    try {
      canvas.toBlob((result) => {
        if (result) downloadBlob(result);
        else reject(new Error('浏览器未能生成图片'));
      }, 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

async function doExport() {
  if (state.exportBusy) return;
  const scope = checkedValue('exportScope', 'all');
  const ratio = checkedValue('exportRatio', 'auto');
  const quality = checkedValue('exportQuality', 'high');
  const withHeader = els.exportHeader.checked;
  const features = filteredFeaturesForDatum();
  if (!features.length) {
    toast('当前筛选没有轨迹');
    return;
  }
  const layout = computeExportLayout({
    scope,
    ratioValue: ratio,
    qualityValue: quality,
    withHeader,
    features,
  });

  state.exportBusy = true;
  els.exportConfirm.disabled = true;
  els.exportConfirm.textContent = '生成中…';
  els.exportBtn.disabled = true;

  try {
    let mapCanvas;
    if (scope === 'all') {
      els.exportConfirm.textContent = '正在绘制…';
      mapCanvas = await renderFullMap(features, { ratio, quality, withHeader });
    } else {
      mapCanvas = await renderViewMap(features, { ratio, quality, withHeader });
    }
    const output = composeImage(mapCanvas, { withHeader, features, layout });
    if (DEBUG) {
      window.__lastExport = output;
      window.__lastExportMeta = {
        width: output.width,
        height: output.height,
        scope,
        ratio,
        quality,
        expected: [layout.finalW, layout.finalH],
        features: features.length,
      };
    }
    await downloadCanvas(output);
    els.exportModal.hidden = true;
    toast('图片已导出');
  } catch (err) {
    console.error('[export]', err);
    const message = String(err && err.message ? err.message : err);
    if (/tainted|SecurityError|cross-origin/i.test(message)) {
      toast('当前底图不允许跨域导出，请切换到浅色 / 深色 / 卫星后重试', 6000);
    } else {
      toast(`导出失败：${message}`, 5000);
    }
  } finally {
    state.exportBusy = false;
    els.exportBtn.disabled = false;
    els.exportConfirm.disabled = false;
    els.exportConfirm.textContent = '导出 PNG';
  }
}

/* ------------------------------------------------------------------ */
/* Import + sync                                                       */
/* ------------------------------------------------------------------ */

function openImportPicker() {
  els.gpxInput.value = '';
  els.gpxInput.click();
}

function setImportProgress(percent) {
  els.importBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function logImport(message) {
  const lines = (els.importLog.textContent ? els.importLog.textContent.split('\n') : []).concat(message);
  els.importLog.textContent = lines.slice(-8).join('\n');
}

let fitModulePromise = null;
function loadFitModule() {
  if (!fitModulePromise) fitModulePromise = import('./fit.js');
  return fitModulePromise;
}

async function handleGpxFiles(fileList) {
  if (state.syncBusy) {
    toast('请先完成或取消行者同步，再导入 GPX / FIT');
    return;
  }
  const candidates = [...fileList].filter(
    (file) => /\.(gpx|fit)$/i.test(file.name) || file.type === 'application/gpx+xml',
  );
  const files = candidates.slice(0, 800);
  if (files.length === 0) {
    toast('请选择 .gpx 或 .fit 文件');
    return;
  }
  if (candidates.length > files.length) {
    toast('一次最多导入 800 个文件，已取前 800 个', 5000);
  }

  const existing = state.source === 'demo' ? [] : state.features.slice();
  const wasDemo = state.source === 'demo';
  const seen = new Set(existing.map((feature) => feature.properties.importKey).filter(Boolean));
  let added = 0;
  let failed = 0;
  state.importAbort = false;

  els.importModal.hidden = false;
  els.importLog.textContent = '';
  els.importStatus.textContent = `正在导入 ${files.length} 个文件…`;
  setImportProgress(0);

  for (let i = 0; i < files.length; i++) {
    if (state.importAbort) break;
    const file = files[i];
    els.importStatus.textContent = `正在读取 ${i + 1}/${files.length}：${file.name}`;
    setImportProgress(((i + 0.5) / files.length) * 100);
    if (file.size > 30 * 1024 * 1024) {
      failed++;
      logImport(`✗ ${file.name}：文件超过 30MB，已跳过`);
      continue;
    }
    try {
      const features = /\.fit$/i.test(file.name)
        ? await (await loadFitModule()).fitFileToFeatures(file)
        : await gpxFileToFeatures(file);
      for (const feature of features) {
        if (seen.has(feature.properties.importKey)) continue;
        seen.add(feature.properties.importKey);
        existing.push(feature);
        added++;
      }
    } catch (err) {
      failed++;
      logImport(`✗ ${file.name}：${err.message}`);
    }
    setImportProgress(((i + 1) / files.length) * 100);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (state.importAbort) {
    els.importStatus.textContent = '已取消导入';
    els.importModal.hidden = true;
    toast('已取消导入');
    return;
  }

  if (added === 0) {
    els.importStatus.textContent = failed ? '没有导入成功，请查看日志' : '这些文件已经在当前地图里了';
    return;
  }

  let source = 'file';
  if (state.dataReady && (state.source === 'xingzhe' || state.source === 'mixed')) source = 'mixed';
  if (wasDemo) setName('我的轨迹', { custom: false, persist: false });
  const manifest = buildManifest(existing, { user: { name: state.name }, source });
  try {
    await applyDataset(
      { manifest, features: existing, user: { name: state.name }, source },
      { persist: true, source },
    );
    try {
      localStorage.removeItem(WALLPAPER_CLEARED_KEY);
    } catch {
      /* ignore */
    }
    els.importModal.hidden = true;
    toast(`已导入 ${added} 条轨迹${failed ? `，${failed} 个文件失败` : ''}`);
  } catch (err) {
    els.importStatus.textContent = `保存失败：${err.message}`;
    logImport(`✗ ${err.message}`);
  }
}

function updateSyncButton() {
  els.syncStart.disabled = !els.syncConsent.checked || !els.cookieInput.value.trim();
}

const SYNC_RANGE_LABELS = { '1y': '最近 1 年', '3y': '最近 3 年', all: '全部历史' };

function selectedSyncRange() {
  const checked = document.querySelector('input[name="syncRange"]:checked');
  const value = checked?.value;
  return value === '3y' || value === 'all' ? value : '1y';
}

function openSyncModal() {
  els.syncIntro.hidden = false;
  els.syncProgress.hidden = true;
  els.cookieInput.value = '';
  els.syncConsent.checked = false;
  els.syncStart.disabled = true;
  const defaultRange = document.querySelector('input[name="syncRange"][value="1y"]');
  if (defaultRange) defaultRange.checked = true;
  els.syncStatus.textContent = '准备中…';
  els.syncBar.style.width = '0%';
  els.syncLog.textContent = '';
  els.syncModal.hidden = false;
  els.cookieInput.focus();
  els.syncStop.textContent = '取消同步';
  els.syncStop.disabled = false;
}

function closeSyncModal() {
  if (state.syncBusy) {
    state.syncAbort?.abort();
    state.syncBusy = false;
  }
  els.cookieInput.value = '';
  els.syncModal.hidden = true;
  els.syncIntro.hidden = false;
  els.syncProgress.hidden = true;
}

function setSyncStatus(text) {
  els.syncStatus.textContent = text;
}

function appendSyncLog(text) {
  const lines = (els.syncLog.textContent ? els.syncLog.textContent.split('\n') : []).concat(text);
  els.syncLog.textContent = lines.slice(-8).join('\n');
  els.syncLog.scrollTop = els.syncLog.scrollHeight;
}

function handleSyncEvent(event) {
  if (!event || !event.type) return;
  if (event.type === 'range') {
    setSyncStatus(`${event.label || ''} · 共 ${event.months || 0} 个月，准备读取…`);
  } else if (event.type === 'user') {
    setSyncStatus(
      `已登录：${event.user?.name || '行者用户'}${
        state.syncRangeLabel ? ` · ${state.syncRangeLabel}` : ''
      }`,
    );
  } else if (event.type === 'progress' && event.phase === 'months') {
    const ratio = event.total ? event.current / event.total : 0;
    els.syncBar.style.width = `${Math.min(20, ratio * 20)}%`;
    setSyncStatus(
      `读取运动列表 ${event.current}/${event.total}${
        event.found ? ` · 已找到 ${event.found} 条` : ''
      }${event.merged ? ` · 跳过合并 ${event.merged}` : ''}`,
    );
  } else if (event.type === 'progress' && event.phase === 'tracks') {
    const ratio = event.total ? event.current / event.total : 0;
    els.syncBar.style.width = `${20 + ratio * 80}%`;
    setSyncStatus(`下载轨迹 ${event.current}/${event.total}`);
    appendSyncLog(`· ${event.title || ''}`);
  } else if (event.type === 'done') {
    els.syncBar.style.width = '100%';
    setSyncStatus('正在整理地图…');
  } else if (event.type === 'error') {
    setSyncStatus(`同步失败：${event.message || '未知错误'}`);
  }
}

async function readNdjson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

async function startSync() {
  if (state.syncBusy) return;
  if (!els.importModal.hidden) {
    toast('请先完成 GPX 导入');
    return;
  }
  const cookie = els.cookieInput.value.trim();
  if (!cookie) {
    toast('请先粘贴行者 Cookie');
    return;
  }
  if (cookie.length > 12000) {
    toast('Cookie 内容过长，请检查是否复制完整');
    return;
  }
  const range = selectedSyncRange();
  const rangeLabel = SYNC_RANGE_LABELS[range];
  state.syncRangeLabel = rangeLabel;

  state.syncBusy = true;
  state.syncAbort = new AbortController();
  els.cookieInput.value = '';
  els.syncIntro.hidden = true;
  els.syncProgress.hidden = false;
  els.syncLog.textContent = '';
  els.syncBar.style.width = '0%';
  setSyncStatus(`正在校验登录态…（${rangeLabel}）`);
  els.syncStop.disabled = false;
  els.syncStop.textContent = '取消同步';

  let donePayload = null;
  let syncError = null;
  try {
    const response = await fetch('api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie, range }),
      signal: state.syncAbort.signal,
    });
    if (response.status === 404) {
      throw new Error('同步服务未部署，请改用 GPX / FIT 导入');
    }
    if (!response.ok) {
      let message = `同步请求失败（HTTP ${response.status}）`;
      try {
        const json = await response.json();
        if (json.message) message = json.message;
      } catch {
        /* ignore */
      }
      throw new Error(message);
    }
    if (!response.body) throw new Error('当前浏览器不支持流式同步');
    await readNdjson(response, (event) => {
      if (event.type === 'done') donePayload = event;
      if (event.type === 'error') syncError = event.message || '同步失败';
      handleSyncEvent(event);
    });
    if (syncError) throw new Error(syncError);
    if (!donePayload || !Array.isArray(donePayload.features) || donePayload.features.length === 0) {
      throw new Error('同步没有返回轨迹，请确认账号里有 GPS 记录');
    }
    const syncedName = donePayload.user?.name || donePayload.manifest?.user?.name;
    await applyDataset(
      {
        manifest: donePayload.manifest,
        features: donePayload.features,
        user: donePayload.user,
        source: 'xingzhe',
      },
      { persist: true, source: 'xingzhe', displayName: syncedName },
    );
    els.syncModal.hidden = true;
    els.syncIntro.hidden = false;
    els.syncProgress.hidden = true;
    const truncated = donePayload.manifest?.truncated;
    const merged = donePayload.manifest?.skipped?.merged || 0;
    const doneRange = donePayload.manifest?.rangeLabel || rangeLabel;
    const extras = [
      merged ? `跳过 ${merged} 条合并记录` : '',
      truncated ? '已达上限，较早记录未包含' : '',
    ].filter(Boolean);
    toast(
      `同步完成：${donePayload.features.length} 条轨迹（${doneRange}）${
        extras.length ? `；${extras.join('；')}` : ''
      }`,
      truncated ? 6500 : 4200,
    );
  } catch (err) {
    if (err.name === 'AbortError') {
      setSyncStatus('已取消同步');
    } else {
      setSyncStatus(`同步失败：${err.message}`);
      appendSyncLog(`✗ ${err.message}`);
      toast(`同步失败：${err.message}`, 5000);
    }
  } finally {
    state.syncBusy = false;
    state.syncAbort = null;
    els.cookieInput.value = '';
    els.syncStop.textContent = '关闭';
  }
}

/* ------------------------------------------------------------------ */
/* UI wiring                                                           */
/* ------------------------------------------------------------------ */

els.baseButtons.addEventListener('click', (event) => {
  const button = event.target.closest('.base-btn');
  if (!button) return;
  const id = button.dataset.base;
  if (!id || id === state.base) return;
  applyBasemap(id);
  updateStats(filteredFeaturesForDatum());
});

els.colorPalette.addEventListener('click', (event) => {
  const button = event.target.closest('.color-swatch');
  if (!button) return;
  applyTrackColor(button.dataset.color);
});

els.showLabels.addEventListener('change', () => {
  state.showLabels = els.showLabels.checked;
  try {
    localStorage.setItem(LABELS_KEY, state.showLabels ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (map.getLayer('basemap-labels')) {
    map.setLayoutProperty(
      'basemap-labels',
      'visibility',
      state.showLabels ? 'visible' : 'none',
    );
  }
});

els.roadDensity.addEventListener('input', () => {
  const value = Number(els.roadDensity.value);
  state.roadDensity = Math.max(0, Math.min(100, Math.round(value / 5) * 5));
  els.roadDensityValue.textContent = `${state.roadDensity}%`;
  try {
    localStorage.setItem(ROAD_DENSITY_KEY, String(state.roadDensity));
  } catch {
    /* ignore */
  }
  applyRoadDensity();
});

els.roadOpacity.addEventListener('input', () => {
  const value = Number(els.roadOpacity.value);
  state.roadOpacity = Math.max(0, Math.min(100, Math.round(value)));
  els.roadOpacityValue.textContent = `${state.roadOpacity}%`;
  try {
    localStorage.setItem(ROAD_OPACITY_KEY, String(state.roadOpacity));
  } catch {
    /* ignore */
  }
  applyRoadOpacity();
});

els.yearSelect.addEventListener('change', () => {
  applyYear(els.yearSelect.value);
});

els.opacity.addEventListener('input', () => {
  state.autoOpacity = false;
  applyOpacity(els.opacity.value);
});

els.nameInput.addEventListener('input', () => {
  state.customName = true;
  state.name = els.nameInput.value.slice(0, 24) || '我的轨迹';
  saveName();
  updateDocumentTitle();
});

els.nameInput.addEventListener('blur', () => {
  setName(els.nameInput.value, { custom: true, persist: true });
});

els.nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    els.nameInput.blur();
  }
});

els.fitBtn.addEventListener('click', () => fitAll(600));
els.exportBtn.addEventListener('click', openExport);
els.exportClose.addEventListener('click', closeExport);
els.exportCancel.addEventListener('click', closeExport);
els.exportConfirm.addEventListener('click', doExport);
$$(
  'input[name="exportScope"], input[name="exportRatio"], input[name="exportQuality"], #exportHeader',
).forEach((input) => {
  input.addEventListener('change', updateExportHint);
});
els.importBtn.addEventListener('click', openImportPicker);
els.wallpaperZoomIn?.addEventListener('click', () => zoomMapBy(0.5));
els.wallpaperZoomOut?.addEventListener('click', () => zoomMapBy(-0.5));
els.wallpaperResetBtn?.addEventListener('click', async () => {
  if (!window.__WALLPAPER_DATA__) return;
  try {
    await clearDataset();
    localStorage.removeItem(WALLPAPER_CLEARED_KEY);
    await applyDataset(window.__WALLPAPER_DATA__, { persist: false, fit: true });
  } catch (err) {
    console.error('[wallpaper] reset route failed', err);
  }
});
els.wallpaperClearBtn?.addEventListener('click', clearWallpaperRoute);
els.syncBtn.addEventListener('click', openSyncModal);
els.clearBtn.addEventListener('click', clearData);
els.onboardImport.addEventListener('click', openImportPicker);
els.onboardSync.addEventListener('click', openSyncModal);
els.onboardExample.addEventListener('click', loadExample);
els.gpxInput.addEventListener('change', () => {
  if (els.gpxInput.files?.length) handleGpxFiles(els.gpxInput.files);
});

els.exportModal.addEventListener('click', (event) => {
  if (event.target === els.exportModal) closeExport();
});

els.syncConsent.addEventListener('change', updateSyncButton);
els.cookieInput.addEventListener('input', updateSyncButton);
els.syncStart.addEventListener('click', startSync);
els.syncStop.addEventListener('click', () => {
  if (state.syncBusy) state.syncAbort?.abort();
  else closeSyncModal();
});
els.syncClose.addEventListener('click', closeSyncModal);
els.syncCancel.addEventListener('click', closeSyncModal);
els.syncImportAlt.addEventListener('click', () => {
  closeSyncModal();
  openImportPicker();
});
els.syncModal.addEventListener('click', (event) => {
  if (event.target === els.syncModal && !state.syncBusy) closeSyncModal();
});

els.importClose.addEventListener('click', () => {
  state.importAbort = true;
  els.importModal.hidden = true;
});
els.importModal.addEventListener('click', (event) => {
  if (event.target === els.importModal) {
    state.importAbort = true;
    els.importModal.hidden = true;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!els.exportModal.hidden) closeExport();
  else if (!els.syncModal.hidden && !state.syncBusy) closeSyncModal();
  else if (!els.importModal.hidden) {
    state.importAbort = true;
    els.importModal.hidden = true;
  }
});

/* Drag & drop files anywhere on the page. */
let dragDepth = 0;
function hasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}
window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  if (event.dataTransfer.files?.length) handleGpxFiles(event.dataTransfer.files);
});

const PANEL_POS_KEY = 'trailmap.wallpaper.panelPos';
const LAUNCHER_POS_KEY = 'trailmap.wallpaper.launcherPos';
let panelDrag = null;
let launcherDrag = null;
let suppressLauncherClick = false;
let panelAnimTimer = 0;
let savedPanelPosition = readStoredPosition(PANEL_POS_KEY);
let lastPanelPosition = savedPanelPosition;
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function readStoredPosition(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    return saved && Number.isFinite(saved.left) && Number.isFinite(saved.top) ? saved : null;
  } catch {
    return null;
  }
}

function writeStoredPosition(key, left, top) {
  try {
    localStorage.setItem(key, JSON.stringify({ left: Math.round(left), top: Math.round(top) }));
  } catch {
    /* ignore */
  }
}

function applyPanelPosition(left, top, { persist = false } = {}) {
  const margin = 8;
  const width = els.panel.offsetWidth || 316;
  const height = els.panel.offsetHeight || 400;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(
    margin,
    window.innerHeight - Math.min(height, window.innerHeight - margin * 2) - margin,
  );
  const x = Math.round(Math.min(Math.max(margin, left), maxLeft));
  const y = Math.round(Math.min(Math.max(margin, top), maxTop));
  els.panel.style.left = `${x}px`;
  els.panel.style.top = `${y}px`;
  els.panel.style.right = 'auto';
  els.panel.style.bottom = 'auto';
  lastPanelPosition = { left: x, top: y };
  if (persist) {
    savedPanelPosition = { left: x, top: y };
    writeStoredPosition(PANEL_POS_KEY, x, y);
  }
}

function defaultPanelTop() {
  return Math.max(18, Math.round((window.innerHeight - els.panel.offsetHeight) / 2));
}

function resetPanelPosition() {
  savedPanelPosition = null;
  lastPanelPosition = null;
  try {
    localStorage.removeItem(PANEL_POS_KEY);
  } catch {
    /* ignore */
  }
  if (els.panel.hidden) return;
  applyPanelPosition(18, defaultPanelTop(), { persist: false });
}

function applyLauncherPosition(left, top, { persist = false } = {}) {
  const margin = 8;
  const width = els.panelLauncher.offsetWidth || 42;
  const height = els.panelLauncher.offsetHeight || 42;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  const x = Math.round(Math.min(Math.max(margin, left), maxLeft));
  const y = Math.round(Math.min(Math.max(margin, top), maxTop));
  els.panelLauncher.style.left = `${x}px`;
  els.panelLauncher.style.top = `${y}px`;
  els.panelLauncher.style.right = 'auto';
  els.panelLauncher.style.bottom = 'auto';
  if (persist) writeStoredPosition(LAUNCHER_POS_KEY, x, y);
}

function launcherCenter() {
  const saved = readStoredPosition(LAUNCHER_POS_KEY);
  const width = els.panelLauncher.offsetWidth || 42;
  const height = els.panelLauncher.offsetHeight || 42;
  const left = saved ? saved.left : window.innerWidth - 24 - width;
  const top = saved ? saved.top : window.innerHeight - 24 - height;
  return { x: left + width / 2, y: top + height / 2 };
}

function setPanelTransformOrigin(rect) {
  const target = launcherCenter();
  els.panel.style.transformOrigin = `${target.x - rect.left}px ${target.y - rect.top}px`;
}

function hidePanel() {
  if (els.panel.hidden || panelAnimTimer) return;
  setMapInteractive(false);
  try {
    map.stop();
  } catch {
    /* ignore */
  }
  const rect = els.panel.getBoundingClientRect();
  writeStoredPosition(PANEL_POS_KEY, rect.left, rect.top);
  savedPanelPosition = { left: Math.round(rect.left), top: Math.round(rect.top) };

  const finish = () => {
    panelAnimTimer = 0;
    els.panel.hidden = true;
    els.panel.classList.remove('is-minimizing');
    els.panel.style.transformOrigin = '';
    els.panelLauncher.hidden = false;
    els.panelToggle.setAttribute('aria-expanded', 'false');
    if (!prefersReducedMotion) {
      els.panelLauncher.classList.add('is-popping');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => els.panelLauncher.classList.remove('is-popping'));
      });
    }
  };

  if (prefersReducedMotion) {
    finish();
    return;
  }
  setPanelTransformOrigin(rect);
  els.panel.classList.add('is-minimizing');
  panelAnimTimer = window.setTimeout(finish, 260);
}

function showPanel() {
  if (!els.panel.hidden) return;
  if (panelAnimTimer) {
    clearTimeout(panelAnimTimer);
    panelAnimTimer = 0;
  }
  els.panelLauncher.hidden = true;
  els.panelLauncher.classList.remove('is-popping');
  els.panel.hidden = false;
  els.panel.classList.remove('is-minimizing');
  els.panelToggle.setAttribute('aria-expanded', 'true');

  if (savedPanelPosition || lastPanelPosition) {
    const position = savedPanelPosition || lastPanelPosition;
    applyPanelPosition(position.left, position.top, { persist: false });
  } else {
    applyPanelPosition(18, defaultPanelTop(), { persist: false });
  }
  const placedRect = els.panel.getBoundingClientRect();
  setMapInteractive(true);

  if (prefersReducedMotion) return;
  setPanelTransformOrigin(placedRect);
  els.panel.animate(
    [
      { transform: 'scale(0.18)', opacity: 0 },
      { transform: 'scale(1)', opacity: 1 },
    ],
    {
      duration: 240,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    },
  );
}


function initLauncherDrag() {
  els.panelLauncher.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = els.panelLauncher.getBoundingClientRect();
    launcherDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    try {
      els.panelLauncher.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    const onMove = (moveEvent) => {
      if (!launcherDrag || moveEvent.pointerId !== launcherDrag.pointerId) return;
      const dx = moveEvent.clientX - launcherDrag.startX;
      const dy = moveEvent.clientY - launcherDrag.startY;
      if (!launcherDrag.moved && Math.hypot(dx, dy) < 4) return;
      launcherDrag.moved = true;
      moveEvent.preventDefault();
      applyLauncherPosition(launcherDrag.left + dx, launcherDrag.top + dy, { persist: false });
    };
    const finish = (upEvent, open) => {
      if (!launcherDrag || upEvent.pointerId !== launcherDrag.pointerId) return;
      const wasMoved = launcherDrag.moved;
      launcherDrag = null;
      try {
        els.panelLauncher.releasePointerCapture(upEvent.pointerId);
      } catch {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (wasMoved) {
        const rect2 = els.panelLauncher.getBoundingClientRect();
        applyLauncherPosition(rect2.left, rect2.top, { persist: true });
        suppressLauncherClick = true;
        window.setTimeout(() => {
          suppressLauncherClick = false;
        }, 0);
      } else if (open) {
        showPanel();
      }
    };
    const onUp = (upEvent) => finish(upEvent, true);
    const onCancel = (upEvent) => finish(upEvent, false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  });

  els.panelLauncher.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    showPanel();
  });

  els.panelLauncher.addEventListener('click', () => {
    if (suppressLauncherClick) {
      suppressLauncherClick = false;
      return;
    }
    if (els.panel.hidden) showPanel();
  });
}

function initPanelDrag() {
  const head = els.panel.querySelector('.panel-head');
  if (!head) return;

  head.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('input, button, select, textarea, a, label')) return;
    event.preventDefault();
    const rect = els.panel.getBoundingClientRect();
    panelDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    els.panel.classList.add('is-dragging');
    try {
      head.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    const onMove = (moveEvent) => {
      if (!panelDrag || moveEvent.pointerId !== panelDrag.pointerId) return;
      moveEvent.preventDefault();
      applyPanelPosition(
        panelDrag.left + moveEvent.clientX - panelDrag.startX,
        panelDrag.top + moveEvent.clientY - panelDrag.startY,
        { persist: false },
      );
    };
    const finish = (upEvent) => {
      if (!panelDrag || upEvent.pointerId !== panelDrag.pointerId) return;
      panelDrag = null;
      els.panel.classList.remove('is-dragging');
      try {
        head.releasePointerCapture(upEvent.pointerId);
      } catch {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const finalRect = els.panel.getBoundingClientRect();
      applyPanelPosition(finalRect.left, finalRect.top, { persist: true });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });

  head.addEventListener('dblclick', (event) => {
    if (event.target.closest('input, button, select, textarea, a, label')) return;
    resetPanelPosition();
  });
}

(function restoreLauncherPosition() {
  const saved = readStoredPosition(LAUNCHER_POS_KEY);
  if (saved) applyLauncherPosition(saved.left, saved.top);
})();

initPanelDrag();
initLauncherDrag();

els.panelToggle.addEventListener('click', hidePanel);

window.addEventListener('resize', () => {
  if (!els.panel.hidden) {
    const rect = els.panel.getBoundingClientRect();
    applyPanelPosition(rect.left, rect.top, { persist: false });
  }
  if (!els.panelLauncher.hidden && readStoredPosition(LAUNCHER_POS_KEY)) {
    const rect = els.panelLauncher.getBoundingClientRect();
    applyLauncherPosition(rect.left, rect.top, { persist: false });
  }
  if (els.wallpaperClock.style.left) {
    const rect = els.wallpaperClock.getBoundingClientRect();
    applyClockPosition(rect.left, rect.top, { persist: false });
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function setLoadingError(title, sub) {
  els.spinner.style.display = 'none';
  els.loadingText.textContent = title;
  els.loadingSub.textContent = sub;
  els.loading.hidden = false;
  els.loading.classList.remove('is-hidden');
}

function hideLoading() {
  els.loading.classList.add('is-hidden');
  setTimeout(() => {
    els.loading.hidden = true;
  }, 320);
}

async function boot() {
  startWallpaperClock();
  let savedBase = (() => {
    try {
      return localStorage.getItem(BASE_KEY) || localStorage.getItem('xingzhe.base');
    } catch {
      return null;
    }
  })();
  if (savedBase === 'natgeo') {
    savedBase = 'dark';
    try {
      localStorage.setItem(BASE_KEY, 'dark');
    } catch {
      /* ignore */
    }
  }
  if (savedBase === 'gaode') {
    savedBase = 'light';
    try {
      localStorage.setItem(BASE_KEY, 'light');
    } catch {
      /* ignore */
    }
  }

  let tiandituEnabled = false;
  try {
    const response = await fetch('api/config', { cache: 'no-store' });
    if (response.ok) {
      const config = await response.json();
      tiandituEnabled = Boolean(config.tianditu);
    }
  } catch {
    /* static deployment without API */
  }
  state.tiandituEnabled = tiandituEnabled;
  if (savedBase === 'terrain' && !tiandituEnabled) {
    savedBase = 'dark';
  }

  state.base = savedBase && BASEMAPS[savedBase] ? savedBase : 'dark';
  updateAvailableBasemaps();
  updateBaseButtons();
  updateLabelToggle();
  updateRoadDensityUI();
  applyOpacity(els.opacity.value);

  let savedColor = null;
  try {
    savedColor = localStorage.getItem(TRACK_COLOR_KEY);
  } catch {
    /* ignore */
  }
  state.trackColor = TRACK_COLORS.some((entry) => entry.hex === savedColor) ? savedColor : TRACK;
  document.documentElement.style.setProperty('--track-color', state.trackColor);
  document.documentElement.style.setProperty('--track-color-soft', hexToRgba(state.trackColor, 0.16));
  syncColorButtons();

  try {
    state.showLabels = localStorage.getItem(LABELS_KEY) === '1';
  } catch {
    state.showLabels = false;
  }
  try {
    const rawDensity = localStorage.getItem(ROAD_DENSITY_KEY);
    const storedDensity = rawDensity === null ? Number.NaN : Number(rawDensity);
    state.roadDensity = Number.isFinite(storedDensity)
      ? Math.max(0, Math.min(100, Math.round(storedDensity / 5) * 5))
      : 100;
  } catch {
    state.roadDensity = 100;
  }
  try {
    const rawOpacity = localStorage.getItem(ROAD_OPACITY_KEY);
    const storedOpacity = rawOpacity === null ? Number.NaN : Number(rawOpacity);
    state.roadOpacity = Number.isFinite(storedOpacity)
      ? Math.max(0, Math.min(100, Math.round(storedOpacity)))
      : 92;
  } catch {
    state.roadOpacity = 92;
  }

  let savedName = null;
  try {
    savedName = localStorage.getItem(NAME_KEY);
  } catch {
    /* ignore */
  }
  if (savedName) {
    state.customName = true;
    setName(savedName, { custom: true, persist: false });
  } else {
    setName('我的轨迹', { persist: false });
  }

  try {
    await mapLoaded;
    setMapInteractive(false);
    applyBasemap(state.base, { preserveView: false, persist: false });
    applyTrackColor(state.trackColor, { persist: false });
  } catch (err) {
    setLoadingError('地图无法初始化', err.message);
    return;
  }

  map.jumpTo({ center: [104, 35], zoom: 3.4 });

  let hasStored = false;
  let wallpaperCleared = false;
  try {
    wallpaperCleared = WALLPAPER_MODE && localStorage.getItem(WALLPAPER_CLEARED_KEY) === '1';
  } catch {
    wallpaperCleared = false;
  }
  if (WALLPAPER_MODE && !wallpaperCleared) {
    try {
      const stored = await loadDataset();
      if (stored && Array.isArray(stored.features) && stored.features.length > 0) {
        await applyDataset(stored, { persist: false, fit: true });
        hasStored = true;
        if (!state.customName && stored.user?.name) {
          setName(stored.user.name, { custom: false, persist: false });
        }
      }
    } catch (err) {
      console.warn('[store]', err);
    }
  }
  if (!hasStored && WALLPAPER_MODE && !wallpaperCleared && window.__WALLPAPER_DATA__) {
    try {
      await applyDataset(window.__WALLPAPER_DATA__, { persist: false, fit: true });
      hasStored = true;
    } catch (err) {
      console.error('[wallpaper] static data failed', err);
    }
  }
  if (!WALLPAPER_MODE && !hasStored) {
    try {
      const stored = await loadDataset();
      if (stored && Array.isArray(stored.features) && stored.features.length > 0) {
        await applyDataset(stored, { persist: false, fit: true });
        hasStored = true;
        if (!state.customName && stored.user?.name) {
          setName(stored.user.name, { custom: false, persist: false });
        }
      }
    } catch (err) {
      console.warn('[store]', err);
      toast('浏览器本地存储不可用，刷新后数据会丢失', 5000);
    }
  }
  if (els.wallpaperResetBtn) {
    els.wallpaperResetBtn.hidden = !window.__WALLPAPER_DATA__;
  }

  if (!hasStored) showEmptyUI();
  if (!hasStored && new URLSearchParams(location.search).has('demo')) {
    await loadExample();
  }
  if (!hasStored) {
    fetch('data/manifest.json', { method: 'HEAD' })
      .then((response) => {
        if (!response.ok) els.onboardExample.hidden = true;
      })
      .catch(() => {
        els.onboardExample.hidden = true;
      });
  }
  if (WALLPAPER_MODE && !hasStored) {
    console.warn('[wallpaper] no static data; run node scripts/build-wallpaper.mjs');
  }
  hideLoading();
}

boot();
