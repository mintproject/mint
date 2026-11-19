// main.js - Main application logic and event handlers
import { $, esc, svoName, humanSvo, dataObjectLabel } from './utils.js';
import { api, setToken, getToken, restoreToken } from './api.js';
import { STATE } from './state.js';
import { renderSources, renderChain, renderDfcPlan, renderDfcEvaluationResults, renderDfcAnswerPlaceholder, specInContract } from './components/render.js';
import { updateDfcContextSelectors, dfcMetricTargetsForCurrentContext, loadDfcTargetRecords, recordMatchesAquiferSelection } from './components/map.js';
import { loadRunHistory, initHistoryHandlers, renderDfcResults } from './components/history.js';

// ── Auth ─────────────────────────────────────────────────────────────────
function initAuth() {
  const show = on => {
    ['loginBtn', 'jwtInput'].forEach(id => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; });
    const logoutBtn = $('logoutBtn');
    if (logoutBtn) logoutBtn.style.display = on ? 'none' : '';
  };
  const loginBtn = $('loginBtn');
  if (loginBtn) loginBtn.onclick = () => { const t = $('jwtInput')?.value.trim(); if (t) { setToken(t); if ($('jwtInput')) $('jwtInput').value = ''; } };
  const jwtInput = $('jwtInput');
  if (jwtInput) jwtInput.addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn?.click(); });
  const logoutBtn = $('logoutBtn');
  if (logoutBtn) logoutBtn.onclick = () => setToken(null);
  restoreToken();
  const token = getToken();
  if (!token) { $('authLabel').textContent = 'not logged in'; show(true); return; }
  let who = 'token';
  try { const c = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); who = (c['tapis/username'] || 'token') + (c['tapis/tenant_id'] ? ' @ ' + c['tapis/tenant_id'] : ''); } catch {}
  $('authLabel').textContent = who; show(false);
}

// ── Mode ─────────────────────────────────────────────────────────────────
async function checkMode() {
  try {
    const h = await api('GET', '/health');
    if (!h.demo_mode) {
      $('modeTag').textContent = 'live mode';
      $('modeTag').style.cssText = 'font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(34,197,94,.12);color:var(--ok);border:1px solid rgba(34,197,94,.2)';
    } else {
      $('modeTag').textContent = 'local fixture mode';
    }
  } catch { $('modeTag').textContent = 'service unreachable'; }
}

// ── Runtime defaults ──────────────────────────────────────────────────────
async function loadRuntimeDefaults() {
  try { STATE.RUNTIME_DEFAULTS = await api('GET', '/runtime-defaults'); } catch { STATE.RUNTIME_DEFAULTS = {}; }
  try {
    const contract = await api('GET', '/etl/common-variables');
    STATE.ETL_COMMON_VARIABLES = contract.variables || contract.canonical || [];
  } catch {
    STATE.ETL_COMMON_VARIABLES = [];
  }
  try {
    const catalog = await api('GET', '/spatial/layers');
    STATE.SPATIAL_LAYER_OPTIONS = catalog.layers || [];
  } catch {
    STATE.SPATIAL_LAYER_OPTIONS = STATE.RUNTIME_DEFAULTS.spatial_layers || [];
  }
  applyRuntimeDefaults();
  return STATE.RUNTIME_DEFAULTS;
}

function applySpatialLayerOptions() {
  const list = $('spatialLayerOptions');
  if (!list) return;
  list.innerHTML = '';
  (STATE.SPATIAL_LAYER_OPTIONS || []).forEach(layer => {
    if (!layer?.uri) return;
    const option = document.createElement('option');
    option.value = layer.uri;
    option.label = layer.label || layer.id || layer.uri;
    list.appendChild(option);
  });
  const select = $('dfcSpatialLayerSelect');
  if (!select) return;
  select.innerHTML = '<option value="">Custom URI</option>';
  (STATE.SPATIAL_LAYER_OPTIONS || []).forEach(layer => {
    if (!layer?.uri) return;
    const option = document.createElement('option');
    option.value = layer.id || layer.uri;
    option.textContent = layer.label || layer.id || layer.uri;
    select.appendChild(option);
  });
  select.onchange = () => {
    const layer = (STATE.SPATIAL_LAYER_OPTIONS || []).find(item => item.id === select.value);
    if (!layer) return;
    const input = $('dfcBoundaryUri');
    if (input) input.value = layer.uri;
    const field = $('dfcGeometryFilterField');
    if (field && layer.default_filter_field) field.value = layer.default_filter_field;
  };
}

function applyRuntimeDefaults() {
  applySpatialLayerOptions();
  const actorInput = $('dfcGeoActorId');
  if (actorInput && !actorInput.value.trim() && STATE.RUNTIME_DEFAULTS.geo_actor_id) actorInput.value = STATE.RUNTIME_DEFAULTS.geo_actor_id;
  const boundaryInput = $('dfcBoundaryUri');
  const defaultBoundary = STATE.RUNTIME_DEFAULTS.geometry_source_uri || STATE.TWDB_GMA_BOUNDARY_LAYER;
  if (boundaryInput && !boundaryInput.value.trim()) boundaryInput.value = defaultBoundary;
  const areaBoundaryInput = $('dfcAreaBoundaryUri');
  const defaultAreaBoundary = defaultBoundary;
  if (areaBoundaryInput && !areaBoundaryInput.value.trim()) areaBoundaryInput.value = defaultAreaBoundary;
}

// ── Forecast graph ────────────────────────────────────────────────────────
function renderForecastGraph(plan) {
  if (!plan) { $('graphOut').innerHTML = '<p class="err">no plan</p>'; return; }
  const byUri = Object.fromEntries(STATE.OBJECTS.map(o => [o.resource_uri, o]));
  const runSpec = Object.values(STATE.SPECS).find(s => s.name === plan.run_spec);
  const inputContracts = (runSpec?.contracts || []).filter(c => c.role === 'input');
  const branches = plan.branches.map((b, i) => {
    const obj = byUri[b.source];
    if (!obj) return `<div class="branch"><p class="err">source "${esc(b.source)}" not in registry</p></div>`;
    const tgtC = inputContracts.find(c => svoName(c.standard_variable_uri || '') === b.standard_variable) || {};
    const target = specInContract(tgtC);
    if (!target.svo) target.svo = b.standard_variable ? `.../${b.standard_variable}` : null;
    const pill = b.satisfied ? `<span class="pill ok">resolved</span>` : `<span class="pill bad">unresolved</span>`;
    return `<div class="branch">
      <div class="branch-header">
        <div class="branch-index">${i + 1}</div>
        <div class="branch-title">${esc(humanSvo(b.standard_variable))} ${pill}</div>
      </div>
      ${renderChain(obj, b.chain || [], target)}
    </div>`;
  }).join('');
  const outC = (runSpec?.contracts || []).find(c => c.role === 'output') || {};
  const outSvo = humanSvo(outC.standard_variable_uri || 'output');
  const outUnit = outC.unit ? ` [${outC.unit}]` : '';
  const allOk = plan.branches.every(b => b.satisfied);
  const convergence = `<div class="convergence">
    <div class="conv-header">${allOk ? 'All ' + plan.branches.length + ' branches resolved — converge into model run' : '⚠ Some branches unresolved'}</div>
    <div class="model-box">
      <span class="mb-name">▶ ${esc(plan.run_spec)}</span>
      <span class="mb-type">subsidence_forecast · tapis_function</span>
      <div class="mb-out">${plan.branches.length} inputs → <span style="color:var(--ok)">${esc(outSvo)}${esc(outUnit)}</span></div>
    </div>
  </div>`;
  $('bfsNote').textContent = 'BFS walks the transform registry from each source. At every step it checks which registered transform\'s input contract matches the current data state (SVO, unit, format). The first path that closes all gaps to the model\'s input requirement is selected — one branch per model input, all converging into the final run.';
  $('graphOut').innerHTML = branches + convergence;
}

// ── DFC helpers ───────────────────────────────────────────────────────────
function sourceVariableName(o) {
  const v = (o.variables || [])[0] || {};
  return humanSvo(v.standard_variable_uri || '').toLowerCase();
}

function chooseDfcSource(target) {
  const fmt = o => String(o.format || '').toLowerCase();
  const variable = o => sourceVariableName(o);
  if (target.sourceKind === 'geotiff') {
    return STATE.OBJECTS.find(o => fmt(o) === 'geotiff' && variable(o).includes('hydraulic_head'))
      || STATE.OBJECTS.find(o => fmt(o).includes('tif') && variable(o).includes('hydraulic_head'))
      || STATE.OBJECTS.find(o => variable(o).includes('hydraulic_head'))
      || STATE.OBJECTS[0] || null;
  }
  if (target.sourceKind === 'hds') {
    return STATE.OBJECTS.find(o => fmt(o).includes('hds')) || STATE.OBJECTS.find(o => variable(o).includes('hydraulic_head')) || STATE.OBJECTS[0] || null;
  }
  if (target.sourceKind === 'cbc') {
    return STATE.OBJECTS.find(o => fmt(o).includes('cbc')) || STATE.OBJECTS.find(o => variable(o).includes('flow_rate')) || STATE.OBJECTS[0] || null;
  }
  return STATE.OBJECTS[0] || null;
}

async function loadDfcObjectives() {
  try {
    const data = await api('GET', '/objectives');
    STATE.DFC_OBJECTIVES = data.objectives || [];
  } catch (_) {
    STATE.DFC_OBJECTIVES = [];
  }
  return STATE.DFC_OBJECTIVES;
}

function objectiveFullSpec(id) {
  return api('GET', `/objectives/${encodeURIComponent(id)}`);
}

async function fetchDfcTargetLookup() {
  const qs = new URLSearchParams();
  const gma = $('dfcGmaId')?.value;
  const aquifer = $('dfcAquifer')?.value.trim();
  if (gma) qs.set('gma_id', gma);
  if (aquifer) qs.set('aquifer', aquifer);
  qs.set('limit', '1000');
  return api('GET', `/dfc-targets?${qs.toString()}`);
}

function targetRecordsForMetric(records, target) {
  const year = Number($('dfcTargetYear')?.value || 0);
  const aquifer = $('dfcAquifer')?.value?.trim();
  return (records || []).filter(r => {
    if (r.metric !== target.targetMetric) return false;
    if (!recordMatchesAquiferSelection(r, aquifer)) return false;
    const targetYear = Number(r.period?.target_year || 0);
    return !year || !targetYear || targetYear === year;
  });
}

function dfcContextLabel() {
  const gma = $('dfcGmaId')?.value || 'selected GMA';
  const aquifer = $('dfcAquifer')?.value?.trim() || 'selected aquifer';
  const year = $('dfcTargetYear')?.value?.trim() || 'target year';
  return `${gma} | ${aquifer} | ${year}`;
}

function normText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function objectiveMatchesTarget(objective, target) {
  if (!objective || !target) return false;
  const sel = objective.selection || {};
  const gma = $('dfcGmaId')?.value || '';
  const aquifer = $('dfcAquifer')?.value || '';
  const year = String($('dfcTargetYear')?.value || '');
  return objective.objective_type === 'dfc_compliance'
    && normText(sel.gma_id) === normText(gma)
    && normText(sel.aquifer) === normText(aquifer)
    && String(sel.target_year || '') === year
    && String(sel.metric || '') === String(target.targetMetric || '');
}

function objectiveForTarget(target) {
  return (STATE.DFC_OBJECTIVES || []).find(o => objectiveMatchesTarget(o, target)) || null;
}

function sourceForPlan(plan, fallbackTarget = null) {
  const sourceUri = plan?.plan_json?.steps?.find(s => s.source)?.source;
  return STATE.OBJECTS.find(o => o.resource_uri === sourceUri)
    || (fallbackTarget ? chooseDfcSource(fallbackTarget) : null)
    || STATE.OBJECTS[0]
    || null;
}

// ── DFC run args ──────────────────────────────────────────────────────────
function dfcRunArgs() {
  const args = {};
  const add = (key, val) => { if (val === undefined || val === null || String(val).trim() === '') return; args[key] = { value: val }; };
  const addPlanArg = (key, val) => {
    const params = STATE.PLAN_DFC?.plan_json?.parameters || [];
    const usedByStep = dfcPlanUsesArg(key);
    const declared = params.some(item => item?.name === key);
    if (usedByStep || declared) add(key, val);
  };
  const addCanonical = (key, val) => {
    const known = STATE.ETL_COMMON_VARIABLES || [];
    if (!known.length || known.some(item => item.key === key)) addPlanArg(key, val);
  };
  const gmaBoundaryUri = $('dfcBoundaryUri')?.value.trim() || STATE.RUNTIME_DEFAULTS.geometry_source_uri || STATE.TWDB_GMA_BOUNDARY_LAYER;
  const areaBoundaryUri = $('dfcAreaBoundaryUri')?.value.trim() || gmaBoundaryUri;
  const selectedRecords = STATE.DFC_SELECTED_TARGET ? targetRecordsForMetric(STATE.DFC_TARGET_RECORDS, STATE.DFC_SELECTED_TARGET) : [];
  const selectedRecord = selectedRecords[0] || null;
  const gmaScope = $('dfcGmaId')?.value.trim();
  const areaType = selectedRecord?.area_type || (selectedRecord?.area ? 'dfc-area' : 'gma');
  const layer = (STATE.SPATIAL_LAYER_OPTIONS || []).find(item => item.uri === gmaBoundaryUri);
  let geometryFilterField = layer?.default_filter_field || 'GMAnum';
  let geometryFilterValue = gmaScope;
  if (selectedRecord?.area_type === 'county') {
    geometryFilterField = layer?.default_filter_field || 'Name';
    geometryFilterValue = selectedRecord.area;
  } else if (selectedRecord?.area_type === 'gcd') {
    geometryFilterField = layer?.default_filter_field || 'DistrictName';
    geometryFilterValue = selectedRecord.area;
  }

  addPlanArg('gma_id', $('dfcGmaId')?.value.trim());
  if (dfcPlanUsesArg('spatial_scope_id')) addCanonical('spatial_scope_id', gmaScope);
  if (dfcPlanUsesArg('spatial_scope_type')) addCanonical('spatial_scope_type', areaType === 'dfc-area' ? 'custom' : areaType);
  if (dfcPlanUsesArg('spatial_scope_name')) addCanonical('spatial_scope_name', selectedRecord?.area || 'GMA-wide');
  addPlanArg('aquifer', $('dfcAquifer')?.value.trim());
  addPlanArg('layer', Number($('dfcLayer')?.value || 1));
  if (dfcPlanUsesArg('model_layer')) addCanonical('model_layer', Number($('dfcLayer')?.value || 1));
  addPlanArg('stress_period', Number($('dfcStressPeriod')?.value || 1));
  addPlanArg('timestep', Number($('dfcTimestep')?.value || 1));
  addPlanArg('target_year', $('dfcTargetYear')?.value.trim());
  addPlanArg('baseline_year', $('dfcBaselineYear')?.value.trim());
  addPlanArg('area', selectedRecord?.area || 'GMA-wide');
  addPlanArg('area_type', areaType);
  addPlanArg('gcd_name', selectedRecord?.area_type === 'gcd' ? selectedRecord.area : '');
  addPlanArg('county_name', selectedRecord?.area_type === 'county' ? selectedRecord.area : '');
  if (dfcPlanUsesArg('geometry_filter_field')) addCanonical('geometry_filter_field', geometryFilterField);
  if (dfcPlanUsesArg('geometry_filter_value')) addCanonical('geometry_filter_value', geometryFilterValue);
  addPlanArg('gma_boundary_uri', gmaBoundaryUri);
  addPlanArg('dfc_area_boundary_uri', areaBoundaryUri);
  if (dfcPlanUsesArg('geometry_source_uri')) addCanonical('geometry_source_uri', gmaBoundaryUri);
  addPlanArg('geo_actor_id', $('dfcGeoActorId')?.value.trim());
  addPlanArg('grid_uri', $('dfcGridUri')?.value.trim());
  addPlanArg('source_uri', STATE.DFC_SELECTED_SOURCE?.resource_uri || '');
  addPlanArg('tapis_base_url', 'https://portals.tapis.io');
  return args;
}

function dfcPlanUsesArg(argName) {
  const steps = STATE.PLAN_DFC?.plan_json?.steps || [];
  return steps.some(step => Object.values(step.env_from_args || {}).includes(argName));
}

function validateDfcLiveArgs(args) {
  const missing = [];
  const needs = key => dfcPlanUsesArg(key) && !args[key]?.value;
  const needsAny = keys => keys.some(dfcPlanUsesArg);
  const missingAny = keys => keys.every(k => !args[k]?.value);
  if (needs('geo_actor_id') && !STATE.RUNTIME_DEFAULTS.geo_actor_id) missing.push('Geo actor ID');
  if (needs('source_uri')) missing.push('modeled output source URI');
  if (needs('grid_uri')) missing.push('model grid / DIS URI');
  if (needsAny(['gma_id', 'spatial_scope_id']) && missingAny(['gma_id', 'spatial_scope_id'])) missing.push('GMA / scope ID');
  if (needsAny(['gma_boundary_uri', 'geometry_source_uri']) && missingAny(['gma_boundary_uri', 'geometry_source_uri'])) missing.push('GMA boundary URI');
  if (dfcPlanUsesArg('tapis_token') && !getToken()) missing.push('Tapis login token');
  if (missing.length) throw new Error(`Live DFC run needs ${missing.join(', ')}. Keep dry-run checked to inspect the workflow without these runtime values.`);
}

function liveDfcMissingArgs(workflow, args) {
  const params = workflow?.tapis_workflow_definition?.params || workflow?.params || {};
  const requiredGroups = [
    ['source_uri'],
    ['gma_id', 'spatial_scope_id'],
    ['gma_boundary_uri', 'geometry_source_uri'],
    ['dfc_area_boundary_uri'],
    ['geo_actor_id'],
    ['grid_uri'],
    ['tapis_token'],
  ];
  return requiredGroups.map(group => {
    const active = group.filter(key => key in params);
    if (!active.length) return null;
    if (active.some(key => args[key]?.value)) return null;
    // The backend injects the Authorization bearer into tapis_token for live
    // submits, so a logged-in UI should not report tapis_token as missing.
    if (active.includes('tapis_token') && getToken()) return null;
    return active[0];
  }).filter(Boolean);
}

function appendLivePrerequisites(workflow, args) {
  const missing = liveDfcMissingArgs(workflow, args);
  if (!missing.length) return;
  $('runOut').innerHTML += `<p class="warn" style="margin-top:12px"><b>Live extraction prerequisites missing:</b> ${missing.map(esc).join(', ')}. Local fixture mode generated the workflow only; no modeled outputs or compliance results were fabricated.</p>`;
}

// ── Load case ─────────────────────────────────────────────────────────────
async function loadCase(key) {
  stopPoll();
  STATE.CASE_KEY = key;
  $('statusLine').textContent = 'loading…';
  $('graphOut').innerHTML = '<p class="muted">Loading…</p>';
  $('sourcesList').innerHTML = '<p class="muted">Loading…</p>';
  $('runOut').innerHTML = ''; $('runMsg').textContent = ''; $('dfcQuestionMsg').textContent = '';
  if ($('dfcPlanMsg')) $('dfcPlanMsg').textContent = '';
  STATE.PLAN_FORECAST = STATE.PLAN_DFC = STATE.SCENARIO = null;
  STATE.DFC_SELECTED_SOURCE = STATE.DFC_SELECTED_TARGET = null;
  if ($('dfcQuestionSection')) $('dfcQuestionSection').style.display = key === 'dfc' ? '' : 'none';
  if ($('dfcAnswerSection')) $('dfcAnswerSection').style.display = key === 'dfc' ? '' : 'none';
  if ($('setupSection')) $('setupSection').style.display = key === 'dfc' ? '' : 'none';
  if ($('piecesSection')) $('piecesSection').style.display = key === 'pieces' ? '' : 'none';
  if ($('forecastRunControls')) $('forecastRunControls').style.display = key === 'forecast' ? 'flex' : 'none';
  if ($('dfcRunControls')) $('dfcRunControls').style.display = key === 'dfc' ? '' : 'none';
  if ($('dfcControls')) $('dfcControls').style.display = 'none';
  if ($('sourcesTitle')) $('sourcesTitle').innerHTML = key === 'dfc' ? 'Model sources <span class="desc">— registered modeled outputs for this evaluation</span>' : 'Sources <span class="desc">— data objects registered for this test case</span>';
  if ($('inferenceTitle')) $('inferenceTitle').textContent = key === 'dfc' ? 'Calculation Evidence' : 'Inference graph';
  if ($('runTitle')) $('runTitle').textContent = key === 'dfc' ? 'Workflow' : 'Run';
  if ($('runTapisBtn')) $('runTapisBtn').textContent = 'Run workflow';
  if (key === 'dfc') renderDfcAnswerPlaceholder();

  try {
    if (STATE.IS_DEMO) {
      const needsSeed = !STATE.SPECS || !Object.keys(STATE.SPECS).length;
      if (needsSeed) {
        if (key === 'forecast') await api('POST', '/admin/seed-ntgam-forecast');
        else if (key === 'dfc') await api('POST', '/admin/seed-gma-dfc');
        else throw new Error(`unknown case: ${key}`);
      }
    }
    const [specs, objs] = await Promise.all([api('GET', '/transform-specs'), api('GET', '/data-objects')]);
    STATE.SPECS = {};
    for (const s of specs) STATE.SPECS[s.id] = s;
    STATE.OBJECTS = Array.isArray(objs) ? objs : (objs.data_objects || []);
    renderSources(STATE.OBJECTS);
    if (key === 'dfc') {
      if ($('runLocalBtn')) $('runLocalBtn').style.display = 'none';
      await Promise.all([loadDfcTargetRecords(), loadRuntimeDefaults(), loadDfcObjectives()]);
      applyRuntimeDefaults();
      renderDfcControls();
      const objectiveNote = STATE.DFC_OBJECTIVES.length ? `; ${STATE.DFC_OBJECTIVES.length} objective spec${STATE.DFC_OBJECTIVES.length === 1 ? '' : 's'} loaded` : '';
      $('dfcQuestionMsg').textContent = STATE.OBJECTS.length ? `fixture model outputs loaded${objectiveNote}` : `no model outputs registered${objectiveNote}`;
    } else if (!STATE.IS_DEMO) {
      if ($('runLocalBtn')) $('runLocalBtn').style.display = 'none';
      $('graphOut').innerHTML = '<p class="muted" style="padding:8px 0">Fixture seed data is not available in live mode.</p>';
    } else if (key === 'forecast') {
      STATE.PLAN_FORECAST = await api('POST', '/forecast/plan', forecastRequestBody());
      if ($('runLocalBtn')) $('runLocalBtn').style.display = '';
      renderForecastGraph(STATE.PLAN_FORECAST);
    } else if (key === 'pieces') {
      renderPieces(specs);
    } else {
      throw new Error(`unknown case: ${key}`);
    }
    $('statusLine').textContent = '';
    loadRunHistory();
  } catch (e) {
    $('statusLine').innerHTML = `<span class="err">${esc(e.message)}</span>`;
    $('graphOut').innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

function renderPieces(specs) {
  const list = $('piecesList');
  if (!list) return;
  if (!specs.length) { list.innerHTML = '<p class="muted">No ETL pieces registered.</p>'; return; }
  list.innerHTML = specs.map(s => {
    const params = s.parameters_schema_json || {};
    const meta = params.metadata || {};
    const runtime = meta.runtime || {};
    const hasSource = Boolean(meta.source?.code);
    const kind = runtime.kind || (s.tapis_app_id ? 'tapis_app' : 'built-in function');
    const contracts = (s.contracts || []).map(c => `${c.role}: ${humanSvo(c.standard_variable_uri || 'unspecified')} ${c.unit || ''} ${c.format || ''}`).join('<br>');
    return `<div class="context-card" style="margin-bottom:8px"><b>${esc(s.name || s.id)}</b> <span class="muted">${esc(s.version || '')}</span><br><span class="muted">${esc(kind)}${hasSource ? ' · Python source registered' : ''}</span><div style="margin-top:6px;font-size:12px">${contracts || 'No contracts'}</div><button class="ghost test-piece-btn" data-piece-id="${esc(s.id)}" type="button" style="margin-top:8px">Generate test workflow</button><pre id="piece-test-${esc(s.id)}" style="display:none;margin-top:8px;max-height:240px;overflow:auto"></pre></div>`;
  }).join('');
}

async function testPiece(specId, button) {
  const out = document.getElementById(`piece-test-${specId}`);
  try { button.disabled = true; button.textContent = 'Generating…'; const result = await api('POST', `/transform-specs/${encodeURIComponent(specId)}/test`, { dry_run: true }, { auth: true }); out.style.display = ''; out.textContent = JSON.stringify(result, null, 2); }
  catch (e) { out.style.display = ''; out.textContent = e.message; }
  finally { button.disabled = false; button.textContent = 'Generate test workflow'; }
}

function contractRow(role, values = {}) {
  const id = `piece-${role}-${Math.random().toString(16).slice(2)}`;
  return `<div class="context-card piece-contract" data-role="${role}" style="margin:8px 0"><div class="dfc-grid">
    <label>SVO URI or short name <input data-field="standard_variable_uri" value="${esc(values.standard_variable_uri || '')}" placeholder="groundwater__hydraulic_head"></label>
    <label>Unit <input data-field="unit" value="${esc(values.unit || '')}" placeholder="m"></label>
    <label>Format <input data-field="format" value="${esc(values.format || '')}" placeholder="csv"></label>
    <label>Dimensionality <input data-field="dimensionality" value="${esc(values.dimensionality || '')}" placeholder="scalar"></label>
    <label>Spatial type <input data-field="spatial_type" value="${esc(values.spatial_type || '')}" placeholder="point/grid"></label>
    <label>CRS <input data-field="crs_requirement" value="${esc(values.crs_requirement || '')}" placeholder="EPSG:4326"></label>
    <label>Temporal resolution <input data-field="temporal_resolution" value="${esc(values.temporal_resolution || '')}" placeholder="daily"></label>
  </div><button class="ghost remove-piece-contract" type="button" data-target="${id}">Remove ${role}</button></div>`.replace('class="context-card piece-contract"', `id="${id}" class="context-card piece-contract"`);
}

function addPieceContract(role, values) {
  const target = role === 'input' ? $('pieceInputs') : $('pieceOutputs');
  if (target) target.insertAdjacentHTML('beforeend', contractRow(role, values));
}

function collectPieceContracts() {
  return [...document.querySelectorAll('.piece-contract')].map(row => {
    const out = { role: row.dataset.role };
    row.querySelectorAll('[data-field]').forEach(el => { if (el.value.trim()) out[el.dataset.field] = el.value.trim(); });
    return out;
  });
}

function piecePayload() {
  const runtime = $('pieceRuntime').value;
  const source = $('pieceSource').value;
  const advanced = $('pieceAdvanced').value.trim() ? JSON.parse($('pieceAdvanced').value) : {};
  const payload = {
    id: $('pieceId').value.trim() || undefined, name: $('pieceName').value.trim(), version: $('pieceVersion').value.trim() || undefined,
    description: $('pieceDescription').value.trim() || undefined, transform_type: $('pieceType').value.trim() || 'custom_python',
    method: runtime, tapis_app_id: runtime === 'tapis_app' ? ($('pieceAppId').value.trim() || undefined) : undefined,
    app_version: runtime === 'tapis_app' ? ($('pieceAppVersion').value.trim() || undefined) : undefined,
    container_image: $('pieceContainer').value.trim() || undefined,
    metadata: { ...(advanced.metadata || {}), runtime: { kind: runtime, language: 'python', entrypoint: $('pieceEntrypoint').value.trim() || 'transform' }, source: { language: 'python', entrypoint: $('pieceEntrypoint').value.trim() || 'transform', code: source } },
    contracts: collectPieceContracts(),
    parameters_schema_json: advanced.parameters_schema_json,
    env_from_args: advanced.env_from_args,
    file_inputs: advanced.file_inputs,
  };
  return JSON.parse(JSON.stringify(payload));
}

async function loadPieces() {
  const msg = $('pieceMsg');
  try { const specs = await api('GET', '/transform-specs'); renderPieces(specs); if (msg) msg.textContent = `${specs.length} piece${specs.length === 1 ? '' : 's'} loaded`; }
  catch (e) { if (msg) msg.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

async function registerPiece() {
  const msg = $('pieceMsg');
  try {
    const payload = piecePayload();
    if (!payload.name || !payload.contracts?.length) throw new Error('name and at least one contract are required');
    if (payload.metadata?.source && typeof payload.metadata.source.code !== 'string') throw new Error('metadata.source.code must be a string');
    if (payload.method === 'tapis_app' && !payload.tapis_app_id) throw new Error('Tapis app ID is required for app/job runtime');
    msg.textContent = 'registering…';
    await api('POST', '/transform-specs', payload, { auth: true });
    msg.textContent = 'registered; refreshing registry';
    await loadPieces();
  } catch (e) { msg.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

function renderDfcControls() {
  if ($('dfcControls')) $('dfcControls').style.display = '';
  const srcSel = $('dfcSourceSel');
  if (srcSel) {
    srcSel.innerHTML = '';
    if (!STATE.OBJECTS.length) {
      srcSel.innerHTML = '<option value="">No data objects registered</option>';
      srcSel.disabled = true;
    } else {
      srcSel.disabled = false;
      for (const o of STATE.OBJECTS) {
        const opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = dataObjectLabel(o);
        srcSel.appendChild(opt);
      }
    }
  }
  const tgtSel = $('dfcTargetSel');
  if (tgtSel) {
    tgtSel.innerHTML = '';
    for (const t of STATE.DFC_TARGETS) {
      const opt = document.createElement('option');
      opt.value = t.key;
      opt.textContent = t.plannerLabel || t.label;
      tgtSel.appendChild(opt);
    }
  }
  updateDfcContextSelectors();
  const planBtn = $('planDfcBtn');
  if (planBtn) planBtn.disabled = !STATE.OBJECTS.length;
  const bfsNote = $('bfsNote');
  if (bfsNote && !bfsNote.textContent.trim()) {
    bfsNote.textContent = 'Select a CKAN GAM modeled output and the DFC metric you want. The adapter plans from the modeled-output contract through the DFC transform registry: HDS heads can become GMA-average head or saturated thickness; CBC budget files can become spring-flow or stream-flow scalars.';
  }
  if ($('graphOut')) {
    $('graphOut').innerHTML = STATE.OBJECTS.length ? '<p class="muted" style="padding:8px 0">Choose a source and DFC target, then plan the transform chain.</p>' : '<p class="muted" style="padding:8px 0">No data objects are registered yet. In live mode, sync CKAN GAM resources after loading DFC transforms.</p>';
  }
}

// ── Polling ───────────────────────────────────────────────────────────────
function stopPoll() { if (STATE._pollTimer) { clearInterval(STATE._pollTimer); STATE._pollTimer = null; } }

function _statusClass(st) {
  const u = st.toUpperCase();
  if (['COMPLETED', 'DONE', 'SUCCESS'].includes(u)) return 'ok';
  if (['FAILED', 'ERROR', 'CANCELLED', 'ARCHIVING_FAILED', 'PHASE_ERROR'].includes(u)) return 'bad';
  return 'warn';
}

function pollForecast(uuid, pipelineId) {
  if (!getToken()) { $('runMsg').textContent += ' — log in to poll status'; return; }
  const TERMINAL = ['COMPLETED', 'FAILED', 'ARCHIVING_FAILED', 'CANCELLED', 'PHASE_ERROR'];
  const start = Date.now();
  STATE._pollTimer = setInterval(async () => {
    try {
      const elapsed = Math.round((Date.now() - start) / 1000);
      const d = await api('GET', `/forecast/run-tapis/${uuid}?pipeline_id=${encodeURIComponent(pipelineId)}`, undefined, { auth: true });
      const st = (d.status || 'PENDING').toUpperCase();
      const done = TERMINAL.includes(st);
      $('runMsg').innerHTML = `run <code>${uuid.slice(0, 8)}…</code> <b class="${_statusClass(st)}">${st}</b> (${elapsed}s)`;
      if (done) {
        stopPoll();
        const forecastTask = (d.tasks || []).find(t => t.task_id === 'forecast' || String(t.task_id || '').endsWith('-forecast'));
        if (st === 'COMPLETED') {
          if (forecastTask?.stdout) { try { renderForecastResult(JSON.parse(forecastTask.stdout)); } catch (_) { } }
          else $('runOut').innerHTML += `<pre style="margin-top:8px">${esc(JSON.stringify(d, null, 2))}</pre>`;
        } else {
          const msg = forecastTask?.last_message || forecastTask?.stderr || JSON.stringify(d, null, 2);
          $('runOut').innerHTML += `<pre class="err" style="margin-top:8px;padding:8px;border-radius:5px;border:1px solid var(--bad);white-space:pre-wrap">${esc(msg)}</pre>`;
        }
      }
    } catch (e) {
      $('runMsg').innerHTML += ` <span class="err">(poll: ${esc(e.message)})</span>`;
      stopPoll();
    }
  }, 5000);
}

function pollWorkflowRun(runId) {
  const TERMINAL = ['completed', 'failed', 'cancelled', 'error'];
  const start = Date.now();
  STATE._pollTimer = setInterval(async () => {
    try {
      const elapsed = Math.round((Date.now() - start) / 1000);
      const d = getToken()
        ? await api('POST', `/runs/${runId}/poll`, undefined, { auth: true })
        : await api('GET', `/runs/${runId}`, undefined, { auth: true });
      const st = (d.status || 'submitted').toLowerCase();
      const done = TERMINAL.includes(st);
      $('runMsg').innerHTML = `run <code>${runId.slice(0, 8)}…</code> <b class="${_statusClass(st)}">${st}</b> (${elapsed}s)`;
      if (done) {
        stopPoll();
        if (d.error_message) $('runOut').innerHTML += `<pre class="err" style="margin-top:8px;padding:8px;border-radius:5px;border:1px solid var(--bad);white-space:pre-wrap">${esc(d.error_message)}</pre>`;
        else if (st === 'completed') $('runOut').innerHTML = renderDfcResults(d);
        else $('runOut').innerHTML += `<pre style="margin-top:8px">${esc(JSON.stringify(d, null, 2))}</pre>`;
      }
    } catch (e) {
      $('runMsg').innerHTML += ` <span class="err">(poll: ${esc(e.message)})</span>`;
      stopPoll();
    }
  }, 5000);
}

// ── Forecast result renderer ──────────────────────────────────────────────
function renderForecastResult(r) {
  const pj = r.projection || {};
  const fmtV = v => (typeof v === 'number' && !Number.isInteger(v)) ? v.toFixed(3) : String(v ?? '—');
  const factors = Object.entries(r.risk_factors || {}).map(([k, v]) => `<div class="rf"><span class="muted">${k.replace(/_/g, ' ')}</span><b>${fmtV(v)}</b></div>`).join('');
  $('runOut').innerHTML = `<div class="risk-grid">
    <div class="risk-box"><div class="rb-label">Subsidence risk (0–10)</div><div class="rb-val">${r.risk_score ?? '—'}</div></div>
    <div class="risk-box"><div class="rb-label">Projected subsidence ${pj.start_year}–${pj.final_year} (ft)</div>
      <div class="rb-val">${pj.final_subsidence_min_ft?.toFixed(2) ?? '—'} – ${pj.final_subsidence_max_ft?.toFixed(2) ?? '—'}</div></div>
    <div class="risk-box"><div class="rb-label">Water-level decline (ft)</div><div class="rb-val">${pj.final_drawdown_ft?.toFixed(1) ?? '—'}</div></div>
  </div>
  <div style="margin-top:14px;font-size:12px;font-weight:700;color:var(--mut)">Risk factors</div>
  <div class="risk-factors">${factors}</div>`;
}

function forecastRequestBody(extra = {}) {
  const latEl = $('forecastLat');
  const lonEl = $('forecastLon');
  const layerEl = $('forecastLayer');
  if (!latEl || !lonEl || !layerEl) throw new Error('Forecast controls are not available in this UI view.');
  const lat = Number(latEl.value);
  const lon = Number(lonEl.value);
  const model_layer = Number(layerEl.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isInteger(model_layer)) throw new Error('lat, lon, and integer model layer are required');
  return { lat, lon, model_layer, ...extra };
}

function redactedTapisDryRun(r) {
  const copy = JSON.parse(JSON.stringify(r));
  const wf = copy.tapis_workflow_definition || copy;
  for (const t of (wf.tasks || [])) { if (typeof t.code === 'string') t.code = `<redacted ${t.code.length} chars>`; }
  return copy;
}

function renderTapisDryRun(r) {
  const wf = r.tapis_workflow_definition || {};
  const tasks = wf.tasks || [];
  const rows = tasks.map(t => {
    const deps = (t.depends_on || []).map(d => d.id || String(d)).join(', ') || '—';
    const codeLen = typeof t.code === 'string' ? `${t.code.length.toLocaleString()} chars` : '—';
    return `<tr><td><code>${esc(t.id || t.task_id || '')}</code></td><td>${esc(t.type || '')}</td><td>${esc(deps)}</td><td>${esc(codeLen)}</td></tr>`;
  }).join('');
  $('runOut').innerHTML = `<div class="risk-grid">
    <div class="risk-box"><div class="rb-label">Pipeline</div><div class="rb-val" style="font-size:16px">${esc(r.pipeline_id || wf.id || '—')}</div></div>
    <div class="risk-box"><div class="rb-label">Tasks</div><div class="rb-val">${tasks.length}</div></div>
    <div class="risk-box"><div class="rb-label">Status</div><div class="rb-val" style="font-size:18px">${esc(r.status || 'generated')}</div></div>
  </div>
  <table style="width:100%;margin-top:14px;border-collapse:collapse;font-size:12px"><thead><tr><th align="left">task</th><th align="left">type</th><th align="left">depends on</th><th align="left">code</th></tr></thead><tbody>${rows}</tbody></table>
  <details style="margin-top:12px"><summary class="muted">redacted workflow JSON</summary><pre>${esc(JSON.stringify(redactedTapisDryRun(r), null, 2))}</pre></details>`;
}

// ── Run locally (NTGAM) ───────────────────────────────────────────────────
function initRunLocal() {
  const btn = $('runLocalBtn');
  if (btn) btn.onclick = async () => {
    $('runMsg').textContent = 'assembling scenario…'; $('runOut').innerHTML = '';
    try {
      const sr = await api('POST', '/forecast/scenario', forecastRequestBody());
      STATE.SCENARIO = sr.scenario;
      $('runMsg').textContent = 'running…';
      const r = await api('POST', '/forecast/run', { scenario: STATE.SCENARIO });
      renderForecastResult(r);
      $('runMsg').textContent = 'done';
    } catch (e) { $('runMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  };
}

// ── Run on Tapis ──────────────────────────────────────────────────────────
function initRunTapis() {
  const btn = $('runTapisBtn');
  if (btn) btn.onclick = async () => {
    stopPoll();
    $('runMsg').textContent = 'submitting…'; $('runOut').innerHTML = '';
    try {
      let r;
      if (STATE.CASE_KEY === 'forecast') {
        r = await api('POST', '/forecast/run-tapis', forecastRequestBody(), { auth: true });
      } else if (STATE.CASE_KEY === 'dfc') {
        if (!STATE.PLAN_DFC?.plan_id) throw new Error('Plan a DFC transform chain first');
        const args = dfcRunArgs();
        r = await api('POST', '/workflows/submit', { plan_id: STATE.PLAN_DFC.plan_id, dry_run: false, recreate: true, args }, { auth: true });
      } else {
        throw new Error(`unknown case: ${STATE.CASE_KEY}`);
      }
      const shortId = (r.uuid || r.run_id || '?').toString().slice(0, 8);
      $('runMsg').textContent = `submitted — ${shortId}… polling…`;
      $('runOut').innerHTML = `<pre style="opacity:.5">${esc(JSON.stringify(r, null, 2))}</pre>`;
      if (STATE.CASE_KEY === 'forecast' && r.uuid) pollForecast(r.uuid, r.pipelineId || r.pipeline_id || '');
      else if (r.run_id) pollWorkflowRun(r.run_id);
    } catch (e) { $('runMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  };
}

// ── DFC planning ──────────────────────────────────────────────────────────
async function planDfcMetric(target, source) {
  if (!source) return { target, source, error: 'No matching modeled output registered' };
  try {
    const plan = await api('POST', '/plans', { data_object_id: source.id, target_contract: target.contract });
    return { target, source, plan };
  } catch (e) { return { target, source, error: e.message }; }
}

async function planDfcObjective(target, objective) {
  try {
    const plan = await api('POST', `/objectives/${encodeURIComponent(objective.id)}/evaluate-plan`, {});
    const source = sourceForPlan(plan, target);
    return { target, source, plan, objectiveId: objective.id };
  } catch (e) {
    return { target, source: chooseDfcSource(target), objectiveId: objective.id, error: e.message };
  }
}

function hasAreaSpecificTargets(records) {
  return (records || []).some(r => r.area && !/^gma[-\s]?wide$/i.test(String(r.area).trim()));
}

async function planDfcForSelectedTargets(source, target, targetRecords) {
  const objective = objectiveForTarget(target);
  if (objective) return api('POST', `/objectives/${encodeURIComponent(objective.id)}/evaluate-plan`, {});
  if (hasAreaSpecificTargets(targetRecords) && target.key === 'head-drawdown') {
    return api('POST', '/plans/dfc-fanout', {
      data_object_id: source.id,
      target_contract: target.contract,
      target_records: targetRecords,
      gma_id: $('dfcGmaId')?.value?.trim(),
    });
  }
  return api('POST', '/plans', { data_object_id: source.id, target_contract: target.contract });
}

async function evaluateDfcMetrics() {
  const selected = $('dfcMetricQuestionSel')?.value;
  const availableTargets = dfcMetricTargetsForCurrentContext();
  const targets = availableTargets.filter(t => selected === 'all' || t.key === selected);
  if (!targets.length) {
    $('dfcQuestionMsg').textContent = 'no adopted DFC metrics were extracted for this GMA/aquifer/year';
    $('dfcAnswerOut').innerHTML = '<p class="muted">No adopted DFC target records matched this planning context. Choose another GMA or aquifer, or inspect the PDF extraction gap.</p>';
    $('graphOut').innerHTML = '';
    return;
  }
  $('dfcQuestionMsg').textContent = 'loading adopted targets and evaluating modeled outputs…';
  $('dfcAnswerOut').innerHTML = '<p class="muted">Loading adopted DFC targets and checking calculation paths…</p>';
  $('graphOut').innerHTML = '<p class="muted">Planning workflows…</p>';
  try {
    const [lookup, planned] = await Promise.all([
      fetchDfcTargetLookup().catch(e => ({ count: 0, records: [], error: e.message })),
      Promise.all(targets.map(t => {
        const objective = objectiveForTarget(t);
        return objective ? planDfcObjective(t, objective) : planDfcMetric(t, chooseDfcSource(t));
      })),
    ]);
    const records = lookup.records || [];
    const results = planned.map(r => ({ ...r, targetRecords: targetRecordsForMetric(records, r.target) }));
    renderDfcEvaluationResults(results);
    const ready = results.filter(r => !r.error).length;
    const targetCount = results.reduce((n, r) => n + (r.targetRecords?.length || 0), 0);
    const objectiveCount = results.filter(r => r.objectiveId).length;
    const objectiveNote = objectiveCount ? `; ${objectiveCount} planned from objective spec${objectiveCount === 1 ? '' : 's'}` : '';
    $('dfcQuestionMsg').textContent = `${ready} modeled calculation path${ready === 1 ? '' : 's'} available; ${targetCount} adopted target${targetCount === 1 ? '' : 's'} matched${objectiveNote}`;
  } catch (e) { $('dfcQuestionMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

function runWorkflowForPlan(plan, source, target, { dryRun = false } = {}) {
  const args = dfcRunArgs();
  if (!dryRun) validateDfcLiveArgs(args);
  $('runMsg').textContent = dryRun ? 'generating workflow…' : 'submitting…';
  $('runOut').innerHTML = '';
  const loadCompletedForPlan = async () => {
    if (dryRun || !plan?.plan_id) return null;
    const data = await api('GET', '/runs?limit=50', undefined, { auth: true });
    const run = (data.runs || []).find(r => r.workflow_plan_id === plan.plan_id && String(r.status || '').toLowerCase() === 'completed');
    if (!run) return null;
    return getToken()
      ? api('POST', `/runs/${run.id}/poll`, undefined, { auth: true })
      : api('GET', `/runs/${run.id}`, undefined, { auth: true });
  };
  loadCompletedForPlan()
    .then(existing => {
      if (existing) {
        $('runMsg').textContent = `reused completed run — ${existing.id.slice(0, 8)}…`;
        $('runOut').innerHTML = renderDfcResults(existing);
        return null;
      }
      return api('POST', '/workflows/submit', { plan_id: plan.plan_id, dry_run: dryRun, recreate: true, args }, { auth: !dryRun });
    })
    .then(r => {
      if (!r) return;
      if (dryRun) {
        $('runMsg').textContent = 'workflow generated — live extraction requires Tapis + geo_actor runtime args';
        renderTapisDryRun(r);
        appendLivePrerequisites(r, args);
        return;
      }
      const shortId = (r.uuid || r.run_id || '?').toString().slice(0, 8);
      $('runMsg').textContent = `submitted — ${shortId}… polling…`;
      $('runOut').innerHTML = `<pre style="opacity:.5">${esc(JSON.stringify(r, null, 2))}</pre>`;
      if (r.run_id) pollWorkflowRun(r.run_id);
    })
    .catch(err => $('runMsg').innerHTML = `<span class="err">${esc(err.message)}</span>`);
}

// ── Event handlers ────────────────────────────────────────────────────────
function initEventHandlers() {
  // Tabs
  document.querySelectorAll('.tc').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tc').forEach(b => b.classList.toggle('active', b === btn));
      STATE.CASE_KEY = btn.dataset.case;
      loadCase(STATE.CASE_KEY);
    };
  });

  // DFC evaluate button
  if ($('evaluateDfcBtn')) $('evaluateDfcBtn').onclick = evaluateDfcMetrics;
  if ($('registerPieceBtn')) $('registerPieceBtn').onclick = registerPiece;
  if ($('refreshPiecesBtn')) $('refreshPiecesBtn').onclick = loadPieces;
  if ($('addPieceInputBtn')) $('addPieceInputBtn').onclick = () => addPieceContract('input');
  if ($('addPieceOutputBtn')) $('addPieceOutputBtn').onclick = () => addPieceContract('output');
  if ($('pieceInputs') && !$('pieceInputs').children.length) addPieceContract('input', { standard_variable_uri: 'groundwater__hydraulic_head', unit: 'm', format: 'csv' });
  if ($('pieceOutputs') && !$('pieceOutputs').children.length) addPieceContract('output', { standard_variable_uri: 'groundwater__hydraulic_head', unit: 'ft', format: 'csv' });
  document.addEventListener('click', e => { const btn = e.target.closest('.remove-piece-contract'); if (btn) document.getElementById(btn.dataset.target)?.remove(); });
  document.addEventListener('click', e => { const btn = e.target.closest('.test-piece-btn'); if (btn) testPiece(btn.dataset.pieceId, btn); });

  // DFC context selectors
  if ($('dfcGmaId')) $('dfcGmaId').onchange = () => { updateDfcContextSelectors({ preserveGma: true, preserveAquifer: false, preserveYear: false, preserveMetric: false }); renderDfcAnswerPlaceholder(); $('dfcQuestionMsg').textContent = 'planning context updated'; };
  if ($('dfcAquifer')) $('dfcAquifer').onchange = () => { updateDfcContextSelectors({ preserveGma: true, preserveAquifer: true, preserveYear: false, preserveMetric: false }); renderDfcAnswerPlaceholder(); $('dfcQuestionMsg').textContent = 'planning context updated'; };
  if ($('dfcTargetYear')) $('dfcTargetYear').onchange = () => { updateDfcContextSelectors({ preserveGma: true, preserveAquifer: true, preserveYear: true, preserveMetric: false }); renderDfcAnswerPlaceholder(); $('dfcQuestionMsg').textContent = 'planning context updated'; };

  // DFC answer section click (metric inspect buttons)
  if ($('dfcAnswerSection')) $('dfcAnswerSection').addEventListener('click', e => {
    const btn = e.target.closest('.metric-inspect-btn');
    if (!btn) return;
    const sourceId = btn.dataset.sourceId;
    const targetKey = btn.dataset.targetKey;
    const objectiveId = btn.dataset.objectiveId;
    const source = STATE.OBJECTS.find(o => o.id === sourceId);
    const target = STATE.DFC_TARGETS.find(t => t.key === targetKey);
    if (!source || !target) return;
    STATE.PLAN_DFC = null;
    STATE.DFC_SELECTED_SOURCE = source;
    STATE.DFC_SELECTED_TARGET = target;
    $('inspectSection').style.display = '';
    $('graphOut').innerHTML = '<p class="muted">Planning…</p>';
    $('dfcControls').style.display = 'none';
    const targetRecords = targetRecordsForMetric(STATE.DFC_TARGET_RECORDS, target);
    const planPromise = objectiveId
      ? api('POST', `/objectives/${encodeURIComponent(objectiveId)}/evaluate-plan`, {})
      : planDfcForSelectedTargets(source, target, targetRecords);
    planPromise
      .then(plan => {
        STATE.PLAN_DFC = plan;
        const resolvedSource = sourceForPlan(plan, target) || source;
        STATE.DFC_SELECTED_SOURCE = resolvedSource;
        renderDfcPlan(plan, resolvedSource, target);
        $('dfcControls').style.display = '';
        const genBtn = $('generateWorkflowBtn');
        const submitBtn = $('submitWorkflowBtn');
        if (genBtn) genBtn.onclick = () => runWorkflowForPlan(plan, resolvedSource, target, { dryRun: true });
        if (submitBtn) submitBtn.onclick = () => runWorkflowForPlan(plan, resolvedSource, target, { dryRun: false });
      })
      .catch(err => { $('graphOut').innerHTML = `<p class="err">${esc(err.message)}</p>`; });
  });

  // Seed DFC button
  if ($('seedDfcBtn')) $('seedDfcBtn').onclick = async () => {
    $('dfcSetupMsg').textContent = 'loading transform registry…';
    $('dfcSetupResult').innerHTML = '';
    try {
      const r = await api('POST', '/admin/seed-gma-dfc', undefined, { auth: !!getToken() });
      $('dfcSetupMsg').textContent = 'DFC transforms loaded';
      $('dfcSetupResult').innerHTML = `<pre>${esc(JSON.stringify({ transform_specs: r.transform_specs?.length || 0, sources: r.sources?.length || 0, targets: Object.keys(r.targets || {}) }, null, 2))}</pre>`;
      await loadCase('dfc');
    } catch (e) { $('dfcSetupMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  };

  // Sync CKAN button
  if ($('syncCkanBtn')) $('syncCkanBtn').onclick = async () => {
    const org = $('dfcCkanOrg')?.value.trim();
    const dry = $('dfcSyncMode')?.value !== 'write';
    $('dfcSetupMsg').textContent = dry ? 'previewing CKAN sync…' : 'syncing CKAN resources…';
    $('dfcSetupResult').innerHTML = '';
    try {
      const qs = new URLSearchParams();
      qs.set('dry_run', dry ? 'true' : 'false');
      if (org) qs.set('org', org);
      const r = await api('POST', `/admin/sync-from-ckan?${qs.toString()}`, undefined, { auth: !dry });
      $('dfcSetupMsg').textContent = dry ? 'CKAN sync preview complete' : 'CKAN resources synced';
      $('dfcSetupResult').innerHTML = `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`;
      if (!dry) await loadCase('dfc');
    } catch (e) { $('dfcSetupMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  };

  // Plan DFC button
  if ($('planDfcBtn')) $('planDfcBtn').onclick = async () => {
    const sourceId = $('dfcSourceSel')?.value;
    const targetKey = $('dfcTargetSel')?.value;
    const source = STATE.OBJECTS.find(o => o.id === sourceId);
    const target = STATE.DFC_TARGETS.find(t => t.key === targetKey);
    if (!source || !target) { $('dfcPlanMsg').innerHTML = '<span class="err">Select a source and target first.</span>'; return; }
    $('dfcPlanMsg').textContent = 'planning…';
    $('graphOut').innerHTML = '<p class="muted">Planning…</p>';
    try {
      const targetRecords = targetRecordsForMetric(STATE.DFC_TARGET_RECORDS, target);
      const plan = await planDfcForSelectedTargets(source, target, targetRecords);
      const resolvedSource = sourceForPlan(plan, target) || source;
      STATE.PLAN_DFC = plan;
      STATE.DFC_SELECTED_SOURCE = resolvedSource;
      STATE.DFC_SELECTED_TARGET = target;
      renderDfcPlan(plan, resolvedSource, target);
      $('dfcPlanMsg').textContent = plan.plan_json?.steps ? `${plan.plan_json.steps.length}-step path found` : 'source is already compatible';
    } catch (e) {
      STATE.PLAN_DFC = null;
      $('dfcPlanMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`;
      $('graphOut').innerHTML = '';
    }
  };

  // History handlers
  initHistoryHandlers(runWorkflowForPlan, pollWorkflowRun);
}

// ── Init ──────────────────────────────────────────────────────────────────
export async function init() {
  initAuth();
  await checkMode();
  api('GET', '/health').then(h => { STATE.IS_DEMO = !!h?.demo_mode; }).catch(() => { }).finally(() => loadCase(STATE.CASE_KEY));
  initEventHandlers();
  initRunLocal();
  initRunTapis();
}

init();
