"""Verify the bilingual atlas and language changes without loading a new page.

python tests/e2e_language.py --local-web
python tests/e2e_language.py --base-url https://nasa.aican.cloud
"""
import argparse
import re

from playwright.sync_api import expect, sync_playwright

from e2e_workbench import local_server


def language(page, code, control='#app-language'):
    page.locator(f'{control} [data-language="{code}"]').click()
    expect(page.locator('html')).to_have_attribute('lang', code)
    expect(page.locator(f'{control} [data-language="{code}"]')).to_have_attribute('aria-pressed', 'true')


def desktop(browser, base):
    page = browser.new_page(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Qyzylorda')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(f'{base}/?view=atlas&lang=ru', wait_until='domcontentloaded')
    expect(page.locator('#onboarding-welcome')).to_be_visible()
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
    page.locator('#open-period').click()
    expect(page.locator('[data-period="month"]')).to_have_text('Month')
    page.keyboard.press('Escape')

    page.locator('a[href="#activity-calendar"]').click()
    expect(page.locator('#study-calendar table')).to_be_visible(timeout=25000)
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
    language(page, 'en')
    expect(upload).to_contain_text('Your data')
    expect(result).to_be_visible()
    expect(result.locator('thead th[scope="col"]').nth(2)).to_have_text('Осадки')

    page.locator('.app-nav [data-app-view="cases"]').click()
    expect(page.locator('#kishkenekol-case')).to_be_visible(timeout=25000)
    expect(page.locator('#kishkenekol-case')).to_contain_text('What happened southwest of Kishkenekol')
    page.locator('.app-nav [data-app-view="analysis"]').click()
    expect(page.locator('#analysis-form')).to_be_visible(timeout=25000)
    expect(page.locator('#preset option[value="sko"]')).to_have_text('North Kazakhstan Region')
    expect(page.locator('#study-next-note')).to_contain_text('Choose the comparison conditions')
    query = page.locator('#analysis-territory-query')
    expect(query).to_be_enabled(timeout=25000)
    query.fill('Kazakhstan')
    page.locator('#analysis-territory-results button').first.wait_for()
    query.press('ArrowDown')
    page.keyboard.press('Enter')
    expect(page.locator('#analysis-territory-results')).to_be_hidden()
    expect(query).to_have_value('Kazakhstan')
    language(page, 'ru')
    expect(query).to_have_value('Казахстан')
    language(page, 'en')
    page.locator('#app-method-open').click()
    expect(page.locator('#app-method-heading')).to_have_text('Method and data')
    assert not errors, errors
    page.close()


def mobile(browser, base):
    for width in (320, 390):
        page = browser.new_page(viewport={'width': width, 'height': 820})
        page.add_init_script("localStorage.setItem('nasa-space-apps-onboarding-v1', 'true')")
        page.goto(f'{base}/?view=atlas&lang=en', wait_until='domcontentloaded')
        expect(page.locator('#app-language [data-language="en"]')).to_have_attribute('aria-pressed', 'true')
        assert page.evaluate('document.documentElement.scrollWidth === innerWidth')
        box = page.locator('#app-language').bounding_box()
        assert width - 20 <= box['x'] + box['width'] <= width
        page.close()


def example(browser, base):
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto(f'{base}/?view=atlas&lang=en', wait_until='domcontentloaded')
    expect(page.locator('#onboarding-demo')).to_have_text('Example study')
    page.locator('#onboarding-demo').click()
    expect(page.locator('#analysis-form')).to_be_visible(timeout=25000)
    expect(page.locator('html')).to_have_attribute('lang', 'en')
    expect(page.locator('#onboarding-step-title')).to_have_text('Anomaly from the historical baseline', timeout=25000)
    assert 'lang=en' in page.url
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
            desktop(browser, base)
            mobile(browser, base)
            example(browser, base)
            browser.close()
        print('PASS language switching in onboarding, atlas, calendar, matrix and file import, case study and area analysis')
    finally:
        if server:
            server.shutdown()
