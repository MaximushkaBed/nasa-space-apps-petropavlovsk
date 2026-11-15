"""Isolated browser regression: actual atlas search -> Analysis handoff.

python3 tests/e2e_atlas_analysis_handoff.py
Uses local UI, explicit boundary/API fixtures, and no production requests.
The shared test HTTP server exposes shell capture functions only in its responses.
"""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

spec=importlib.util.spec_from_file_location('atlas_state_fixture',Path(__file__).with_name('e2e_atlas_study_state.py'))
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)

NY_GEOMETRY=dict(type='MultiPolygon',coordinates=[
    [[[-79.75,42],[-73.3,42],[-73.3,45],[-79.75,45],[-79.75,42]],
     [[-77.5,43],[-77,43],[-77,43.5],[-77.5,43.5],[-77.5,43]]],
    [[[-74.2,40.5],[-73.8,40.5],[-73.8,40.9],[-74.2,40.9],[-74.2,40.5]]],
])
CA_GEOMETRY=dict(type='Polygon',coordinates=[[[ -124,32],[-114,32],[-114,42],[-124,42],[-124,32]]])
FOCUS=dict(start='2022-04-12',end='2022-04-12',basis='UTC',grain='day')


class HandoffAPI(fixture.MockAPI):
    async def route(self, route):
        request=route.request;path=urlsplit(request.url).path
        if request.url.startswith(self.base+'/'):
            if path=='/data/atlas-boundaries/index.json':
                body=[['United States','',['USA','США'],'USA','USA',0],
                      ['New York','United States',['Нью-Йорк'],'USA','NY',1],
                      ['California','United States',['Калифорния'],'USA','CA',1]]
                return await route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
            if path=='/data/atlas-boundaries/USA.json':
                return await route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(NY=NY_GEOMETRY,CA=CA_GEOMETRY)))
            if path=='/api/v1/analyses' and request.method=='POST':
                config=request.post_data_json;self.calls.append(dict(method='POST',path=path,body=config))
                identifier=f'{self.counter:032x}';self.counter+=1
                parent=fixture.analysis(config,identifier)
                parent['result'].update(models={},profiles={},daily=[],availability=[],weekly_profiles={},provenance=dict(fixture=True))
                self.jobs[identifier]=parent
                return await route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(id=identifier,status='queued')))
            if path.startswith('/api/v1/maps/'):
                self.calls.append(dict(method='GET',path=path,body=None))
                return await route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(cells=[],grid_km=10,display_grid_km=10)))
        return await super().route(route)


async def search(page, name):
    await page.locator('#area-search-mode').click()
    await page.locator('#area-query').fill(name+', USA')
    await page.locator('#area-search button[type="submit"]').click()
    result=page.locator('#area-results button',has_text=name+' · United States')
    await result.wait_for(state='visible')
    await result.click()
    await page.locator('#selected-area-panel').wait_for(state='visible')


async def wait_analysis(page,name,platform=None):
    await page.wait_for_function("""([name,platform])=>{
        const state=window.__studyShell.capture().states.analysis;
        return document.body.dataset.appView==='analysis' && state?.context?.roi?.name===name
            && (!platform||state.context.platform===platform) && !document.querySelector('#run').disabled;
    }""",arg=[name,platform])


async def capture_analysis(page):
    return await page.evaluate('window.__studyShell.capture().states.analysis')


async def open_calendar_settings(page):
    tab=page.locator('.tool-nav a[href="#activity-calendar"]')
    if await tab.get_attribute('aria-expanded')!='true':
        await tab.click()
    await page.locator('#activity-calendar').wait_for(state='visible')
    await page.locator('#study-settings').evaluate('(node)=>node.open=true')


async def run(base,output):
    output.mkdir(parents=True,exist_ok=True)
    report=dict(status='RUNNING',checks=[],javascript_errors=[])
    def check(condition,message,actual=None,fatal=True):
        report['checks'].append(dict(passed=bool(condition),message=message,actual=actual))
        print(('PASS ' if condition else 'FAIL ')+message,flush=True)
        if not condition and fatal:raise AssertionError(message)
    def posts(mocks):return sum(call['method']=='POST' for call in mocks.calls)
    mocks=HandoffAPI(base)
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        context=await browser.new_context(viewport=dict(width=1440,height=1000))
        await mocks.attach(context)
        page=await context.new_page();page.on('pageerror',lambda error:report['javascript_errors'].append(str(error)))
        try:
            await page.goto(base+'/?view=atlas',wait_until='domcontentloaded');await fixture.shell(page)
            check(await page.locator('#area-open-analysis').count()==1 and await page.locator('#atlas-open-analysis').count()==1,'Selected-area and toolbar Analysis CTA exist')
            check(await page.locator('#area-open-analysis').is_hidden() and await page.locator('#atlas-open-analysis').is_hidden(),'Analysis CTA stay hidden when no territory is selected')
            await page.evaluate("window.__initialHeader=document.querySelector('#app-header')")
            await search(page,'New York')
            check(await page.locator('#area-name').inner_text()=='New York','Actual boundary search selects New York')
            selected=await page.evaluate('window.__studyShell.capture().states.atlas.context.roi')
            check(selected['geometry']==NY_GEOMETRY,'Selected New York retains the exact multipolygon, island and hole',selected)
            check(await page.locator('#area-open-analysis').is_visible(),'Selected-territory overview exposes Analysis CTA')
            await open_calendar_settings(page)
            await fixture.set_settings(page,fixture.SETTINGS);await fixture.matrix_ready(page)
            await page.locator('#world-satellite').select_option('1')  # Map NOAA-20, study explicitly Aqua.
            await page.locator('#world-date').fill(FOCUS['start']);await page.locator('#world-date').dispatch_event('change')
            await page.wait_for_timeout(80)
            await page.locator('#open-area').click()
            before=posts(mocks)
            await page.locator('#area-open-analysis').click();await wait_analysis(page,'New York','Aqua')
            state=await capture_analysis(page);ctx=state['context']
            check(posts(mocks)==before and state['analysisId'] is None,'Panel CTA only prefills the form; it does not submit an analysis')
            check(ctx['roi']['geometry']==NY_GEOMETRY and ctx['roi']['name']=='New York','Handoff preserves exact New York geometry and name',ctx['roi'])
            check(ctx['history']==dict(start=fixture.SETTINGS['start'],end=fixture.SETTINGS['end']) and ctx['baseline']==dict(start=2020,end=2022),'Handoff uses study dates and baseline years, not old workbench defaults',ctx)
            check(ctx['platform']=='Aqua' and await page.locator('#platform').input_value()=='Aqua','Explicit study satellite takes precedence over the map satellite',ctx['platform'])
            check(ctx['quality']=='sp' and ctx['daynight']=='all' and ctx['grid_km']==10,'Handoff has the declared SP, day/night and grid filters')
            check(ctx['focus']==FOCUS,'Map focus inside the study interval is preserved exactly',ctx['focus'])
            before_run_calls=len(mocks.calls)
            await page.locator('#run').click()
            await page.wait_for_function("!document.querySelector('#export-csv').disabled")
            sent=[call['body'] for call in mocks.calls[before_run_calls:] if call['method']=='POST' and call['path']=='/api/v1/analyses']
            check(len(sent)==1 and sent[0].get('geometry')==NY_GEOMETRY and sent[0]['start']==fixture.SETTINGS['start'] and sent[0]['baseline_start']==2020,'Explicit Run submits one request containing the exact boundary and study period',sent)

            await page.locator('.app-nav [data-app-view="atlas"]').click();await fixture.shell(page)
            await search(page,'California')
            await open_calendar_settings(page)
            await fixture.set_settings(page,fixture.SETTINGS);await fixture.matrix_ready(page)
            await page.locator('#world-date').fill('2025-12-31');await page.locator('#world-date').dispatch_event('change')
            before=posts(mocks)
            await page.locator('.app-nav [data-app-view="analysis"]').click();await wait_analysis(page,'California','Aqua')
            state=await capture_analysis(page);ctx=state['context']
            check(posts(mocks)==before and state['analysisId'] is None,'Navbar handoff also prefills without a POST')
            check(ctx['roi']['geometry']==CA_GEOMETRY and ctx['roi']['name']=='California','Navbar transfers the newly selected territory instead of stale New York',ctx['roi'])
            check(ctx['history']==dict(start=fixture.SETTINGS['start'],end=fixture.SETTINGS['end']) and ctx['focus'] is None,'An out-of-history map date is cleared without expanding study history',ctx,fatal=False)
            check('Дата карты вне периода исследования' in await page.locator('#shell-status').inner_text(),'An out-of-history focus has an explicit user notice')

            await page.locator('.app-nav [data-app-view="atlas"]').click();await fixture.shell(page)
            await open_calendar_settings(page)
            await page.locator('#study-platform').select_option('auto')
            await page.locator('#world-satellite').select_option('')
            await page.locator('#open-area').click()
            await page.locator('#selected-area-panel [data-close-panel]').click()
            await page.set_viewport_size(dict(width=390,height=900));await page.wait_for_timeout(150)
            check(await page.locator('#selected-area-panel').is_hidden() and await page.locator('#atlas-open-analysis').is_visible(),'Collapsed territory overview retains a visible toolbar CTA at 390px')
            check(not await page.evaluate('document.documentElement.scrollWidth>innerWidth'),'Mobile toolbar and CTA have no horizontal overflow')
            before=posts(mocks)
            await page.locator('#atlas-open-analysis').click();await wait_analysis(page,'California','all')
            state=await capture_analysis(page)
            check(posts(mocks)==before and state['context']['platform']=='all' and await page.locator('#platform').input_value()=='all','Auto study source plus all map platforms stays all without an automatic fallback')
            await page.locator('#run').click();await page.wait_for_timeout(80)
            check(posts(mocks)==before and 'Выберите один спутник' in await page.locator('#error-banner').inner_text(),'Run requires an explicit satellite before submitting an all-platform handoff')
            check(await page.evaluate("window.__initialHeader===document.querySelector('#app-header')"),'Handoff and Run preserve the shell instead of submitting a document navigation')
            check(not report['javascript_errors'],'No unhandled JavaScript errors in the handoff flow',report['javascript_errors'])
            report['status']='PASS' if all(item['passed'] for item in report['checks']) else 'FAIL';await page.screenshot(path=str(output/'handoff-mobile.png'),full_page=True)
        except Exception as error:
            report.update(status='FAIL',failure=str(error));print('FAIL',str(error),flush=True)
            await page.screenshot(path=str(output/'failure.png'),full_page=True)
        finally:
            report['api_calls']=mocks.calls;report['production_requests']=0
            report['blocked_external_requests']=len(mocks.external_requests)
            (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            await browser.close()
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',type=Path,default=Path('/tmp/nasa-atlas-analysis-handoff'))
    args=parser.parse_args();server=fixture.SourceServer()
    try:
        report=asyncio.run(run(server.start(),args.output_dir))
        print(json.dumps(dict(status=report['status'],checks=len(report['checks']),report=str(args.output_dir/'report.json'))))
        raise SystemExit(0 if report['status']=='PASS' else 1)
    finally:server.close()
