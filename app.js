// Mono Lake phalarope survey viewer: an auto-playing time slider over a
// static shoreline basemap, animating bubble size per survey point as it
// steps through survey dates. Modeled on ArcGIS Online's time-enabled-layer
// animation, built on MapLibre GL JS's paint-property transitions so bubble
// size tweens smoothly between dates rather than jumping.

const TRANSITION_MS = 450;

// --- Marker encoding, matched to scripts/static_maps.py --------------------
// Bubbles are sized on the ground (in degrees of longitude), not in screen
// pixels, so they keep the same size relative to the lake at every zoom
// level -- and at the same proportions as the static maps. Points per degree
// of longitude measured from a static daily map (axes width / lon span).
const STATIC_PT_PER_DEG_LON = 1683.1;
// Marker areas (pt^2) of the smallest/largest count range; ranges in
// between step up by a constant area ratio (static_maps._category_size).
const MIN_MARKER_AREA = 18;
const MAX_MARKER_AREA = 640;
const ZERO_MARKER_AREA = 45;
const BUBBLE_FILL_ALPHA = 0.75;
const ZERO_MARKER_ALPHA = 0.5;
// Lake-boundary holes smaller than this (deg^2) are tiny tufa/rock specks,
// dropped as in static_maps._drop_tiny_holes; the real islands are kept.
const MIN_BOUNDARY_HOLE_AREA = 1e-5;
// How far the user can zoom out/in from the initial lake-fitting view.
// Bubbles (and the Count legend's circles) grow 2x per zoom level, so the
// zoom-in limit keeps the largest legend circle a reasonable size.
const ZOOM_OUT_LIMIT = 0.5;
const ZOOM_IN_LIMIT = 1.5;

// Per-species boat/shore colors -- must match SPECIES_SURVEY_TYPE_COLORS in
// scripts/static_maps.py, so the viewer and the static/animated maps show
// each species in the same colors.
const SPECIES_SURVEY_TYPE_COLORS = {
  WIPH: { boat: "#0072B2", shore: "#E69F00" },   // blue / orange
  RNPH: { boat: "#882255", shore: "#66A61E" },   // wine / green
  total: { boat: "#332288", shore: "#44AA99" },  // indigo / teal
};
const FALLBACK_MARKER_COLOR = "#4d4d4d";

function circleColorExpression(species) {
  const colors = SPECIES_SURVEY_TYPE_COLORS[species];
  return ["match", ["get", "survey_type"], "boat", colors.boat, "shore", colors.shore, FALLBACK_MARKER_COLOR];
}

const state = {
  data: null,
  boundary: null,
  index: 0,
  species: "total",
  playing: false,
  timer: null,
  // 1 second per survey date at 1x -- the pace Ryan approved on the GIFs.
  frameMs: 1000,
  // Zero-count X's start hidden, like the GIFs (the "Show 0 counts" box
  // turns them on).
  showZeroCounts: false,
};

function categoryArea(index, nCategories) {
  if (nCategories <= 1) return MAX_MARKER_AREA;
  return MIN_MARKER_AREA * (MAX_MARKER_AREA / MIN_MARKER_AREA) ** (index / (nCategories - 1));
}

// Web Mercator: one degree of longitude is 512 * 2^zoom / 360 CSS px.
function pxPerDegLon(zoom) {
  return (512 * 2 ** zoom) / 360;
}

// Marker diameter in screen px at `zoom` for a static-map marker area (pt^2).
function diameterPx(area, zoom) {
  return (Math.sqrt(area) / STATIC_PT_PER_DEG_LON) * pxPerDegLon(zoom);
}

// A ["zoom"]-driven expression scaling `valueAtZoom0` (itself possibly a
// data expression) by 2^zoom, so the marker tracks the map's scale exactly.
function scaleWithZoom(valueAtZoom0) {
  return ["interpolate", ["exponential", 2], ["zoom"], 0, valueAtZoom0, 24, ["*", valueAtZoom0, 2 ** 24]];
}

function circleRadiusExpression(bins) {
  const radius0 = (i) => diameterPx(categoryArea(i, bins.length), 0) / 2;
  // Features carry size_class (0 = no birds, k = the k-th count range), not
  // an exact count, so the data file can be published without exact counts.
  const step = ["step", ["get", "size_class"], radius0(0)];
  bins.slice(1).forEach((_label, i) => step.push(i + 2, radius0(i + 1)));
  return scaleWithZoom(step);
}

function shoelaceArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(area / 2);
}

// Drop the lake polygon's tiny interior holes (tufa/rock specks), keeping
// the outer ring and the real islands -- matches the static maps.
function dropTinyHoles(geojson) {
  const clean = (rings) => [rings[0], ...rings.slice(1).filter((r) => shoelaceArea(r) >= MIN_BOUNDARY_HOLE_AREA)];
  const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];
  for (const f of features) {
    const g = f.geometry;
    if (g.type === "Polygon") g.coordinates = clean(g.coordinates);
    else if (g.type === "MultiPolygon") g.coordinates = g.coordinates.map(clean);
  }
  return geojson;
}

function collectCoordinates(geometry, out) {
  const coords = geometry.coordinates;
  if (geometry.type === "Point") out.push(coords);
  else if (geometry.type === "MultiPoint" || geometry.type === "LineString") coords.forEach((c) => out.push(c));
  else if (geometry.type === "MultiLineString" || geometry.type === "Polygon") coords.forEach((ring) => ring.forEach((c) => out.push(c)));
  else if (geometry.type === "MultiPolygon") coords.forEach((poly) => poly.forEach((ring) => ring.forEach((c) => out.push(c))));
}

function boundsOf(geojson) {
  const coords = [];
  const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];
  for (const f of features) collectCoordinates(f.geometry, coords);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return [[minX, minY], [maxX, maxY]];
}

// Base size (CSS px) of the generated "x" icon image; the X itself spans
// X_ICON_SPAN_FRAC of it. Drawn large and scaled down by icon-size, so it
// stays sharp when zoomed in.
const X_ICON_PX = 64;
const X_ICON_SPAN_FRAC = 0.56;

function makeXIcon(color) {
  const scale = window.devicePixelRatio || 1;
  const px = Math.round(X_ICON_PX * scale);
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = color;
  // Same stroke-to-size ratio as the static maps' X (1.1 pt line on a
  // ~6.7 pt marker).
  ctx.lineWidth = px * X_ICON_SPAN_FRAC * 0.164;
  ctx.lineCap = "round";
  const pad = px * 0.22;
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(px - pad, px - pad);
  ctx.moveTo(px - pad, pad);
  ctx.lineTo(pad, px - pad);
  ctx.stroke();
  return ctx.getImageData(0, 0, px, px);
}

async function loadData() {
  const [data, boundary] = await Promise.all([
    fetch("data/survey_points.json").then((r) => r.json()),
    fetch("data/mono_lake_boundary.geojson").then((r) => r.json()),
  ]);
  return { data, boundary };
}

// Count legend: one true-size hollow circle per count range at the map's
// current zoom (rebuilt on zoom), plus the "0" X when zeros are shown --
// same ranges and sizes as the static maps' Count legend.
function buildSizeLegend(bins, zoom) {
  const el = document.getElementById("sizeLegend");
  el.innerHTML = "";
  const maxD = bins.length ? diameterPx(categoryArea(bins.length - 1, bins.length), zoom) : 0;
  const cellWidth = Math.max(maxD, 14);
  // Each row is just tall enough for its own circle, keeping the legend
  // compact when zoomed in.
  const addRow = (markerHtml, label, rowHeight) => {
    const row = document.createElement("div");
    row.className = "size-row";
    row.style.height = `${rowHeight}px`;
    row.innerHTML = `<div class="size-cell" style="width:${cellWidth}px">${markerHtml}</div><span>${label}</span>`;
    el.appendChild(row);
  };
  if (state.showZeroCounts) addRow(`<div class="zero-marker">&#10005;</div>`, "0", 22);
  bins.forEach((bin, i) => {
    const d = diameterPx(categoryArea(i, bins.length), zoom);
    addRow(`<div class="bubble" style="width:${d}px;height:${d}px"></div>`, bin, Math.max(d, 14) + 8);
  });
}

// North arrow (split arrowhead, "N" above), as on the static maps. North is
// always up: map rotation is disabled.
class NorthArrowControl {
  onAdd() {
    this._el = document.createElement("div");
    this._el.className = "maplibregl-ctrl north-arrow";
    this._el.innerHTML = `<div class="north-n">N</div>
      <svg width="14" height="30" viewBox="0 0 14 30" aria-hidden="true">
        <polygon points="7,0 0,30 7,24" fill="#000" stroke="#000" stroke-width="0.8" stroke-linejoin="miter"/>
        <polygon points="7,0 14,30 7,24" fill="#fff" stroke="#000" stroke-width="0.8" stroke-linejoin="miter"/>
      </svg>`;
    return this._el;
  }
  onRemove() { this._el.remove(); }
}

function main() {
  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#eef3f5" } }],
    },
  });
  // North is always up (as on the static maps), so rotation is disabled.
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  // km and mi scale bars plus north arrow, grouped bottom-right (static maps:
  // scale bar lower right, north arrow upper right -- the upper right here
  // is taken by the legend panel).
  // (Bottom-corner controls stack upward in the order added.)
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "imperial" }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-right");
  map.addControl(new NorthArrowControl(), "bottom-right");

  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();

  const playBtn = document.getElementById("playBtn");
  const scrubber = document.getElementById("scrubber");
  const dateLabel = document.getElementById("dateLabel");
  const speciesSelect = document.getElementById("speciesSelect");
  const speedSelect = document.getElementById("speedSelect");
  const showZeroToggle = document.getElementById("showZeroToggle");

  function currentFeatureCollection() {
    const date = state.data.dates[state.index];
    return state.data.frames[date][state.species];
  }

  function renderFrame() {
    const date = state.data.dates[state.index];
    dateLabel.textContent = date;
    scrubber.value = state.index;
    const source = map.getSource("points");
    if (source) source.setData(currentFeatureCollection());
  }

  function setSpecies(species) {
    state.species = species;
    // One fixed set of count ranges per species (labels from the data file,
    // computed over every survey), so bubble size means the same thing on
    // every date.
    state.bins = state.data.bins[species];
    // Per-species title (same wording as the GIFs); the date sits below it.
    if (state.data.titles) document.getElementById("pageTitle").textContent = state.data.titles[species];
    buildSizeLegend(state.bins, map.getZoom());
    // Recolor bubbles, zero X's, and the survey-type legend swatches.
    map.setPaintProperty("points-circle", "circle-color", circleColorExpression(species));
    map.setPaintProperty("points-circle", "circle-radius", circleRadiusExpression(state.bins));
    map.setLayoutProperty("points-zero", "icon-image", ["concat", `x-${species}-`, ["get", "survey_type"]]);
    // Species portrait(s) below the Count legend, as on the animated maps
    // (both species side by side for total).
    const portraits = (state.data.illustrations || {})[species] || [];
    const portraitEl = document.getElementById("speciesPortrait");
    portraitEl.innerHTML = portraits.map((src) => `<img src="${src}" alt="" />`).join("");
    portraitEl.parentElement.hidden = portraits.length === 0;
    document.getElementById("boatSwatch").style.background = SPECIES_SURVEY_TYPE_COLORS[species].boat;
    document.getElementById("shoreSwatch").style.background = SPECIES_SURVEY_TYPE_COLORS[species].shore;
    renderFrame();
  }

  function stepForward() {
    state.index = (state.index + 1) % state.data.dates.length;
    renderFrame();
  }

  function setPlaying(playing) {
    state.playing = playing;
    playBtn.innerHTML = playing ? "&#10074;&#10074;" : "&#9654;";
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    clearInterval(state.timer);
    if (playing) state.timer = setInterval(stepForward, state.frameMs);
  }

  playBtn.addEventListener("click", () => setPlaying(!state.playing));

  scrubber.addEventListener("input", (e) => {
    setPlaying(false);
    state.index = Number(e.target.value);
    renderFrame();
  });

  speciesSelect.addEventListener("change", (e) => setSpecies(e.target.value));

  showZeroToggle.addEventListener("change", (e) => {
    state.showZeroCounts = e.target.checked;
    map.setLayoutProperty("points-zero", "visibility", state.showZeroCounts ? "visible" : "none");
    buildSizeLegend(state.bins, map.getZoom());
  });

  speedSelect.addEventListener("change", (e) => {
    state.frameMs = Number(e.target.value);
    if (state.playing) setPlaying(true);
  });

  map.on("load", async () => {
    const { data, boundary: rawBoundary } = await loadData();
    const boundary = dropTinyHoles(rawBoundary);
    state.data = data;
    state.boundary = boundary;
    // Preload every species portrait up front, so switching species shows
    // them instantly instead of fetching (and possibly failing) mid-session.
    state.portraitPreloads = [...new Set(Object.values(data.illustrations || {}).flat())].map((src) => {
      const img = new Image();
      img.src = src;
      return img;
    });

    map.addSource("boundary", { type: "geojson", data: boundary });
    map.addLayer({
      id: "boundary-fill",
      type: "fill",
      source: "boundary",
      paint: { "fill-color": "#cfe8f3", "fill-opacity": 0.9 },
    });
    map.addLayer({
      id: "boundary-line",
      type: "line",
      source: "boundary",
      paint: { "line-color": "#4a90a4", "line-width": 1.2 },
    });

    map.addSource("points", { type: "geojson", data: data.frames[data.dates[0]][state.species] });

    // Nonzero counts: a bubble sized by count range, colored by survey type.
    // Largest drawn first (circle-sort-key: higher draws on top), so small
    // bubbles stay visible where they overlap big ones -- as on the static
    // maps.
    map.addLayer({
      id: "points-circle",
      type: "circle",
      source: "points",
      filter: [">", ["get", "size_class"], 0],
      layout: { "circle-sort-key": ["*", -1, ["get", "size_class"]] },
      paint: {
        "circle-radius-transition": { duration: TRANSITION_MS },
        "circle-color": circleColorExpression(state.species),
        "circle-color-transition": { duration: TRANSITION_MS },
        "circle-stroke-color": "#000",
        "circle-stroke-width": 0.5,
        "circle-opacity": BUBBLE_FILL_ALPHA,
      },
    });

    // Zero counts: a faded "x" colored by survey type -- same
    // zero_count_style="x" convention as static_maps.py, rather than a
    // smallest-circle bubble. Drawn as canvas-generated icon images (one per
    // species/survey-type color) rather than a text-field symbol layer,
    // since text-field requires a "glyphs" font-PBF URL on the style --
    // pulling that in over the network just to draw an X isn't worth it.
    for (const [species, colors] of Object.entries(SPECIES_SURVEY_TYPE_COLORS)) {
      for (const [surveyType, color] of Object.entries(colors)) {
        map.addImage(`x-${species}-${surveyType}`, makeXIcon(color), { pixelRatio: window.devicePixelRatio || 1 });
      }
    }
    // Same ground size as the static maps' X, scaled with zoom like the bubbles.
    const zeroIconSize0 = diameterPx(ZERO_MARKER_AREA, 0) / (X_ICON_PX * X_ICON_SPAN_FRAC);
    map.addLayer({
      id: "points-zero",
      type: "symbol",
      source: "points",
      filter: ["==", ["get", "size_class"], 0],
      layout: {
        visibility: state.showZeroCounts ? "visible" : "none",
        "icon-image": ["concat", `x-${state.species}-`, ["get", "survey_type"]],
        "icon-size": scaleWithZoom(zeroIconSize0),
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-opacity": ZERO_MARKER_ALPHA,
        "icon-opacity-transition": { duration: TRANSITION_MS },
      },
    });

    // Fit the lake into the area left clear by the overlaid title, legend
    // panel, and playback bar, so no shoreline starts hidden behind them.
    const legendWidth = document.getElementById("legend").offsetWidth;
    const controlsHeight = document.getElementById("controls").offsetHeight;
    map.fitBounds(boundsOf(boundary), {
      padding: { top: 64, bottom: controlsHeight + 40, left: 40, right: legendWidth + 40 },
      duration: 0,
    });
    // Limit zoom to a range around the lake-fitting view: bubbles scale with
    // zoom, so far out they'd shrink to specks and far in they'd fill the
    // screen.
    const fitZoom = map.getZoom();
    map.setMinZoom(fitZoom - ZOOM_OUT_LIMIT);
    map.setMaxZoom(fitZoom + ZOOM_IN_LIMIT);
    // Keep the Count legend's circles true to the map's current scale.
    map.on("zoom", () => buildSizeLegend(state.bins, map.getZoom()));

    scrubber.max = data.dates.length - 1;
    setSpecies(state.species);
    setPlaying(true);
  });
}

main();
