"""Exercise client-side CSV and Excel matrices with the published atlas series.

python tests/e2e_matrix_file.py --local-web
python tests/e2e_matrix_file.py --base-url https://nasa.aican.cloud
"""
import argparse
import calendar
from collections import defaultdict
import gzip
import json
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright

from e2e_workbench import local_server


def published_fire(api_base, snapshot='world-atlas'):
    with urlopen(f'{api_base}/data/{snapshot}.json.gz', timeout=45) as response:
        published = json.loads(gzip.decompress(response.read()))
    series = published['matrix']['result']['time_series']
    return list(zip(series['dates'], series['fire']['NOAA-20']))


def csv_upload(target, name, text):
    target.set_input_files({'name': name, 'mimeType': 'text/csv', 'buffer': text.encode('utf-8')})


def select_fields(scope, *names):
    labels = scope.locator('.matrix-file-columns label')
    for label in labels.all():
        label.get_by_role('checkbox').set_checked(label.inner_text() in names)


def check_pair(scope, left, right, rho, count):
    result = scope.locator('.matrix-file-result')
    button = result.get_by_role('button', name=f'{left} и {right}:', exact=False)
    expect(button.locator('strong')).to_have_text(rho)
    expect(button.locator('small')).to_have_text(f'n {count}')
    button.click()
    expect(result.locator('.matrix-pair-title')).to_have_text(f'{left} × {right}')
    expect(result.locator('.matrix-scatter circle')).to_have_count(count)


def exercise(page, base, fire, regional):
    page.goto(f'{base}/?view=atlas', wait_until='domcontentloaded')
    page.get_by_role('link', name='Внешние связи').click()
    scope = page.locator('.matrix-import')
    scope.locator('summary').click()
    file = scope.locator('.matrix-file')
    mode = scope.locator('.matrix-file-mode')
    run = scope.locator('.matrix-file-calculate')

    csv_upload(file, 'русские-числа.csv',
               '\ufeffДата;Наблюдение;Проверка;Район\r\n12.04.2025;"1,2";4;"СКО; район А"\r\n'
               '13.04.2025;"2,5";3;Б\r\n14.04.2025;3;2;В\r\n'
               '15.04.2025;4;1;Г\r\n16.04.2025;5;;Д\r\n')
    expect(mode).to_be_visible(timeout=15000)
    mode.select_option('file')
    select_fields(scope, 'Наблюдение', 'Проверка')
    run.click()
    check_pair(scope, 'Наблюдение', 'Проверка', '-1', 4)

    excel = page.evaluate("""async () => {
        const x = document.createElement('script');
        x.src = '/vendor/sheetjs-0.20.3.min.js';
        await new Promise((resolve,reject) => {x.onload=resolve;x.onerror=reject;document.head.append(x)});
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), 'Пустой');
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
            ['Дата','Уровень','Сток'],
            [new Date('2024-01-01'), 0, 10],
            [new Date('2024-02-01'), 2, 20],
            [new Date('2024-03-01'), 2, 20],
            [new Date('2024-04-01'), 3, 30]
        ]), 'Измерения');
        return Object.fromEntries(['xlsx','xls'].map(bookType=>[bookType,
            Array.from(new Uint8Array(XLSX.write(book,{type:'array',bookType})))]));
    }""")
    for extension, content in excel.items():
        file.set_input_files({'name': f'река.{extension}', 'mimeType': 'application/octet-stream', 'buffer': bytes(content)})
        sheet = scope.locator('.matrix-sheet')
        expect(sheet).to_be_visible()
        sheet.select_option('Измерения')
        expect(scope.locator('.matrix-date-column')).to_have_value('0')
        select_fields(scope, 'Уровень', 'Сток')
        run.click()
        check_pair(scope, 'Уровень', 'Сток', '1', 4)
    print('PASS CSV with Cyrillic, semicolon, decimal commas and missing pairs; multi-sheet Excel with dates and tied ranks', flush=True)

    daily = [(d, count) for d, count in fire if count is not None and d.startswith('2025')][:40]
    assert len(daily) == 40
    payload = 'date,Инверсный ряд\n' + '\n'.join(f'{day},{-value}' for day, value in daily)
    payload += '\n2039-01-01,5\n2025-02-30,5\n'
    csv_upload(file, 'дни.csv', payload)
    expect(scope.locator('.matrix-file-columns')).to_contain_text('Инверсный ряд')
    mode.select_option('atlas')
    expect(scope.locator('.matrix-import-atlas')).to_contain_text('NOAA-20', timeout=35000)
    expect(run).to_be_enabled()
    run.click()
    expect(scope.locator('.matrix-file-status')).to_contain_text('Совпало 40 из 41')
    check_pair(scope, 'Обнаруженная активность', 'Инверсный ряд', '-1', 40)

    groups = defaultdict(list)
    for day, value in fire:
        groups[day[:7]].append(value)
    months = []
    for month, values in groups.items():
        year, n = map(int, month.split('-'))
        if month.startswith('2025') and len(values) == calendar.monthrange(year, n)[1] and None not in values:
            months.append((month, sum(values)))
    assert len(months) >= 3
    csv_upload(file, 'месяцы.csv', 'Месяц;Показатель\n' + '\n'.join(f'{month};{total}' for month, total in months))
    expect(scope.locator('.matrix-file-columns')).to_contain_text('Показатель')
    expect(scope.locator('.matrix-file-grain')).to_have_value('month')
    run.click()
    check_pair(scope, 'Обнаруженная активность', 'Показатель', '1', len(months))
    print('PASS joins to published FIRMS data by day and complete month, excludes unmatched and invalid dates', flush=True)

    page.locator('#reset-map').click()
    page.evaluate("""() => {
        for (const [id, value] of Object.entries({
            'study-start':'2022-01-01', 'study-end':'2025-12-31',
            'study-baseline-start':'2022', 'study-baseline-end':'2024'
        })) document.getElementById(id).value = value;
        document.getElementById('study-baseline-end').dispatchEvent(new Event('change'));
    }""")
    page.get_by_role('link', name='Внешние связи').click()
    expect(scope.locator('.matrix-file-result')).to_be_hidden()
    expect(page.locator('#study-status')).to_contain_text('Готовый расчёт СКО', timeout=20000)
    regional_days = [(day, value) for day, value in regional if value is not None and day.startswith('2025-04')][:30]
    if len(regional_days) < 30:
        regional_days = [(day, value) for day, value in regional if value is not None and day.startswith('2025')][:40]
    assert len(regional_days) >= 30
    csv_upload(file, 'ряд-ско.csv', 'Дата;Показатель СКО\n' + '\n'.join(f'{day};{value}' for day, value in regional_days))
    expect(scope.locator('.matrix-file-columns')).to_contain_text('Показатель СКО')
    expect(run).to_be_enabled()
    run.click()
    check_pair(scope, 'Обнаруженная активность', 'Показатель СКО', '1', len(regional_days))
    print('PASS territory changes clear previous joins and bind to the prepared SKO matrix', flush=True)


def run(base, api_base):
    fire = published_fire(api_base)
    regional = published_fire(base, 'sko-study')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={'width': 390, 'height': 844}, timezone_id='Asia/Qyzylorda')
        page.add_init_script("localStorage.setItem('nasa-space-apps-onboarding-v1', 'true')")
        errors, posts = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: posts.append(request.url) if request.method == 'POST' else None)
        exercise(page, base, fire, regional)
        assert not posts, posts
        assert not errors, errors
        assert page.evaluate('document.documentElement.scrollWidth === innerWidth')
        browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='https://nasa.aican.cloud')
    parser.add_argument('--local-web', action='store_true')
    args = parser.parse_args()
    server, base = local_server(args.base_url, args.base_url) if args.local_web else (None, args.base_url)
    if server:
        server.handle_error = lambda *args: None
    try:
        run(base, args.base_url)
    finally:
        if server:
            server.shutdown()
