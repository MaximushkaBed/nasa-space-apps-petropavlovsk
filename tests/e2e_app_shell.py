"""Manual real-browser integration for the persistent NASA Space Apps shell.

python3 tests/e2e_app_shell.py --local-web --api-base http://31.97.72.56:18090
Uses the real global FIRMS API for the atlas, with no generated science data.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import time
from playwright.sync_api import sync_playwright

spec=importlib.util.spec_from_file_location('workbench_e2e',Path(__file__).with_name('e2e_workbench.py'))
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)

def run(base,output,timeout):
    output.mkdir(parents=True,exist_ok=True)
    report={'base_url':base,'checks':[],'javascript_errors':[],'requests':[],'status':'RUNNING'}
    def check(value,message):
        assert value,message
        report['checks'].append(message);print('PASS',message,flush=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':1440,'height':1000})
        page.on('pageerror',lambda e:report['javascript_errors'].append(str(e)))
        page.on('request',lambda r:report['requests'].append({'method':r.method,'url':r.url}) if '/api/' in r.url else None)
        try:
            page.goto(base,wait_until='domcontentloaded')
            page.locator('#world-date').wait_for()
            page.wait_for_function("!document.querySelector('#world-date').disabled",timeout=60000)
            page.wait_for_function("/^Мир/.test(document.querySelector('#map-summary').textContent)",timeout=90000)
            check('Мир' in page.locator('#map-summary').inner_text(),'Atlas receives an actual global FIRMS day frame')
            check(page.locator('body').get_attribute('data-app-view')=='atlas','First visit opens the global atlas')
            check(page.locator('#atlas-launcher').is_visible(),'Territory selection and the analysis action are visible on entry')
            check(not any(r['method']=='POST' and '/api/v1/' in r['url'] for r in report['requests']),'Opening the atlas does not start a historical or matrix computation')
            page.evaluate("window.__headerBeforeNavigation=document.querySelector('#app-header')")
            header=page.locator('#app-header').bounding_box();mapbox=page.locator('#map').bounding_box()
            check(mapbox['y']>=header['y']+header['height']-1,'Atlas begins below the persistent global header')
            page.screenshot(path=str(output/'atlas-entry.png'),full_page=True)
            page.locator('.app-nav [data-app-view="cases"]').click()
            page.wait_for_function("document.body.dataset.appView==='cases' && !document.querySelector('#kishkenekol-case').hidden")
            check(page.evaluate("window.__headerBeforeNavigation===document.querySelector('#app-header')"),'Header DOM identity persists when entering a case')
            check(page.locator('#kishkenekol-case').is_visible(),'The global cases route opens the existing Oksana case')
            check(page.locator('#atlas-launcher').is_hidden(),'A case keeps its own context without the entry launcher covering it')
            page.go_back()
            page.wait_for_function("document.body.dataset.appView==='atlas'")
            check(page.locator('#world-date').is_enabled(),'Browser Back restores the atlas')
            check(page.locator('#atlas-launcher').is_visible(),'Returning from a case restores the territory action')
            page.locator('#atlas-launcher [data-demo="sko"]').click()
            page.wait_for_function("document.body.dataset.appView==='analysis'",timeout=30000)
            deadline=time.monotonic()+timeout/1000
            while page.locator('#export-csv').is_disabled():
                if page.locator('#error-banner').is_visible():raise AssertionError(page.locator('#error-banner').inner_text())
                if time.monotonic()>deadline:raise AssertionError('Real analysis did not complete before timeout')
                page.wait_for_timeout(1000)
            check(page.locator('.calendar-cell').count()>=72,'Prepared territory opens a real multi-year calendar')
            check(page.evaluate("window.__headerBeforeNavigation===document.querySelector('#app-header')"),'Atlas to analysis keeps the same header and page')
            check(page.locator('#tab-matrix').count()==1,'Dynamic factor matrix has its own analysis tab')
            check(not any(r['method']=='POST' and r['url'].endswith('/matrix') for r in report['requests']),'The expensive factor matrix is not calculated automatically')
            page.locator('#focus-month').select_option('2025-04')
            page.locator('.app-nav [data-app-view="atlas"]').click()
            page.wait_for_function("document.body.dataset.appView==='atlas'")
            page.locator('.app-nav [data-app-view="analysis"]').click()
            page.wait_for_function("document.body.dataset.appView==='analysis'")
            check(page.locator('#focus-month').input_value()=='2025-04','Returning to analysis preserves its selected period')
            page.evaluate('window.scrollTo(0,500)')
            check(abs(page.locator('#app-header').bounding_box()['y'])<1,'Global navigation stays visible while analysis scrolls')
            page.set_viewport_size({'width':390,'height':900});page.wait_for_timeout(600)
            check(not page.evaluate('document.documentElement.scrollWidth>innerWidth'),'Persistent shell and analysis fit a 390px viewport')
            page.screenshot(path=str(output/'analysis-mobile.png'),full_page=True)
            check(not report['javascript_errors'],'No unhandled browser errors across atlas, case and analysis navigation')
            report['status']='PASS';return report
        except Exception as error:
            report['status']='BLOCK';report['failure']=str(error)
            page.screenshot(path=str(output/'failure.png'),full_page=True)
            raise
        finally:
            (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            browser.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='http://31.97.72.56:18089')
    parser.add_argument('--local-web',action='store_true')
    parser.add_argument('--api-base',default='http://31.97.72.56:18090')
    parser.add_argument('--fires-base',default='https://nasa.aican.cloud')
    parser.add_argument('--output-dir',type=Path,default=Path('/tmp/nasa-shell-e2e'))
    parser.add_argument('--timeout',type=int,default=600000)
    args=parser.parse_args();server=None
    try:
        base=args.base_url
        if args.local_web:server,base=helper.local_server(args.api_base,args.fires_base)
        print(json.dumps(run(base,args.output_dir,args.timeout),ensure_ascii=False,indent=2))
    finally:
        if server:server.shutdown()
