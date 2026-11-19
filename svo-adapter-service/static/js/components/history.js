// history.js - Run history and provenance
import { $, esc, formatTime, statusBadge } from '../utils.js';
import { api } from '../api.js';
import { STATE } from '../state.js';

function metricLabelFor(metric) {
  return ({
    drawdown: 'average drawdown',
    water_level: 'water-level',
    saturated_thickness_or_storage: 'saturated thickness / storage',
    spring_or_stream_flow: 'spring or stream flow',
  })[metric] || metric || 'metric';
}

function metricDirection(metric) {
  if (metric === 'drawdown') return { expected: 'kept at or below', exceeds: 'a drawdown above it', badDir: 'above' };
  if (metric === 'saturated_thickness_or_storage') return { expected: 'kept at or above', exceeds: 'a thickness below it', badDir: 'below' };
  if (metric === 'water_level') return { expected: 'kept at or above', exceeds: 'a water level below it', badDir: 'below' };
  if (metric === 'spring_or_stream_flow') return { expected: 'kept at or above', exceeds: 'a flow below it', badDir: 'below' };
  return { expected: 'consistent with', exceeds: 'a value outside it', badDir: 'outside' };
}

function jsonPayloadsFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try { return [JSON.parse(raw)]; } catch {}
  const payloads = [];
  for (const line of raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try { payloads.push(JSON.parse(line)); } catch {}
  }
  return payloads;
}

function firstNumericPayloadValue(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of ['value', 'average_value', 'average_head', 'mean', 'total_flow', 'flow', 'head']) {
    if (typeof payload[key] === 'number') return { value: payload[key], unit: payload.unit || payload.units || '' };
  }
  return null;
}

function inferMetricAndScope(out, fallbackMetric, fallbackScope) {
  const names = [out?.operation, ...(out?.steps || []).map(s => `${s.name || ''} ${s.status || ''}`)].join(' ').toLowerCase();
  let metric = fallbackMetric;
  let scope = fallbackScope;
  if (names.includes('head') || names.includes('drawdown')) metric = 'drawdown';
  else if (names.includes('satthk') || names.includes('saturated')) metric = 'saturated_thickness_or_storage';
  else if (names.includes('drain') || names.includes('spring')) metric = 'spring_or_stream_flow';
  else if (names.includes('river') || names.includes('stream')) metric = 'spring_or_stream_flow';
  if (names.includes('gma') || out?.result?.gma_id) scope = 'gma';
  return { metric, scope };
}

function modeledResultFromTask(task) {
  const texts = [task.stdout, task.last_message].filter(Boolean);
  for (const text of texts) {
    for (const out of jsonPayloadsFromText(text)) {
      const candidates = [out?.result, out, ...(out?.steps || []).map(s => s.result)].filter(Boolean);
      for (const candidate of candidates) {
        const found = firstNumericPayloadValue(candidate);
        if (!found) continue;
        const inferred = inferMetricAndScope(out, null, 'unknown');
        return {
          ...found,
          metric: inferred.metric,
          scope: candidate.scope || out.scope || inferred.scope,
          area: candidate.area || out.area || null,
          payload: out,
        };
      }
    }
  }
  return null;
}

function cleanAreaName(value) {
  return String(value || '').replace(/\s*\*+\s*$/, '').trim();
}

function areaKey(value) {
  return cleanAreaName(value).toLowerCase();
}

function errorFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (String(payload.status || '').toLowerCase() === 'error') return payload.message || JSON.stringify(payload);
  if (payload.result && String(payload.result.status || '').toLowerCase() === 'error') return payload.result.message || JSON.stringify(payload.result);
  for (const step of payload.steps || []) {
    if (step?.result && String(step.result.status || '').toLowerCase() === 'error') {
      return `${step.name || `step ${step.step}`}: ${step.result.message || JSON.stringify(step.result)}`;
    }
  }
  return '';
}

function taskErrorSummary(tasks) {
  for (const task of tasks) {
    for (const text of [task.stdout, task.last_message, task.stderr].filter(Boolean)) {
      for (const payload of jsonPayloadsFromText(text)) {
        const msg = errorFromPayload(payload);
        if (msg) return `${task.task_id || task.id || 'task'}: ${msg}`;
      }
    }
  }
  return '';
}

function taskOutputSummary(tasks) {
  if (!tasks.length) return 'No task details were returned by the local poll endpoint.';
  return tasks.map(t => {
    const snippet = String(t.stdout || t.last_message || t.stderr || '').slice(0, 500);
    return `${t.task_id || t.id || 'task'} [${t.status || 'unknown'}]${snippet ? `\n${snippet}` : ''}`;
  }).join('\n\n');
}

export function renderDfcResults(run) {
  const tasks = run.tasks || [];
  const modeledResults = [];
  let modeledValue = null, modeledUnit = null, modeledMetric = null;
  let modeledScope = 'unknown';
  for (const task of tasks) {
    const found = modeledResultFromTask(task);
    if (!found) continue;
    modeledResults.push(found);
    if (modeledValue === null) {
      modeledValue = found.value;
      modeledUnit = found.unit;
      modeledMetric = found.metric;
      modeledScope = found.scope;
    }
  }
  const gma = $('dfcGmaId')?.value;
  const aquifer = $('dfcAquifer')?.value?.trim();
  const year = Number($('dfcTargetYear')?.value || 0);
  const targetRecords = STATE.DFC_TARGET_RECORDS.filter(r => {
    if (gma && (r.gma || r.gma_id) != gma.replace('GMA ', '')) return false;
    if (aquifer && r.aquifer !== aquifer && r.aquifer_system !== aquifer) return false;
    const ty = Number(r.period?.target_year || 0);
    if (year && ty && ty !== year) return false;
    return true;
  });
  let html = '<h4 style="margin-bottom:12px">DFC Compliance Check</h4>';
  if (modeledValue === null) {
    const nestedError = taskErrorSummary(tasks);
    html += nestedError
      ? `<p class="err">Workflow completed without a modeled value because a task returned an error: ${esc(nestedError)}</p>`
      : '<p class="err">No modeled value found in run outputs.</p>';
    html += `<details style="margin-top:10px"><summary class="muted" style="cursor:pointer">Show task output returned by Tapis</summary><pre>${esc(taskOutputSummary(tasks))}</pre></details>`;
  } else if (!targetRecords.length) {
    html += `<p class="warn">Modeled value: <b>${modeledValue} ${modeledUnit}</b></p><p class="muted">No adopted DFC targets matched current context (GMA: ${gma}, Aquifer: ${aquifer}, Year: ${year}).</p>`;
  } else {
    const first = targetRecords[0];
    const baseline = first.period?.baseline_year || '?';
    const targetYear = first.period?.target_year || year || '?';
    const metric = metricLabelFor(targetRecords.map(r => r.metric).find(Boolean) || modeledMetric);
    const direction = metricDirection(first.metric);
    const adoption = first.adoption_date ? ` adopted ${first.adoption_date}` : '';
    const pdfPage = first.source?.pdf_page ? `PDF p. ${first.source?.pdf_page}` : 'PDF';
    const districtCount = new Set(targetRecords.map(r => r.area)).size;
    const hasAreaSpecificTargets = targetRecords.some(r => r.area && !/^gma[-\s]?wide$/i.test(String(r.area).trim()));
    const resultsByArea = new Map(modeledResults.filter(r => r.area).map(r => [areaKey(r.area), r]));
    const hasAreaResults = hasAreaSpecificTargets && resultsByArea.size > 0;
    const canCompare = hasAreaResults || !(modeledScope === 'gma' && hasAreaSpecificTargets);
    const modeledScopeLabel = modeledScope === 'gma' ? 'GMA-average' : 'modeled';
    html += `<div class="answer-hero" style="margin-bottom:14px">
      <div class="answer-label">Planning context</div>
      <div class="answer-title" style="font-size:17px">${esc(gma)} · ${esc(aquifer)} · target ${targetYear}</div>
      <div class="answer-copy" style="margin-top:8px">A <b>Desired Future Condition</b> (DFC) is a groundwater planning objective GMA ${esc(String(gma).replace('GMA ', ''))} committed to for the ${baseline}–${targetYear} planning horizon${adoption}. The targets below are adopted DFC rules extracted from the TWDB 2021 report (${pdfPage}).</div>
    </div>`;
    html += `<p class="muted" style="font-size:12px;margin-bottom:4px">For ${esc(metric)} DFCs, the condition is ${direction.expected} the adopted target. When the modeled value goes ${direction.badDir} the target (${direction.exceeds}), the DFC is projected <b class="bad">not to be met</b> for that district.</p>`;
    if (!canCompare) {
      html += `<p class="warn" style="font-size:12px;margin-bottom:8px"><b>Scope mismatch:</b> this run produced one <b>${modeledScopeLabel}</b> value (${modeledValue} ${modeledUnit}), but the selected DFC rules are <b>district/county-specific</b>. A valid DFC compliance answer needs the model output aggregated over each target area's boundary, not one GMA-wide value reused for every area.</p>`;
    } else if (hasAreaResults) {
      html += `<p style="font-size:12px;margin-bottom:2px">Modeled <b>${esc(metric)}</b> (${baseline}–${targetYear}) was aggregated separately for <b>${resultsByArea.size}</b> target area${resultsByArea.size === 1 ? '' : 's'} and compared against the matching adopted DFC row.</p>`;
    } else {
      html += `<p style="font-size:12px;margin-bottom:2px">Modeled <b>${esc(metric)}</b> (${baseline}–${targetYear}): <b style="font-size:15px">${modeledValue} ${modeledUnit}</b> — compared against <b>${targetRecords.length}</b> adopted target${targetRecords.length === 1 ? '' : 's'} across <b>${districtCount}</b> area${districtCount === 1 ? '' : 's'}.</p>`;
    }
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:12px"><thead><tr style="text-align:left;border-bottom:1px solid var(--line)"><th style="padding:8px">Area</th><th style="padding:8px">Aquifer</th><th style="padding:8px">DFC Target</th><th style="padding:8px">Modeled</th><th style="padding:8px">Status</th><th style="padding:8px">Margin</th></tr></thead><tbody>';
    for (const rec of targetRecords) {
      const tv = (rec.target_values || [])[0];
      let targetVal = null, targetUnit = '';
      if (tv) {
        if (tv.value !== undefined) { targetVal = tv.value; targetUnit = tv.unit; }
        else if (tv.min !== undefined && tv.max !== undefined) { targetVal = (tv.min + tv.max) / 2; targetUnit = tv.unit; }
      }
      const areaResult = hasAreaResults ? resultsByArea.get(areaKey(rec.area)) : null;
      const rowModeledValue = areaResult ? areaResult.value : modeledValue;
      const rowModeledUnit = areaResult ? areaResult.unit : modeledUnit;
      let status = '—', margin = '—', cls = 'muted';
      if (hasAreaResults && !areaResult) {
        status = 'NEEDS AREA RUN';
        cls = 'warn';
      } else if (!canCompare) {
        status = 'NEEDS AREA RUN';
        cls = 'warn';
      } else if (targetVal !== null && rowModeledValue !== null) {
        const diff = rowModeledValue - targetVal;
        margin = `${diff.toFixed(2)} ${targetUnit}`;
        if (rec.metric === 'drawdown' || rec.metric === 'saturated_thickness_or_storage') {
          if (rec.metric === 'drawdown') {
            status = diff <= 0 ? 'MEETS' : 'EXCEEDS';
            cls = diff <= 0 ? 'ok' : 'bad';
          } else {
            status = diff >= 0 ? 'MEETS' : 'BELOW';
            cls = diff >= 0 ? 'ok' : 'bad';
          }
        } else {
          status = diff >= 0 ? 'MEETS' : 'BELOW';
          cls = diff >= 0 ? 'ok' : 'bad';
        }
      }
      html += `<tr style="border-bottom:1px solid var(--line)">
        <td style="padding:8px">${esc(rec.area || 'GMA-wide')}</td>
        <td style="padding:8px">${esc(rec.aquifer || rec.aquifer_system || '')}</td>
        <td style="padding:8px">${targetVal !== null ? `${targetVal} ${targetUnit}` : rec.dfc_statement}</td>
        <td style="padding:8px">${canCompare ? `${rowModeledValue} ${rowModeledUnit}${areaResult ? ' (area)' : ''}` : `${modeledValue} ${modeledUnit} (${modeledScopeLabel})`}</td>
        <td style="padding:8px"><span class="pill ${cls}">${status}</span></td>
        <td style="padding:8px">${margin}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  return html;
}

export async function loadRunHistory() {
  const historyOut = $('historyOut');
  const historyMsg = $('historyMsg');
  if (!historyOut || !historyMsg) return;

  historyMsg.textContent = 'loading…';
  historyOut.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await api('GET', '/runs', undefined, { auth: true });
    const runs = data.runs || [];
    if (!runs.length) {
      historyOut.innerHTML = '<p class="muted">No runs yet. Submit a workflow to see history.</p>';
      historyMsg.textContent = '';
      return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="text-align:left;border-bottom:1px solid var(--line)"><th style="padding:8px">Run ID</th><th style="padding:8px">Plan</th><th style="padding:8px">Status</th><th style="padding:8px">Started</th><th style="padding:8px">Completed</th><th style="padding:8px">Actions</th></tr></thead><tbody>';
    for (const r of runs) {
      html += `<tr style="border-bottom:1px solid var(--line)">
        <td style="padding:8px"><code>${esc(r.id)}</code></td>
        <td style="padding:8px"><code>${esc(r.workflow_plan_id?.slice(0,12) || '—')}</code></td>
        <td style="padding:8px">${statusBadge(r.status)}</td>
        <td style="padding:8px">${formatTime(r.started_at)}</td>
        <td style="padding:8px">${formatTime(r.completed_at)}</td>
        <td style="padding:8px">
          <button class="pill-btn history-detail-btn" data-run-id="${esc(r.id)}">Details</button>
          <button class="pill-btn history-prov-btn" data-run-id="${esc(r.id)}" style="margin-left:6px">Provenance</button>
          <button class="pill-btn history-dfc-btn" data-run-id="${esc(r.id)}" style="margin-left:6px">DFC Results</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
    historyOut.innerHTML = html;
    historyMsg.textContent = `${runs.length} run${runs.length === 1 ? '' : 's'} (${data.total} total)`;
  } catch (e) {
    historyOut.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    historyMsg.textContent = '';
  }
}

export function initHistoryHandlers(runWorkflowForPlan, pollWorkflowRun) {
  // Refresh button
  const refreshBtn = $('refreshHistoryBtn');
  if (refreshBtn) refreshBtn.onclick = loadRunHistory;

  // History table clicks
  const historyOut = $('historyOut');
  if (historyOut) {
    historyOut.addEventListener('click', async e => {
      const btn = e.target.closest('.history-detail-btn');
      if (btn) {
        const runId = btn.dataset.runId;
        try {
          const run = STATE.TOKEN
            ? await api('POST', `/runs/${runId}/poll`, undefined, { auth: true })
            : await api('GET', `/runs/${runId}`, undefined, { auth: true });
          const runOut = $('runOut');
          if (runOut) runOut.innerHTML = `<pre>${esc(JSON.stringify(run, null, 2))}</pre>`;
          const runMsg = $('runMsg');
          if (runMsg) runMsg.textContent = `Run ${runId.slice(0,8)}… details loaded`;
        } catch (err) {
          const runMsg = $('runMsg');
          if (runMsg) runMsg.innerHTML = `<span class="err">${esc(err.message)}</span>`;
        }
        return;
      }
      const provBtn = e.target.closest('.history-prov-btn');
      if (provBtn) {
        const runId = provBtn.dataset.runId;
        try {
          const prov = await api('GET', `/runs/${runId}/provenance`, undefined, { auth: true });
          const events = prov.events || [];
          let html = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="text-align:left;border-bottom:1px solid var(--line)"><th style="padding:8px">Time</th><th style="padding:8px">Event</th><th style="padding:8px">Payload</th></tr></thead><tbody>';
          for (const ev of events) {
            html += `<tr style="border-bottom:1px solid var(--line)">
              <td style="padding:8px">${formatTime(ev.created_at)}</td>
              <td style="padding:8px"><b>${esc(ev.event_type)}</b></td>
              <td style="padding:8px"><pre style="margin:0;max-height:200px;overflow:auto">${esc(JSON.stringify(ev.payload_json, null, 2))}</pre></td>
            </tr>`;
          }
          html += '</tbody></table>';
          const runOut = $('runOut');
          if (runOut) runOut.innerHTML = html;
          const runMsg = $('runMsg');
          if (runMsg) runMsg.textContent = `Provenance for ${runId.slice(0,8)}… (${events.length} events)`;
        } catch (err) {
          const runMsg = $('runMsg');
          if (runMsg) runMsg.innerHTML = `<span class="err">${esc(err.message)}</span>`;
        }
      }
      const dfcBtn = e.target.closest('.history-dfc-btn');
      if (dfcBtn) {
        const runId = dfcBtn.dataset.runId;
        try {
          const run = await api('GET', `/runs/${runId}`, undefined, { auth: true });
          const runOut = $('runOut');
          if (runOut) runOut.innerHTML = renderDfcResults(run);
          const runMsg = $('runMsg');
          if (runMsg) runMsg.textContent = `DFC results for run ${runId.slice(0,8)}…`;
        } catch (err) {
          const runMsg = $('runMsg');
          if (runMsg) runMsg.innerHTML = `<span class="err">${esc(err.message)}</span>`;
        }
      }
    });
  }
}
