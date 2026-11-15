"""Isolated browser regression for atlas study state and cached-result ownership.

All API/data responses are explicit fixtures; no production API or calculation is used.
Run: python3 tests/e2e_atlas_study_state.py
Reproduce the pre-fix UI: python3 tests/e2e_atlas_study_state.py --source-ref 4c1b3be

The local HTTP server exposes existing shell capture/share/navigate functions with a
test-only appended export. It does not change their implementations or product files.
"""
import argparse
import asyncio
from copy import deepcopy
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path, PurePosixPath
import subprocess
import threading
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
STORAGE_KEY = 'nasa-space-apps-context-v1'
SNAPSHOT = '2026-11-14T12:00:00Z'
SETTINGS = dict(start='2020-04-01', end='2023-10-31', baseline_start=2020,
                baseline_end=2022, platform='Aqua')
OTHER_SETTINGS = dict(start='2021-01-01', end='2024-12-31', baseline_start=2021,
                      baseline_end=2023, platform='NOAA-20')
SOURCES = ['Aqua', 'NOAA-20']


def roi(name, bbox):
    w, s, e, n = bbox
    return dict(preset='custom', name=name, bbox=bbox, source='Explicit browser fixture',
                geometry=dict(type='Polygon', coordinates=[[[w,s],[e,s],[e,n],[w,n],[w,s]]]))


ROI_A = roi('California test territory', [-124,32,-114,42])
ROI_B = roi('Brazil test territory', [-60,-18,-50,-8])
WORLD_CONFIG = dict(preset='world', bbox=[-180,-85,180,85], start='2022-01-01',
                    end='2025-12-31', baseline_start=2022, baseline_end=2024,
                    grid_km=250, quality='sp', daynight='all')


def monthly(config, sentinel):
    rows = []
    for year in range(int(config['start'][:4]), int(config['end'][:4]) + 1):
        for month in range(1, 13):
            key = f'{year}-{month:02}'
            if not config['start'][:7] <= key <= config['end'][:7]:
                continue
            for platform in SOURCES:
                rows.append(dict(month=key, platform=platform, cells=sentinel, points=sentinel*2,
                                 eligible_days=30, calendar_days=30, anomaly_pct=10,
                                 preliminary=False, partial=False, nrt_points=0))
    return rows


def analysis(config, identifier):
    config = deepcopy(config)
    if config['preset'] == 'world':
        config.update(bbox=[-180,-85,180,85], grid_km=250)
    sentinel = 22222 if config.get('bbox', [0])[0] == ROI_B['bbox'][0] else 11111
    return dict(id=identifier, result=dict(config=config, extract_id='extract-'+identifier,
                snapshot_at=SNAPSHOT, monthly=monthly(config, sentinel), warnings=[]))


def matrix(parent, identifier):
    config = parent['result']['config']
    factors = [dict(id='fire', label='Recorded activity', short='Activity', unit='cell-days'),
               dict(id='temperature', label='Temperature', short='Temp', unit='°C')]
    values = [[[1,4],[0.5,4]],[[0.5,4],[1,4]]]
    details = [[dict(reason=None, n_overlap=4, n_used=4, strata_used=1,
                     mask_sha256='explicit-fixture-mask') for _ in factors] for _ in factors]
    return dict(id=identifier, result=dict(config=deepcopy(config), analysis_id=parent['id'],
                extract_id=parent['result']['extract_id'], snapshot_at=SNAPSHOT,
                version='explicit-browser-fixture', platforms=SOURCES,
                time_factors=factors, space_factors=factors,
                results={source:{mode:deepcopy(values) for mode in ['within','pooled','space']}
                         for source in SOURCES},
                pair_details={source:{mode:deepcopy(details) for mode in ['within','pooled','space']}
                              for source in SOURCES},
                time_series=dict(dates=['2022-04-01','2022-04-02','2022-04-03','2022-04-04'],
                                 conditions=[[10],[20],[30],[40]], fire={s:[1,2,3,4] for s in SOURCES}),
                space_units=[], warnings=['Explicit browser fixtures; not scientific validation.'],
                provenance=dict(fixture=True)))


class SourceServer:
    def __init__(self, ref=None):
        self.ref = ref

    def read(self, relative):
        if self.ref:
            process = subprocess.run(['git','show',f'{self.ref}:web/{relative}'], cwd=ROOT,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
            if process.returncode:
                raise FileNotFoundError(relative)
            return process.stdout
        return (ROOT/'web'/relative).read_bytes()

    def start(self):
        source = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                relative = urlsplit(self.path).path.lstrip('/') or 'index.html'
                if '..' in PurePosixPath(relative).parts or relative.startswith('api/'):
                    return self.send_error(404)
                try:
                    body = source.read(relative)
                except (FileNotFoundError, IsADirectoryError):
                    return self.send_error(404)
                if relative == 'app-shell.js':
                    body += b'\nexport const __atlasStudyTest={capture,share,navigate};\n'
                self.send_response(200)
                self.send_header('Content-Type', mimetypes.guess_type(relative)[0] or 'application/octet-stream')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                # A missing browser mock must never become a real API call.
                self.send_error(500, 'Unmocked local POST')

            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return f'http://127.0.0.1:{self.server.server_port}'

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class MockAPI:
    def __init__(self, base):
        self.base = base
        self.calls = []
        self.external_requests = []
        self.jobs = {}
        self.matrices = {}
        self.counter = 1
        self.world = analysis(WORLD_CONFIG, 'a'*32)
        self.world_matrix = matrix(self.world, 'b'*32)

    async def attach(self, context):
        await context.route('**/*', self.route)

    async def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if not request.url.startswith(self.base+'/'):
            self.external_requests.append(request.url)
            return await route.abort()
        path = parsed.path
        body = None
        if path.startswith('/api/'):
            self.calls.append(dict(method=request.method, path=path,
                                   body=request.post_data_json if request.method=='POST' else None))
            if path == '/api/fires/range':
                body = dict(first='2020-01-01', last='2025-12-31', through=SNAPSHOT,
                            platforms=['Aqua','NOAA-20'], periodDetailDays=31)
            elif path.startswith('/api/fires/'):
                query = parse_qs(parsed.query)
                body = dict(status='ok', points=[], total=0, count=0, regionalCount=0,
                            start=query.get('start',['2025-12-31'])[0],
                            end=query.get('end',['2025-12-31'])[0])
            elif path == '/api/v1/world-calendar':
                body = dict(revision='explicit-fixture', start='2020-01-01', end='2025-12-31',
                            through=SNAPSHOT, snapshot_at=SNAPSHOT,
                            monthly=monthly(dict(start='2020-01-01',end='2025-12-31'),11111))
            elif path == '/api/v1/analyses' and request.method == 'POST':
                identifier = f'{self.counter:032x}'; self.counter += 1
                self.jobs[identifier] = analysis(request.post_data_json, identifier)
                body = dict(id=identifier, status='queued')
            elif path.endswith('/matrix') and request.method == 'POST':
                parent = self.jobs[path.split('/')[-2]]
                identifier = f'{100000+self.counter:032x}'; self.counter += 1
                self.matrices[identifier] = matrix(parent, identifier)
                body = dict(id=identifier, status='queued')
            elif path.startswith('/api/v1/analyses/'):
                identifier = path.rsplit('/',1)[-1]
                parent = self.jobs.get(identifier)
                if parent:
                    body = dict(status='done', progress=100, message='Fixture ready', **parent)
            elif path.startswith('/api/v1/matrices/'):
                identifier = path.rsplit('/',1)[-1]
                saved = self.matrices.get(identifier)
                if saved:
                    body = dict(status='done', progress=100, message='Fixture ready', **saved)
            elif path == '/api/v1/config':
                body = dict(end='2025-12-31',rows=1000,presets=[dict(id='sko',name='SKO',bbox=[66,52,72,56])])
            if body is None:
                return await route.fulfill(status=404, content_type='application/json', body='{"error":"Unknown fixture API route"}')
        elif path in ['/data/world-calendar.json','/data/world-atlas.json']:
            body = (dict(analysis=self.world,matrix=self.world_matrix) if 'world-atlas' in path
                    else dict(revision='explicit-fixture',start='2020-01-01',end='2025-12-31',
                              snapshot_at=SNAPSHOT,monthly=monthly(dict(start='2020-01-01',end='2025-12-31'),11111)))
        elif path == '/data/world-atlas.json.gz':
            return await route.fulfill(status=404, body='')
        elif path == '/data/layers.json':
            body = dict(version=1,layers=[])
        if body is not None:
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
        await route.continue_()


async def shell(page):
    await page.wait_for_function("document.querySelector('#world-date') && !document.querySelector('#world-date').disabled", timeout=20000)
    await page.evaluate('''async()=>{
        const url=document.querySelector('script[src*="app-shell.js"]').src;
        window.__studyShell=(await import(url)).__atlasStudyTest;
    }''')


async def navigate(page, view, payload=None):
    await page.evaluate('([view,payload])=>window.__studyShell.navigate(view,payload)', [view,payload or {}])


async def settings(page):
    return await page.evaluate('''()=>({start:document.querySelector('#study-start').value,
        end:document.querySelector('#study-end').value,
        baseline_start:Number(document.querySelector('#study-baseline-start').value),
        baseline_end:Number(document.querySelector('#study-baseline-end').value),
        platform:document.querySelector('#study-platform').value})''')


async def set_settings(page, desired):
    await page.evaluate('''value=>{
        for(const [key,id] of Object.entries({start:'study-start',end:'study-end',baseline_start:'study-baseline-start',baseline_end:'study-baseline-end',platform:'study-platform'})){
            const input=document.getElementById(id);input.value=value[key];input.dispatchEvent(new Event('change',{bubbles:true}));
        }
    }''', desired)
    await page.wait_for_function("document.querySelector('#study-spinner').hidden && document.querySelector('#study-calendar button')", timeout=12000)


async def matrix_ready(page):
    await page.wait_for_function("document.querySelector('#external-factors .matrix-status')?.textContent.includes('Матрица готова')", timeout=12000)


def subset(study):
    return {key:study.get(key) for key in SETTINGS} if isinstance(study,dict) else None


async def run(base, output, source_ref=None):
    output.mkdir(parents=True,exist_ok=True)
    report=dict(source_ref=source_ref or 'workspace',checks=[],javascript_errors=[],status='RUNNING')
    def check(value, message, actual=None):
        report['checks'].append(dict(passed=bool(value),message=message,actual=actual))
        print(('PASS ' if value else 'FAIL ')+message,flush=True)
    mocks = MockAPI(base)
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        context=await browser.new_context(viewport=dict(width=1440,height=1000))
        await mocks.attach(context)
        page=await context.new_page()
        page.on('pageerror',lambda error:report['javascript_errors'].append(str(error)))
        try:
            await page.goto(base+'/?view=atlas',wait_until='domcontentloaded')
            await shell(page)
            await navigate(page,'atlas',dict(context=dict(roi=ROI_A)))
            await page.locator('.tool-nav a[href="#activity-calendar"]').click()
            await page.locator('#study-settings').evaluate('(node)=>node.open=true')
            await set_settings(page,SETTINGS)
            await navigate(page,'atlas',dict(context=dict(roi=ROI_B)))
            check(await settings(page)==SETTINGS,'Changing ROI preserves study dates, baseline years and satellite',await settings(page))
            # Keep independent roundtrip assertions meaningful even when the pre-fix ROI step is red.
            await page.locator('.tool-nav a[href="#activity-calendar"]').click()
            await set_settings(page,SETTINGS)
            await matrix_ready(page)
            captured=await page.evaluate('window.__studyShell.capture()')
            study=captured.get('states',{}).get('atlas',{}).get('study')
            check(subset(study)==SETTINGS,'Atlas getState includes serializable study settings',study)
            check(isinstance(study,dict) and study.get('version')==1 and study.get('openTab')=='#activity-calendar','Study state preserves schema version and open panel',study)
            check(isinstance(study,dict) and bool(study.get('analysisId')) and bool(study.get('matrixId')),'Completed study state includes both cached job IDs',study)
            await page.evaluate("window.__studyShell.share('atlas')")
            shared_url=page.url
            portable=json.loads(parse_qs(urlsplit(shared_url).query).get('state',['{}'])[0])
            check(subset(portable.get('study'))==SETTINGS,'Portable share URL includes the same study settings',portable.get('study'))
            fresh=await browser.new_context(viewport=dict(width=1440,height=1000));await mocks.attach(fresh)
            linked=await fresh.new_page();linked.on('pageerror',lambda error:report['javascript_errors'].append(str(error)))
            before_link=sum(c['method']=='POST' for c in mocks.calls)
            await linked.goto(shared_url,wait_until='domcontentloaded');await shell(linked)
            await matrix_ready(linked)
            check(await settings(linked)==SETTINGS,'A fresh session restores study settings from the shared URL',await settings(linked))
            linked_state=await linked.evaluate('window.__studyShell.capture().states.atlas.study')
            check(isinstance(linked_state,dict) and isinstance(study,dict) and linked_state.get('analysisId')==study.get('analysisId') and linked_state.get('matrixId')==study.get('matrixId') and sum(c['method']=='POST' for c in mocks.calls)==before_link,'A matching shared study restores both IDs without new POSTs',linked_state)
            await fresh.close()
            # Force the large-ROI URL branch with display-only metadata, not a new computation.
            if isinstance(study,dict) and study.get('analysisId'):
                await page.evaluate("()=>{const state=window.__studyShell.capture().states.atlas;state.context.roi.source='fixture-metadata-'.repeat(500);return window.__studyShell.share('atlas',state);}")
                large_url=page.url;large_query=parse_qs(urlsplit(large_url).query);large_state=json.loads(large_query.get('state',['{}'])[0])
                check(large_query.get('analysis_id')==[study['analysisId']] and large_state.get('context',{}).get('roi') is None and large_state.get('study',{}).get('config') is None,'Oversized share uses analysis_id and removes repeated ROI/config geometry',large_state.get('study'))
                large_context=await browser.new_context(viewport=dict(width=1440,height=1000));await mocks.attach(large_context)
                large_page=await large_context.new_page();large_page.on('pageerror',lambda error:report['javascript_errors'].append(str(error)))
                before_large=sum(c['method']=='POST' for c in mocks.calls)
                await large_page.goto(large_url,wait_until='domcontentloaded');await shell(large_page);await matrix_ready(large_page)
                large_capture=await large_page.evaluate('window.__studyShell.capture()')
                check(await settings(large_page)==SETTINGS and large_capture['states']['atlas']['context']['roi']['geometry']==ROI_B['geometry'] and sum(c['method']=='POST' for c in mocks.calls)==before_large,'Oversized shared ROI restores authoritative geometry and cached settings without POSTs')
                await large_context.close()
            else:
                check(False,'Oversized share requires a completed study ID (missing in this UI version)')
            before_reload=sum(c['method']=='POST' for c in mocks.calls)
            await page.reload(wait_until='domcontentloaded');await shell(page)
            await matrix_ready(page)
            check(await settings(page)==SETTINGS,'Refresh restores study settings',await settings(page))
            reloaded=await page.evaluate('window.__studyShell.capture().states.atlas.study')
            check(isinstance(reloaded,dict) and isinstance(study,dict) and reloaded.get('analysisId')==study.get('analysisId') and reloaded.get('matrixId')==study.get('matrixId') and sum(c['method']=='POST' for c in mocks.calls)==before_reload,'Refresh restores both cached IDs without new POSTs',reloaded)
            await navigate(page,'cases');await navigate(page,'atlas')
            await page.locator('.tool-nav a[href="#activity-calendar"]').click()
            await set_settings(page,OTHER_SETTINGS)
            await page.go_back();await page.wait_for_function("document.body.dataset.appView==='cases'")
            await page.go_back();await page.wait_for_function("document.body.dataset.appView==='atlas'")
            await page.wait_for_timeout(150)
            check(await settings(page)==SETTINGS,'Browser Back restores the prior study settings instead of the latest form values',await settings(page))

            # A foreign cached study is explicitly supplied together with a different current ROI.
            cfg=dict(preset='custom',bbox=ROI_A['bbox'],geometry=ROI_A['geometry'],roi_name=ROI_A['name'],
                     start=SETTINGS['start'],end=SETTINGS['end'],baseline_start=SETTINGS['baseline_start'],
                     baseline_end=SETTINGS['baseline_end'],grid_km=10,quality='sp',daynight='all')
            parent=analysis(cfg,'c'*32);saved_matrix=matrix(parent,'d'*32)
            mocks.jobs[parent['id']]=parent;mocks.matrices[saved_matrix['id']]=saved_matrix
            cached=dict(version=1,**SETTINGS,allWorld=False,openTab='#activity-calendar',
                        analysisId=parent['id'],matrixId=saved_matrix['id'],config=cfg,
                        matrixState=dict(platform='Aqua',mode='within',pair=[0,1]))
            before=len([c for c in mocks.calls if c['method']=='POST'])
            await navigate(page,'atlas',dict(context=dict(roi=ROI_B),state=dict(context=dict(roi=ROI_A),study=cached)))
            await page.wait_for_timeout(1200)
            text=await page.locator('#study-status').inner_text()
            check(await page.locator('#study-calendar button').count()==0,'A cached California analysis is not shown under the Brazil ROI')
            await page.locator('.tool-nav a[href="#external-factors"]').click()
            check(await page.locator('#external-factors .matrix-cell').count()==0,'A cached California matrix is not shown under the Brazil ROI')
            check(len([c for c in mocks.calls if c['method']=='POST'])==before,'A rejected foreign cache does not trigger an automatic replacement POST')
            check(any(term in text.lower() for term in ['друг','параметр','принадлеж','соответ','сохран']),'A rejected foreign cache has an explicit visible status',text)
            check(not report['javascript_errors'],'No unhandled JavaScript errors',report['javascript_errors'])
            await page.screenshot(path=str(output/'final.png'),full_page=True)
            report['status']='PASS' if all(c['passed'] for c in report['checks']) else 'FAIL'
        except Exception as error:
            report['status']='ERROR';report['failure']=str(error)
            await page.screenshot(path=str(output/'error.png'),full_page=True)
            print('ERROR',str(error),flush=True)
        finally:
            report['api_calls']=mocks.calls
            report['blocked_external_requests']=len(mocks.external_requests)
            report['production_requests']=0
            (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            await browser.close()
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-ref',help='Read immutable UI sources from this Git ref without checkout')
    parser.add_argument('--output-dir',type=Path,default=Path('/tmp/nasa-atlas-study-state'))
    args=parser.parse_args()
    server=SourceServer(args.source_ref)
    try:
        result=asyncio.run(run(server.start(),args.output_dir,args.source_ref))
        print(json.dumps(dict(status=result['status'],passed=sum(c['passed'] for c in result['checks']),
                              checks=len(result['checks']),report=str(args.output_dir/'report.json')),ensure_ascii=False))
        raise SystemExit(0 if result['status']=='PASS' else 1)
    finally:
        server.close()
