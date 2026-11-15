"""Touch analysis audit with screenshots and synthetic local API fixtures.

Run from the repository: python3 tests/e2e_analysis_mobile.py
No production API is contacted. Satellite/background imagery is blocked; charts
and request contracts are synthetic and do not validate scientific accuracy.
"""
import asyncio,json,sys,math,re
from pathlib import Path
from urllib.parse import urlencode
from urllib.parse import urlsplit,parse_qs
sys.path.insert(0,str(Path.cwd()/'tests'))
sys.path.insert(0,str(Path.cwd()))
from api.revisions import compare_results
from e2e_result_reuse import CachedAPI
from e2e_study_planner import local_server
import study_planner_fixtures as f
from playwright.async_api import async_playwright,expect
OUT=Path('data/monitor/mobile-analysis/after');OUT.mkdir(parents=True,exist_ok=True)
PARENT_NAME='Synthetic territory with a long readable name'
CHILD_GEOMETRY={'type':'Polygon','coordinates':[[[-59.8,-16.8],[-58.2,-16.8],[-58.2,-15.2],[-59.8,-15.2],[-59.8,-16.8]]]}
async def shot(page,name,selector=None):
 if selector: await page.locator(selector).scroll_into_view_if_needed()
 await page.wait_for_timeout(100)
 await page.screenshot(path=str(OUT/(name+'.png')))
 metrics=await page.evaluate('''()=>({bodyWidth:document.documentElement.scrollWidth,width:innerWidth,bodyScroll:scrollY,small:[...document.querySelectorAll('#analysis-view button,#analysis-view input,#analysis-view select,#analysis-view summary')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[hidden]')&&!e.closest('[inert]')&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth}).map(e=>({id:e.id||e.className,label:e.textContent.trim().slice(0,42),h:Math.round(e.getBoundingClientRect().height),w:Math.round(e.getBoundingClientRect().width),font:getComputedStyle(e).fontSize,x:Math.round(e.getBoundingClientRect().x),y:Math.round(e.getBoundingClientRect().y)}))})''')
 REPORT[name]=metrics
class API(CachedAPI):
 async def route(self,route):
  parsed=urlsplit(route.request.url);path=parsed.path
  async def respond(data):return await route.fulfill(content_type='application/json',body=json.dumps(data))
  if path.endswith('/data/atlas-boundaries/index.json'):
   return await respond([[PARENT_NAME,'Synthetic country',['Синтетическая область'],'TST','parent',0],['Synthetic child district','Synthetic country',['Синтетический район'],'TST','child',1]])
  if path.endswith('/data/atlas-boundaries/TST.json'):
   return await respond({'parent':f.HOLE,'child':CHILD_GEOMETRY})
  if parsed.hostname=='geocoding-api.open-meteo.com':return await respond({'results':[]})
  if path.endswith('/geometry/clip'):
   geometry=route.request.post_data_json['geometry'];points=[point for ring in geometry['coordinates'] for point in ring]
   return await respond({'geometry':geometry,'bbox':[min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)],'clipped':False})
  if path.endswith('/changes'):
   after=self.results[f.JOB_ID];before=json.loads(json.dumps(after));before['calculated_at']='2026-10-01T00:00:00Z'
   for row in before['monthly']:row['cells']=max(0,row['cells']-2)
   query=parse_qs(parsed.query)
   return await respond(compare_results(before,after,question=query.get('question',['anomaly'])[0],platform=query.get('platform',['NOAA-20'])[0],month=query.get('month',['2025-04'])[0],before_summary={'id':'d'*32,'retention':'saved','method_status':'current','config':before['config'],'calculated_at':before['calculated_at']},after_summary={'id':f.JOB_ID,'retention':'saved','method_status':'current','config':after['config'],'calculated_at':after['calculated_at']}))
  if path.endswith('/save'):
   return await route.fulfill(content_type='application/json',body=json.dumps({'id':f.JOB_ID,'retention':'saved'}))
  if path.endswith('/place-boundary'):
   return await route.fulfill(content_type='application/json',body=json.dumps({'geometry':f.HOLE}))
  return await super().route(route)
def rich_result(config):
 result=f.analysis(config)
 for platform in f.PLATFORMS:
  result['weekly_profiles'][platform]={'weeks':[{'week':week,'median':5+week%5,'low':1,'high':12,'years':4} for week in range(1,54)],'years':{},'year_metrics':{},'threshold':7}
  for year in range(2020,2026):
   result['weekly_profiles'][platform]['years'][str(year)]=[{'week':week,'cells':10+week,'rate':3+((week*year)%15),'eligible_days':7} for week in range(1,54)]
   result['weekly_profiles'][platform]['year_metrics'][str(year)]={'first_week':12,'peak_week':18,'last_week':38,'active_weeks':21,'total_cells':1200,'start_date':f'{year}-01-01','end_date':f'{year}-12-31','partial_year':False}
  if platform in result['models']:
   result['models'][platform]['pairs']=[{'month':f'{year}-{m:02}','aqua':4+m,'partner':8+m*2} for year in (2024,2025) for m in range(1,13)]
 for day in range(1,31):
  for platform in f.PLATFORMS:
   result['daily'].append({'date':f'2025-04-{day:02}','platform':platform,'cells':day%8+2})
   result['availability'].append({'date':f'2025-04-{day:02}','platform':platform,'sp':True})
 return result
REPORT={}
async def main():
 server,origin=local_server()
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True)
  for w,h in [(320,740),(360,800),(390,844),(844,390)]:
   ctx=await browser.new_context(viewport={'width':w,'height':h},is_mobile=True,has_touch=True,device_scale_factor=1)
   api=API({'blocked_external_requests':[],'mock_requests':[]});await api.install(ctx)
   value=f.context();value['roi']['name']=PARENT_NAME;value['roi']['boundary_ref']={'code':'TST','id':'parent','level':0}
   api.results[f.JOB_ID]=rich_result(f.config_from_context(value))
   page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   state={'version':1,'context':value,'analysisId':f.JOB_ID}
   await page.goto(origin+'/?'+urlencode({'lang':'ru','view':'analysis','state':json.dumps(state)}))
   await expect(page.locator('#export-csv')).to_be_enabled()
   prefix=f'{w}x{h}'
   await shot(page,prefix+'-ready')
   for tab in ['calendar','series','compare','matrix','validation']:
    await page.locator('#tab-'+tab).tap()
    await shot(page,prefix+'-'+tab,'#study-results')
   await shot(page,prefix+'-map','#analysis-map')
   await shot(page,prefix+'-timeline','#day-range')
   await page.locator('#provenance-open').tap();await shot(page,prefix+'-method');await page.locator('#method-close').tap()
   await page.locator('#revision-details').evaluate('(e)=>e.open=true')
   await shot(page,prefix+'-revisions','#study-revisions')
   await page.locator('#revision-before-id').fill('d'*32)
   await page.locator('#revision-compare').tap()
   await expect(page.locator('#revision-result')).to_be_visible()
   await shot(page,prefix+'-revisions-comparison','#revision-result')
   async with page.expect_download() as downloaded:await page.locator('#export-csv').tap()
   REPORT[prefix+'-csv-export']=(await downloaded.value).suggested_filename
   async with page.expect_download() as downloaded:await page.locator('#export-image').tap()
   REPORT[prefix+'-image-export']=(await downloaded.value).suggested_filename
   for step in ['territory','task','conditions']:
    await page.evaluate("step=>document.dispatchEvent(new CustomEvent('nasa:analysis-settings',{detail:{step}}))",step)
    await shot(page,prefix+'-'+step)
    if step=='conditions':
     await page.locator('#manual-conditions').evaluate('(e)=>e.open=true')
     await shot(page,prefix+'-data-inputs','#platform')
     assert await page.locator('#run').evaluate("e=>e.closest('.analysis-workflow-navigation')!==null")
     await page.locator('#manual-conditions').evaluate('(e)=>e.open=false')
     await page.locator('#study-plan-request').tap()
     await expect(page.locator('[data-study-apply]').first).to_be_visible()
     await shot(page,prefix+'-data-plan','#study-plan-options [data-study-apply="current-request"]')
     await page.locator('[data-study-apply="current-request"]').tap()
     await expect(page.locator('#run')).to_be_visible()
     await shot(page,prefix+'-data-applied')
     api.post_gate=asyncio.Event()
     await page.locator('#run').tap()
     await api.post_started.wait()
     await shot(page,prefix+'-running','#job-banner')
     api.post_gate.set()
     await expect(page.locator('#export-csv')).to_be_enabled()
   await page.evaluate("document.dispatchEvent(new CustomEvent('nasa:analysis-settings',{detail:{step:'territory'}}))")
   await expect(page.locator('#territory-child')).to_be_enabled()
   await page.locator('#territory-child').select_option('0')
   await expect(page.locator('#analysis-territory-selected')).to_contain_text('Synthetic child district')
   await shot(page,prefix+'-child-territory')
   await page.locator('#analysis-territory-query').fill('Синтетическая')
   await page.locator('#analysis-territory-find').tap()
   await expect(page.locator('#analysis-territory-results button').first).to_be_visible()
   await shot(page,prefix+'-territory-search')
   await page.locator('#analysis-territory-results button').first.tap()
   await page.locator('#draw-polygon').tap()
   await shot(page,prefix+'-drawing')
   box=await page.locator('#analysis-map').bounding_box()
   for dx,dy in [(.25,.4),(.65,.4),(.6,.56)]:await page.touchscreen.tap(box['x']+box['width']*dx,box['y']+box['height']*dy)
   await shot(page,prefix+'-drawing-points')
   assert await page.locator('#selection-finish').is_enabled(), 'Three touch points must allow Done without a keyboard'
   await page.locator('#selection-finish').tap()
   await expect(page.locator('#selection-actions')).to_be_hidden()
   await shot(page,prefix+'-drawing-applied')
   for shape in ('rectangle','circle'):
    await page.locator('#draw-'+('area' if shape=='rectangle' else shape)).tap()
    await shot(page,prefix+'-drawing-'+shape)
    box=await page.locator('#analysis-map').bounding_box()
    for dx,dy in [(.3,.4),(.6,.55)]:await page.touchscreen.tap(box['x']+box['width']*dx,box['y']+box['height']*dy)
    await expect(page.locator('#selection-actions')).to_be_hidden()
   assert len(api.posts)==1,'Only the explicitly tested local Run may create an analysis'
   assert not errors, errors
   REPORT[prefix+'-errors']=errors
   await ctx.close()
  await browser.close()
 server.shutdown()
 (OUT/'audit.json').write_text(json.dumps(REPORT,ensure_ascii=False,indent=2))
 print(OUT)
asyncio.run(main())
