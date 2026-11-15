"""Offline browser acceptance of the real atlas / study planner / results journey.

Run: python3 tests/e2e_study_planner.py
No production API, archive query, package install, or job is used. A fail-closed
static server plus browser routes substitute explicit synthetic API fixtures.
This verifies browser state and HTTP contracts, never actual fire/model accuracy.
"""
import argparse
import asyncio
from copy import deepcopy
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import threading
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.async_api import async_playwright, expect

import study_planner_fixtures as fixtures

ROOT = Path(__file__).resolve().parents[1]
STORAGE = 'nasa-space-apps-context-v1'


def local_server():
    class StaticOnly(SimpleHTTPRequestHandler):
        def do_GET(self):
            # Chromium's download-attribute request can bypass Playwright routes.
            # Serve only this explicit constant export fixture, never proxy it.
            if re.fullmatch(r'/api/v1/analyses/[0-9a-f]{32}/export', urlsplit(self.path).path):
                body = b'local_coverage,fixture\nunknown,SYNTHETIC UI ONLY\n'
                self.send_response(200)
                self.send_header('Content-Type', 'text/csv')
                self.send_header('Content-Disposition', 'attachment; filename=nasa-synthetic.csv')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif urlsplit(self.path).path.startswith('/api/'):
                self.send_error(503, 'API must be intercepted by the test')
            else:
                super().do_GET()

        def do_POST(self):
            self.send_error(503, 'No live API or POST forwarding exists in this server')

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(StaticOnly, directory=str(ROOT / 'web')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}'


class MockAPI:
    def __init__(self, report):
        self.report = report
        self.plans = []
        self.posts = []
        self.assessments = []
        self.results = {}
        self.plan_mode = 'normal'
        self.job_mode = 'done'
        self.plan_gate = None
        self.job_gate = None
        self.assessment_error = False
        self.config_error = False
        self.config_gate = None
        self.config_started = asyncio.Event()
        self.unexpected = []
        self.gates = []

    def hold_plan(self):
        self.plan_gate = asyncio.Event()
        self.gates.append(self.plan_gate)
        return self.plan_gate

    def hold_job(self):
        self.job_gate = asyncio.Event()
        self.gates.append(self.job_gate)
        return self.job_gate

    def hold_config(self):
        self.config_gate = asyncio.Event()
        self.gates.append(self.config_gate)
        return self.config_gate

    async def install(self, context):
        await context.route('**/*', self.route)

    async def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        path = parsed.path
        if not parsed.hostname in ('127.0.0.1', 'localhost'):
            self.report['blocked_external_requests'].append(request.url)
            await route.fulfill(status=204, body='')
            return
        if not path.startswith('/api/'):
            await route.continue_()
            return
        entry = {'method': request.method, 'path': path, 'query': parse_qs(parsed.query)}
        self.report['mock_requests'].append(entry)

        async def respond(body, status=200):
            try:
                await route.fulfill(status=status, content_type='application/json', body=json.dumps(body, ensure_ascii=False))
            except Exception as error:
                # AbortController/navigation may cancel an intentionally delayed response.
                if 'closed' not in str(error).lower() and 'invalid interception' not in str(error).lower():
                    raise

        if path == '/api/v1/config':
            self.config_started.set()
            gate = self.config_gate
            if gate:
                await gate.wait()
            if self.config_error:
                return await respond({'error': 'Synthetic config offline'}, 503)
            return await respond(fixtures.settings())
        if path == '/api/fires/range':
            return await respond({'first': '2000-11-01', 'last': '2026-11-14', 'through': '2026-11-14T23:59:00Z',
                                  'platforms': fixtures.PLATFORMS, 'periodDetailDays': 31})
        if path.startswith('/api/fires/'):
            return await respond({'status': 'ok', 'points': [], 'total': 0, 'platforms': fixtures.PLATFORMS,
                                  'date': '2026-11-14', 'grid': 1, 'approximate': False, 'missing': []})
        if path == '/api/v1/world-calendar':
            return await respond({'start': '2020-01-01', 'end': '2025-12-31', 'revision': 'synthetic-ui-fixture',
                                  'monthly': [{'month': '2025-04', 'platform': 'NOAA-20', 'points': 0,
                                               'cells': 0, 'eligible_days': 30, 'anomaly_pct': None}]})
        if path == '/api/v1/study-plan' and request.method == 'POST':
            payload = request.post_data_json
            self.plans.append(deepcopy(payload))
            mode, gate = self.plan_mode, self.plan_gate
            response = fixtures.proposal(payload['config'], payload['question'], payload.get('platform', 'auto'), mode)
            if gate:
                await gate.wait()
            if mode == 'error':
                return await respond({'error': 'Synthetic preflight unavailable. Повторите запрос.'}, 503)
            if mode == 'empty':
                response['options'] = []
                response['recommended_option_id'] = None
            return await respond(response)
        if path == '/api/v1/analyses' and request.method == 'POST':
            payload = request.post_data_json
            self.posts.append(deepcopy(payload))
            identifier = f'{len(self.posts):032x}'
            self.results[identifier] = fixtures.analysis(payload)
            return await respond({'id': identifier, 'status': 'queued', 'message': 'Synthetic queue', 'progress': 0})
        match = re.fullmatch(r'/api/v1/analyses/([0-9a-f]{32})/study-assessment', path)
        if match:
            query = parse_qs(parsed.query)
            self.assessments.append(query)
            if self.assessment_error:
                return await respond({'error': 'Synthetic assessment unavailable'}, 503)
            return await respond(fixtures.assessment(query.get('question', ['anomaly'])[0],
                                                      query.get('platform', ['NOAA-20'])[0],
                                                      query.get('month', ['MISSING'])[0]))
        match = re.fullmatch(r'/api/v1/analyses/([0-9a-f]{32})', path)
        if match:
            result = deepcopy(self.results.get(match[1]))
            mode, gate = self.job_mode, self.job_gate
            if gate:
                await gate.wait()
            if mode == 'error':
                return await respond({'id': match[1], 'status': 'error', 'message': 'Synthetic analysis failed; retry available'})
            if result is None:
                return await respond({'error': 'Synthetic stored result not found'}, 404)
            return await respond({'id': match[1], 'status': 'done', 'progress': 100,
                                  'message': 'Synthetic UI result', 'result': result})
        if re.fullmatch(r'/api/v1/(anomaly-map|maps)/[0-9a-f]{32}', path):
            return await respond({'status': 'ok', 'cells': [], 'grid_km': 10, 'display_grid_km': 10, 'baseline_years': 2})
        if path.endswith('/export'):
            return await route.fulfill(status=200, content_type='text/csv',
                                       headers={'Content-Disposition': 'attachment; filename=nasa-synthetic.csv'},
                                       body='local_coverage,fixture\nunknown,SYNTHETIC UI ONLY\n')
        # The existing atlas automatically requests its separate factor matrix.
        if path.endswith('/matrix'):
            return await respond({'error': 'Synthetic fixture does not compute a factor matrix'}, 503)
        self.unexpected.append(entry)
        return await respond({'error': f'Unexpected synthetic API path: {path}'}, 500)


class Suite:
    def __init__(self, browser, base, output):
        self.browser, self.base, self.output = browser, base, output
        self.report = {'status': 'RUNNING', 'scope': 'SYNTHETIC UI CONTRACT; no scientific validation',
                       'checks': [], 'cases': [], 'javascript_errors': [],
                       'mock_requests': [], 'blocked_external_requests': [], 'production_requests': 0}

    def check(self, condition, label):
        if not condition:
            raise AssertionError(label)
        self.report['checks'].append(label)
        print('PASS', label, flush=True)

    async def new_page(self):
        context = await self.browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        api = MockAPI(self.report)
        await api.install(context)
        page = await context.new_page()
        page.set_default_timeout(10000)
        page.on('pageerror', lambda error: self.report['javascript_errors'].append(str(error)))
        return context, page, api

    def url(self, view='analysis', value=None, **extra):
        params = {'view': view, **extra}
        if value is not None:
            params['state'] = json.dumps({'version': 1, 'context': value}, ensure_ascii=False)
        return self.base + '/?' + urlencode(params)

    async def open_analysis(self, page, value=None):
        value = value or fixtures.context()
        await page.goto(self.url(value=value), wait_until='domcontentloaded')
        await expect(page.locator('#study-question')).to_be_visible()
        await expect(page.locator('#analysis-area-title')).to_have_text(value['roi']['name'])
        await expect(page.locator('#study-plan-request')).to_be_enabled()

    async def propose(self, page, question='anomaly'):
        await page.locator('#study-question').select_option(question)
        await page.locator('#study-plan-request').click()
        await expect(page.locator('#study-plan-options [data-study-apply]').first).to_be_visible()

    async def apply(self, page, option='current-request'):
        await page.locator(f'#study-plan-options [data-option-id="{option}"] [data-study-apply]').click()
        await expect(page.locator('#study-applied')).to_be_visible()

    async def result(self, page, expected='Недостаточно'):
        await page.locator('#run').click()
        await expect(page.locator('#export-csv')).to_be_enabled()
        await expect(page.locator('#study-assessment')).to_be_visible()
        await expect(page.locator('#study-assessment')).to_contain_text(expected)

    async def entry(self, page, api):
        await page.goto(self.base, wait_until='domcontentloaded')
        await expect(page.locator('#world-date')).to_be_enabled()
        self.check(await page.locator('body').get_attribute('data-app-view') == 'atlas', 'A fresh visitor enters the existing global atlas')
        self.check(len(api.posts) == 0, 'A fresh atlas visit creates no analysis job')
        await page.evaluate('window.__qaHeader = document.querySelector("#app-header")')
        await page.locator('.app-nav [data-app-view="analysis"]').click()
        await expect(page.locator('#study-question')).to_be_visible()
        self.check(await page.evaluate('window.__qaHeader === document.querySelector("#app-header")'), 'Atlas and planner keep the same persistent application header')
        self.check(await page.locator('#study-next-step').is_visible(), 'New analysis explains its next step before results exist')
        await page.evaluate('window.scrollTo(0,0)')
        await page.screenshot(path=str(self.output / 'desktop-initial.png'), full_page=True)
        self.check(await page.locator('#study-plan-status').get_attribute('role') == 'status', 'Planner progress is exposed as an accessible status')
        self.check(await page.locator('#analysis-form .step').all_text_contents() == ['1', '2', '3', '4'], 'New study presents ordered territory → question → conditions → calculation steps')
        await page.locator('#preset').select_option('brazil')
        await self.propose(page)
        self.check(api.plans[-1]['platform'] == 'auto', 'A new user can request options before choosing a display platform')
        self.check(not api.posts, 'A proposed automatic source remains an explicit choice before calculation')
        await self.apply(page, 'same-platform-Aqua')
        self.check(await page.locator('#platform').input_value() == 'Aqua', 'Selecting an automatic recommendation applies one explicit source, never a sum')
        await page.locator('#manual-conditions > summary').click()
        await page.locator('#platform').select_option('NOAA-20')
        await self.propose(page)
        self.check(not api.posts, 'Requesting preliminary options does not create an analysis job')
        await expect(page.locator('#study-applied')).to_be_hidden()
        self.check(await page.locator('#study-assessment').is_hidden()
                   and await page.locator('#series-mode option[value="calibrated"]').is_disabled(),
                   'Product metadata cannot display computed admission or enable calibrated output before analysis')
        await page.locator('#study-plan-options .study-option-limitations > summary').first.click()
        text = (await page.locator('#study-plan-options').inner_text()).lower()
        self.check('предваритель' in text and 'неизвест' in text, 'Proposed options disclose preliminary status and inspectable unknown local coverage')
        await page.evaluate('window.scrollTo(0,0)')
        await page.screenshot(path=str(self.output / 'desktop-plan.png'), full_page=True)

    async def transfer(self, page, api):
        for shape in ('circle', 'hole', 'dateline'):
            value = fixtures.context(shape)
            await page.goto(self.url('atlas', value), wait_until='domcontentloaded')
            await expect(page.locator('#world-date')).to_be_enabled()
            await expect(page.locator('#atlas-open-analysis')).to_be_enabled()
            if shape == 'circle':
                await page.locator('.app-nav [data-app-view="analysis"]').click()
            else:
                await page.locator('#atlas-open-analysis').click()
            await expect(page.locator('#study-question')).to_be_visible()
            await expect(page.locator('#study-current-conditions')).to_contain_text(value['platform'])
            await expect(page.locator('#study-current-conditions')).to_contain_text('ночь')
            await self.propose(page)
            payload = api.plans[-1]
            expected = fixtures.config_from_context(value)
            shape_key = 'circle' if 'circle' in expected else 'geometry'
            self.check(payload['config'].get(shape_key) == expected.get(shape_key), f'Atlas → analysis preserves exact {shape} shape including every ring')
            keys = ('start', 'end', 'baseline_start', 'baseline_end', 'quality', 'daynight', 'grid_km')
            differences = {k: {'expected': expected[k], 'actual': payload['config'].get(k)} for k in keys if payload['config'].get(k) != expected[k]}
            self.check(not differences, f'Atlas → analysis preserves {shape} dates, baseline and observation filters: {differences}')
            self.check(payload['platform'] == value['platform'], f'Atlas → analysis preserves {shape} platform')

    async def workflow(self, page, api):
        await self.open_analysis(page)
        self.check(not api.posts, 'A shared planning context restores without silently running a job')
        await self.propose(page, 'anomaly')
        proposed = fixtures.proposal(api.plans[-1]['config'], 'anomaly', api.plans[-1]['platform'])
        chosen = proposed['options'][1]
        self.check(await page.locator('#start').input_value() == '2020-01-01', 'Suggestions do not silently replace the requested history')
        await self.apply(page, chosen['id'])
        self.check(await page.locator('#start').input_value() == chosen['config']['start'], 'Explicit option selection applies its actual history')
        self.check(bool((await page.locator('#study-applied-changes').inner_text()).strip()), 'Changed conditions retain their reasons before launch')
        await self.result(page)
        self.check(api.posts[-1] == chosen['config'], 'Analysis POST exactly matches the explicitly chosen option config')
        self.check(await page.locator('#tab-calendar').get_attribute('aria-selected') == 'true', 'An anomaly question opens the existing calendar tab')
        self.check(await page.locator('#series-mode option[value="calibrated"]').is_disabled(), 'Rejected regional model cannot enable the Aqua scale')
        self.check(api.assessments[-1].get('month') == ['2025-04'], 'Assessment is requested for the actual selected target month')
        self.check('2' in await page.locator('#study-assessment').inner_text() or 'два' in await page.locator('#study-assessment').inner_text(), 'Assessment shows insufficient baseline facts, even with another valid historical month')
        await page.locator('#tab-calendar').click()
        self.check(await page.locator('.calendar-cell').count() > 0, 'Existing calendar renders after planned analysis')
        await page.locator('#focus-month').select_option('2025-01')
        await expect(page.locator('#study-assessment')).to_contain_text('Историческое сравнение доступно')
        self.check(api.assessments[-1].get('month') == ['2025-01'], 'Changing target month refreshes the assessment scope')
        await page.locator('#focus-month').select_option('2025-04')
        await expect(page.locator('#study-assessment')).to_contain_text('Недостаточно')
        await page.locator('#tab-series').click()
        await page.locator('[data-step="day"]').click()
        self.check(await page.locator('#series-chart').is_visible(), 'Existing period detail remains usable after planning')
        await page.locator('#tab-matrix').click()
        self.check(await page.locator('#matrix-panel .matrix-run').is_visible(), 'Existing separate factor matrix remains available')
        await page.locator('#tab-validation').click()
        await expect(page.locator('#validation-summary')).to_contain_text('не допущена')
        post_count = len(api.posts)
        if await page.locator('#manual-conditions').get_attribute('open') is None:
            await page.locator('#manual-conditions > summary').click()
        await page.locator('#platform').select_option('NOAA-21')
        await expect(page.locator('#export-csv')).to_be_enabled()
        await expect(page.locator('#study-assessment')).to_contain_text('Недостаточно')
        self.check(api.assessments[-1].get('platform') == ['NOAA-21'] and len(api.posts) == post_count,
                   'Changing display platform checks its own model without recomputing or summing sources')
        await page.locator('#platform').select_option('all')
        await expect(page.locator('#export-csv')).to_be_disabled()
        await page.locator('#run').click()
        await expect(page.locator('#error-banner')).to_contain_text('Выберите один спутник')
        self.check(len(api.posts) == post_count, 'All-platform selection cannot launch a summed scientific analysis')
        await page.locator('#platform').select_option('NOAA-20')
        await expect(page.locator('#export-csv')).to_be_enabled()
        self.check('Локальная видимость неизвестна' in await page.locator('.quality-bar').inner_text(), 'Unknown local observation coverage stays visible with computed results')
        await page.evaluate('window.scrollTo(0,0)')
        await page.screenshot(path=str(self.output / 'desktop-result.png'), full_page=True)
        with_download = page.expect_download()
        async with with_download as downloaded:
            await page.locator('#export-csv').click()
        filename = (await downloaded.value).suggested_filename
        self.check(filename.startswith('nasa'), 'Existing export remains a NASA download after planning: ' + filename)
        await self.propose(page, 'compare-years')
        await self.apply(page)
        await self.result(page, expected='Историческое сравнение доступно')
        self.check(await page.locator('#tab-compare').get_attribute('aria-selected') == 'true', 'A compare-years question opens the existing comparison tab')

    async def stale(self, page, api):
        await self.open_analysis(page)
        await page.locator('#manual-conditions > summary').click()
        gate = api.hold_plan()
        await page.locator('#study-plan-request').click()
        await expect(page.locator('#study-plan-status')).to_contain_text(re.compile('провер|получ|готов|загру', re.I))
        await page.locator('#end').fill('2024-12-31')
        await page.locator('#end').dispatch_event('change')
        gate.set()
        api.plan_gate = None
        await page.wait_for_timeout(200)
        self.check(await page.locator('#study-plan-options [data-study-apply]').count() == 0, 'A preflight response from previous dates cannot replace the current plan')
        await self.propose(page)
        self.check(api.plans[-1]['config']['end'] == '2024-12-31', 'Retry proposes the current edited dates')
        gate = api.hold_plan()
        await page.locator('#study-plan-request').click()
        await expect(page.locator('#study-plan-options')).to_have_attribute('aria-busy', 'true')
        await page.locator('#study-question').select_option('sensor-transition')
        gate.set()
        api.plan_gate = None
        await page.wait_for_timeout(200)
        self.check(await page.locator('#study-plan-options [data-study-apply]').count() == 0,
                   'A delayed preflight for another question cannot become the current plan')
        await self.propose(page)
        await self.apply(page)
        gate = api.hold_job()
        await page.locator('#run').click()
        await expect(page.locator('#job-banner')).to_be_visible()
        # Changing context in the atlas is possible while the analysis job is pending.
        await page.locator('.app-nav [data-app-view="atlas"]').click()
        await expect(page.locator('#world-date')).to_be_enabled()
        await page.locator('#area-clear').click()
        await page.locator('#reset-map').click()
        await page.locator('.app-nav [data-app-view="analysis"]').click()
        await expect(page.locator('#preset')).to_have_value('sko')
        gate.set()
        api.job_gate = None
        await page.wait_for_timeout(300)
        self.check(await page.locator('#export-csv').is_disabled(), 'A previous ROI job cannot display after a different atlas territory is selected')
        self.check(await page.locator('#preset').input_value() == 'sko', 'Late analysis completion cannot overwrite the current ROI')

    async def persistence(self, page, api, shape='circle'):
        snapshots = []

        async def capture(label):
            value = await page.evaluate("""() => ({url:location.href,history:history.state,
                stored:JSON.parse(localStorage.getItem('nasa-space-apps-context-v1')||'null'),
                dom:{view:document.body.dataset.appView,platform:document.querySelector('#platform')?.value,
                     daynight:document.querySelector('#daynight')?.value,
                     status:document.querySelector('#form-status')?.textContent,
                     exportDisabled:document.querySelector('#export-csv')?.disabled}})""")
            snapshots.append({'label': label, **value})
            filename = 'persistence-snapshots.json' if shape == 'circle' else 'dateline-persistence-snapshots.json'
            (self.output / filename).write_text(json.dumps(snapshots, ensure_ascii=False, indent=2) + '\n')

        value = fixtures.context(shape)
        await self.open_analysis(page, value)
        await self.propose(page, 'sensor-transition')
        await self.apply(page)
        await self.result(page)
        self.check(await page.locator('#tab-validation').get_attribute('aria-selected') == 'true', 'Sensor-transition question opens the existing validation tab')
        count = len(api.posts)
        await capture('result-before-show-atlas')
        await page.locator('#show-atlas').click()
        await expect(page.locator('body')).to_have_attribute('data-app-view', 'atlas')
        await capture('atlas-before-go-back')
        await page.go_back()
        await expect(page.locator('body')).to_have_attribute('data-app-view', 'analysis')
        await expect(page.locator('#study-question')).to_have_value('sensor-transition')
        await page.wait_for_timeout(200)
        await capture('analysis-after-go-back')
        await expect(page.locator('#export-csv')).to_be_enabled()
        await page.go_forward()
        await expect(page.locator('body')).to_have_attribute('data-app-view', 'atlas')
        await page.wait_for_timeout(200)
        await capture('atlas-after-go-forward')
        await page.locator('.app-nav [data-app-view="analysis"]').click()
        await page.wait_for_timeout(200)
        await capture('analysis-after-header-return')
        await expect(page.locator('#export-csv')).to_be_enabled()
        await page.locator('#share').click()
        await page.wait_for_function("new URL(location.href).searchParams.has('state')")
        shared = page.url
        await page.reload(wait_until='domcontentloaded')
        await expect(page.locator('#study-question')).to_be_visible()
        await page.wait_for_timeout(200)
        await capture('analysis-after-shared-reload')
        await expect(page.locator('#export-csv')).to_be_enabled()
        self.check(len(api.posts) == count, 'Back/Forward/reload/share restore an existing result without a new job')
        self.check(await page.locator('#study-question').input_value() == 'sensor-transition', 'Question survives Back/Forward and shared-result reload')
        state = json.loads(parse_qs(urlsplit(shared).query)['state'][0])
        self.check(state['context']['roi']['circle'] == value['roi']['circle'], 'Share retains the exact circle rather than its display bbox')
        fresh_context, fresh, fresh_api = await self.new_page()
        fresh_api.results = deepcopy(api.results)
        try:
            await fresh.goto(shared, wait_until='domcontentloaded')
            await expect(fresh.locator('#export-csv')).to_be_enabled()
            await expect(fresh.locator('#study-question')).to_have_value('sensor-transition')
            self.check(await fresh.locator('#daynight').input_value() == 'N' and not fresh_api.posts,
                       'A shared result restores exact filters and question in a fresh browser context without a new job')
        except Exception:
            await fresh.screenshot(path=str(self.output / 'fresh-share-failure.png'), full_page=True)
            raise
        finally:
            await fresh_context.close()
        identifier = state['analysisId']
        mismatched = deepcopy(api.results[identifier])
        mismatched['config']['circle']['radius_km'] = 26
        api.results[identifier] = mismatched
        await page.goto(shared + '&analysis_id=' + identifier, wait_until='domcontentloaded')
        await expect(page.locator('#error-banner')).to_contain_text(re.compile('друг|соответств|параметр', re.I))
        self.check(await page.locator('#export-csv').is_disabled(), 'Backend config with a different circle is rejected despite the saved job id')
        self.check(await page.locator('#start').input_value() == '2020-01-01', 'Rejected cached result retains the intended scientific inputs')

    async def dateline_persistence(self, page, api):
        await self.persistence(page, api, 'dateline')

    async def errors(self, page, api):
        await self.open_analysis(page)
        for mode in ('error', 'empty', 'no-sp'):
            api.plan_mode = mode
            await page.locator('#study-plan-request').click()
            await page.wait_for_timeout(150)
            if mode == 'error':
                await expect(page.locator('#study-plan-status')).to_contain_text(re.compile('недоступ|unavailable|Повтор', re.I))
            self.check(not api.posts, f'{mode} preflight does not silently launch analysis')
            self.check(await page.locator('#preset').input_value() == 'custom', f'{mode} preflight keeps the chosen ROI')
            self.check(await page.locator('#study-plan-request').is_enabled(), f'{mode} preflight offers retry')
            if mode == 'no-sp':
                await expect(page.locator('#study-plan-options [data-option-id="same-platform-NOAA-20"] [data-study-apply]')).to_be_disabled()
                self.check(await page.locator('#study-plan-options [data-option-id="current-request"]').is_visible(),
                           'Missing SP disables the archive proposal while keeping explicit manual conditions with limitations')
        api.plan_mode = 'normal'
        await self.propose(page)
        await self.apply(page)
        api.job_mode = 'error'
        await page.locator('#run').click()
        await expect(page.locator('#error-banner')).to_contain_text('Synthetic analysis failed')
        self.check(await page.locator('#run').is_enabled(), 'Analysis failure restores an enabled retry action')
        self.check(await page.locator('#preset').input_value() == 'custom', 'Analysis failure preserves the selected ROI')
        api.job_mode = 'done'
        api.assessment_error = True
        await page.locator('#run').click()
        await expect(page.locator('#export-csv')).to_be_enabled()
        await expect(page.locator('#study-assessment-retry')).to_be_visible()
        api.assessment_error = False
        await page.locator('#study-assessment-retry').click()
        await expect(page.locator('#study-assessment')).to_contain_text('Недостаточно')
        self.check(await page.locator('#export-csv').is_enabled(), 'Assessment API retry preserves the completed analysis')

    async def binding(self, page, api):
        for mutation in ('circle', 'hole', 'quality', 'daynight', 'grid', 'dates'):
            value = fixtures.context('circle' if mutation == 'circle' else 'hole')
            candidate = fixtures.analysis(fixtures.config_from_context(value))
            if mutation == 'circle':
                candidate['config']['circle']['radius_km'] += 1
            elif mutation == 'hole':
                candidate['config']['geometry']['coordinates'][1][0][0] += .1
            else:
                key, replacement = {'quality': ('quality', 'all'), 'daynight': ('daynight', 'D'),
                                    'grid': ('grid_km', 20), 'dates': ('start', '2020-02-01')}[mutation]
                candidate['config'][key] = replacement
            api.results[fixtures.JOB_ID] = candidate
            state = {'version': 1, 'context': value, 'analysisId': fixtures.JOB_ID,
                     'study': {'question': 'anomaly', 'stage': 'result'}}
            url = self.base + '/?' + urlencode({'view': 'analysis', 'state': json.dumps(state),
                                               'analysis_id': fixtures.JOB_ID})
            await page.goto(url, wait_until='domcontentloaded')
            await expect(page.locator('#error-banner')).to_contain_text(re.compile('друг|соответств|параметр', re.I))
            self.check(await page.locator('#export-csv').is_disabled(), f'Stored backend result with changed {mutation} is rejected despite matching job id')
            self.check(not api.posts, f'Rejected {mutation} restore never launches a replacement job silently')
        self.check(await page.locator('#study-current-conditions').inner_text() ==
                   'NOAA-20 · 2020-01-01 — 2025-12-31 · база 2020–2023 · 10 км · SP · ночь',
                   'Rejecting backend mismatches preserves the explicitly requested dates and observation filters')

    async def bootstrap(self, page, api):
        api.config_error = True
        value = fixtures.context()
        await page.goto(self.url(value=value), wait_until='domcontentloaded')
        await expect(page.locator('#error-banner')).to_contain_text('Synthetic config offline')
        stored = await page.evaluate("JSON.parse(localStorage.getItem('nasa-space-apps-context-v1'))")
        self.check(stored['context']['roi'].get('geometry') == fixtures.HOLE,
                   'An unavailable initial config API cannot replace the intended polygon with default SKO')
        self.check(stored['context']['daynight'] == 'N' and stored['context']['platform'] == 'NOAA-20',
                   'An unavailable initial config API preserves the intended observation filters')
        api.config_error = False
        await expect(page.locator('#study-config-retry')).to_be_visible()
        await page.locator('#study-config-retry').click()
        await expect(page.locator('#analysis-area-title')).to_have_text(value['roi']['name'])
        await self.propose(page)
        self.check(api.plans[-1]['config']['geometry'] == fixtures.HOLE and not api.posts,
                   'Explicit initial API retry uses the original ROI without silently running a job')

    async def slow_bootstrap(self, page, api):
        gate = api.hold_config()
        value = fixtures.context()
        await page.goto(self.url(value=value), wait_until='domcontentloaded')
        await asyncio.wait_for(api.config_started.wait(), timeout=10)
        await expect(page.locator('#analysis-area-title')).to_have_text(value['roi']['name'])
        self.check(await page.locator('#preset').input_value() == 'custom',
                   'A slow initial config response shows the intended custom territory before archive readiness')
        await expect(page.locator('#study-current-conditions')).to_contain_text('NOAA-20')
        await expect(page.locator('#study-current-conditions')).to_contain_text('ночь')
        self.check(await page.locator('#study-plan-request').is_disabled()
                   and await page.locator('#run').is_disabled(),
                   'Preflight and analysis controls stay disabled while initial config is pending')
        self.check(await page.locator('#analysis-form').get_attribute('aria-busy') == 'true',
                   'Initial archive loading exposes an accessible busy state')
        await page.locator('#share').click()
        await page.wait_for_function("new URL(location.href).searchParams.has('state')")
        draft = json.loads(parse_qs(urlsplit(page.url).query)['state'][0])['context']
        self.check(draft['roi']['geometry'] == fixtures.HOLE
                   and draft['platform'] == 'NOAA-20' and draft['daynight'] == 'N',
                   'A shared draft during slow bootstrap retains the exact polygon and observation filters')
        # Event dispatch additionally verifies the controller guard, independently
        # of native disabled-button behavior, without reaching any live service.
        await page.locator('#study-plan-request').dispatch_event('click')
        await page.locator('#analysis-form').dispatch_event('submit')
        await page.wait_for_timeout(150)
        self.check(not api.plans and not api.posts,
                   'Early planner and submit events cannot issue a wrong-territory preflight or analysis POST')
        gate.set()
        api.config_gate = None
        await expect(page.locator('#study-plan-request')).to_be_enabled()
        await expect(page.locator('#analysis-form')).to_have_attribute('aria-busy', 'false')
        await self.propose(page)
        self.check(api.plans[-1]['config'] == fixtures.config_from_context(value) and not api.posts,
                   'After slow config settles, the first preflight uses the original exact inputs without an automatic job')

    async def mobile_legacy(self, page, api):
        await self.open_analysis(page)
        await page.set_viewport_size({'width': 390, 'height': 900})
        await page.locator('#study-question').focus()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
        self.check(await page.locator('#study-question').input_value() in ('compare-years', 'sensor-transition'), 'Research question is selectable with a keyboard')
        await self.propose(page)
        self.check(not await page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'Proposed conditions fit a 390px viewport without horizontal overflow')
        await self.apply(page)
        await self.result(page)
        self.check(not await page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'Planner and result fit a 390px viewport without horizontal overflow')
        await page.locator('#tab-calendar').focus()
        await page.keyboard.press('ArrowRight')
        self.check(await page.locator('#tab-series').get_attribute('aria-selected') == 'true', 'Existing result tabs support keyboard arrows')
        self.check(bool(await page.locator('#study-assessment').get_attribute('aria-labelledby'))
                   and await page.locator('#study-assessment-summary').get_attribute('role') == 'status',
                   'Computed assessment has an accessible name and live status')
        await page.evaluate('window.scrollTo(0,0)')
        await page.screenshot(path=str(self.output / 'mobile-result.png'), full_page=True)
        await page.goto(self.base + '/atlas.html#kishkenekol-case', wait_until='domcontentloaded')
        await expect(page.locator('body')).to_have_attribute('data-app-view', 'cases')
        await expect(page.locator('#kishkenekol-case')).to_be_visible()
        self.check('Кишкенеколь' in await page.locator('#app-context').inner_text(), 'Legacy atlas case links retain the existing case scope')
        await page.locator('.app-nav [data-app-view="atlas"]').click()
        await expect(page.locator('#open-layers')).to_be_enabled()
        await page.locator('#open-layers').click()
        self.check(await page.locator('#map-layer-controls').is_visible(), 'Existing atlas layer panel still opens after planner navigation')

    async def run(self, cases):
        for name in cases:
            context, page, api = await self.new_page()
            record = {'name': name, 'status': 'RUNNING'}
            self.report['cases'].append(record)
            try:
                await getattr(self, name)(page, api)
                self.check(not api.unexpected, f'{name}: all API requests match explicit offline fixtures')
                record['status'] = 'PASS'
            except Exception as error:
                record.update(status='BLOCK', error=str(error))
                print('BLOCK', name, str(error), flush=True)
                await page.screenshot(path=str(self.output / (name + '-failure.png')), full_page=True)
                (self.output / (name + '-failure.html')).write_text(await page.content())
            finally:
                record['plan_payloads'] = api.plans
                record['analysis_payloads'] = api.posts
                for gate in api.gates:
                    gate.set()
                await context.close()
        if self.report['javascript_errors']:
            self.report['cases'].append({'name': 'javascript', 'status': 'BLOCK', 'errors': self.report['javascript_errors']})
        self.report['status'] = 'PASS' if all(item['status'] == 'PASS' for item in self.report['cases']) else 'BLOCK'
        (self.output / 'report.json').write_text(json.dumps(self.report, ensure_ascii=False, indent=2) + '\n')
        return self.report


async def main(args):
    args.output_dir.mkdir(parents=True, exist_ok=True)
    server, base = local_server()
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                report = await Suite(browser, base, args.output_dir).run(args.case or [
                    'entry', 'transfer', 'workflow', 'stale', 'persistence', 'dateline_persistence',
                    'errors', 'binding', 'bootstrap', 'slow_bootstrap', 'mobile_legacy'])
            finally:
                await browser.close()
    finally:
        server.shutdown()
    cases = [{key: value for key, value in case.items() if key in ('name', 'status', 'error', 'errors')} for case in report['cases']]
    print(json.dumps({'status': report['status'], 'checks': len(report['checks']), 'cases': cases,
                      'report': str(args.output_dir / 'report.json')}, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=Path('/tmp/nasa-study-planner-e2e'))
    parser.add_argument('--case', action='append', choices=['entry', 'transfer', 'workflow', 'stale', 'persistence',
                                                         'dateline_persistence', 'errors', 'binding', 'bootstrap',
                                                         'slow_bootstrap', 'mobile_legacy'])
    raise SystemExit(asyncio.run(main(parser.parse_args())))
