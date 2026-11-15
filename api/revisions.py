"""Bounded immutable analysis snapshots and comparisons of their recorded values.

No archive reads, recomputation, current assessor, or background jobs belong here.
Hashes describe provenance; changes in those hashes do not establish local effects.
"""
from contextlib import contextmanager
from datetime import date, datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile

from api.analysis import PLATFORMS

VERSION = 1
MAX_SNAPSHOTS = 64
MAX_TOTAL_BYTES = 256 * 1024 ** 2
MAX_RESULT_BYTES = 32 * 1024 ** 2
CURRENT_ANALYSIS_VERSION = 'nasa-temporal-v4'
CURRENT_EXTRACT_VERSION = 'nasa-spatial-v2'
LIMITATIONS = [
    'Сравниваются сохранённые числа. Первоначальный вопрос, режим и статус интерфейса не были записаны.',
    'Изменение хэша архива не доказывает изменение данных выбранной территории или причину изменения вывода.',
    'Локальное покрытие и облачность неизвестны; ноль детекций не подтверждает отсутствие огня.',
]


class RevisionError(ValueError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code

    def response(self):
        return dict(error=str(self), code=self.code)


def _id(identifier):
    if not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-f]{32}', identifier):
        raise RevisionError(400, 'invalid_id', 'Неверный идентификатор расчёта.')
    return identifier


def _json(value):
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    except (ValueError, TypeError, OverflowError, RecursionError) as error:
        raise RevisionError(422, 'invalid_result', 'Результат содержит неподдерживаемые значения.') from error


def _hash(value):
    return hashlib.sha256(_json(value)).hexdigest()


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _same(a, b):
    if _number(a) and _number(b):
        return a == b if isinstance(a, int) and isinstance(b, int) else math.isclose(a, b, rel_tol=1e-10, abs_tol=1e-9)
    return type(a) is type(b) and a == b


def _result(value):
    if not isinstance(value, dict) or not isinstance(value.get('config'), dict) or not isinstance(value.get('monthly'), list):
        raise RevisionError(422, 'unsupported_result', 'Нужен полный сохранённый результат с параметрами и месячными значениями.')
    return value


def _method_status(result):
    version = result.get('analysis_version')
    return 'current' if version == CURRENT_ANALYSIS_VERSION else 'historical' if isinstance(version, str) and version else 'unknown'


def _roi(result):
    config = result.get('config', {})
    recorded = result.get('provenance', {}).get('geometry_sha256')
    geometry = config.get('geometry')
    if geometry:
        return dict(kind='geometry', sha256=_hash(geometry), scope='stored-effective-geometry')
    if config.get('preset') == 'sko':
        return dict(kind='preset', sha256=recorded, scope='stored-geometry-hash' if recorded else 'unknown')
    bbox = config.get('bbox')
    if isinstance(bbox, list) and len(bbox) == 4 and all(_number(x) for x in bbox):
        return dict(kind='bbox', sha256=_hash([float(x) for x in bbox]), scope='stored-effective-geometry')
    return dict(kind='preset', sha256=None, scope='unknown')


def _roi_relation(a, b):
    ac, bc = a['config'], b['config']
    ar, br = _roi(a), _roi(b)
    if ar['scope'] == 'unknown' or br['scope'] == 'unknown':
        return 'unknown'
    if ar['kind'] == br['kind'] and ar['sha256'] == br['sha256']:
        return 'same'
    # Different exact bounding boxes prove distinct query extents. Different
    # ring order or a changed geometry hash alone cannot prove a changed area.
    if ac.get('bbox') is not None and bc.get('bbox') is not None and ac['bbox'] != bc['bbox']:
        return 'different'
    return 'unknown'


def summary(identifier, result, retention='cache-only', *, saved_at=None, digest=None):
    return dict(version=VERSION, id=_id(identifier), retention=retention, saved_at=saved_at,
                result_sha256=digest or _hash(result), calculated_at=result.get('calculated_at'),
                snapshot_at=result.get('snapshot_at'), analysis_version=result.get('analysis_version'),
                extract_version=result.get('provenance', {}).get('extract_version'), method_status=_method_status(result),
                config=result['config'], roi_identity=_roi(result),
                capabilities=dict(numeric_comparison=bool(result.get('monthly')),
                                  assessment='supported' if _method_status(result) == 'current' else 'unsupported'))


class RevisionStore:
    """Saved files are not part of the jobs/extracts eviction policy.

    All writers take the same filesystem lock. A complete, fsynced temporary
    inode is hard-linked into its final name without ever replacing a snapshot.
    Readers see either no snapshot or one complete immutable envelope.
    """
    def __init__(self, cache, *, max_snapshots=MAX_SNAPSHOTS, max_total_bytes=MAX_TOTAL_BYTES,
                 max_result_bytes=MAX_RESULT_BYTES):
        self.cache = Path(cache)
        self.directory = self.cache / 'saved-analyses'
        for limit in (max_snapshots, max_total_bytes, max_result_bytes):
            if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
                raise ValueError('Snapshot limits must be positive integers.')
        self.max_snapshots, self.max_total_bytes, self.max_result_bytes = max_snapshots, max_total_bytes, max_result_bytes

    @contextmanager
    def _lock(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        with (self.directory / '.lock').open('a+b') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            try:
                # A terminated writer may leave an unpublished inode. With the
                # exclusive lock no cooperating writer can still be using it.
                for pending in self.directory.glob('.snapshot-*.part'):
                    pending.unlink(missing_ok=True)
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def _read(self, path, *, envelope=False):
        try:
            with path.open('rb') as stream:
                content = stream.read(self.max_result_bytes + 65537)
        except FileNotFoundError:
            return None
        if len(content) > self.max_result_bytes + (65536 if envelope else 0):
            raise RevisionError(413, 'snapshot_too_large', 'Результат превышает допустимый размер сохранённой версии.')
        try:
            value = json.loads(content)
            if envelope:
                if not isinstance(value, dict) or value.get('version') != VERSION or value.get('id') != path.stem:
                    raise ValueError('Invalid snapshot envelope')
                result = _result(value.get('result'))
                if value.get('result_sha256') != _hash(result):
                    raise ValueError('Snapshot checksum mismatch')
            else:
                result = _result(value)
        except (ValueError, TypeError, KeyError, RecursionError) as error:
            raise RevisionError(503, 'snapshot_corrupt', 'Сохранённая версия повреждена или имеет неподдерживаемый формат.') from error
        return value

    def load(self, identifier):
        identifier = _id(identifier)
        saved = self._read(self.directory / (identifier + '.json'), envelope=True)
        if saved is not None:
            return saved['result'], summary(identifier, saved['result'], 'saved', saved_at=saved['saved_at'], digest=saved['result_sha256'])
        result = self._read(self.cache / 'jobs' / (identifier + '.json'))
        if result is None:
            raise RevisionError(404, 'snapshot_missing', 'Расчёт не найден: он ещё не сохранён или уже удалён из кэша.')
        return result, summary(identifier, result)

    def snapshot(self, identifier):
        return self.load(identifier)[1]

    def save(self, identifier, result=None):
        """An optional full completed result lets the HTTP layer use an in-memory job.

        No callers may submit arbitrary results through the public HTTP body.
        The HTTP endpoint accepts only {} and supplies its own completed job.
        """
        identifier = _id(identifier)
        if result is None:
            result, old_summary = self.load(identifier)
            if old_summary['retention'] == 'saved':
                return self._receipt(old_summary)
        result = _result(result)
        content = _json(result)
        if len(content) > self.max_result_bytes:
            raise RevisionError(413, 'snapshot_too_large', 'Результат превышает 32 MiB или настроенный предел; версия не сохранена.')
        digest = hashlib.sha256(content).hexdigest()
        with self._lock():
            destination = self.directory / (identifier + '.json')
            existing = self._read(destination, envelope=True)
            if existing is not None:
                if existing['result_sha256'] != digest:
                    raise RevisionError(409, 'snapshot_conflict', 'Эта версия уже сохранена с другим содержимым; перезапись запрещена.')
                return self._receipt(summary(identifier, existing['result'], 'saved', saved_at=existing['saved_at'], digest=digest))
            envelope = dict(version=VERSION, id=identifier, saved_at=datetime.now(timezone.utc).isoformat(),
                            result_sha256=digest, result=result)
            encoded = _json(envelope)
            files = list(self.directory.glob('[0-9a-f]' * 32 + '.json'))
            if len(files) >= self.max_snapshots or sum(path.stat().st_size for path in files) + len(encoded) > self.max_total_bytes:
                raise RevisionError(507, 'snapshot_quota', 'Хранилище сохранённых версий заполнено. Прежние версии не удалены; новая не сохранена.')
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=self.directory, prefix='.snapshot-', suffix='.part', delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temporary, destination)
                except FileExistsError as error:
                    # Even a non-cooperating writer cannot make us overwrite it.
                    raise RevisionError(409, 'snapshot_conflict', 'Имя сохранённой версии уже занято; перезапись запрещена.') from error
                descriptor = os.open(self.directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            except OSError as error:
                raise RevisionError(507, 'snapshot_write_failed', 'Версия не подтверждена как сохранённая: ошибка записи хранилища. Повторите сохранение.') from error
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            return self._receipt(summary(identifier, result, 'saved', saved_at=envelope['saved_at'], digest=digest), len(encoded))

    def _receipt(self, info, size=None):
        if size is None:
            size = (self.directory / (info['id'] + '.json')).stat().st_size
        return {k: info[k] for k in ('version', 'id', 'saved_at', 'result_sha256', 'retention', 'method_status')} | dict(status='saved', bytes=size)

    def changes(self, before_id, after_id, **scope):
        before, before_summary = self.load(before_id)
        after, after_summary = self.load(after_id)
        return compare_results(before, after, before_summary=before_summary, after_summary=after_summary, **scope)


def _scope(question, platform, month, series_mode, years):
    if question not in ('anomaly', 'compare-years', 'sensor-transition') or platform not in PLATFORMS:
        raise RevisionError(400, 'invalid_scope', 'Выберите исследовательский вопрос и один спутник.')
    if series_mode not in ('raw', 'calibrated'):
        raise RevisionError(422, 'unsupported_series', 'Поддерживаются исходный ряд и сохранённая шкала Aqua.')
    if month is not None and (not isinstance(month, str) or not re.fullmatch(r'[1-9]\d{3}-(0[1-9]|1[0-2])', month)):
        raise RevisionError(400, 'invalid_month', 'Месяц должен иметь формат ГГГГ-ММ.')
    if question == 'anomaly' and month is None:
        raise RevisionError(400, 'month_required', 'Для изменения месячного вывода выберите месяц.')
    if question == 'compare-years':
        if series_mode != 'raw' or month is not None:
            raise RevisionError(422, 'unsupported_year_scope', 'Сравнение ISO-лет использует исходные недельные значения и два явно выбранных года.')
        if isinstance(years, str):
            years = years.split(',')
        if not isinstance(years, (tuple, list)) or len(years) != 2 or any(isinstance(y, bool) or not re.fullmatch(r'[1-9]\d{3}', str(y)) for y in years):
            raise RevisionError(400, 'years_required', 'Выберите два разных ISO-года в формате ГГГГ,ГГГГ.')
        years = [int(y) for y in years]
        if years[0] == years[1] or 9999 in years:
            raise RevisionError(400, 'invalid_years', 'Выберите два разных ISO-года до 9999.')
    elif years is not None:
        raise RevisionError(422, 'unexpected_years', 'Выбор двух ISO-лет относится только к вопросу сравнения лет.')
    if question == 'sensor-transition' and series_mode != 'raw':
        raise RevisionError(422, 'unsupported_transition_scope', 'Переход сравнивается по сохранённым SP-проверкам модели, без пересчёта ряда.')
    return dict(question=question, platform=platform, month=month, series_mode=series_mode, years=years,
                year_basis='ISO' if question == 'compare-years' else None)


def _monthly(result, scope):
    return {row['month']: row for row in result.get('monthly', [])
            if isinstance(row, dict) and row.get('platform') == scope['platform'] and isinstance(row.get('month'), str)
            and (scope['month'] is None or row['month'] == scope['month'])}


def _day_selected(day, config, scope):
    if not isinstance(day, str) or not config.get('start', '') <= day <= config.get('end', ''):
        return False
    if scope['month'] is not None:
        return day[:7] == scope['month']
    if scope['years']:
        try:
            return date.fromisoformat(day).isocalendar().year in scope['years']
        except ValueError:
            return False
    return True


def _derivatives(result, scope):
    config = result['config']
    daily = result.get('daily')
    availability = result.get('availability')
    values = None if not isinstance(daily, list) else {
        row['date']: {k: row.get(k) for k in ('cells', 'points', 'sp_cells', 'nrt_points')}
        for row in daily if isinstance(row, dict) and row.get('platform') == scope['platform'] and _day_selected(row.get('date'), config, scope)}
    available = None if not isinstance(availability, list) else {
        row['date']: row.get('sp') for row in availability if isinstance(row, dict) and row.get('platform') == scope['platform']
        and _day_selected(row.get('date'), config, scope) and (config.get('quality') == 'all' or row.get('sp') is True)}
    return values, available


def _windows(result, scope, rows):
    if scope['question'] == 'compare-years':
        profile = result.get('weekly_profiles', {}).get(scope['platform'], {})
        return {str(year): {k: profile.get('year_metrics', {}).get(str(year), {}).get(k) for k in ('start_date', 'end_date')}
                for year in scope['years']}
    if scope['month']:
        key = scope['month']
        import calendar
        last = f'{key}-{calendar.monthrange(int(key[:4]), int(key[5:]))[1]:02}'
        return [max(result['config'].get('start', ''), key + '-01'), min(result['config'].get('end', ''), last)]
    return [result['config'].get('start'), result['config'].get('end')]


def _mask(result, scope, rows, availability):
    if scope['question'] == 'compare-years':
        return sorted(availability) if availability is not None else None
    if rows and all(isinstance(row.get('comparison_day_numbers'), list) for row in rows.values()):
        return {key: row['comparison_day_numbers'] for key, row in sorted(rows.items())}
    return sorted(availability) if availability is not None else None


def _relation(a, b):
    return 'unknown' if a is None or b is None else 'same' if _same(a, b) else 'different'


def _classification(row, series_mode):
    if not row or row.get('cells') is None:
        return 'unavailable'
    if row.get('comparison_status') != 'ok':
        return 'unavailable' if row.get('comparison_status') else 'unknown'
    baseline = row.get('baseline_equivalent' if series_mode == 'calibrated' else 'baseline')
    if series_mode == 'calibrated' and (row.get('model_valid') is not True or row.get('baseline_calibration_eligible') is not True):
        return 'unavailable'
    if series_mode == 'calibrated' and not _number(row.get('aqua_equivalent')):
        return 'unavailable'
    anomaly = row.get('anomaly_pct')
    if not _number(baseline) or baseline <= 0 or not _number(anomaly):
        return 'unavailable'
    return 'at-baseline' if math.isclose(anomaly, 0, abs_tol=1e-9) else 'above-baseline' if anomaly > 0 else 'below-baseline'


def compare_results(before, after, *, question='anomaly', platform=None, month=None, series_mode='raw', years=None,
                    before_summary=None, after_summary=None):
    """Compare stored facts under one explicit scope, never infer causal shares."""
    before, after = _result(before), _result(after)
    scope = _scope(question, platform, month, series_mode, years)
    a, b = before['config'], after['config']
    ar, br = _monthly(before, scope), _monthly(after, scope)
    ad, aa = _derivatives(before, scope)
    bd, ba = _derivatives(after, scope)
    ap, bp = before.get('provenance', {}), after.get('provenance', {})
    am, bm = before.get('models', {}).get(platform, {}), after.get('models', {}).get(platform, {})
    filters = lambda c: {key: c.get(key) for key in ('quality', 'daynight')}
    method = lambda r: [r.get('analysis_version'), r.get('provenance', {}).get('extract_version')]
    method_a, method_b = method(before), method(after)
    known_method = all(isinstance(v, str) and v for v in method_a + method_b)
    relations = dict(roi=_roi_relation(before, after), grid=_relation(a.get('grid_km'), b.get('grid_km')),
                     platform='same', unit=_relation(before.get('unit'), after.get('unit')),
                     target_window=_relation(_windows(before, scope, ar), _windows(after, scope, br)),
                     target_mask=_relation(_mask(before, scope, ar, aa), _mask(after, scope, br, ba)),
                     filters=_relation(filters(a), filters(b)), method=_relation(method_a, method_b) if known_method else 'unknown',
                     calibration=_relation(am.get('coefficient'), bm.get('coefficient')) if series_mode == 'calibrated' else 'same')
    reasons = [f'{name}: {value}' for name, value in relations.items() if value != 'same']
    direct = all(value == 'same' for value in relations.values())
    comparability = {**relations, 'direct': direct, 'reasons': reasons}
    changes, metrics = [], []

    def change(group, field, old, new, evidence='stored-values', **extra):
        if not _same(old, new):
            changes.append(dict(group=group, field=field, before=old, after=new, evidence=evidence, **extra))

    change('territory', 'roi_identity', _roi(before), _roi(after), 'metadata-only')
    for field in ('grid_km', 'quality', 'daynight', 'start', 'end'):
        change('parameters', field, a.get(field), b.get(field))
    for field in ('baseline_start', 'baseline_end'):
        change('baseline', field, a.get(field), b.get(field))
    for field in ('analysis_version',):
        change('method', field, before.get(field), after.get(field), 'metadata-only')
    for field in ('extract_version', 'outages_sha256', 'confidence_filter', 'fire_type', 'grid_crs', 'incomplete_utc_dates'):
        change('method', field, ap.get(field), bp.get(field), 'metadata-only')
    for field in ('snapshot_at', 'through'):
        change('data', field, before.get(field), after.get(field), 'metadata-only')
    source_map = lambda provenance: {s['path']: s.get('sha256') for s in provenance.get('sources', []) if isinstance(s, dict) and isinstance(s.get('path'), str)}
    sources_a, sources_b = source_map(ap), source_map(bp)
    # File additions caused by a changed history are source selection, not proof
    # that a previously selected file was revised.
    change('data', 'source_selection', sorted(sources_a), sorted(sources_b), 'metadata-only')
    revised = [dict(path=path, before=sources_a[path], after=sources_b[path]) for path in sorted(sources_a.keys() & sources_b.keys()) if sources_a[path] != sources_b[path]]
    if revised:
        changes.append(dict(group='data', field='source_hashes', before=[{'path':r['path'], 'sha256':r['before']} for r in revised],
                            after=[{'path':r['path'], 'sha256':r['after']} for r in revised], evidence='metadata-only'))
    for field, old, new in (('daily_values', ad, bd), ('available_dates', aa, ba)):
        if old is not None and new is not None and old != new:
            keys = [key for key in sorted(old.keys() | new.keys()) if old.get(key) != new.get(key) or (key in old) != (key in new)]
            changes.append(dict(group='data', field=field, before=dict(records=len(old)), after=dict(records=len(new)), evidence='stored-values',
                                changed_records=len(keys), examples=[dict(date=key, before=old.get(key), after=new.get(key)) for key in keys[:12]]))

    def metric(period, name, old, new, unit=None, *, numeric=True, eligible=True):
        compatible = direct and eligible
        delta = new - old if compatible and numeric and _number(old) and _number(new) else None
        if _number(delta) and _same(old, new):
            delta = 0
        metrics.append(dict(period=period, name=name, unit=unit, before=old, after=new, delta=delta,
                            comparable=compatible, reason=None if compatible else 'Сопоставимость условий или пригодность сохранённого значения не подтверждена.'))

    def outcomes(rows):
        return dict(classification=rows[0]['classification'] if len(rows) == 1 else 'not-summarized', rows=rows)

    outcome_a, outcome_b = [], []
    supported = True
    if question == 'compare-years':
        for year in scope['years']:
            pa, pb = before.get('weekly_profiles', {}).get(platform, {}), after.get('weekly_profiles', {}).get(platform, {})
            valid_profiles = pa.get('year_basis') == pb.get('year_basis') == 'ISO'
            ya, yb = pa.get('years', {}).get(str(year)), pb.get('years', {}).get(str(year))
            supported = supported and valid_profiles and isinstance(ya, list) and isinstance(yb, list)
            if not valid_profiles or not isinstance(ya, list) or not isinstance(yb, list):
                continue
            ma, mb = pa.get('year_metrics', {}).get(str(year), {}), pb.get('year_metrics', {}).get(str(year), {})
            for field in ('total_cells', 'available_weeks', 'first_week', 'last_week', 'peak_week', 'active_weeks', 'partial_year'):
                metric(str(year), field, ma.get(field), mb.get(field), 'cell-days' if field == 'total_cells' else None,
                       numeric=field != 'partial_year', eligible=bool(ma and mb))
            wa, wb = {r['week']:r for r in ya if isinstance(r, dict) and 'week' in r}, {r['week']:r for r in yb if isinstance(r, dict) and 'week' in r}
            for week in sorted(wa.keys() | wb.keys()):
                for field in ('cells', 'rate', 'eligible_days'):
                    metric(f'{year}-W{week:02}', field, wa.get(week, {}).get(field), wb.get(week, {}).get(field),
                           'cell-days/day' if field == 'rate' else 'days' if field == 'eligible_days' else 'cell-days',
                           eligible=wa.get(week, {}).get('complete') is True and wb.get(week, {}).get('complete') is True)
        # No numerical or verbal average of the two years is invented.
    elif question == 'sensor-transition':
        for field in ('coefficient', 'fit_months', 'test_months', 'accepted', 'checks', 'status', 'mae_before', 'mae_after', 'seasonal_mae', 'bias_pct'):
            metric('model', field, am.get(field), bm.get(field), numeric=field not in ('accepted', 'checks', 'status'), eligible=bool(am and bm))
            change('method', 'model.' + field, am.get(field), bm.get(field))
        for model, rows, outcomes_list in ((am, ar, outcome_a), (bm, br, outcome_b)):
            classification = 'model-accepted' if model.get('accepted') is True else 'model-rejected' if model.get('accepted') is False else 'unknown'
            if month and (month not in rows or rows[month].get('model_valid') is not True):
                classification = 'target-not-eligible'
            outcomes_list.append(dict(period=month or 'model', classification=classification, basis='stored-model-flags'))
        supported = bool(am and bm)
    else:
        keys = sorted(ar.keys() | br.keys()) or [month]
        for key in keys:
            ra, rb = ar.get(key, {}), br.get(key, {})
            for field in ('cells', 'points', 'eligible_days', 'nrt_points', 'preliminary_days', 'baseline', 'baseline_low', 'baseline_high',
                          'baseline_year_ids', 'comparison_day_numbers', 'anomaly_pct', 'percentile', 'comparison_status'):
                if series_mode == 'calibrated' and field in ('baseline_low', 'baseline_high'):
                    # These intervals were stored only in the raw scale. Do not
                    # mix them with the saved Aqua-equivalent point estimates.
                    continue
                display_a, display_b = ra.get(field), rb.get(field)
                eligible = bool(ra and rb)
                if series_mode == 'calibrated' and field in ('cells', 'baseline'):
                    stored = 'aqua_equivalent' if field == 'cells' else 'baseline_equivalent'
                    display_a, display_b = ra.get(stored), rb.get(stored)
                    eligible = ra.get('model_valid') is True and rb.get('model_valid') is True
                    if field == 'baseline':
                        eligible = eligible and ra.get('baseline_calibration_eligible') is True and rb.get('baseline_calibration_eligible') is True
                if series_mode == 'calibrated' and field in ('anomaly_pct', 'percentile'):
                    valid_a = ra.get('model_valid') is True and ra.get('baseline_calibration_eligible') is True and _number(ra.get('baseline_equivalent'))
                    valid_b = rb.get('model_valid') is True and rb.get('baseline_calibration_eligible') is True and _number(rb.get('baseline_equivalent'))
                    display_a, display_b = display_a if valid_a else None, display_b if valid_b else None
                    eligible = valid_a and valid_b
                metric(key, field, display_a, display_b,
                       ('cell-days:Aqua-estimate' if series_mode == 'calibrated' else 'cell-days') if field in ('cells', 'baseline', 'baseline_low', 'baseline_high') else 'percent' if field in ('anomaly_pct', 'percentile') else None,
                       numeric=field not in ('baseline_year_ids', 'comparison_day_numbers', 'comparison_status'), eligible=eligible)
                if field in ('baseline', 'baseline_low', 'baseline_high', 'baseline_year_ids'):
                    change('baseline', key + '.' + field, ra.get(field), rb.get(field))
            outcome_a.append(dict(period=key, classification=_classification(ra, series_mode), basis='derived-from-saved-values'))
            outcome_b.append(dict(period=key, classification=_classification(rb, series_mode), basis='derived-from-saved-values'))
        supported = any(_number(row.get('cells')) for row in ar.values()) and any(_number(row.get('cells')) for row in br.values())
    material = any(not _same(m['before'], m['after']) for m in metrics)
    changed = any(x['classification'] != y['classification'] for x, y in zip(outcome_a, outcome_b)) if direct and supported and outcome_a else None
    status = 'different-context' if relations['roi'] == 'different' or relations['grid'] == 'different' else 'unavailable' if not supported else 'comparable' if direct else 'limited'
    warnings = list(LIMITATIONS)
    if _method_status(before) != 'current' or _method_status(after) != 'current':
        warnings.append('Есть историческая или неизвестная версия метода. Показаны записанные значения и флаги; текущая проверка пригодности к ним не применялась.')
    if question == 'compare-years':
        warnings.append('ISO-годы показаны отдельно по сохранённым неделям. Общий итог и усреднённый вывод между разными годами не вычисляются.')
    if (before_summary or {}).get('retention') == 'cache-only' or (after_summary or {}).get('retention') == 'cache-only':
        warnings.append('Несохранённый расчёт может исчезнуть из кэша. Для устойчивой ссылки явно сохраните обе версии.')
    return dict(version=VERSION, scope=scope, status=status, before=before_summary, after=after_summary,
                comparability=comparability, changes=changes, metrics=metrics,
                outcomes=dict(before=outcomes(outcome_a), after=outcomes(outcome_b), changed=changed, policy_version=VERSION),
                attribution=dict(status='observed-change' if direct and material else 'unresolved',
                                 reason='Показаны фактические различия сохранённых чисел; вклад отдельных причин не оценивался.' if direct and material
                                 else 'Причину пересмотра нельзя установить: числа не изменились, сведения неполны или условия различаются.'),
                warnings=warnings)
