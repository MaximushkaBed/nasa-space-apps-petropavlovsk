"""Temporal analysis of recorded detections, with explicitly unknown local coverage."""
from collections import defaultdict
from datetime import date, timedelta
import calendar
import math
import random
import statistics

PLATFORMS = ('Aqua', 'Terra', 'Suomi-NPP', 'NOAA-20', 'NOAA-21')


def quantile(values, probability):
    if not values:
        return None
    ordered = sorted(values)
    at = (len(ordered) - 1) * probability
    lower = math.floor(at)
    return ordered[lower] + (ordered[math.ceil(at)] - ordered[lower]) * (at - lower)


def days_between(start, end):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def month_keys(start, end):
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        yield f'{year:04}-{month:02}'
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)


def analyze(daily, availability, config, exclusions=None):
    """Availability is global product presence, never local clear-sky coverage.

    daily rows: date/platform/points/cells/sp_cells/nrt_points.
    availability rows: date/platform/sp (global index of source observations).
    Known outage dates are conservatively excluded. Counts on other dates are
    recorded activity; a zero is not evidence that a usable local observation
    occurred. Calendar-period comparisons keep identical day-of-month windows.
    """
    exclusions = exclusions or set()
    start, end = date.fromisoformat(config['start']), date.fromisoformat(config['end'])
    baseline = range(config['baseline_start'], config['baseline_end'] + 1)
    lookup = {(row['date'], row['platform']): row for row in daily}
    available = {(row['date'], row['platform']): bool(row['sp']) for row in availability}
    for pair in exclusions:
        available.pop(pair, None)
    months = list(month_keys(start, end))
    windows = {}
    monthly = []
    by_source = defaultdict(dict)
    for key in months:
        year, month = map(int, key.split('-'))
        first = max(start, date(year, month, 1))
        last = min(end, date(year, month, calendar.monthrange(year, month)[1]))
        windows[key] = (first.day, last.day)
        for platform in PLATFORMS:
            dates = [d.isoformat() for d in days_between(first, last)
                     if (d.isoformat(), platform) in available and
                     (config['quality'] == 'all' or available[(d.isoformat(), platform)])]
            rows = [lookup.get((d, platform), {}) for d in dates]
            cells = sum(row.get('cells', 0) for row in rows)
            value = {'month': key, 'platform': platform, 'cells': cells if dates else None,
                     'points': sum(row.get('points', 0) for row in rows) if dates else None,
                     'eligible_days': len(dates), 'calendar_days': (last - first).days + 1,
                     'nrt_points': sum(row.get('nrt_points', 0) for row in rows),
                     'preliminary_days':sum(not available[(d,platform)] for d in dates),
                     'comparison_status':'insufficient_target_days',
                     'incomplete_utc_day':False,
                     'partial': first.day != 1 or last.day != calendar.monthrange(year, month)[1],
                     'local_coverage': 'unknown', 'baseline': None, 'percentile': None, 'anomaly_pct': None}
            monthly.append(value)
            by_source[platform][key] = value
    # Each target month uses its own exact day-of-month window in baseline years.
    for value in monthly:
        key, platform = value['month'], value['platform']
        year, month = map(int, key.split('-'))
        low, high = windows[key]
        target_days=[day for day in range(low,high+1)
                     if (f'{year:04}-{month:02}-{day:02}',platform) in available
                     and (config['quality']=='all' or available[(f'{year:04}-{month:02}-{day:02}',platform)])]
        value['comparison_day_numbers']=target_days
        reference = []
        reference_years=[]
        reference_sp_eligible=[]
        for past in baseline:
            if past == year:
                continue  # Leave evaluated year out of its reference distribution.
            rates = []
            for day in target_days:
                if day>calendar.monthrange(past,month)[1]:
                    break
                d = f'{past:04}-{month:02}-{day:02}'
                if not (config['start'] <= d <= config['end']):
                    continue
                if (d, platform) in available and (config['quality'] == 'all' or available[(d, platform)]):
                    rates.append(lookup.get((d, platform), {}).get('cells', 0))
            # A baseline year must have the entire target day-of-month mask.
            # Otherwise averaging different sets of dates creates false anomalies.
            if rates and len(rates)==len(target_days):
                reference.append(statistics.mean(rates))
                reference_years.append(past)
                reference_sp_eligible.append(all(
                    available[(f'{past:04}-{month:02}-{day:02}',platform)]
                    and lookup.get((f'{past:04}-{month:02}-{day:02}',platform),{}).get('nrt_points',0)==0
                    for day in target_days))
        value['baseline_years'] = len(reference)
        value['baseline_year_ids']=reference_years
        # The fitted SP coefficient cannot validate a mixed SP/NRT reference.
        value['baseline_calibration_eligible']=len(reference)>=3 and all(reference_sp_eligible)
        enough_target=len(target_days)>=min(10,high-low+1)
        if enough_target:
            value['comparison_status']='ok' if len(reference)>=3 else 'insufficient_baseline'
        if enough_target and len(reference) >= 3:
            usual = statistics.median(reference)
            current = value['cells'] / value['eligible_days']
            value['baseline'] = usual * value['eligible_days']
            value['baseline_low'] = quantile(reference, .1) * value['eligible_days']
            value['baseline_high'] = quantile(reference, .9) * value['eligible_days']
            value['percentile'] = 100 * (sum(r < current for r in reference) + .5 * sum(r == current for r in reference)) / len(reference)
            if usual > 0:
                value['anomaly_pct'] = 100 * (current / usual - 1)
        if any(f'{year:04}-{month:02}-{day:02}' in config.get('incomplete_utc_dates',[]) for day in target_days):
            value.update(comparison_status='incomplete_utc_day',baseline=None,percentile=None,anomaly_pct=None,incomplete_utc_day=True)
    profiles = {}
    for platform in PLATFORMS:
        profile = []
        for month in range(1, 13):
            values = [row['cells'] / row['eligible_days'] for key, row in by_source[platform].items()
                      if int(key[:4]) in baseline and int(key[5:]) == month
                      and row['eligible_days'] >= 10 and not row['partial'] and not row['incomplete_utc_day']]
            profile.append({'month': month, 'years': len(values), 'median': quantile(values, .5),
                            'low': quantile(values, .1), 'high': quantile(values, .9)})
        valid = [row for row in profile if row['years'] >= 3 and row['median'] is not None]
        threshold = quantile([row['median'] for row in valid], .75)
        high = [row['month'] for row in valid if row['median'] > 0 and row['median'] >= threshold] if valid else []
        profiles[platform] = {'months': profile, 'high_activity_months': high}
    models = {}
    for platform in PLATFORMS:
        if platform == 'Aqua':
            continue
        pairs = []
        for key in months:
            year, month = map(int, key.split('-'))
            if windows[key] != (1, calendar.monthrange(year, month)[1]):
                continue
            common = [day.isoformat() for day in days_between(date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1]))
                      if available.get((day.isoformat(), 'Aqua')) and available.get((day.isoformat(), platform))]
            if len(common) < 10:
                continue
            reference = sum(lookup.get((d, 'Aqua'), {}).get('sp_cells', 0) for d in common)
            partner = sum(lookup.get((d, platform), {}).get('sp_cells', 0) for d in common)
            pairs.append({'month': key, 'aqua': reference, 'partner': partner, 'days': len(common)})
        fit = [row for row in pairs if int(row['month'][:4]) in baseline]
        test = [row for row in pairs if int(row['month'][:4]) > config['baseline_end']]
        total_x, total_y = sum(row['partner'] for row in fit), sum(row['aqua'] for row in fit)
        coefficient = total_y / total_x if total_x > 0 and total_y > 0 else None
        model = {'platform': platform, 'reference': 'Aqua', 'fit_months': len(fit), 'test_months': len(test),
                 'coefficient': coefficient, 'accepted': False, 'pairs': pairs,
                 'fit_start': config['baseline_start'], 'fit_end': config['baseline_end'],
                 'method': 'Ratio of SP cell-day totals on shared globally available dates; local coverage unknown.',
                 'calibration_scope':'SP only',
                 'status': 'insufficient_data', 'coefficient_interval': None}
        if coefficient is not None and test and sum(row['aqua'] for row in test) > 0:
            before = statistics.mean(abs(row['partner'] - row['aqua']) for row in test)
            after = statistics.mean(abs(row['partner'] * coefficient - row['aqua']) for row in test)
            seasonal = defaultdict(list)
            for row in fit:
                seasonal[row['month'][5:]].append(row['aqua']/row['days'])
            control = [abs(statistics.median(seasonal[row['month'][5:]])*row['days']-row['aqua'])
                       for row in test if seasonal[row['month'][5:]]]
            seasonal_mae=statistics.mean(control) if len(control)==len(test) else None
            model.update(mae_before=before, mae_after=after,
                         seasonal_mae=seasonal_mae,
                         improvement_pct=100 * (1 - after / before) if before else None,
                         bias_pct=100 * (sum(row['partner'] * coefficient for row in test) / sum(row['aqua'] for row in test) - 1))
            model['checks'] = {'fit_months':len(fit)>=24, 'test_months':len(test)>=12,
                 'active_fit_months':sum(row['partner']>0 or row['aqua']>0 for row in fit)>=6,
                 'improves_uncorrected':after<before,
                 'matches_or_beats_seasonal':seasonal_mae is not None and after<=seasonal_mae,
                 'bias_within_35_percent':abs(model['bias_pct'])<=35}
            model['accepted'] = all(model['checks'].values())
            model['status'] = 'experimental_validated' if model['accepted'] else 'validation_not_passed'
            blocks = defaultdict(lambda: [0, 0])
            for row in fit:
                blocks[row['month'][:4]][0] += row['aqua']
                blocks[row['month'][:4]][1] += row['partner']
            if len(blocks) >= 3:
                rng = random.Random(42)
                estimates = []
                for _ in range(200):
                    chosen = rng.choices(list(blocks.values()), k=len(blocks))
                    a, b = map(sum, zip(*chosen))
                    if b:
                        estimates.append(a / b)
                model['coefficient_interval'] = [quantile(estimates, .1), quantile(estimates, .9)]
        models[platform] = model
    for row in monthly:
        model=models.get(row['platform'],{})
        row['calibration_eligible']=row['cells'] is not None and row['nrt_points']==0 and row['preliminary_days']==0
        row['model_valid']=bool(model.get('accepted') and row['calibration_eligible'])
        row['aqua_equivalent']=row['cells']*model['coefficient'] if row['model_valid'] else None
        row['baseline_equivalent']=row['baseline']*model['coefficient'] if row['model_valid'] and row['baseline_calibration_eligible'] and row['baseline'] is not None else None
    return {'monthly': monthly, 'profiles': profiles, 'models': models,
            'weekly_profiles':weekly_profiles(lookup,available,config),
            'unit': f'active cell-days on a fixed {config["grid_km"]} km EPSG:6933 grid',
            'warnings': [
                'Горячая точка не равна отдельному пожару; площадь ячейки не равна выгоревшей площади.',
                'Локальная облачность и пригодность пролётов неизвестны. Ноль означает отсутствие записанных детекций, а не подтверждённое отсутствие огня.',
                'Экспериментальная калибровка проверяется на последующих годах относительно Aqua, а не относительно наземной истины.',
                'Число детекций разных платформ не складывается в число пожаров. NRT и неизвестный тип источника помечаются отдельно.',
                'Периоды высокой исторической активности — ориентир для внимания, не прогноз возникновения пожара.'
            ]}


def weekly_profiles(lookup,available,config):
    buckets=defaultdict(lambda:{'cells':0,'eligible_days':0,'incomplete_utc_day':False})
    start,end=date.fromisoformat(config['start']),date.fromisoformat(config['end'])
    for day in days_between(start,end):
        year,week,_=day.isocalendar()
        for platform in PLATFORMS:
            key=(day.isoformat(),platform)
            if key not in available or (config['quality']=='sp' and not available[key]):
                continue
            row=buckets[(platform,year,week)]
            row['cells']+=lookup.get(key,{}).get('cells',0)
            row['eligible_days']+=1
            if day.isoformat() in config.get('incomplete_utc_dates',[]):
                row['incomplete_utc_day']=True
    result={}
    for platform in PLATFORMS:
        years={}
        for year in range(start.isocalendar().year,end.isocalendar().year+1):
            values=[]
            for week in range(1,54):
                record=buckets.get((platform,year,week),{})
                days=record.get('eligible_days',0)
                values.append({'week':week,'cells':record.get('cells') if days else None,
                    'eligible_days':days,'complete':days==7 and not record.get('incomplete_utc_day'),
                    'rate':record.get('cells',0)/days if days==7 and not record.get('incomplete_utc_day') else None})
            years[str(year)]=values
        weeks=[]
        for week in range(1,54):
            rates=[years[str(y)][week-1]['rate'] for y in range(config['baseline_start'],config['baseline_end']+1)
                   if str(y) in years and years[str(y)][week-1]['rate'] is not None]
            weeks.append({'week':week,'years':len(rates),'median':quantile(rates,.5),
                'low':quantile(rates,.1),'high':quantile(rates,.9)})
        positive=[r['median'] for r in weeks if r['years']>=3 and r['median'] is not None and r['median']>0]
        threshold=quantile(positive,.75)
        metrics={}
        for year,values in years.items():
            valid=[r for r in values if r['rate'] is not None]
            active=[r['week'] for r in valid if threshold is not None and r['rate']>0 and r['rate']>=threshold]
            peak=max(valid,key=lambda r:r['rate']) if valid and any(r['rate']>0 for r in valid) else None
            first=date.fromisocalendar(int(year),1,1)
            last=date.fromisocalendar(int(year)+1,1,1)-timedelta(days=1)
            metrics[year]={'first_week':min(active) if active else None,'last_week':max(active) if active else None,
                'peak_week':peak['week'] if peak else None,'active_weeks':len(active),
                'total_cells':sum(r['cells'] or 0 for r in values),'available_weeks':len(valid),
                'start_date':max(first,start).isoformat(),'end_date':min(last,end).isoformat(),
                'partial_year':first<start or last>end}
        result[platform]={'weeks':weeks,'years':years,'threshold':threshold,'year_metrics':metrics,
            'year_basis':'ISO',
            'unit':'cell-days per globally available day within ISO week',
            'threshold_definition':'75th percentile of positive baseline weekly medians with >=3 years',
            'local_coverage':'unknown'}
    return result
