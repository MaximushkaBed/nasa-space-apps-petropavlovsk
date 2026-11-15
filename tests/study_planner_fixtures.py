"""Small, deliberately synthetic UI fixtures; never scientific validation data.

The browser test serves the real application and substitutes only HTTP responses.
These fixtures describe an API contract, not the planner's implementation.
"""
import calendar
from copy import deepcopy

PLATFORMS = ['Aqua', 'Terra', 'Suomi-NPP', 'NOAA-20', 'NOAA-21']
JOB_ID = 'a' * 32
EXTRACT_ID = 'b' * 32
PRESETS = [
    {'id': 'sko', 'name': 'Северо-Казахстанская область', 'bbox': [65.9, 52.2, 74.3, 55.5]},
    {'id': 'california', 'name': 'Калифорния · окно исследования', 'bbox': [-124.5, 32.5, -114, 42]},
    {'id': 'brazil', 'name': 'Мату-Гросу · окно исследования', 'bbox': [-61.5, -18, -50, -7]},
    {'id': 'canada', 'name': 'Альберта · окно исследования', 'bbox': [-120, 49, -110, 60]},
]
HOLE = {'type': 'Polygon', 'coordinates': [
    [[-60, -17], [-54, -17], [-54, -10], [-60, -10], [-60, -17]],
    [[-58, -15], [-58, -12], [-56, -12], [-56, -15], [-58, -15]],
]}
CIRCLE = {'center': [-120, 38], 'radius_km': 25}


def context(shape='hole', platform='NOAA-20'):
    roi = {'preset': 'custom', 'name': 'Synthetic Brazil polygon with a hole',
           'bbox': [-60, -17, -54, -10], 'geometry': deepcopy(HOLE), 'source': 'qa-fixture'}
    if shape in ('circle', 'dateline'):
        roi = {'preset': 'custom', 'name': 'Synthetic California circle',
               # Fixed expected extent of the server's canonical 128-vertex circle.
               # An arbitrary display box would not represent a real saved config.
               'bbox': [-120.28531258680533, 37.775169909068865,
                        -119.71468741319465, 38.224830090931135],
               'circle': deepcopy(CIRCLE), 'source': 'qa-fixture'}
        if shape == 'dateline':
            roi.update(name='Synthetic dateline circle',
                       bbox=[-180, 49.370475745392824, 180, 50.62952425460718],
                       circle={'center': [179.8, 50], 'radius_km': 70})
    return {'roi': roi, 'history': {'start': '2020-01-01', 'end': '2025-12-31'},
            'baseline': {'start': 2020, 'end': 2023},
            'focus': {'start': '2025-04-01', 'end': '2025-04-30', 'basis': 'UTC', 'grain': 'month'},
            'platform': platform, 'quality': 'sp', 'daynight': 'N', 'grid_km': 10}


def config_from_context(value):
    roi = value['roi']
    return {'preset': roi['preset'], 'bbox': deepcopy(roi['bbox']),
            **{key: deepcopy(roi[key]) for key in ('circle', 'geometry') if key in roi},
            'roi_name': roi['name'], 'roi_source': roi['source'],
            'start': value['history']['start'], 'end': value['history']['end'],
            'baseline_start': value['baseline']['start'], 'baseline_end': value['baseline']['end'],
            'grid_km': value['grid_km'], 'quality': value['quality'], 'daynight': value['daynight']}


def settings():
    return {'presets': deepcopy(PRESETS), 'platforms': PLATFORMS,
            'start': '2000-11-01', 'end': '2026-11-14', 'rows': 1000,
            'snapshot_at': '2026-11-14T00:00:00Z',
            'region_geometry': {'type': 'Polygon', 'coordinates': [[[66, 52.3], [74, 52.3], [74, 55], [66, 55], [66, 52.3]]]}}


def proposal(config, question='anomaly', platform='NOAA-20', mode='normal'):
    config = deepcopy(config)
    if platform == 'auto' and mode == 'normal':
        response = proposal(config, question, 'Aqua')
        response['platform'] = 'auto'
        automatic = response['options'][0]
        automatic.update(id='same-platform-Aqua', title='Synthetic one-source Aqua history')
        automatic['changes'] = [{'field': 'platform', 'from': 'auto', 'to': 'Aqua',
                                 'reason': 'Один исходный ряд; разные спутники не суммируются.'}]
        manual = deepcopy(automatic)
        manual.update(id='current-request', platform='auto', status='unavailable',
                      reason='Сначала выберите один источник.', changes=[])
        response['options'] = [automatic, manual]
        response['recommended_option_id'] = automatic['id']
        return response
    available = platform in PLATFORMS and mode != 'no-sp'
    option = {'id': 'current-request', 'title': 'Synthetic original conditions',
              'description': 'Предварительный план; региональная модель ещё не проверена.',
              'platform': platform, 'config': config, 'changes': [],
              'limitations': ['Локальная видимость неизвестна.', 'Наличие глобального продукта не доказывает локальное покрытие.'],
              'status': 'proposed' if available else 'unavailable',
              'reason': None if available else 'Нет стандартных SP-данных выбранного спутника.'}
    alternatives = []
    if mode == 'no-sp':
        option['id'] = 'same-platform-' + platform
        manual = deepcopy(option)
        manual.update(id='current-request', title='Synthetic manual conditions', status='proposed',
                      description='Ручное исследование без обещания пригодности. Нет доступного SP-ряда; возможны пропуски.',
                      reason='Можно проверить исходный ряд, не считать отсутствие данных нулём.')
        alternatives.append(manual)
    if mode == 'normal' and available:
        alternative = deepcopy(option)
        alternative.update(id='same-platform-longer-history', title='Synthetic extended history')
        alternative['config']['start'] = '2018-04-01'
        alternative['config']['baseline_start'] = 2019
        alternative['changes'] = [
            {'field': 'start', 'from': config['start'], 'to': '2018-04-01', 'reason': 'Больше доступных лет истории.'},
            {'field': 'baseline_start', 'from': config['baseline_start'], 'to': 2019, 'reason': 'Дополнительный базовый год.'}]
        alternatives.append(alternative)
    return {'version': 1, 'question': question, 'platform': platform,
            'requested_config': config,
            'availability': {'source': 'published-world-calendar', 'revision': 'synthetic-ui-fixture',
                             'snapshot_at': '2026-11-14T00:00:00Z',
                             'status': 'available', 'scope': 'global-product-presence', 'local_coverage': 'unknown',
                             'platforms': [{'platform': platform, 'first_month': '2018-04', 'last_month': '2026-11',
                                            'sp_first_month': '2018-04' if available else None,
                                            'sp_last_month': '2025-12' if available else None,
                                            'eligible_sp_years': list(range(2020, 2026)) if available else []}]},
            'recommended_option_id': option['id'] if available else 'current-request' if mode == 'no-sp' else None,
            'options': [option, *alternatives],
            'warnings': ['Предварительные условия — не подтверждение пригодности региональной калибровки.']}


def analysis(config):
    """A rejected model with one usable and one unusable target month."""
    monthly = []
    for year in range(2020, 2026):
        for month in (1, 4):
            days = calendar.monthrange(year, month)[1]
            for platform in PLATFORMS:
                limited = year == 2025 and month == 4
                monthly.append({'month': f'{year}-{month:02}', 'platform': platform,
                                'cells': 60 if limited else 10, 'points': 120 if limited else 20,
                                'baseline': None if limited else 8, 'anomaly_pct': None if limited else 25,
                                'percentile': None if limited else 75, 'baseline_years': 2 if limited else 3,
                                'baseline_year_ids': [2020, 2021] if limited else [2020, 2021, 2022],
                                'comparison_status': 'insufficient_baseline' if limited else 'ok',
                                'eligible_days': days, 'available_days': days, 'sp_days': days, 'calendar_days': days,
                                'coverage_pct': 100, 'local_coverage': 'unknown', 'partial': False,
                                'model_valid': False, 'aqua_equivalent': None})
    models = {p: {'accepted': False, 'coefficient': None, 'fit_months': 6, 'test_months': 2,
                  'fit_start': 2020, 'fit_end': 2023, 'mae_before': 8, 'mae_after': 9,
                  'seasonal_mae': 5, 'bias_pct': 40, 'pairs': [], 'checks': {'enough_fit': False}}
              for p in PLATFORMS if p != 'Aqua'}
    return {'config': deepcopy(config), 'extract_id': EXTRACT_ID, 'analysis_version': 'synthetic-ui-v1',
            'snapshot_at': '2026-11-14T00:00:00Z', 'calculated_at': '2026-11-15T00:00:00Z',
            'monthly': monthly, 'daily': [], 'availability': [], 'models': models,
            'profiles': {p: {'high_activity_months': [4], 'months': []} for p in PLATFORMS},
            'weekly_profiles': {}, 'provenance': {'fixture': 'SYNTHETIC UI ONLY'}}


def assessment(question='anomaly', platform='NOAA-20', month='2025-04'):
    limited = month == '2025-04' or question == 'sensor-transition'
    return {'version': 1, 'question': question, 'platform': platform,
            'status': 'limited' if limited else 'ready',
            'title': 'Недостаточно данных для выбранного периода' if limited else 'Историческое сравнение доступно',
            'summary': 'В выбранном месяце только два других базовых года; нужно три.' if limited else 'Выбранный месяц имеет три сопоставимых года.',
            'reasons': ['insufficient_baseline'] if limited else [],
            'facts': {'analysis_id': JOB_ID, 'analysis_version': 'synthetic-ui-v1', 'extract_id': EXTRACT_ID,
                      'snapshot_at': '2026-11-14T00:00:00Z', 'source_sha256': ['synthetic-not-real-data'],
                      'target_months': [month], 'comparable_months': [] if limited else [month],
                      'unavailable_months': [month] if limited else [], 'baseline_year_ids': [2020, 2021] if limited else [2020, 2021, 2022],
                      'comparison_status': {'insufficient_baseline': 1} if limited else {'ok': 1},
                      'model_accepted': False, 'model_checks': {'enough_fit': False}},
            'global_availability': {'scope': 'global-product-presence', 'status': 'observed'},
            'local_coverage': 'unknown',
            'limitations': ['Локальная видимость неизвестна.', 'Синтетический UI fixture не доказывает реальную пригодность анализа.']}
