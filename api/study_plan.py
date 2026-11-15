"""Small, read-only study proposals and assessment of completed regional results.

The calendar is a global product-presence index. It is neither a local coverage
mask nor a calibration result. This module never opens the observation archive,
creates jobs, downloads data, or applies a cross-platform coefficient.
"""
import calendar
from collections import Counter
from copy import deepcopy
from datetime import date
import hashlib
import json
import math
import re

from api.analysis import PLATFORMS, month_keys

VERSION = 1
QUESTIONS = ('anomaly', 'compare-years', 'sensor-transition')
LOCAL_LIMIT = 'Глобальное наличие продукта не подтверждает пригодное наблюдение территории: локальное покрытие и облачность неизвестны.'
MASK_LIMIT = 'Месячные метаданные дают только предварительный подбор; точные общие даты и минимум три других базовых года проверяются после расчёта.'
NRT_LIMIT = 'SP и предварительные NRT не являются общим проверенным режимом; смешанные месяцы не подтверждают пригодность SP-коррекции.'


def validate_choices(question, platform, *, allow_auto=True):
    if question not in QUESTIONS:
        raise ValueError('Неизвестный исследовательский вопрос.')
    if platform not in (*PLATFORMS, 'auto') or platform == 'auto' and not allow_auto:
        raise ValueError('Выберите один спутник для исследования.' if not allow_auto else 'Неизвестный спутник.')


def load_calendar(cache, root):
    """Read one atomically published small JSON snapshot, with an explicit seed fallback."""
    for path, source in ((cache / 'world-calendar/published.json', 'published-world-calendar'),
                         (root / 'web/data/world-calendar.json', 'seed-world-calendar')):
        try:
            content = path.read_bytes()
            value = json.loads(content)
            if not isinstance(value, dict) or not isinstance(value.get('monthly'), list):
                continue
            # A checksum identifies the exact bytes even in older snapshots without revision.
            revision = value.get('revision') or hashlib.sha256(content).hexdigest()
            return value, source, revision
        except (OSError, ValueError, TypeError):
            continue
    return {}, 'unknown', None


def _rows(snapshot):
    result = {}
    for row in snapshot.get('monthly', []):
        if not isinstance(row, dict) or row.get('platform') not in PLATFORMS:
            continue
        key = row.get('month', '')
        if not isinstance(key, str) or not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', key):
            continue
        n = row.get('eligible_days')
        if isinstance(n, bool) or not isinstance(n, int) or not 0 <= n <= calendar.monthrange(int(key[:4]), int(key[5:]))[1]:
            continue
        result[row['platform'], key] = row
    return result


def _present(row):
    # Zero recorded detections on a globally present product is distinct from absence.
    return row is not None and row['eligible_days'] > 0 and row.get('points') is not None


def _complete(row, quality='sp'):
    if not _present(row) or row.get('partial', True):
        return False
    expected = calendar.monthrange(int(row['month'][:4]), int(row['month'][5:]))[1]
    if row['eligible_days'] != expected:
        return False
    # Do not infer SP-only support from a mixed-month aggregate.
    return quality == 'all' or row.get('preliminary') is False and row.get('nrt_points', 0) == 0


def _summary(rows):
    platforms = []
    for platform in PLATFORMS:
        observed = sorted(key for (p, key), row in rows.items() if p == platform and _present(row))
        sp = sorted(key for (p, key), row in rows.items() if p == platform and _complete(row))
        platforms.append(dict(platform=platform, first_month=observed[0] if observed else None,
                              last_month=observed[-1] if observed else None,
                              sp_first_month=sp[0] if sp else None, sp_last_month=sp[-1] if sp else None,
                              eligible_sp_years=sorted({int(key[:4]) for key in sp}),
                              preliminary_months=sum(bool(row.get('preliminary')) for (p, _), row in rows.items() if p == platform and _present(row))))
    return platforms


def _target_keys(config):
    """Proposal focus is the last selected calendar year, explicitly stated in description."""
    end = date.fromisoformat(config['end'])
    start = max(date.fromisoformat(config['start']), date(end.year, 1, 1))
    return list(month_keys(start, end))


def _changes(old, new, old_platform, platform):
    reasons = {
        'start': 'История расширена, чтобы включить предложенные базовые годы.',
        'end': 'Конец перенесён на последний полный месяц, поддержанный выбранным режимом в мировом индексе.',
        'baseline_start': 'База подобрана по наличию продукта в тех же календарных месяцах; точные маски ещё не проверены.',
        'baseline_end': 'Оцениваемый последний год оставлен вне предложенной базы.',
    }
    changes = [dict(field=k, **{'from': old[k], 'to': new[k]}, reason=reason)
               for k, reason in reasons.items() if old[k] != new[k]]
    if platform != old_platform:
        changes.append(dict(field='platform', **{'from': old_platform, 'to': platform},
                            reason='Выбран один исходный ряд: наблюдения разных спутников не суммируются.'))
    return changes


def _candidate(config, question, platform, requested_platform, rows):
    proposed = deepcopy(config)
    limitations = [LOCAL_LIMIT, MASK_LIMIT]
    if config['quality'] == 'all':
        limitations.append(NRT_LIMIT)
    source_rows = {key: row for (p, key), row in rows.items() if p == platform}
    in_history = {key: row for key, row in source_rows.items() if config['start'][:7] <= key <= config['end'][:7]}
    supported = sorted(key for key, row in source_rows.items() if _complete(row, config['quality']))
    reason = None
    score = 0
    if question == 'anomaly':
        target = _target_keys(proposed)
        if not all(_complete(source_rows.get(key), config['quality']) for key in target):
            # Offer changed dates only as a visible option; never modify requested_config.
            last = next((key for key in reversed(supported) if key <= config['end'][:7]), None)
            if last is not None and last >= config['start'][:7]:
                year, month = map(int, last.split('-'))
                proposed['end'] = date(year, month, calendar.monthrange(year, month)[1]).isoformat()
                target = _target_keys(proposed)
            if not all(_complete(source_rows.get(key), config['quality']) for key in target):
                reason = 'Выбранный период не подтверждён полными месячными метаданными этого источника и режима; отсутствие продукта не означает нулевую активность.'
        months = {int(key[5:]) for key in target}
        target_year = int(proposed['end'][:4])
        years = sorted({int(key[:4]) for key in supported if int(key[:4]) < target_year
                        and all(_complete(source_rows.get(f'{int(key[:4]):04}-{month:02}'), config['quality']) for month in months)})
        eligible = [y for y in years if proposed['baseline_start'] <= y <= proposed['baseline_end']
                    and proposed['start'] <= f'{y:04}-{min(months):02}-01']
        if proposed['baseline_end'] > target_year:
            eligible = []
        if len(eligible) < 3:
            selected = years[-4:]
            if len(selected) >= 3:
                proposed['baseline_start'], proposed['baseline_end'] = min(selected), max(selected)
                proposed['start'] = min(proposed['start'], f'{min(selected):04}-01-01')
                eligible = selected
            else:
                reason = reason or 'Для тех же календарных месяцев не найдены минимум три других базовых года этого спутника. Даты запуска прибора не заменяют наличие продукта.'
        score = len(eligible)
        title = f'{platform}: необычность последнего выбранного года'
        description = 'Исходный ряд одного спутника; последний выбранный год сравнивается с теми же частями месяцев в других годах. Условия предварительные.'
        if proposed['end'] != config['end']:
            limitations.append(f'Исходный конец {config["end"]} не поддержан полным SP-месяцем или имеет предварительные/неполные данные. Этот вариант явно меняет конец на {proposed["end"]}.')
    elif question == 'compare-years':
        eligible = [key for key, row in in_history.items() if _complete(row, config['quality'])]
        score = len(eligible)
        if len({key[:4] for key in eligible}) < 2:
            reason = 'В выбранной истории метаданные не подтверждают два года с полными месяцами одного источника. Ручной исходный ряд остаётся доступен.'
        title = f'{platform}: сравнение двух лет'
        description = 'История и база сохранены. После расчёта выберите два года в существующем сравнении; используется один исходный спутниковый ряд.'
        limitations.append('Наличие отдельных полных месяцев в двух годах ещё не подтверждает одинаковое покрытие выбранных частей года.')
    else:
        title = f'{platform}: отложенная проверка относительно Aqua'
        description = 'Сначала региональный расчёт, затем проверка SP-согласования на последующих годах. До результата переход между спутниками не считается проверенным.'
        limitations += [NRT_LIMIT, 'Положительный постоянный коэффициент не улучшает собственные проценты аномалии и ранги источника. Ранние Terra, Aqua и VIIRS не образуют автоматически проверенный мост.']
        common = sorted(key for key, row in in_history.items() if _complete(row) and _complete(rows.get(('Aqua', key))))
        def counts(a, b):
            return ([key for key in common if a <= int(key[:4]) <= b], [key for key in common if int(key[:4]) > b])
        fit, test = counts(config['baseline_start'], config['baseline_end'])
        if platform == 'Aqua':
            reason = 'Aqua является опорным рядом; для проверки перехода выберите другую платформу.'
        elif len(fit) < 24 or len(test) < 12:
            years = sorted({int(key[:4]) for key in common})
            for boundary in reversed(years[:-1]):
                candidate_fit, candidate_test = counts(years[0], boundary)
                if len(candidate_fit) >= 24 and len(candidate_test) >= 12 and len({key[:4] for key in candidate_fit}) >= 3:
                    proposed['baseline_start'], proposed['baseline_end'] = years[0], boundary
                    fit, test = candidate_fit, candidate_test
                    break
            else:
                reason = 'Мировой индекс не подтверждает достаточно общих SP-месяцев для обучения и последующей отложенной проверки. Региональный допуск пока неизвестен.'
        score = len(fit) + len(test)
    if source_rows and any(not _present(row) for row in in_history.values()):
        limitations.append('В части выбранной истории продукт этого спутника отсутствует. Такие месяцы остаются пропусками, а не нулями.')
    if config['quality'] == 'sp' and any(row.get('preliminary') for row in in_history.values()):
        limitations.append('В истории есть месяцы с NRT: агрегаты не позволяют подтвердить их полную SP-маску до расчёта.')
    if not int(proposed['start'][:4]) <= proposed['baseline_start'] <= proposed['baseline_end'] <= int(proposed['end'][:4]):
        proposed = deepcopy(config)
        reason = reason or 'Для предложенного периода не удалось подобрать допустимую историческую базу.'
    option = dict(id='same-platform-' + platform, title=title, description=description,
                  platform=platform, config=proposed, changes=_changes(config, proposed, requested_platform, platform),
                  limitations=list(dict.fromkeys(limitations)), status='unavailable' if reason else 'proposed', reason=reason)
    return option, score


def build_plan(config, question, platform, snapshot, source='unknown', revision=None):
    """Build at most two candidates plus the explicitly manual current request."""
    validate_choices(question, platform)
    rows = _rows(snapshot)
    availability = dict(source=source, revision=revision or snapshot.get('revision'), snapshot_at=snapshot.get('snapshot_at'),
                        status='available' if rows else 'unknown', scope='global-product-presence',
                        local_coverage='unknown', platforms=_summary(rows))
    choices = list(PLATFORMS) if platform == 'auto' else [platform]
    if question == 'sensor-transition' and platform == 'auto':
        choices.remove('Aqua')
    candidates = [_candidate(config, question, p, platform, rows) for p in choices]
    candidates.sort(key=lambda pair: (pair[0]['status'] == 'proposed', pair[1]), reverse=True)
    options = [option for option, _ in candidates[:2]]
    manual = dict(id='current-request', title='Текущие условия: ручное исследование',
                  description='Сохранить выбранную историю и базу. Расчёт покажет исходные значения и причины недопуска сравнения; пригодность заранее не обещана.',
                  platform=platform, config=deepcopy(config), changes=[], limitations=[LOCAL_LIMIT, MASK_LIMIT, NRT_LIMIT],
                  status='unavailable' if platform == 'auto' else 'proposed',
                  reason='Выберите один спутник для ручного исследования.' if platform == 'auto' else None)
    options.append(manual)
    recommended = next((o['id'] for o in options if o['status'] == 'proposed' and o['id'] != 'current-request'), None)
    warnings = [LOCAL_LIMIT, 'Предложение условий не запускает расчёт и не является проверенной гармонизацией.']
    if not rows:
        warnings.append('Метаданные доступности неизвестны. Доступно только ручное исследование без обещания пригодности.')
    if source == 'seed-world-calendar':
        warnings.append('Использован сохранённый снимок мирового календаря; его дата указана отдельно, свежесть текущего архива не подтверждена.')
    return dict(version=VERSION, question=question, platform=platform, requested_config=deepcopy(config), availability=availability,
                recommended_option_id=recommended or ('current-request' if platform != 'auto' else None), options=options, warnings=warnings)


def assess(analysis, question, platform, *, month=None, analysis_id=None):
    """Assess only the stored result and its pinned sources, never today's metadata."""
    validate_choices(question, platform, allow_auto=False)
    if month is not None and (not isinstance(month, str) or not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', month)):
        raise ValueError('Выберите месяц в формате ГГГГ-ММ.')
    rows = [row for row in analysis.get('monthly', []) if row.get('platform') == platform and (month is None or row.get('month') == month)]
    recorded = [row for row in rows if row.get('cells') is not None and row.get('eligible_days', 0) > 0]
    comparable = [row for row in rows if row.get('comparison_status') == 'ok'
                  and len(set(row.get('baseline_year_ids', [])) - {int(row['month'][:4])}) >= 3
                  and int(row['month'][:4]) not in row.get('baseline_year_ids', []) and row.get('cells') is not None]
    model = analysis.get('models', {}).get(platform, {})
    provenance = analysis.get('provenance', {})
    checks = model.get('checks', {})
    preliminary = [row for row in recorded if row.get('nrt_points', 0) or row.get('preliminary_days', 0)]
    config = analysis.get('config', {})
    facts = dict(analysis_id=analysis_id, analysis_version=analysis.get('analysis_version'), extract_id=analysis.get('extract_id'),
                 snapshot_at=analysis.get('snapshot_at'), config_sha256=hashlib.sha256(json.dumps(config, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
                 source_sha256=sorted({s['sha256'] for s in provenance.get('sources', []) if s.get('sha256')}),
                 target_months=[row['month'] for row in rows] if rows else ([month] if month else []),
                 comparable_months=[row['month'] for row in comparable], unavailable_months=[row['month'] for row in rows if row not in recorded],
                 baseline_year_ids=sorted({year for row in rows for year in row.get('baseline_year_ids', [])}),
                 comparison_status=dict(Counter(row.get('comparison_status', 'unknown') for row in rows)),
                 model_accepted=model.get('accepted') is True, model_checks=checks,
                 fit_months=model.get('fit_months'), test_months=model.get('test_months'), preliminary_months=[row['month'] for row in preliminary])
    reasons = []
    limitations = [LOCAL_LIMIT, 'Оценка относится к параметрам и снимку источников этого сохранённого расчёта. Детекции не являются числом пожаров или выгоревшей площадью.']
    status = 'unavailable'
    if not rows:
        reasons.append('Выбранный месяц или источник отсутствует в результате этого исследования.')
    elif not recorded:
        reasons.append('Нет доступного продукта выбранного режима в оцениваемом периоде; это пропуск, а не нулевая активность.')
    elif question == 'anomaly':
        status = 'ready' if len(comparable) == len(rows) else 'limited' if comparable else 'unavailable'
        if len(comparable) < len(rows):
            reasons.append('Не все оцениваемые месяцы имеют пригодную целевую маску и минимум три других базовых года. Оцениваемый год исключается из собственной базы.')
        if any(row.get('comparison_status') == 'incomplete_utc_day' for row in rows):
            reasons.append('Последние неполные сутки UTC исключают заключение об аномальности этого месяца.')
        if any(row.get('baseline') == 0 for row in comparable):
            status = 'limited'
            reasons.append('Базовая медиана равна нулю: относительное отклонение в процентах не определено.')
    elif question == 'compare-years':
        years = {row['month'][:4] for row in recorded}
        enough_days = all(row.get('eligible_days', 0) >= min(10, row.get('calendar_days', 31))
                          and row.get('comparison_status') != 'incomplete_utc_day' for row in rows)
        status = 'ready' if len(years) >= 2 and len(recorded) == len(rows) and enough_days else 'limited' if len(years) >= 2 else 'unavailable'
        if len(years) < 2:
            reasons.append('В оцениваемой части результата нет двух лет с данными одного источника.')
        elif len(recorded) != len(rows) or not enough_days:
            reasons.append('Часть выбранной истории имеет пропуски, слишком мало доступных дат или неполные сутки UTC; сравнивайте только совместимые части двух лет.')
        limitations.append('Это допуск к выбору двух лет в исходном ряду; одинаковые части года и доступные даты нужно учитывать в сравнении.')
    else:
        limitations += [NRT_LIMIT, 'Проверка воспроизводит Aqua для этой территории, сетки и фильтров; это не независимая наземная проверка. Постоянный коэффициент не улучшает собственные проценты аномалии или ранги.']
        accepted = model.get('accepted') is True and bool(checks) and all(value is True for value in checks.values())
        coefficient = model.get('coefficient')
        accepted = accepted and isinstance(coefficient, (int, float)) and not isinstance(coefficient, bool) and math.isfinite(coefficient) and coefficient > 0
        accepted = accepted and model.get('fit_months', 0) >= 24 and model.get('test_months', 0) >= 12
        if accepted:
            status = 'ready' if len(recorded) == len(rows) and all(row.get('model_valid') is True and row.get('calibration_eligible') is True for row in rows) else 'limited'
        else:
            reasons.append('Региональная SP-модель не прошла отложенную проверку или данных для проверки недостаточно. Используйте отдельные исходные ряды.')
        if platform == 'Aqua':
            reasons.append('Aqua является опорным рядом; самостоятельная модель перехода для него не строится.')
        if accepted and any(row.get('baseline_equivalent') is None for row in comparable):
            status = 'limited'
            reasons.append('Проверка модели не подтверждает пригодность скорректированной исторической нормы во всех оцениваемых месяцах.')
    if preliminary:
        if status == 'ready':
            status = 'limited'
        reasons.append('В оцениваемом периоде есть предварительные NRT; результат остаётся исходным предварительным рядом, а SP-проверка на него не переносится.')
    if not reasons:
        reasons.append('Условия выбранного вопроса выполнены в оцениваемой части сохранённого результата; локальная наблюдаемость остаётся неизвестной.')
    titles = {'ready': 'Условия сравнения выполнены', 'limited': 'Сравнение доступно с ограничениями', 'unavailable': 'Для выбранного вопроса данных недостаточно'}
    if question == 'sensor-transition' and status == 'ready':
        titles['ready'] = 'Региональная SP-проверка пройдена'
    return dict(version=VERSION, question=question, platform=platform, status=status, title=titles[status], summary=reasons[0],
                reasons=reasons, facts=facts, global_availability=dict(scope='global-product-presence', status='observed' if recorded else 'unknown'),
                local_coverage='unknown', limitations=list(dict.fromkeys(limitations)))
