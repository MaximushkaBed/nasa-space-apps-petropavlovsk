"""Real-browser acceptance for the NASA Space Apps workbench against a running preview/API.

Manual integration check (not a synthetic dataset or a unit-test mirror):
  python3 tests/e2e_workbench.py --base-url http://31.97.72.56:18089
  python3 tests/e2e_workbench.py --local-web --api-base http://31.97.72.56:18089
The second mode serves current web files and forwards API calls to the preview.
"""
import argparse
import csv
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import re
import threading
import time
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def local_server(api_base):
    class Proxy(SimpleHTTPRequestHandler):
        def forward(self):
            length = int(self.headers.get('Content-Length', '0'))
            body = self.rfile.read(length) if length else None
            headers = {'Accept': self.headers.get('Accept', 'application/json')}
            if self.headers.get('Content-Type'):
                headers['Content-Type'] = self.headers['Content-Type']
            request = Request(api_base.rstrip('/') + self.path, data=body,
                              headers=headers, method=self.command)
            try:
                response = urlopen(request, timeout=60)
            except HTTPError as error:
                response = error
            data = response.read()
            self.send_response(response.status)
            for name in ('Content-Type', 'Content-Disposition'):
                if value := response.headers.get(name):
                    self.send_header(name, value)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith('/api/'):
                self.forward()
            else:
                super().do_GET()

        def do_POST(self):
            if self.path.startswith('/api/'):
                self.forward()
            else:
                self.send_error(404)

        def log_message(self, fmt, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Proxy, directory=str(ROOT / 'web')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}'


def run(base_url, output, timeout):
    output.mkdir(parents=True, exist_ok=True)
    report = {'base_url': base_url, 'checks': [], 'javascript_errors': []}
    responses = []
    completed = []

    def check(condition, message):
        if not condition:
            raise AssertionError(message)
        report['checks'].append(message)
        print('PASS', message, flush=True)

    def wait_map(page):
        page.wait_for_function("/^\\d[\\d\\s,.]* ячеек/.test(document.querySelector('#map-count').textContent)", timeout=60000)
        check(page.locator('#retry-map').is_hidden(), 'Current map renders after source/period changes without an unrecovered service error')

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
        page.on('pageerror', lambda error: report['javascript_errors'].append(str(error)))

        def capture(response):
            if '/api/v1/' not in response.url:
                return
            responses.append({'url': response.url, 'status': response.status})
            if re.search(r'/api/v1/analyses/[0-9a-f]{32}$', response.url) and response.status == 200:
                try:
                    body = response.json()
                    if body.get('status') == 'done':
                        completed.append(body['result'])
                except Exception:
                    pass

        page.on('response', capture)
        try:
            page.goto(base_url, wait_until='domcontentloaded', timeout=40000)
            deadline = time.monotonic() + timeout / 1000
            while page.locator('#export-csv').is_disabled():
                if page.locator('#error-banner').is_visible():
                    raise AssertionError(page.locator('#error-banner').inner_text())
                if time.monotonic() > deadline:
                    raise AssertionError('The real analysis did not complete before timeout')
                page.wait_for_timeout(1000)
            page.wait_for_timeout(500)
            wait_map(page)
            check('NASA Space Apps' in page.title(), 'Existing NASA Space Apps project name is preserved')
            check(page.locator('#tab-calendar').get_attribute('aria-selected') == 'true', 'Calendar is the default analysis tab')
            check(page.locator('#view-calendar').is_visible(), 'Main calendar is visible after real data load')
            check(page.locator('.calendar-cell').count() >= 72, 'Calendar contains the requested years and months')
            map_box = page.locator('.map-frame').bounding_box()
            analysis_box = page.locator('.analysis-panel').bounding_box()
            check(map_box['x'] < analysis_box['x'] and abs(map_box['y'] - analysis_box['y']) < 90,
                  'Map is left of the calendar and analysis in the main desktop workspace')
            check(bool(completed), 'Application received an actual completed server analysis')
            result = completed[-1]
            (output / 'analysis-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
            platform = page.locator('#platform').input_value()
            weekly = result.get('weekly_profiles', {}).get(platform)
            check(bool(weekly) and len(weekly.get('weeks', [])) >= 52, 'API supplies an actual weekly seasonal profile')
            check(page.locator('#calendar-season-chart svg').count() == 1, 'Weekly seasonal graph is shown below the central calendar')
            check(page.locator('#activity-value').inner_text() != '—', 'Selected period has computed recorded activity')
            check('неизвестна' in page.locator('.quality-bar').inner_text().lower(), 'Unknown local observation coverage remains explicit')
            page.screenshot(path=str(output / 'desktop-calendar.png'), full_page=True)

            page.locator('.calendar-cell[data-month="2025-04"]').click()
            check(page.locator('#tab-series').get_attribute('aria-selected') == 'true' and 'selected' in page.locator('[data-step="week"]').get_attribute('class'), 'Calendar selection opens the corresponding weekly detail')
            page.wait_for_timeout(1000)
            check('апрель' in page.locator('#focus-month option:checked').inner_text().lower(), 'Selecting a historical month updates the inspected period')
            with page.expect_response(lambda r: '/api/v1/anomaly-map/' in r.url and r.status == 200, timeout=60000) as response:
                page.locator('#map-mode').select_option('anomaly')
            anomaly = response.value.json()
            check(response.value.status == 200, 'Spatial anomaly map is served by the analysis API')
            check(anomaly.get('status') == 'ok' and anomaly.get('baseline_years', 0) >= 3,
                  'Spatial anomaly comparison has at least three other baseline years')
            check(bool(anomaly.get('cells')) and all(len(cell) >= 8 for cell in anomaly.get('cells', [])), 'Anomaly map returns current, baseline and anomaly values per spatial cell')
            wait_map(page)
            check(page.locator('#day-range').is_disabled(), 'Daily playback cannot masquerade as a daily anomaly calculation')
            page.screenshot(path=str(output / 'spatial-anomalies.png'), full_page=True)

            page.locator('#map-mode').select_option('activity')
            page.wait_for_timeout(500)
            page.locator('#tab-series').click()
            page.locator('[data-step="day"]').click()
            page.locator('#day-range').fill('3')
            page.locator('#day-range').dispatch_event('input')
            page.wait_for_timeout(1000)
            check(page.locator('#day-label').inner_text().endswith('04-03'), 'Day drilldown selects the corresponding UTC frame')
            wait_map(page)
            check(any('day=2025-04-03' in r['url'] for r in responses), 'Daily selection requests matching observations for the map')

            page.locator('#tab-compare').click()
            page.locator('#compare-year-a').select_option('2024')
            page.locator('#compare-year-b').select_option('2025')
            page.wait_for_timeout(300)
            check(page.locator('#compare-chart svg polyline').count() >= 2, 'Manual comparison draws both selected years')
            metric_text = page.locator('#compare-metrics').inner_text()
            check(bool(metric_text.strip()), 'Year comparison exposes calculated season metrics')
            check(weekly.get('year_basis') == 'ISO' and 'ISO' in metric_text, 'Year comparison explicitly uses ISO years')
            for compared_year in ('2024', '2025'):
                metrics = weekly['year_metrics'][compared_year]
                check(metrics['start_date'] in metric_text and metrics['end_date'] in metric_text,
                      'Year comparison exposes actual interval bounds for ' + compared_year)
            partial_years = [year for year, metrics in weekly.get('year_metrics', {}).items()
                             if metrics.get('partial_year') and year in [o.get_attribute('value') for o in page.locator('#compare-year-a option').all()]]
            if partial_years:
                page.locator('#compare-year-a').select_option(partial_years[0])
                check('неполный' in page.locator('#compare-metrics').inner_text(), 'Partial ISO years are explicitly labelled')
                page.locator('#compare-year-a').select_option('2024')
            with page.expect_response(lambda r: '/api/v1/maps/' in r.url and r.status == 200 and parse_qs(urlsplit(r.url).query).get('month') == ['2024'], timeout=60000):
                page.locator('#compare-map-a').click()
            wait_map(page)
            check('ISO-год 2024' in page.locator('#map-period').inner_text(), 'Comparison map identifies the same ISO-year window')
            page.screenshot(path=str(output / 'year-comparison.png'), full_page=True)

            page.locator('#tab-validation').click()
            check(bool(page.locator('#validation-summary').inner_text().strip()), 'Holdout validation metrics are inspectable')
            accepted = bool(result.get('models', {}).get(platform, {}).get('accepted'))
            option = page.locator('#series-mode option[value="calibrated"]')
            valid_equivalents = any(r.get('model_valid') is True and isinstance(r.get('aqua_equivalent'), (float, int)) for r in result['monthly'] if r['platform'] == platform)
            correction_available = accepted and valid_equivalents
            check(option.is_enabled() == correction_available, 'Corrected mode requires a measured validation result and eligible monthly rows')
            if correction_available:
                page.locator('#series-mode').select_option('calibrated')
                page.locator('#tab-calendar').click()
                source_rows = [r for r in result['monthly'] if r['platform'] == platform]
                for row in source_rows:
                    cell = page.locator(f'.calendar-cell[data-month="{row["month"]}"]')
                    value = cell.inner_text()
                    if row.get('model_valid') and row.get('aqua_equivalent') is not None:
                        displayed = float(re.sub(r'[^0-9,.-]', '', value).replace(',', '.'))
                        if abs(displayed - row['aqua_equivalent']) > .11:
                            raise AssertionError('Corrected calendar differs from API equivalent for ' + row['month'])
                    elif value != '—':
                        raise AssertionError('Unvalidated corrected month was displayed as a measurement: ' + row['month'])
                check(True, 'Corrected calendar uses row-level API equivalents and leaves invalid months as gaps')
                page.locator('#series-mode').select_option('raw')
            page.locator('#platform').select_option('NOAA-21')
            page.wait_for_timeout(100)
            if not result.get('models', {}).get('NOAA-21', {}).get('accepted'):
                check(page.locator('#series-mode option[value="calibrated"]').is_disabled(), 'Unvalidated NOAA-21 cannot enter corrected mode')
            page.locator('#platform').select_option(platform)
            page.locator('#tab-calendar').click()
            with page.expect_download() as download:
                page.locator('#export-image').click()
            check(download.value.suggested_filename.startswith('nasa-space-apps-'), 'Image export keeps the NASA project name')
            image = output / 'calendar-export.svg'
            download.value.save_as(image)
            tree = ET.fromstring(image.read_bytes())
            text = ' '.join(tree.itertext())
            check(tree.tag.endswith('svg') and ('NASA Space Apps' in text or 'nasa-space-apps' in text), 'Image export is a real readable SVG of the analysis')
            check(platform in text and any(term in text.lower() for term in ('видим', 'coverage', 'облач', 'пригодность')), 'Image export includes source and observation-quality context')
            with page.expect_download() as download:
                page.locator('#export-csv').click()
            check('nasa' in download.value.suggested_filename.lower() and 'fire-seasons' not in download.value.suggested_filename.lower(), 'CSV export keeps the existing NASA project name')
            data = output / 'monthly.csv'
            download.value.save_as(data)
            rows = list(csv.DictReader(io.StringIO(data.read_text(encoding='utf-8-sig'))))
            check(len(rows) >= 72 and 'local_coverage' in rows[0], 'CSV exports actual rows and quality/provenance columns')
            check(all(row['local_coverage'] == 'unknown' for row in rows), 'Export does not invent clear-sky coverage')

            wait_map(page)
            page.set_viewport_size({'width': 390, 'height': 900})
            page.wait_for_timeout(700)
            check(not page.evaluate('document.documentElement.scrollWidth > innerWidth'), '390px mobile view has no horizontal overflow')
            page.screenshot(path=str(output / 'mobile.png'), full_page=True)
            # Regression R6: a response from an older ROI must not repopulate the map.
            page.set_viewport_size({'width': 1440, 'height': 1000})
            held = []
            page.route('**/api/v1/maps/**', lambda route: held.append(route))
            page.locator('#map-mode').select_option('activity')
            page.locator('#focus-month').select_option('2025-04')
            limit = time.monotonic() + 10
            while not held and time.monotonic() < limit:
                page.wait_for_timeout(100)
            check(bool(held), 'Race test intercepts an in-flight map response')
            old_response = held[-1].fetch()
            check(old_response.ok, 'Delayed map response contains actual valid API data')
            page.locator('#preset').select_option('california')
            page.wait_for_timeout(100)
            page.evaluate('''() => {
                window.__staleLayerAdds=0;
                const original=L.LayerGroup.prototype.addLayer;
                L.LayerGroup.prototype.addLayer=function(layer){
                    window.__staleLayerAdds++;return original.call(this,layer);
                };
            }''')
            for route in held:
                try:
                    route.fulfill(response=old_response)
                except Exception:
                    pass  # AbortController may already have cancelled the old request.
            page.wait_for_timeout(700)
            check(not page.locator('#map-count').inner_text().strip(), 'Changing ROI keeps old map counts cleared after a delayed response')
            check(page.evaluate('window.__staleLayerAdds') == 0, 'A stale response cannot redraw old cells under the new ROI')
            page.unroute('**/api/v1/maps/**')
            page.locator('#draw-area').click()
            page.locator('#analysis-map').click(position={'x': 90, 'y': 120})
            page.locator('#analysis-map').click(position={'x': 260, 'y': 230})
            check(page.locator('#preset').input_value() == 'custom' and 'прямоугольнику' in page.locator('#area-note').inner_text(), 'Drawing a map rectangle switches to an explicitly labelled custom area')
            check(float(page.locator('#west').input_value()) < float(page.locator('#east').input_value()) and float(page.locator('#south').input_value()) < float(page.locator('#north').input_value()), 'Custom rectangle writes valid geographic bounds')
            # R7: a half-finished rectangle cannot change the area of a running job.
            pending_posts = []
            page.route('**/api/v1/analyses', lambda route: pending_posts.append(route))
            page.locator('#draw-area').click()
            page.locator('#analysis-map').click(position={'x': 130, 'y': 160})
            page.locator('#run').click()
            deadline = time.monotonic() + 10
            while not pending_posts and time.monotonic() < deadline:
                page.wait_for_timeout(100)
            check(bool(pending_posts) and page.locator('#run').is_disabled(), 'Drawing race test holds a submitted analysis while busy')
            submitted = pending_posts[0].request.post_data_json
            page.locator('#analysis-map').click(position={'x': 300, 'y': 300})
            check(page.locator('#preset').input_value() == submitted['preset'] and
                  [float(page.locator('#' + key).input_value()) for key in ('west', 'south', 'east', 'north')] == submitted['bbox'],
                  'A second rectangle corner cannot change the submitted analysis area while busy')
            check(page.locator('#draw-instruction').is_hidden(), 'Starting an analysis exits unfinished drawing mode')
            # Failure injection verifies a failed request does not leave the form locked.
            for route in pending_posts:
                route.fulfill(status=503, content_type='application/json', body='{"error":"Проверка недоступного сервиса"}')
            page.locator('#error-banner').wait_for(state='visible')
            check('Проверка недоступного сервиса' in page.locator('#error-banner').inner_text(), 'A failed request exposes the service error to the analyst')
            check(page.locator('#run').is_enabled() and page.locator('#export-csv').is_disabled(), 'Failure releases the analysis form and keeps stale exports unavailable')
            page.unroute('**/api/v1/analyses')
            check(not report['javascript_errors'], 'No unhandled JavaScript errors across the analysis workflow')
            report.update(status='PASS', raw_analysis_rows=len(result['monthly']), csv_rows=len(rows), platform=platform,
                          snapshot_at=result['snapshot_at'], completed_at=time.time())
            return report
        except Exception as error:
            report.update(status='BLOCK', failure=str(error))
            page.screenshot(path=str(output / 'failure.png'), full_page=True)
            raise
        finally:
            (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://31.97.72.56:18089')
    parser.add_argument('--api-base', default='http://31.97.72.56:18089')
    parser.add_argument('--local-web', action='store_true')
    parser.add_argument('--output-dir', type=Path, default=Path('/tmp/nasa-workbench-e2e'))
    parser.add_argument('--timeout', type=int, default=240000)
    args = parser.parse_args()
    server = None
    try:
        base = args.base_url
        if args.local_web:
            server, base = local_server(args.api_base)
        print(json.dumps(run(base, args.output_dir, args.timeout), ensure_ascii=False, indent=2))
    finally:
        if server:
            server.shutdown()
