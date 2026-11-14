"""Publish an immutable server-side FIRMS snapshot as verified GitHub assets.

Run --prepare first; it uses hard links so the 12 GB archive is not copied.
Publishing reads a GitHub token from stdin, uses it only in child environments,
and never writes credentials to disk. Requires an authenticated token and gh.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import zipfile

REPO = 'MaximushkaBed/nasa-space-apps-petropavlovsk'


def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def asset_name(relative):
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Invalid dataset path')
    return 'firms-global-' + relative.replace('/', '--').replace('=', '-')


def prepare(root, destination, tag):
    destination.mkdir(parents=True, exist_ok=True)
    plan_path = destination / 'upload-plan.json'
    if plan_path.exists():
        plan = json.loads(plan_path.read_text())
        if plan['tag'] != tag:
            raise ValueError('Existing export has another release tag')
        return plan
    with (root / '.sync.lock').open('r') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads((root / 'manifest.json').read_text())
        if state['status'] != 'ready' or state['errors'] or len(state['assets']) != len(state['plan']):
            raise ValueError('Source snapshot is not fully ready')
        records = []
        datasets = list(state['assets'].values())
        if state.get('live_tail'):
            datasets.append(state['live_tail'])
        for item in sorted(datasets, key=lambda item: item['path']):
            source = root / item['path']
            name = asset_name(item['path'])
            target = destination / name
            if not source.is_file() or source.stat().st_size != item['size']:
                raise ValueError('Source file is missing or has the wrong size: ' + item['path'])
            if item['size'] >= 2 * 1024**3:
                raise ValueError('File exceeds the GitHub release asset size limit: ' + item['path'])
            if target.exists():
                if not os.path.samefile(source, target):
                    raise ValueError('Incomplete snapshot must be inspected before reuse')
            else:
                os.link(source, target)
            records.append({'name': name, 'path': item['path'], 'kind': item['kind'],
                            'size': item['size'], 'sha256': item['sha256']})
        # All source metadata are NASA/public science metadata, never server keys.
        for filename in ['manifest.json', 'catalog.json']:
            if (root / filename).exists():
                name = 'firms-global-source-' + filename
                shutil.copyfile(root / filename, destination / name)
        with zipfile.ZipFile(destination / 'firms-global-source-metadata.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
            for source in sorted((root / 'metadata').glob('*.json')):
                archive.write(source, 'metadata/' + source.name)
        exported_at = datetime.now(timezone.utc).isoformat()
        readme = (
            'Worldwide NASA FIRMS observations via Portolan / Source Cooperative\n\n'
            f'Source snapshot: {state["updated_at"]}\nPrepared: {exported_at}\n'
            f'Base rows: {state["observation_rows"]:,}\n'
            f'Additional non-overlapping live rows: {state.get("live_tail", {}).get("rows", 0):,}\n\n'
            'Files are already compressed Parquet. Use release-manifest.json to map asset names '
            'back to original directories; verify SHA256SUMS before use.\n'
            'Query yearly observations PLUS derived/live-tail.parquet. The raw live file overlaps '
            'the base and must not be blindly appended. Aggregate files are a different dataset.\n\n'
            + '\n'.join('- ' + note for note in state['notes']) + '\n\n'
            'Authoritative producer: NASA LANCE FIRMS / ESDIS. Mirror: Portolan / Source Cooperative. '
            'Mirror license: CC0-1.0. https://source.coop/portolan-mirrors/firms-catalog\n'
        )
        (destination / 'firms-global-README.txt').write_text(readme)
        for name in ['firms-global-source-manifest.json', 'firms-global-source-catalog.json',
                     'firms-global-source-metadata.zip', 'firms-global-README.txt']:
            p = destination / name
            if p.exists():
                records.append({'name': name, 'kind': 'metadata', 'size': p.stat().st_size, 'sha256': checksum(p)})
        export = {'tag': tag, 'repo': REPO, 'prepared_at': exported_at,
                  'source_snapshot_at': state['updated_at'], 'base_rows': state['observation_rows'],
                  'live_tail_rows': state.get('live_tail', {}).get('rows', 0),
                  'notes': state['notes'], 'files': records.copy()}
        p = destination / 'release-manifest.json'
        p.write_text(json.dumps(export, ensure_ascii=False, indent=2) + '\n')
        records.append({'name': p.name, 'kind': 'manifest', 'size': p.stat().st_size, 'sha256': checksum(p)})
        sums = destination / 'SHA256SUMS'
        sums.write_text(''.join(item['sha256'] + '  ' + item['name'] + '\n' for item in records))
        records.append({'name': sums.name, 'kind': 'checksums', 'size': sums.stat().st_size, 'sha256': checksum(sums)})
        plan = {'tag': tag, 'repo': REPO, 'prepared_at': exported_at, 'assets': records}
        plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
        return plan


def verify_asset(asset, expected):
    if asset.get('state') != 'uploaded' or asset.get('size') != expected['size']:
        raise ValueError('GitHub file is incomplete: ' + expected['name'])
    if asset.get('digest') != 'sha256:' + expected['sha256']:
        raise ValueError('GitHub SHA-256 mismatch: ' + expected['name'])


def publish(destination, plan, gh, token):
    environment = dict(os.environ, GH_TOKEN=token, GH_PROMPT_DISABLED='1')

    def command(args, timeout=180):
        result = subprocess.run([str(gh), *args], env=environment, capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            # gh receives the token through environment, never through argv.
            raise RuntimeError('GitHub command failed: ' + args[0] + ': ' + result.stderr[-500:])
        return result.stdout

    def api(endpoint):
        # Read-after-write checks must not reuse a cached pre-upload response.
        separator = '&' if '?' in endpoint else '?'
        fresh = endpoint + separator + '_verification=' + str(time.time_ns())
        return json.loads(command(['api', '--method', 'GET', '-H', 'Cache-Control: no-cache', fresh]))

    releases = api(f'repos/{REPO}/releases?per_page=100')
    release = next((r for r in releases if r['tag_name'] == plan['tag']), None)
    notes = destination / 'release-notes.md'
    notes.write_text(
        'Мировой архив спутниковых обнаружений MODIS/VIIRS: 2000–14 ноября 2026. '
        '641 501 367 строк в годовых файлах и 81 055 новых строк после удаления перекрытий live.\n\n'
        'Данные подготовлены на общем сервере unik. Каждый файл проверен по размеру и SHA-256 GitHub. '
        'Имена исходных путей и правила объединения: release-manifest.json и firms-global-README.txt. '
        'Для скачивания можно выбирать отдельные годы.\n\n'
        'Это исходные обнаружения, не число отдельных пожаров и не глобально гармонизированный ряд. '
        'Зеркало не содержит ранний NOAA-21 (март 2023–16 января 2024). '
        'Национальные реестры, погода и маски наблюдений в этот релиз не входят.\n\n'
        'NASA LANCE FIRMS / ESDIS; зеркало Portolan / Source Cooperative, CC0-1.0.\n'
    )
    if release is None:
        command(['release', 'create', plan['tag'], '--repo', REPO, '--draft', '--target', 'main',
                 '--title', 'Мир: MODIS и VIIRS, 2000–2026', '--notes-file', str(notes)])
        for attempt in range(5):
            release = next((r for r in api(f'repos/{REPO}/releases?per_page=100') if r['tag_name'] == plan['tag']), None)
            if release is not None:
                break
            time.sleep(attempt + 1)
        if release is None:
            raise RuntimeError('New draft is not yet visible through GitHub API; rerun to resume')
    endpoint = f'repos/{REPO}/releases/{release["id"]}/assets?per_page=100'
    existing = {a['name']: a for a in api(endpoint)}

    def transfer(item):
        asset = existing.get(item['name'])
        if asset is not None:
            verify_asset(asset, item)
            return asset
        for attempt in range(3):
            try:
                command(['release', 'upload', plan['tag'], str(destination / item['name']), '--repo', REPO], timeout=3600)
                asset = next(a for a in api(endpoint) if a['name'] == item['name'])
                verify_asset(asset, item)
                return asset
            except Exception:
                # A transfer may have completed despite losing its HTTP response.
                asset = next((a for a in api(endpoint) if a['name'] == item['name']), None)
                if asset and asset.get('state') == 'uploaded':
                    verify_asset(asset, item)
                    return asset
                if asset and asset.get('state') == 'starter' and release['draft']:
                    command(['api', '--method', 'DELETE', f'repos/{REPO}/releases/assets/{asset["id"]}'])
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)

    results = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = {pool.submit(transfer, item): item for item in plan['assets']}
        for future in as_completed(pending):
            item = pending[future]
            asset = future.result()
            results[item['name']] = {'id': asset['id'], 'size': asset['size'], 'digest': asset['digest']}
            print(f'Verified {len(results)}/{len(plan["assets"])}: {item["name"]}', flush=True)
    final = {a['name']: a for a in api(endpoint)}
    for item in plan['assets']:
        verify_asset(final[item['name']], item)
    command(['release', 'edit', plan['tag'], '--repo', REPO, '--draft=false', '--latest=false', '--notes-file', str(notes)])
    result = {'status': 'published', 'release_url': release['html_url'], 'tag': plan['tag'],
              'assets': results, 'verified_at': datetime.now(timezone.utc).isoformat()}
    (destination / 'published.json').write_text(json.dumps(result, indent=2) + '\n')
    print('Published ' + release['html_url'], flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data-dir', type=Path, required=True)
    p.add_argument('--snapshot-dir', type=Path, required=True)
    p.add_argument('--tag', default='data-global-2026-11-14')
    p.add_argument('--prepare', action='store_true')
    p.add_argument('--gh', type=Path)
    args = p.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+', args.tag):
        raise ValueError('Invalid release tag')
    plan = prepare(args.data_dir, args.snapshot_dir, args.tag)
    if args.prepare:
        print(f'Prepared {len(plan["assets"])} assets, {sum(a["size"] for a in plan["assets"]):,} bytes')
        return
    if not args.gh:
        p.error('--gh is required to publish')
    token = sys.stdin.readline().strip()
    if not token:
        raise ValueError('Supply a GitHub token through stdin')
    publish(args.snapshot_dir, plan, args.gh, token)


if __name__ == '__main__':
    main()
