"""Timed fire-detail notice regression using local UI and mocked viewport responses.

python3 tests/e2e_fire_detail_notice.py
python3 tests/e2e_fire_detail_notice.py --source-ref 5c9f20b  # pre-fix RED

Playwright's clock advances timers without real seven-second sleeps. External
requests are blocked; this test does not submit production calculations.
"""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
from urllib.parse import parse_qs,urlsplit

from playwright.async_api import async_playwright

spec=importlib.util.spec_from_file_location('atlas_notice_fixture',Path(__file__).with_name('e2e_atlas_study_state.py'))
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
HELPER_HTML='''<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="focus-target" type="button">Focus stays here</button>
<div id="fire-detail-notice" hidden><span id="fire-detail-status" data-notice-text></span></div>
<script type="module">import {createMapNotice} from '/map-notice.js';
window.notice=createMapNotice(document.querySelector('#fire-detail-notice'),{duration:7000});window.noticeReady=true;</script></body></html>'''


class NoticeAPI(fixture.MockAPI):
    def __init__(self,base):
        super().__init__(base);self.mode='error';self.viewport_calls=[]

    async def route(self,route):
        request=route.request;parsed=urlsplit(request.url)
        if request.url.startswith(self.base+'/'):
            if parsed.path=='/__notice_helper__':
                return await route.fulfill(status=200,content_type='text/html',body=HELPER_HTML)
            if parsed.path=='/api/fires/viewport':
                self.calls.append(dict(method=request.method,path=parsed.path,body=None))
                self.viewport_calls.append(dict(mode=self.mode,query=parse_qs(parsed.query)))
                if self.mode=='error':
                    return await route.fulfill(status=503,content_type='application/json',body='{"error":"Explicit viewport failure fixture"}')
                if self.mode=='too_slow':
                    body=dict(status='too_slow',reason='timeout',points=[])
                else:
                    query=parse_qs(parsed.query);day=query.get('start',['2025-12-30'])[0]
                    body=dict(status='ok',method='archive',points=[[-74,40.7,1,1,day+'T12:00:00Z']],missing=[],coveredStart=day,coveredEnd=day)
                return await route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
        return await super().route(route)


async def show(page,key,message='Explicit helper notice'):
    await page.evaluate('([key,message])=>window.notice.show({key,message})',[key,message])


async def run(base,output,source_ref=None):
    output.mkdir(parents=True,exist_ok=True)
    report=dict(status='RUNNING',source_ref=source_ref or 'workspace',checks=[],javascript_errors=[])
    def check(condition,message,actual=None):
        report['checks'].append(dict(passed=bool(condition),message=message,actual=actual))
        print(('PASS ' if condition else 'FAIL ')+message,flush=True)
        if not condition:raise AssertionError(message)
    api=NoticeAPI(base)
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        context=await browser.new_context(viewport=dict(width=1440,height=1000))
        await api.attach(context)
        atlas=await context.new_page();atlas.on('pageerror',lambda error:report['javascript_errors'].append(str(error)))
        helper=None
        try:
            await atlas.clock.install()
            await atlas.goto(base+'/?view=atlas',wait_until='domcontentloaded');await fixture.shell(atlas)
            check(await atlas.locator('#fire-detail-notice').count()==1 and await atlas.locator('.timeline #fire-detail-status').count()==0,'Fire-detail text moves from the persistent bottom timeline to one top notice')
            check(await atlas.locator('#fire-detail-retry').count()==1 and await atlas.locator('#fire-detail-notice #fire-detail-retry').count()==0 and await atlas.locator('.timeline #fire-detail-retry').count()==1,'One existing retry button stays outside the toast in the bottom timeline')
            check(await atlas.locator('#fire-detail-provenance').count()==1 and await atlas.locator('#fire-detail-notice #fire-detail-provenance').count()==0,'Persistent fire-detail provenance has its own bottom element')

            helper=await context.new_page();helper.on('pageerror',lambda error:report['javascript_errors'].append(str(error)))
            await helper.clock.install()
            await helper.goto(base+'/__notice_helper__',wait_until='domcontentloaded')
            await helper.wait_for_function('window.noticeReady===true')
            notice=helper.locator('#fire-detail-notice')
            await helper.locator('#focus-target').focus();await show(helper,'period-A/error')
            check(await notice.is_visible() and await notice.get_attribute('aria-live')=='polite','Helper exposes a polite live notice immediately')
            check(await helper.evaluate("document.activeElement.id==='focus-target'"),'Showing a notice does not steal keyboard focus')
            await helper.clock.fast_forward(3500);await show(helper,'period-A/error')
            await helper.clock.fast_forward(3600)
            check(await notice.is_hidden(),'Duplicate key rendering does not extend the original seven-second deadline')
            await show(helper,'period-A/error')
            check(await notice.is_hidden(),'Re-rendering the same expired key does not resurrect the notice')
            await show(helper,'period-B/error');await helper.clock.fast_forward(6000)
            await show(helper,'period-C/too_slow');await helper.clock.fast_forward(1200)
            check(await notice.is_visible(),'A new period or failure key gets a fresh full deadline')
            await helper.clock.fast_forward(5900)
            check(await notice.is_hidden(),'The replacement notice expires after its own seven seconds')
            await helper.evaluate('window.notice.clear()');await show(helper,'period-C/too_slow')
            check(await notice.is_visible(),'Clear resets deduplication so the same key can be shown again')
            await helper.clock.fast_forward(1000);await helper.evaluate('window.notice.clear()')
            await show(helper,'period-D/error');await helper.clock.fast_forward(6100)
            check(await notice.is_visible(),'Clear cancels older timers instead of hiding a newer notice early')
            await helper.clock.fast_forward(1000)
            check(await notice.is_hidden() and await helper.evaluate("document.activeElement.id==='focus-target'"),'Expiry hides the whole host without moving focus')
            await helper.close();helper=None

            # Actual atlas rendering and the existing retry listener, with no selected ROI or POST.
            await fixture.navigate(atlas,'atlas',dict(state=dict(camera=dict(center=[40.7,-74],zoom=10))))
            await atlas.wait_for_function("!document.querySelector('#fire-detail-notice').hidden && document.querySelector('#fire-detail-status').textContent.includes('не загрузились')")
            check(await atlas.locator('#fire-detail-status').is_visible() and await atlas.locator('#fire-detail-retry').is_visible(),'Viewport error appears in the top toast with a working persistent retry control')
            await atlas.clock.fast_forward(3500)
            await atlas.locator('#fire-heat').click()  # Re-renders the same failed viewport object.
            await atlas.clock.fast_forward(3600)
            check(await atlas.locator('#fire-detail-notice').is_hidden() and await atlas.locator('#fire-detail-retry').is_visible(),'Duplicate atlas render does not prolong the toast; retry survives its deadline')
            previous=api.viewport_calls[-1]['query'];before_pan=len(api.viewport_calls)
            await atlas.mouse.move(1000,400);await atlas.mouse.down();await atlas.mouse.move(450,400,steps=6);await atlas.mouse.up()
            await atlas.clock.fast_forward(300)
            await atlas.wait_for_function("!document.querySelector('#fire-detail-notice').hidden && document.querySelector('#fire-detail-status').textContent.includes('не загрузились')")
            current=api.viewport_calls[-1]['query']
            check(len(api.viewport_calls)>before_pan and current.get('bbox')!=previous.get('bbox') and current.get('start')==previous.get('start') and current.get('end')==previous.get('end'),'An actual map drag requests a different bbox in the same period')
            check(await atlas.locator('#fire-detail-notice').is_visible(),'A new bbox failure shows a new toast after the previous identical-status toast expired')
            api.mode='too_slow';before=len(api.viewport_calls)
            await atlas.locator('#fire-detail-retry').click()
            await atlas.wait_for_function("!document.querySelector('#fire-detail-notice').hidden && document.querySelector('#fire-detail-status').textContent.includes('долго')")
            check(len(api.viewport_calls)==before+1 and await atlas.locator('#fire-detail-retry').is_visible(),'Retry submits one new viewport request and too_slow keeps the retry action')
            check(await atlas.evaluate("document.activeElement.id==='fire-detail-retry'"),'A renewed error notice does not steal focus from the retry button')
            api.mode='ok';before=len(api.viewport_calls)
            await atlas.locator('#fire-detail-retry').click()
            await atlas.wait_for_function("document.querySelector('#fire-detail-retry').hidden && document.querySelector('#fire-detail-provenance').textContent.length>0")
            check(len(api.viewport_calls)==before+1 and await atlas.locator('#fire-detail-notice').is_hidden() and not (await atlas.locator('#fire-detail-status').text_content()).strip(),'Success clears the previous error text and hides retry immediately')
            provenance=await atlas.locator('#fire-detail-provenance').text_content()
            await atlas.clock.fast_forward(7100)
            check(await atlas.locator('#fire-detail-provenance').is_visible() and await atlas.locator('#fire-detail-provenance').text_content()==provenance,'Success provenance persists independently of the toast deadline')
            api.mode='error'
            await atlas.locator('#world-date').fill('2025-12-29');await atlas.locator('#world-date').dispatch_event('change')
            await atlas.wait_for_function("!document.querySelector('#fire-detail-notice').hidden && document.querySelector('#fire-detail-status').textContent.includes('не загрузились')")
            check(await atlas.locator('#fire-detail-notice').is_visible(),'A different period can show a fresh error toast after success')
            await atlas.set_viewport_size(dict(width=390,height=900));await atlas.clock.fast_forward(300)
            await atlas.wait_for_function("!document.querySelector('#fire-detail-notice').hidden && document.querySelector('#fire-detail-status').textContent.includes('не загрузились')")
            await atlas.evaluate("for(const id of ['map-message','layer-readout']){const node=document.getElementById(id);node.textContent=id+' layout fixture';node.hidden=false;}")
            boxes=await atlas.evaluate("['map-message','layer-readout','fire-detail-notice'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return{id,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};})")
            overlap=lambda a,b:min(a['right'],b['right'])>max(a['x'],b['x']) and min(a['bottom'],b['bottom'])>max(a['y'],b['y'])
            check(all(box['width']>0 and box['height']>0 for box in boxes) and not any(overlap(a,b) for i,a in enumerate(boxes) for b in boxes[i+1:]),'Three top map readouts stack without overlapping at 390px',boxes)
            header=await atlas.locator('#app-header').bounding_box();toast=await atlas.locator('#fire-detail-notice').bounding_box();timeline=await atlas.locator('.timeline').bounding_box()
            check(toast['y']>=header['y']+header['height']-1 and toast['y']+toast['height']<timeline['y'],'Mobile notice floats above the timeline and below the global header')
            check(await atlas.evaluate("Number(getComputedStyle(document.querySelector('.map-notices')).zIndex)>Number(getComputedStyle(document.querySelector('#selected-area-panel')).zIndex) && getComputedStyle(document.querySelector('.map-notices')).pointerEvents==='none'"),'Map notices remain above a selected-territory panel without intercepting map input')
            check(not await atlas.evaluate('document.documentElement.scrollWidth>innerWidth'),'Mobile toast does not create horizontal overflow')
            check(not any(call['method']=='POST' for call in api.calls),'Notice and viewport retry flows submit no historical analysis or matrix POST')
            check(not report['javascript_errors'],'No unhandled JavaScript errors',report['javascript_errors'])
            await atlas.screenshot(path=str(output/'notice-mobile.png'),full_page=True);report['status']='PASS'
        except Exception as error:
            report.update(status='FAIL',failure=str(error));print('FAIL',str(error),flush=True)
            await atlas.screenshot(path=str(output/'failure.png'),full_page=True)
        finally:
            report['api_calls']=api.calls;report['viewport_calls']=api.viewport_calls;report['production_requests']=0
            report['blocked_external_requests']=len(api.external_requests)
            (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            await browser.close()
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-ref',help='Read pre-fix or other immutable UI sources from Git, without checkout')
    parser.add_argument('--output-dir',type=Path,default=Path('/tmp/nasa-fire-detail-notice'))
    args=parser.parse_args();server=fixture.SourceServer(args.source_ref)
    try:
        report=asyncio.run(run(server.start(),args.output_dir,args.source_ref))
        print(json.dumps(dict(status=report['status'],checks=len(report['checks']),report=str(args.output_dir/'report.json'))))
        raise SystemExit(0 if report['status']=='PASS' else 1)
    finally:server.close()
