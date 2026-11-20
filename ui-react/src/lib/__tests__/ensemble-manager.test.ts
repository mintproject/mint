/**
 * Tests for the Ensemble Manager REST calls.
 *
 * Regression guard for #85: these assert the outgoing Authorization header, not
 * the localStorage key. The bug was a key read by string literal that nothing
 * wrote, and a conditional spread that dropped the header without erroring — so
 * a test on the storage key would have passed while every call went out
 * anonymous.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { storeTokens } from '@/lib/auth/token-store';
import {
  EnsembleManagerError,
  NO_OUTPUTS_DECLARED,
  ensembleManagerHeaders,
  createExecutionPlan,
  executionEnginePath,
  fetchExecutionFiles,
  fetchExecutionLog,
  fetchRunHistory,
  fetchRunHistoryDetail,
  publishExecution,
  publishResults,
  submitRuns,
  submitExecutionPlan,
  isResultDownload,
  readExecutionFilePrefix,
} from '@/lib/ensemble-manager';

function lastRequest(): [string, RequestInit] {
  const calls = (globalThis.fetch as unknown as Mock).mock.calls;
  return calls[calls.length - 1] as [string, RequestInit];
}

describe('ensemble-manager', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('log line') }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe('ensembleManagerHeaders', () => {
    it('reads the same key token-store writes', () => {
      storeTokens({ accessToken: 'stored-jwt' });
      expect(ensembleManagerHeaders()).toEqual({ Authorization: 'Bearer stored-jwt' });
    });

    it('omits Authorization when no token is stored', () => {
      expect(ensembleManagerHeaders()).toEqual({});
    });

    it('keeps the base headers alongside the credential', () => {
      storeTokens({ accessToken: 'stored-jwt' });
      expect(ensembleManagerHeaders({ 'Content-Type': 'application/json' })).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer stored-jwt',
      });
    });
  });

  describe('executionEnginePath', () => {
    // Regression guard for #88: the app posted every engine to
    // /executionEngines/<engine>, but the Ensemble Manager registers that
    // prefix for Tapis only and keeps the two older backends on their own
    // paths. Submission 404'd before authentication mattered.
    it('routes localex to its own path, not the executionEngines prefix', () => {
      expect(executionEnginePath('localex')).toBe('/executionsLocal');
    });

    it('routes wings to its own path', () => {
      expect(executionEnginePath('wings')).toBe('/executions');
    });

    it('routes tapis under the executionEngines prefix', () => {
      expect(executionEnginePath('tapis')).toBe('/executionEngines/tapis');
    });

    it('routes an unknown engine under the executionEngines prefix', () => {
      expect(executionEnginePath('slurm')).toBe('/executionEngines/slurm');
    });
  });

  describe('submitRuns', () => {
    it('posts to the route the named engine is served on', async () => {
      await submitRuns('http://ensemble', 'localex', { thread_id: 't', model_id: 'm' });
      expect(lastRequest()[0]).toBe('http://ensemble/executionsLocal');
    });

    it('sends the access token as a Bearer header', async () => {
      storeTokens({ accessToken: 'stored-jwt' });
      await submitRuns('http://ensemble', 'tapis', {
        thread_id: 'thread-1',
        model_id: 'model-1',
      });

      const [url, init] = lastRequest();
      expect(url).toBe('http://ensemble/executionEngines/tapis');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        Authorization: 'Bearer stored-jwt',
      });
      expect(JSON.parse(init.body as string)).toEqual({
        thread_id: 'thread-1',
        model_id: 'model-1',
      });
    });

    it('sends no Authorization header when logged out', async () => {
      await submitRuns('http://ensemble', 'tapis', {
        thread_id: 'thread-1',
        model_id: 'model-1',
      });
      expect(lastRequest()[1].headers).not.toHaveProperty('Authorization');
    });

    it('throws on a non-ok response', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({ ok: false, status: 401 });
      await expect(
        submitRuns('http://ensemble', 'tapis', { thread_id: 't', model_id: 'm' }),
      ).rejects.toThrow('Ensemble manager returned 401');
    });
  });

  describe('run history', () => {
    it('reads a bounded history page with encoded filters and auth', async () => {
      storeTokens({ accessToken: 'history-token' });
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ schema_version: 1, runs: [], next_cursor: null }),
      });

      await fetchRunHistory('http://ensemble/v1', 'thread/1', {
        modelId: 'model/1',
        limit: 10,
        cursor: 'cursor/1',
      });

      const [url, init] = lastRequest();
      expect(url).toBe(
        'http://ensemble/v1/threads/thread%2F1/runs?model_id=model%2F1&limit=10&cursor=cursor%2F1',
      );
      expect(init.headers).toMatchObject({ Authorization: 'Bearer history-token' });
    });

    it('reads a detail packet without treating the run key as a path', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ schema_version: 1, run_key: 'opaque' }),
      });

      await fetchRunHistoryDetail('http://ensemble/v1', 'thread/1', 'run/key');
      expect(lastRequest()[0]).toBe('http://ensemble/v1/threads/thread%2F1/runs/run%2Fkey');
    });
  });

  describe('unified execution plans', () => {
    it('creates an Ensemble Manager plan through the public plan boundary', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            plan_id: 'em_plan',
            executor: 'ensemble_manager',
            version: 1,
            status: 'ready',
            parameters: [],
            parameter_values: {},
          }),
      });

      const plan = await createExecutionPlan('http://ensemble/v1', {
        executor: 'ensemble_manager',
        thread_id: 'thread-1',
        model_id: 'model-1',
        execution_engine: 'tapis',
      });

      expect(plan.plan_id).toBe('em_plan');
      expect(lastRequest()[0]).toBe('http://ensemble/v1/plans');
      expect(JSON.parse(lastRequest()[1].body as string)).toMatchObject({
        executor: 'ensemble_manager',
        thread_id: 'thread-1',
      });
    });

    it('submits adapter parameter values through the same public boundary', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: true,
        status: 202,
        json: () => Promise.resolve({ child_execution_id: 'run-1' }),
      });

      await submitExecutionPlan('http://ensemble/v1', {
        plan_id: 'svo_plan',
        parameter_values: { start_date: '2024-01-01' },
      });

      expect(lastRequest()[0]).toBe('http://ensemble/v1/plans/submit');
      expect(JSON.parse(lastRequest()[1].body as string)).toEqual({
        plan_id: 'svo_plan',
        parameter_values: { start_date: '2024-01-01' },
      });
    });

    it('serializes structured server errors instead of displaying [object Object]', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: false,
        status: 422,
        json: () =>
          Promise.resolve({
            code: 'COMPONENT_CONTRACT_MISMATCH',
            message: { app_input: 'mf6-nam', model_inputs: ['simulation archive'] },
          }),
      });

      await expect(
        submitExecutionPlan('http://ensemble/v1', { plan_id: 'em_plan' }),
      ).rejects.toMatchObject({
        status: 422,
        code: 'COMPONENT_CONTRACT_MISMATCH',
        message:
          'Ensemble manager returned 422: {"app_input":"mf6-nam","model_inputs":["simulation archive"]}',
      });
    });
  });

  describe('publishResults', () => {
    const ids = { problemStatementId: 'ps-1', taskId: 'task-1', threadId: 'thread-1' };

    it('posts to the subtask outputs route the legacy UI calls', async () => {
      await publishResults('http://ensemble', ids);
      expect(lastRequest()[0]).toBe(
        'http://ensemble/problemStatements/ps-1/tasks/task-1/subtasks/thread-1/outputs',
      );
      expect(lastRequest()[1].method).toBe('POST');
    });

    it('sends the access token as a Bearer header', async () => {
      storeTokens({ accessToken: 'stored-jwt' });
      await publishResults('http://ensemble', ids);
      expect(lastRequest()[1].headers).toMatchObject({
        'Content-Type': 'application/json',
        Authorization: 'Bearer stored-jwt',
      });
    });

    it("surfaces the server's own message, so a dead credential is not a bare 400", async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'No executions found to publish' }),
      });
      await expect(publishResults('http://ensemble', ids)).rejects.toThrow(
        'Ensemble manager returned 400: No executions found to publish',
      );
    });

    it('still reports the status when the body carries no message', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
      });
      await expect(publishResults('http://ensemble', ids)).rejects.toThrow(
        'Ensemble manager returned 500',
      );
    });

    // The status alone does not say what to do. 422 NO_OUTPUTS_DECLARED names a
    // missing declaration the user repairs by promoting a file, and the Results
    // step branches on the code to offer that instead of the raw text (#267).
    it("carries the server's own error code", async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: false,
        status: 422,
        json: () =>
          Promise.resolve({
            code: 'NO_OUTPUTS_DECLARED',
            message: 'The model configuration declares no output',
          }),
      });
      await expect(publishResults('http://ensemble', ids)).rejects.toMatchObject({
        status: 422,
        code: NO_OUTPUTS_DECLARED,
      });
    });

    it('throws an EnsembleManagerError, so a caller can read the code off it', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'nope' }),
      });
      await expect(publishResults('http://ensemble', ids)).rejects.toBeInstanceOf(
        EnsembleManagerError,
      );
    });

    it('leaves the code undefined when the server sends none', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'nope' }),
      });
      await expect(publishResults('http://ensemble', ids)).rejects.toMatchObject({
        code: undefined,
      });
    });
  });

  describe('publishExecution', () => {
    const ids = { problemStatementId: 'ps-1', taskId: 'task-1', threadId: 'thread-1' };

    it('posts to the outputs route of one execution', async () => {
      await publishExecution('http://ensemble', ids, 'exec-1');
      expect(lastRequest()[0]).toBe(
        'http://ensemble/problemStatements/ps-1/tasks/task-1/subtasks/thread-1' +
          '/executions/exec-1/outputs',
      );
      expect(lastRequest()[1].method).toBe('POST');
    });

    it('sends the access token as a Bearer header', async () => {
      storeTokens({ accessToken: 'stored-jwt' });
      await publishExecution('http://ensemble', ids, 'exec-1');
      expect(lastRequest()[1].headers).toMatchObject({ Authorization: 'Bearer stored-jwt' });
    });

    it('escapes an id that carries slashes, so it stays one path segment', async () => {
      await publishExecution('http://ensemble', ids, 'mint://exec/1');
      expect(lastRequest()[0]).toContain('/executions/mint%3A%2F%2Fexec%2F1/outputs');
    });

    it('carries the 422 code, so the dialog can ask for a promotion', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ code: 'NO_OUTPUTS_DECLARED', message: 'no outputs' }),
      });
      await expect(publishExecution('http://ensemble', ids, 'exec-1')).rejects.toMatchObject({
        code: NO_OUTPUTS_DECLARED,
      });
    });
  });

  describe('fetchExecutionFiles', () => {
    it('reads the files of one execution', async () => {
      const files = [{ name: 'out.tif', path: 'output/out.tif', size: 12, url: 'tapis://x' }];
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ files }),
      });
      storeTokens({ accessToken: 'stored-jwt' });

      await expect(fetchExecutionFiles('http://ensemble', 'exec-1')).resolves.toEqual(files);
      const [url, init] = lastRequest();
      expect(url).toBe('http://ensemble/executions/exec-1/files');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer stored-jwt' });
    });

    // An archive that holds nothing is not an error: the run may still be on
    // its way, and the server answers 200 with an empty list.
    it('answers an empty list when the archive holds nothing', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ files: [] }),
      });
      await expect(fetchExecutionFiles('http://ensemble', 'exec-1')).resolves.toEqual([]);
    });

    it('answers an empty list when the body carries no files key', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
      await expect(fetchExecutionFiles('http://ensemble', 'exec-1')).resolves.toEqual([]);
    });

    it('forwards the abort signal', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ files: [] }),
      });
      const ctrl = new AbortController();
      await fetchExecutionFiles('http://ensemble', 'exec-1', ctrl.signal);
      expect(lastRequest()[1].signal).toBe(ctrl.signal);
    });

    it("surfaces the server's own message", async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'This instance runs localex' }),
      });
      await expect(fetchExecutionFiles('http://ensemble', 'exec-1')).rejects.toThrow(
        'Ensemble manager returned 400: This instance runs localex',
      );
    });
  });

  describe('fetchExecutionLog', () => {
    it('sends the access token as a Bearer header', async () => {
      storeTokens({ accessToken: 'stored-jwt' });
      const text = await fetchExecutionLog('http://ensemble', 'exec-1');

      const [url, init] = lastRequest();
      expect(url).toBe('http://ensemble/executions/exec-1/logs');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer stored-jwt' });
      expect(text).toBe('log line');
    });

    it('sends no Authorization header when logged out', async () => {
      await fetchExecutionLog('http://ensemble', 'exec-1');
      expect(lastRequest()[1].headers).not.toHaveProperty('Authorization');
    });

    it('forwards the abort signal', async () => {
      const ctrl = new AbortController();
      await fetchExecutionLog('http://ensemble', 'exec-1', ctrl.signal);
      expect(lastRequest()[1].signal).toBe(ctrl.signal);
    });

    it('throws on a non-ok response', async () => {
      (globalThis.fetch as unknown as Mock).mockResolvedValue({ ok: false, status: 404 });
      await expect(fetchExecutionLog('http://ensemble', 'exec-1')).rejects.toThrow('HTTP 404');
    });
  });
});

describe('isResultDownload', () => {
  const folder = { name: 'Run folder', url: 'tapis://sys/home/u/out', kind: 'folder' as const };
  const file = { name: 'Report', url: 'tapis://sys/home/u/out/summary.md', kind: 'file' as const };

  it('offers a result file, what is inside a result folder, and files beside a result file', () => {
    expect(isResultDownload('tapis://sys/home/u/out/summary.md', [file])).toBe(true);
    expect(isResultDownload('tapis://sys/home/u/out/tables/a.csv', [folder])).toBe(true);
    expect(isResultDownload('tapis://sys/home/u/out/counts.csv', [file])).toBe(true);
  });

  it('does not offer a file outside the results', () => {
    expect(isResultDownload('tapis://sys/home/u/other/a.csv', [folder])).toBe(false);
    expect(isResultDownload('tapis://sys/home/u/outside.csv', [folder])).toBe(false);
    expect(isResultDownload('tapis://other/home/u/out/a.csv', [folder])).toBe(false);
    expect(isResultDownload('tapis://sys/home/u/out/a.csv', [])).toBe(false);
    expect(isResultDownload('https://example.org/a.csv', [folder])).toBe(false);
  });
});

describe('readExecutionFilePrefix', () => {
  const file = { systemId: 'cloud.data', path: 'home/u/out/report.md' };

  function streamed(chunks: Uint8Array[]) {
    let at = 0;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn(async () =>
      at < chunks.length ? { done: false, value: chunks[at++] } : { done: true, value: undefined },
    );
    return {
      cancel,
      read,
      response: { ok: true, status: 200, body: { getReader: () => ({ read, cancel }) } },
    };
  }

  beforeEach(() => {
    localStorage.clear();
    storeTokens({ accessToken: 'tok' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('asks the download route with the same token, and stops reading at the cap', async () => {
    const chunks = [new Uint8Array(60), new Uint8Array(60), new Uint8Array(60)];
    const s = streamed(chunks);
    const fetchMock = vi.fn().mockResolvedValue(s.response);
    vi.stubGlobal('fetch', fetchMock);

    const out = await readExecutionFilePrefix('http://em', 'exec-1', file, 100);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://em/executions/exec-1/files/content?path=home%2Fu%2Fout%2Freport.md&systemId=cloud.data',
    );
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(out.bytes).toHaveLength(100);
    expect(out.truncated).toBe(true);
    // The third chunk was never pulled, and the body was cancelled.
    expect(s.read).toHaveBeenCalledTimes(2);
    expect(s.cancel).toHaveBeenCalled();
  });

  it('returns a small file whole and untruncated', async () => {
    const s = streamed([new TextEncoder().encode('hello')]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(s.response));
    const out = await readExecutionFilePrefix('http://em', 'exec-1', file, 100);
    expect(new TextDecoder().decode(out.bytes)).toBe('hello');
    expect(out.truncated).toBe(false);
    expect(s.cancel).not.toHaveBeenCalled();
  });

  it('falls back to a whole read, keeping the start, when the body is not a stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['abcdefghij']) }),
    );
    const out = await readExecutionFilePrefix('http://em', 'exec-1', file, 4);
    expect(new TextDecoder().decode(out.bytes)).toBe('abcd');
    expect(out.truncated).toBe(true);
  });

  it('rejects like a download does when the route refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'raw' }) }),
    );
    await expect(readExecutionFilePrefix('http://em', 'exec-1', file, 100)).rejects.toThrow(
      'Your account cannot read this file in Tapis storage.',
    );
  });
});
