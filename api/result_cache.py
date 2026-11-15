"""Scientific identities and small persistent indexes for immutable job results.

An identity locates a result; it is deliberately not the public job ID. A repair
or recomputation receives a fresh ID so saved revisions can never be overwritten.
"""
import hashlib
import json
from pathlib import Path
import re


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()[:32]


def scientific_config(config, *, spatial=False):
    result = {key: value for key, value in config.items()
              if key not in ('roi_name', 'roi_source') and not (spatial and key.startswith('baseline_'))}
    if result.get('bbox'):
        result['bbox'] = [float(value) for value in result['bbox']]
    if result.get('geometry'):
        def coordinates(value):
            return [coordinates(item) for item in value] if isinstance(value, list) else float(value)
        result['geometry'] = {**result['geometry'], 'coordinates': coordinates(result['geometry']['coordinates'])}
    # Geometry coordinates are not rounded: holes and dateline parts stay exact.
    if result.get('circle'):
        circle = result['circle']
        result['circle'] = {'center': [float(v) for v in circle['center']],
                            'radius_km': float(circle['radius_km'])}
    return result


def source_identity(sources):
    values = []
    for source in sources:
        path = source.get('path')
        matched = re.search(r'year=(\d{4})', path or '')
        year = source.get('year') or (int(matched[1]) if matched else None)
        if year is None and source.get('end'):
            year = int(source['end'][:4])
        values.append({'path': path, 'year': year, 'sha256': source['sha256'],
                       'start': source.get('start'), 'end': source.get('end')})
    if not values or any(not isinstance(v['sha256'], str) or not v['sha256'] for v in values):
        raise ValueError('В выбранном периоде нет проверенных файлов архива.')
    return sorted(values, key=lambda value: json.dumps(value, sort_keys=True))


def incomplete_day(config, through):
    return through[:10] if through and config['start'] <= through[:10] <= config['end'] else None


def spatial_key(config, sources, geometry_sha, outages_sha, extract_version, through=None):
    return digest({'config': scientific_config(config, spatial=True), 'sources': source_identity(sources),
                   'geometry_sha': geometry_sha, 'outages_sha': outages_sha, 'extract_version': extract_version,
                   'incomplete_utc_date': incomplete_day(config, through)})


def analysis_key(config, sources, geometry_sha, outages_sha, extract_version, analysis_version, through):
    incomplete = incomplete_day(config, through)
    return digest({'config': scientific_config(config), 'sources': source_identity(sources),
                   'geometry_sha': geometry_sha, 'outages_sha': outages_sha, 'extract_version': extract_version,
                   'analysis_version': analysis_version, 'incomplete_utc_date': incomplete})


def recorded_analysis_key(result):
    provenance = result['provenance']
    return analysis_key(result['config'], provenance['sources'], provenance['geometry_sha256'],
                        provenance['outages_sha256'], provenance['extract_version'],
                        result['analysis_version'], result.get('through'))


def recorded_spatial_key(result):
    provenance = result['provenance']
    return spatial_key(result['config'], provenance['sources'], provenance['geometry_sha256'],
                       provenance['outages_sha256'], provenance['extract_version'], result.get('through'))


def matrix_key(analysis_id, analysis, version):
    return digest({'analysis_id': analysis_id, 'version': version,
                   'analysis': {**{key: analysis[key] for key in ('extract_id', 'snapshot_at', 'analysis_version')},
                                'config': scientific_config(analysis['config'])},
                   'monthly': analysis['monthly']})


def read_json(path):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, TypeError):
        return None


class ResultIndex:
    def __init__(self, cache, kind, write):
        if kind not in ('analysis', 'matrix', 'extract'):
            raise ValueError('Unsupported result index')
        self.root = Path(cache) / 'result-index' / kind
        self.write = write

    def get(self, key):
        value = read_json(self.root / (key + '.json'))
        identifier = value.get('id') if value and value.get('key') == key and value.get('version') == 1 else None
        return identifier if isinstance(identifier, str) and re.fullmatch('[0-9a-f]{32}', identifier) else None

    def put(self, key, identifier):
        try:
            self.write(self.root / (key + '.json'), {'version': 1, 'key': key, 'id': identifier})
            # This is a disposable lookup, not a revision store. Bound stale
            # pointers left by normal jobs/extract eviction.
            paths = sorted(self.root.glob('*.json'), key=lambda path: path.stat().st_mtime, reverse=True)
            for path in paths[1024:]:
                path.unlink(missing_ok=True)
        except OSError:
            # A full cache must not turn a successfully computed result into an
            # error. Its immutable job file remains usable by its original ID.
            pass
