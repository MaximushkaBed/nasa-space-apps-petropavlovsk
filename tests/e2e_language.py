"""Verify browser-language defaults, persistence and all three interface languages.

python tests/e2e_language.py --local-web
python tests/e2e_language.py --base-url https://nasa.aican.cloud
"""
import argparse
import re
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

from e2e_workbench import local_server


def expect_language(page, code, control='#app-language'):
    expect(page.locator('html')).to_have_attribute('lang', code)
    expect(page.locator(f'{control} [data-language="{code}"]')).to_have_attribute('aria-pressed', 'true')


def language(page, code, control='#app-language'):
    page.locator(f'{control} [data-language="{code}"]').click()
    expect_language(page, code, control)


def initial_languages(browser, base):
    atlas = f'{base}/?view=atlas'
    preference = "localStorage.getItem('nasa-space-apps-language')"
    for locale, code, demo in (
        ('ru-KZ', 'ru', 'Готовый пример'),
        ('en-GB', 'en', 'Example study'),
        ('kk-KZ', 'kk', 'Дайын мысал'),
        ('fr-FR', 'ru', 'Готовый пример'),
    ):
        page = browser.new_page(locale=locale)
        page.goto(atlas, wait_until='domcontentloaded')
        expect_language(page, code)
        expect(page.locator('#onboarding-demo')).to_have_text(demo)
        assert page.evaluate(preference) is None
        page.close()

    page = browser.new_page(locale='fr-FR')
    page.add_init_script("""Object.defineProperty(navigator, 'languages', {
        get: () => ['fr-FR', 'kk-Cyrl-KZ', 'en-GB']
    });""")
    page.goto(atlas, wait_until='domcontentloaded')
    expect_language(page, 'kk')
    assert page.evaluate(preference) is None

    language(page, 'en')
    assert page.evaluate(preference) == 'en'
    page.goto(atlas, wait_until='domcontentloaded')
    expect_language(page, 'en')
    page.reload(wait_until='domcontentloaded')
    expect_language(page, 'en')

    page.goto(f'{atlas}&lang=ru', wait_until='domcontentloaded')
    expect_language(page, 'ru')
    assert page.evaluate(preference) == 'en'
    page.goto(atlas, wait_until='domcontentloaded')
    expect_language(page, 'en')
    page.close()


def atlas_state(browser, base):
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.add_init_script("localStorage.setItem('nasa-space-apps-onboarding-v1', 'true')")
    page.goto(f'{base}/?view=atlas&lang=ru', wait_until='domcontentloaded')

    page.locator('#reset-map').click(timeout=25000)
    expect(page.locator('#selected-area-panel')).to_be_visible()
    date = page.locator('#world-date')
    day = '2025-04-12'
    assert date.input_value() != day
    date.fill(day)
    expect(page.locator('#fire-frame-date')).to_have_class('same-frame', timeout=25000)

    layers = page.locator('#map-layer-controls')
    open_layers = page.locator('#open-layers')
    open_layers.click()
    page.locator('#terrain-layer').check()
    page.locator('#terrain-opacity').fill('65')
    page.locator('#overlay-world-clouds').check()

    boundary = page.locator('#atlas-selection-clip path')
    expect(boundary).to_have_attribute('d', re.compile('^M.+Z$'))
    shape = boundary.get_attribute('d')
    terrain = page.locator('.leaflet-terrain-shading-pane > .leaflet-layer')
    calendar = page.locator('a[href="#activity-calendar"]')

    def expect_atlas_state(area):
        expect(page.locator('.app-nav [data-app-view="atlas"]')).to_have_attribute('aria-current', 'page')
        expect(date).to_have_value(day)
        expect(page.locator('#fire-frame-date')).to_have_class('same-frame')
        expect(page.locator('#area-name')).to_have_text(area)
        expect(boundary).to_have_attribute('d', shape)
        expect(page.locator('#terrain-layer')).to_be_checked()
        expect(page.locator('#terrain-opacity')).to_have_value('65')
        expect(terrain).to_have_css('opacity', '0.65')
        expect(page.locator('#overlay-world-clouds')).to_be_checked()

    languages = (
        ('en', 'North Kazakhstan Region', 'Activity calendar'),
        ('kk', 'Солтүстік Қазақстан облысы', 'Белсенділік күнтізбесі'),
        ('ru', 'Северо-Казахстанская область', 'Календарь активности'),
    )
    for code, area, _ in languages:
        language(page, code)
        expect(layers).to_be_visible()
        expect(open_layers).to_have_attribute('aria-expanded', 'true')
        expect_atlas_state(area)

    calendar.click()
    expect(page.locator('#study-calendar table')).to_be_visible(timeout=25000)
    for code, area, calendar_title in languages:
        language(page, code)
        expect(calendar).to_have_attribute('aria-expanded', 'true')
        expect(page.locator('#analysis-heading')).to_have_text(calendar_title)
        expect(page.locator('#study-calendar table')).to_be_visible()
        expect(page).to_have_url(re.compile(r'#activity-calendar$'))
        expect_atlas_state(area)
    page.close()


def municipal_search(browser, base):
    atlas = browser.new_page(viewport={'width': 1440, 'height': 900})
    atlas.add_init_script("localStorage.setItem('nasa-space-apps-onboarding-v1', 'true')")
    atlas.goto(f'{base}/?view=atlas&lang=ru', wait_until='domcontentloaded')
    atlas.locator('#area-search-mode').click(timeout=25000)
    query = atlas.locator('#area-query')
    query.fill('Лосс Анделес')
    query.press('Enter')
    atlas.get_by_role('button', name='Лос-Анджелес · Калифорния · США · Граница города').click()
    expect(atlas.locator('#area-name')).to_have_text('Лос-Анджелес')
    expect(atlas.locator('#area-radius-label')).to_be_hidden()
    geometry = atlas.request.get(f'{base}/data/atlas-boundaries/los-angeles.geojson').json()['geometry']
    selection = "JSON.parse(localStorage.getItem('nasa-space-apps-context-v1')).context.roi"
    assert atlas.evaluate(selection)['geometry'] == geometry
    atlas.close()

    workbench = browser.new_page(viewport={'width': 1440, 'height': 900})
    workbench.add_init_script("localStorage.setItem('nasa-space-apps-onboarding-v1', 'true')")
    workbench.goto(f'{base}/?view=analysis&lang=en', wait_until='domcontentloaded')
    expect(workbench.locator('#analysis-view')).to_have_attribute('data-bootstrap-pending', 'false', timeout=25000)
    query = workbench.locator('#analysis-territory-query')
    query.fill('Los Angeles, California')
    workbench.get_by_role('option', name='Los Angeles · California · United States · City boundary').click()
    expect(query).to_have_value('Los Angeles')
    assert workbench.evaluate(selection)['geometry'] == geometry
    workbench.close()


def global_city_search(browser, base):
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.add_init_script("localStorage.setItem('nasa-space-apps-onboarding-v1', 'true')")
    shape = {'type': 'Polygon', 'coordinates': [[[2.2, 48.8], [2.4, 48.8], [2.4, 48.9], [2.2, 48.8]]]}

    def requested(route, key):
        return parse_qs(urlsplit(route.request.url).query)[key][0]

    def geocoding(route):
        name = requested(route, 'name')
        if name == 'Atlas Fixture City':
            assert requested(route, 'countryCode') == 'FR'
        route.fulfill(json={'results': [{'name': name, 'longitude': 2.34, 'latitude': 48.85,
                                         'country': 'France', 'country_code': 'FR', 'feature_code': 'PPL'}]})

    def boundary(route):
        name = requested(route, 'name')
        if name == 'Atlas Fixture Outage':
            route.fulfill(status=503, json={'error': 'Unavailable'})
        else:
            route.fulfill(json={'geometry': shape if name == 'Atlas Fixture City' else None})

    page.route('https://geocoding-api.open-meteo.com/v1/search?**', geocoding)
    page.route('https://www.geoboundaries.org/api/current/gbOpen/FRA/ADM2/', lambda route: route.fulfill(status=404))
    page.route('**/api/v1/place-boundary?**', boundary)
    page.goto(f'{base}/?view=atlas&lang=en', wait_until='domcontentloaded')
    selection = "JSON.parse(localStorage.getItem('nasa-space-apps-context-v1')).context.roi"
    for name in ('Atlas Fixture City', 'Atlas Fixture Hamlet', 'Atlas Fixture Outage'):
        page.locator('#area-search-mode').click(timeout=25000)
        query = page.locator('#area-query')
        query.fill(f'{name}, Франция' if name == 'Atlas Fixture City' else name)
        query.press('Enter')
        page.get_by_role('button', name=f'{name} · France · Settlement').click()
        if name == 'Atlas Fixture Outage':
            expect(page.locator('#area-results')).to_have_text(
                'The city boundary catalogue is temporarily unavailable. Try searching again.')
            assert page.evaluate(selection)['name'] == 'Atlas Fixture Hamlet'
        else:
            expect(page.locator('#area-name')).to_have_text(name)
            roi = page.evaluate(selection)
            if name == 'Atlas Fixture City':
                assert roi['geometry'] == shape and 'circle' not in roi
            else:
                assert roi['circle'] == {'center': [2.34, 48.85], 'radius_km': 5}
                expect(page.locator('#area-radius')).to_have_value('5')
    page.close()


def desktop(browser, base):
    page = browser.new_page(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Qyzylorda')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(f'{base}/?view=atlas&lang=ru', wait_until='domcontentloaded')
    expect(page.locator('#onboarding-welcome')).to_be_visible()
    language(page, 'kk')
    expect(page.locator('#app-language')).to_have_attribute('aria-label', 'Интерфейс тілі')
    expect(page.locator('#onboarding-demo')).to_have_text('Дайын мысал')
    language(page, 'en')
    expect(page.locator('#onboarding-demo')).to_have_text('Example study')
    page.locator('#onboarding-skip').click()

    date = page.locator('#world-date')
    expect(date).to_be_enabled(timeout=25000)
    chosen_date = date.input_value()
    expect(page.locator('.app-nav [data-app-view="atlas"]')).to_have_text('Atlas')
    page.locator('#open-layers').click()
    expect(page.locator('#layers-title')).to_have_text('Map layers')
    expect(page.locator('label', has=page.locator('#overlay-world-clouds'))).to_have_text('Cloud cover')
    language(page, 'kk')
    expect(page.locator('#layers-title')).to_have_text('Карта қабаттары')
    expect(page.locator('label', has=page.locator('#overlay-world-clouds'))).to_have_text('Бұлттылық')
    expect(page.locator('#frame-date')).to_contain_text(re.compile(
        r'қаңтар|ақпан|наурыз|сәуір|мамыр|маусым|шілде|тамыз|қыркүйек|қазан|қараша|желтоқсан'))
    formatted = page.evaluate(r"""async () => {
        const {numberFormat, translate} = await import('./i18n.js');
        return translate(numberFormat().format(74578.25)).replace(/\s/g, ' ');
    }""")
    assert formatted == '74 578,25', formatted
    page.locator('#open-period').click()
    expect(page.locator('[data-period="month"]')).to_have_text('Ай')
    page.keyboard.press('Escape')

    page.locator('a[href="#activity-calendar"]').click()
    expect(page.locator('#study-calendar table')).to_be_visible(timeout=25000)
    expect(page.locator('#analysis-heading')).to_have_text('Белсенділік күнтізбесі')
    language(page, 'en')
    expect(page.locator('#analysis-heading')).to_have_text('Activity calendar')
    labels = page.locator('#study-calendar button[title]').evaluate_all(
        "buttons => buttons.map(button => button.title)")
    assert labels
    assert all(not re.search(r'[А-Яа-яЁё]', label) for label in labels)
    page.locator('a[href="#external-factors"]').click()
    expect(page.locator('#external-factors > div .matrix-grid table')).to_be_visible(timeout=25000)
    expect(page.locator('#analysis-heading')).to_have_text('Factor correlations')
    upload = page.locator('.matrix-import > details > summary')
    upload.click()
    page.locator('.matrix-file').set_input_files({
        'name': 'measurements.csv', 'mimeType': 'text/csv',
        'buffer': 'Date,Активность,Осадки\n2025-04-01,1,3\n2025-04-02,2,2\n2025-04-03,3,1\n'.encode('utf-8'),
    })
    page.locator('.matrix-file-mode').select_option('file')
    page.get_by_role('button', name='Calculate from file').click()
    result = page.locator('.matrix-file-result .matrix-grid table')
    expect(result).to_be_visible()
    expect(result.locator('thead th[scope="col"]').nth(1)).to_have_text('Активность')
    expect(page.locator('.matrix-file-result .matrix-pair-title')).to_have_text('Активность × Осадки')
    language(page, 'ru')
    expect(upload).to_contain_text('Свои данные')
    expect(result).to_be_visible()
    assert date.input_value() == chosen_date
    language(page, 'kk')
    expect(upload).to_contain_text('Өз деректеріңіз')
    expect(result).to_be_visible()
    expect(page.locator('.matrix-file-result .matrix-pair-title')).to_have_text('Активность × Осадки')
    expect(page.locator('.matrix-file-result .matrix-pair-summary')).to_contain_text('жұп')
    language(page, 'en')
    expect(upload).to_contain_text('Your data')
    expect(result).to_be_visible()
    expect(result.locator('thead th[scope="col"]').nth(2)).to_have_text('Осадки')

    page.locator('.app-nav [data-app-view="cases"]').click()
    expect(page.locator('#kishkenekol-case')).to_be_visible(timeout=25000)
    expect(page.locator('#kishkenekol-case')).to_contain_text('What happened southwest of Kishkenekol')
    language(page, 'kk')
    expect(page.locator('#kishkenekol-case')).to_contain_text('Кішкенекөлдің оңтүстік-батысында не болды?')
    language(page, 'en')
    page.locator('.app-nav [data-app-view="analysis"]').click()
    expect(page.locator('#analysis-form')).to_be_visible(timeout=25000)
    expect(page.locator('#preset option[value="sko"]')).to_have_text('North Kazakhstan Region')
    expect(page.locator('#study-next-note')).to_contain_text('First, check which data are in the archive.')
    query = page.locator('#analysis-territory-query')
    expect(query).to_be_enabled(timeout=25000)
    query.fill('Kazakhstan')
    page.locator('#analysis-territory-results button').first.wait_for()
    query.press('ArrowDown')
    page.keyboard.press('Enter')
    expect(page.locator('#analysis-territory-results')).to_be_hidden()
    expect(query).to_have_value('Kazakhstan')
    language(page, 'kk')
    expect(query).to_have_value('Қазақстан')
    expect(page.locator('#preset option[value="sko"]')).to_have_text('Солтүстік Қазақстан облысы')
    expect(page.locator('#territory-child')).to_contain_text('Ақмола облысы')
    expect(page.locator('#analysis-territory-context .territory-context-toggle')).to_have_text('Шекаралар мен атаулар')
    expect(page.locator('#analysis-map .leaflet-control-zoom-in')).to_have_attribute('aria-label', 'Картаны жақындату')
    page.locator('#app-method-open').click()
    expect(page.locator('#app-method-heading')).to_have_text('Әдіс және деректер')
    page.keyboard.press('Escape')
    language(page, 'ru')
    expect(query).to_have_value('Казахстан')
    language(page, 'en')
    page.locator('#app-method-open').click()
    expect(page.locator('#app-method-heading')).to_have_text('Method and data')
    page.keyboard.press('Escape')
    language(page, 'kk')
    expect(page.locator('label[for="territory-child"]')).to_have_text('Аумақ бөлігі')
    page.locator('#draw-circle').click()
    expect(page.locator('#selection-state')).to_contain_text('Шеңбер үшін алдымен ортасын')
    language(page, 'en')
    expect(page.locator('#selection-state')).to_contain_text('Circle: select its centre')
    expect(page.locator('#draw-circle')).to_have_attribute('aria-pressed', 'true')
    page.locator('#selection-cancel').click()
    language(page, 'kk')
    query.fill('Ұлыбритания')
    expect(page.locator('#analysis-territory-results button').first).to_have_text('Ұлыбритания')
    assert not errors, errors
    page.close()


def mobile(browser, base):
    for width in (320, 390):
        page = browser.new_page(viewport={'width': width, 'height': 820})
        page.add_init_script("localStorage.setItem('nasa-space-apps-onboarding-v1', 'true')")
        page.goto(f'{base}/?view=atlas&lang=kk', wait_until='domcontentloaded')
        expect(page.locator('#app-language [data-language="kk"]')).to_have_attribute('aria-pressed', 'true')
        for code in ('en', 'ru', 'kk'):
            language(page, code)
            assert page.evaluate('document.documentElement.scrollWidth === innerWidth')
            box = page.locator('#app-language').bounding_box()
            assert width - 20 <= box['x'] + box['width'] <= width
        page.reload(wait_until='domcontentloaded')
        expect(page.locator('#app-language [data-language="kk"]')).to_have_attribute('aria-pressed', 'true')
        page.close()


def example(browser, base, code, button, step):
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto(f'{base}/?view=atlas&lang={code}', wait_until='domcontentloaded')
    expect(page.locator('#onboarding-demo')).to_have_text(button)
    page.locator('#onboarding-demo').click()
    expect(page.locator('#analysis-form')).to_be_visible(timeout=25000)
    expect(page.locator('html')).to_have_attribute('lang', code)
    expect(page.locator('#onboarding-step-title')).to_have_text(step, timeout=25000)
    assert f'lang={code}' in page.url
    page.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='https://nasa.aican.cloud')
    parser.add_argument('--local-web', action='store_true')
    args = parser.parse_args()
    server, base = local_server(args.base_url, args.base_url) if args.local_web else (None, args.base_url)
    if server:
        server.handle_error = lambda *args: None
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            initial_languages(browser, base)
            atlas_state(browser, base)
            municipal_search(browser, base)
            global_city_search(browser, base)
            desktop(browser, base)
            mobile(browser, base)
            example(browser, base, 'en', 'Example study', 'Anomaly from the historical baseline')
            example(browser, base, 'kk', 'Дайын мысал', 'Тарихи деңгейден ауытқу')
            browser.close()
        print('PASS browser language and persistence, RU / EN / KK in onboarding, atlas state, calendar, matrix and file import, case study and area analysis')
    finally:
        if server:
            server.shutdown()
