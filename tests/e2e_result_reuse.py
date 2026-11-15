"""Offline browser checks for analysis/matrix reuse. No live API is contacted.

Run: python3 tests/e2e_result_reuse.py
Synthetic fixtures verify request and lifecycle contracts, not scientific output.
"""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from urllib.parse import urlencode

from playwright.async_api import async_playwright, expect

from e2e_study_planner import MockAPI, local_server
import study_planner_fixtures as fixtures

ROOT = Path(__file__).resolve().parents[1]


def matrix_result(identifier, analysis):
    return {key: deepcopy(analysis[key]) for key in ('config', 'extract_id', 'snapshot_at')} | {
        'analysis_id': identifier, 'platforms': ['NOAA-20', 'NOAA-21'],
        'time_factors': [], 'space_factors': [], 'warnings': [], 'warnings_sources': [],
    }


class CachedAPI(MockAPI):
    def __init__(self, report):
        super().__init__(report)
        self.keys = {}
        self.matrix_posts = []
        self.matrix_results = {}
        self.analysis_gets = 0
        self.matrix_gets = 0
        self.post_started = asyncio.Event()
        self.post_gate = None
        self.post_error = False
        self.compact_analysis = False
        self.compact_matrix = False
        self.matrix_gate = None
        self.matrix_queued = False
        self.matrix_get_gate = None

    async def route(self, route):
        request = route.request
        path = urlsplit(request.url).path
        if path == '/api/v1/analyses' and request.method == 'POST':
            config = request.post_data_json
            self.posts.append(deepcopy(config))
            if self.post_error:
                return await route.fulfill(status=503, content_type='application/json',
                                           body=json.dumps({'error': 'Synthetic cache offline'}))
            key = json.dumps({key: value for key, value in config.items()
                              if key not in ('roi_name', 'roi_source')}, sort_keys=True)
            hit = key in self.keys
            if not hit:
                identifier = f'{len(self.keys)+1:032x}'
                self.keys[key] = identifier
                stored = deepcopy(config)
                stored['roi_name'] = 'Original archived label'
                self.results[identifier] = fixtures.analysis(stored)
            identifier = self.keys[key]
            self.post_started.set()
            if self.post_gate:
                await self.post_gate.wait()
            try:
                response = {
                    'id': identifier, 'status': 'done', 'progress': 100,
                    'result': self.results[identifier], 'cache_hit': hit,
                }
                if self.compact_analysis:
                    response.pop('result')
                return await route.fulfill(content_type='application/json', body=json.dumps(response))
            except Exception as error:
                if 'closed' not in str(error).lower() and 'invalid interception' not in str(error).lower():
                    raise
                return
        if re.fullmatch('/api/v1/analyses/[0-9a-f]{32}', path):
            self.analysis_gets += 1
        match = re.fullmatch('/api/v1/analyses/([0-9a-f]{32})/matrix', path)
        if match:
            self.matrix_posts.append(match[1])
            identifier = match[1]
            self.matrix_results[identifier] = matrix_result(identifier, self.results[identifier])
            if self.matrix_gate:
                await self.matrix_gate.wait()
            response = {'id': identifier, 'status': 'queued'} if self.matrix_queued else {
                'id': identifier, 'status': 'done', 'result': self.matrix_results[identifier]}
            if self.compact_matrix:
                response.pop('result', None)
            return await route.fulfill(content_type='application/json', body=json.dumps(response))
        match = re.fullmatch('/api/v1/matrices/([0-9a-f]{32})', path)
        if match:
            self.matrix_gets += 1
            if self.matrix_get_gate:
                await self.matrix_get_gate.wait()
            return await route.fulfill(content_type='application/json', body=json.dumps({
                'id': match[1], 'status': 'done', 'result': self.matrix_results[match[1]],
            }))
        if path.startswith('/data/world-atlas.'):
            return await route.fulfill(status=404, body='No synthetic world snapshot')
        return await super().route(route)


async def matrix_checks(browser, origin):
    page = await browser.new_page()
    await page.route('**/cache-harness', lambda route: route.fulfill(
        content_type='text/html', body='<div id="matrix"></div>'))
    await page.goto(origin + '/cache-harness')
    config = fixtures.config_from_context(fixtures.context())
    analysis = fixtures.analysis(config)
    await page.evaluate('''async ({analysis,snapshot})=>{
      const {mountMatrixPanel}=await import('/matrix-panel.js');
      window.current={id:'a'.repeat(32),result:analysis,platform:'NOAA-20'};
      window.counts={post:0,get:0};window.snapshot=snapshot;window.events=[];
      window.newGate=()=>window.gate=new Promise(resolve=>window.release=resolve);
      window.newGate();
      window.panel=mountMatrixPanel(document.querySelector('#matrix'),{
        getAnalysis:()=>window.current,
        onDataChange:event=>window.events.push({id:event.id,analysisId:event.analysisId,busy:event.busy}),
        request:async(path,options)=>{
          if(options?.method==='POST'){
            window.counts.post++;const response=structuredClone(window.snapshot);
            await window.gate;return {id:response.analysis_id,status:'done',result:response,cache_hit:true};
          }
          window.counts.get++;return {id:window.snapshot.analysis_id,status:'done',result:window.snapshot};
        }
      });
      window.calls=[window.panel.start(),window.panel.start()];
    }''', {'analysis': analysis, 'snapshot': matrix_result(fixtures.JOB_ID, analysis)})
    assert await page.evaluate('counts.post') == 1, 'Concurrent starts must share one POST'
    await page.evaluate('async()=>{release();await Promise.all(calls);await panel.start()}')
    assert await page.evaluate('counts') == {'post': 1, 'get': 0}, 'A ready POST and reopening need no GET/recalculation'
    await page.evaluate('async()=>{await panel.start({refresh:true})}')
    assert await page.evaluate('counts.post') == 2, 'Explicit refresh checks the server'
    await page.evaluate('''async()=>{
      snapshot.warnings_sources=['Synthetic weather unavailable'];
      await panel.start({refresh:true});await panel.start();
    }''')
    assert await page.evaluate('counts.post') == 4, 'Partial-source results remain retryable'
    await page.evaluate('''()=>{
      panel.reset();newGate();snapshot.warnings_sources=[];
      window.old=panel.start();panel.reset();window.returned=panel.start();
    }''')
    assert await page.evaluate('counts.post') == 5, 'Reset before POST returns must still share the in-flight request'
    await page.evaluate('async()=>{release();await Promise.all([old,returned])}')
    assert await page.evaluate('Boolean(panel.getState().result)')
    await page.evaluate('''()=>{
      panel.reset();newGate();window.old=panel.start();
      window.current={...current,id:'d'.repeat(32),result:{...current.result,
        config:{...current.result.config,daynight:'D'}}};
      panel.reset();window.snapshot={...snapshot,analysis_id:current.id,config:current.result.config};
      window.latest=panel.start();
    }''')
    await page.evaluate('async()=>{release();await Promise.all([old,latest])}')
    assert await page.evaluate('panel.getState().result.config.daynight') == 'D', 'Late old requests cannot replace changed inputs'
    assert await page.evaluate('events.some(event=>event.analysisId&&event.id)')
    await page.close()
    print('PASS matrix duplicate starts, ready cache response, explicit refresh, partial retry, reset and stale response', flush=True)


async def make_page(browser, origin, kind):
    context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
    report = {'blocked_external_requests': [], 'mock_requests': []}
    api = CachedAPI(report)
    await api.install(context)
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    if kind == 'workbench':
        html = ''.join(f'<link rel="stylesheet" href="/{name}">' for name in
                       ('vendor/leaflet.css', 'workbench.css', 'matrix-panel.css'))
        html += '<script src="/vendor/leaflet.js"></script><div id="root">' + (ROOT / 'web/analysis-view.html').read_text() + '</div>'
    else:
        html = re.sub(r'<script\b[^>]*>.*?</script>', '', (ROOT / 'web/atlas.html').read_text(), flags=re.S)
    await page.route('**/cache-harness', lambda route: route.fulfill(content_type='text/html', body=html))
    await page.goto(origin + '/cache-harness')
    return context, page, api, errors


async def workbench_checks(browser, origin):
    context, page, api, errors = await make_page(browser, origin, 'workbench')
    value = fixtures.context()
    await page.evaluate('''async value=>{
      const {mountWorkbench}=await import('/workbench.js');
      window.workbench=mountWorkbench(document.querySelector('#root'));
      await workbench.activate({context:value,run:true});
    }''', value)
    await expect(page.locator('#export-csv')).to_be_enabled()
    assert api.analysis_gets == 0, 'A completed analysis POST must be displayed immediately'
    assert await page.locator('#analysis-area-title').inner_text() == value['roi']['name'], 'Cached display labels must not rename the current ROI'
    saved = await page.evaluate('workbench.getState()')
    await page.evaluate('''()=>{
      document.dispatchEvent(new CustomEvent('nasa:analysis-settings',{detail:{step:'conditions'}}));
      document.querySelector('#analysis-form').requestSubmit();
    }''')
    await expect(page.locator('#form-status')).to_contain_text('из кэша')
    assert len(api.posts) == 2, 'Explicit Run must revalidate current source versions on the server'
    assert api.analysis_gets == 0
    await page.evaluate('''async value=>{
      workbench.deactivate();await workbench.activate({context:value.context,state:value});
    }''', saved)
    assert len(api.posts) == 2 and api.analysis_gets == 0, 'View return reuses the matching resident snapshot'
    other = deepcopy(value)
    other['daynight'] = 'D'
    await page.evaluate('async value=>{await workbench.activate({context:value,run:true})}', other)
    assert len(api.posts) == 3
    await page.evaluate('async value=>{await workbench.activate({context:value.context,state:value})}', saved)
    assert len(api.posts) == 3 and api.analysis_gets == 1, 'A→B→A restores historical A without a new calculation'
    assert await page.evaluate('workbench.getState().context.daynight') == 'N'
    api.post_error = True
    await page.evaluate('''()=>{
      document.dispatchEvent(new CustomEvent('nasa:analysis-settings',{detail:{step:'conditions'}}));
      document.querySelector('#analysis-form').requestSubmit();
    }''')
    await expect(page.locator('#error-banner')).to_contain_text('Synthetic cache offline')
    await expect(page.locator('#export-csv')).to_be_enabled()
    assert await page.evaluate('workbench.getState().analysisId') == saved['analysisId'], 'A failed refresh must keep the previous immutable result usable'
    api.post_error = False
    api.compact_analysis = api.compact_matrix = True
    previous_posts, previous_gets = len(api.posts), api.analysis_gets
    await page.evaluate('''()=>{
      document.dispatchEvent(new CustomEvent('nasa:analysis-settings',{detail:{step:'conditions'}}));
      document.querySelector('#analysis-form').requestSubmit();
    }''')
    await expect(page.locator('#form-status')).to_contain_text('из кэша')
    assert len(api.posts) == previous_posts + 1 and api.analysis_gets == previous_gets + 1, 'Compact done cache hits need exactly one GET and no extra POST'
    await page.evaluate("document.querySelector('#matrix-panel .matrix-run').click()")
    await page.wait_for_function("document.querySelector('#matrix-panel .matrix-status').textContent.startsWith('Матрица готова')")
    assert len(api.matrix_posts) == api.matrix_gets == 1, 'A compact matrix response needs one GET and no extra POST'
    assert not errors, errors
    await context.close()
    print('PASS workbench ready cache hit, explicit freshness check, view return, A→B→A and current ROI label', flush=True)


async def atlas_checks(browser, origin):
    context, page, api, errors = await make_page(browser, origin, 'atlas')
    roi = fixtures.context()['roi']
    await page.evaluate('''async roi=>{
      const {createAtlasStudy}=await import('/atlas-study.js');
      window.study=createAtlasStudy(document,()=> 'NOAA-20',()=>{});
      study.setScope(roi);study.setArchive({first:'2000-11-01',last:'2026-11-14'});
      study.show('#external-factors');
    }''', roi)
    await page.wait_for_function("document.querySelector('#external-factors .matrix-status').textContent.startsWith('Матрица готова')")
    assert len(api.posts) == len(api.matrix_posts) == 1
    assert api.analysis_gets == api.matrix_gets == 0
    renamed = {**roi, 'name': 'New display label', 'source': 'New display description'}
    await page.evaluate('roi=>study.setScope(roi)', renamed)
    await page.wait_for_function("document.querySelector('#external-factors .matrix-status').textContent.startsWith('Матрица готова')")
    assert len(api.posts) == len(api.matrix_posts) == 1, 'Display metadata must not trigger a new scientific calculation'
    other = deepcopy(roi)
    other['bbox'][0] -= 1
    await page.evaluate('roi=>study.setScope(roi)', other)
    await page.wait_for_function("document.querySelector('#external-factors .matrix-status').textContent.startsWith('Матрица готова')")
    assert len(api.posts) == len(api.matrix_posts) == 2
    await page.evaluate('roi=>study.setScope(roi)', roi)
    await page.wait_for_function("document.querySelector('#external-factors .matrix-status').textContent.startsWith('Матрица готова')")
    assert len(api.posts) == len(api.matrix_posts) == 2, 'Atlas A→B→A restores both results without POST'
    # Leave and return while the server already knows a matrix ID but its result
    # is not ready. Both visits must poll the same immutable job.
    api.matrix_queued = True
    api.matrix_get_gate = asyncio.Event()
    pending = deepcopy(roi)
    pending['bbox'][0] -= 2
    await page.evaluate('roi=>study.setScope(roi)', pending)
    await page.wait_for_function("document.querySelector('#external-factors .matrix-progress').hidden===false")
    while api.matrix_gets < 3:
        await asyncio.sleep(.02)
    count = len(api.matrix_posts)
    await page.evaluate('roi=>study.setScope(roi)', roi)
    await page.evaluate('roi=>study.setScope(roi)', pending)
    await page.wait_for_timeout(750)
    assert len(api.matrix_posts) == count, 'Returning resumes a known in-flight matrix ID'
    api.matrix_get_gate.set()
    await page.wait_for_function("document.querySelector('#external-factors .matrix-status').textContent.startsWith('Матрица готова')")
    assert not errors, errors
    await context.close()
    print('PASS atlas direct ready responses, labels excluded from key and A→B→A', flush=True)


async def history_checks(browser, origin):
    context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
    report = {'blocked_external_requests': [], 'mock_requests': []}
    api = CachedAPI(report)
    await api.install(context)
    page = await context.new_page()
    value = fixtures.context()
    url = origin + '/?' + urlencode({'view': 'analysis', 'state': json.dumps({'version': 1, 'context': value})})
    await page.goto(url)
    await expect(page.locator('#study-plan-request')).to_be_enabled()
    await page.evaluate('''()=>{
      document.dispatchEvent(new CustomEvent('nasa:analysis-settings',{detail:{step:'conditions'}}));
      document.querySelector('#analysis-form').requestSubmit();
    }''')
    await expect(page.locator('#export-csv')).to_be_enabled()
    assert len(api.posts) == 1
    api.compact_matrix = True
    await page.evaluate("document.querySelector('#matrix-panel .matrix-run').click()")
    await page.wait_for_function("document.querySelector('#matrix-panel .matrix-controls').hidden===false")
    matrix_id = await page.evaluate("history.state.snapshot.states.analysis.matrixId")
    assert matrix_id, 'Matrix ID publishes must update this history entry'
    await page.reload()
    await expect(page.locator('#export-csv')).to_be_enabled()
    assert len(api.posts) == 1, 'Reload of the original shared URL must retain the completed analysis ID'
    await page.wait_for_function("document.querySelector('#matrix-panel .matrix-controls').hidden===false")
    assert len(api.matrix_posts) == 1, 'Reload must restore the existing matrix ID without another POST'
    original_id = await page.evaluate("history.state.snapshot.states.analysis.analysisId")
    assert original_id, 'Analysis ID publishes must update this history entry'
    await page.locator('#app-header a[data-app-view="atlas"]').last.click()
    await expect(page.locator('body')).to_have_attribute('data-app-view', 'atlas')
    await page.go_back()
    await expect(page.locator('#export-csv')).to_be_enabled()
    assert len(api.posts) == 1, 'Back must reopen a historical result without rerunning'
    await page.go_forward()
    await expect(page.locator('body')).to_have_attribute('data-app-view', 'atlas')
    await page.locator('#app-header a[data-app-view="analysis"]').click()
    await expect(page.locator('#export-csv')).to_be_enabled()
    assert len(api.posts) == 1
    await page.reload()
    await expect(page.locator('#export-csv')).to_be_enabled()
    assert len(api.posts) == 1, 'Refresh on the normal analysis URL must restore the saved ID'
    other = fixtures.context('circle')
    other['roi']['name'] = 'Fresh copied California URL'
    copied_url = origin + '/?' + urlencode({'view': 'analysis', 'state': json.dumps({'version': 1, 'context': other})})
    copied = await context.new_page()
    await copied.goto(copied_url)
    await expect(copied.locator('#analysis-area-title')).to_have_text(other['roi']['name'])
    await expect(copied.locator('#export-csv')).to_be_disabled()
    assert len(api.posts) == 1, 'A newly opened different URL must obey its explicit ROI without starting a calculation'
    await copied.wait_for_function("Boolean(history.state?.snapshot?.states?.analysis?.context?.roi?.circle)")
    assert await copied.evaluate("history.state.snapshot.states.analysis.context.roi.circle") == other['roi']['circle']
    await context.close()
    print('PASS shell Back, Forward and reload without new analysis jobs', flush=True)


async def main():
    server, origin = local_server()
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            await matrix_checks(browser, origin)
            await workbench_checks(browser, origin)
            await atlas_checks(browser, origin)
            await history_checks(browser, origin)
            await browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    asyncio.run(main())
