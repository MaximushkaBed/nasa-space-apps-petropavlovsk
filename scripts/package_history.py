"""Package the verified historical database for a teammate, excluding credentials."""

import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

from scripts.fetch_firms import PROJECT_ROOT, read_map_key


def main():
    source = PROJECT_ROOT / "data/raw/firms/sko/history"
    manifest = json.loads((source / "manifest.json").read_text())
    summary = json.loads((source / "summary.json").read_text())
    if manifest["status"] != "complete" or manifest["errors"]:
        raise ValueError("Complete the historical download before packaging it.")
    count = sum(summary["totals_by_source"].values())
    delivery = source / "delivery"
    delivery.mkdir(exist_ok=True)
    name = f"sko-history-{summary['requested_start']}_{summary['requested_end']}"
    path = delivery / f"{name}.zip"
    files = {}
    for filename in ("observations.csv", "monthly.csv", "yearly.csv", "summary.json"):
        files[f"data/{filename}"] = (source / filename).read_bytes()
    portable_manifest = json.loads(json.dumps(manifest))
    portable_manifest["cache_files_included"] = False
    for item in portable_manifest["completed"]:
        item["file"] = "cache/" + Path(item["file"]).name
    files["data/manifest.json"] = (json.dumps(portable_manifest, ensure_ascii=False, indent=2) + "\n").encode()
    for filename in ("north-kazakhstan.geojson", "README.md"):
        files[f"data/boundaries/{filename}"] = (PROJECT_ROOT / "data/boundaries" / filename).read_bytes()
    for item in (PROJECT_ROOT / "reports").iterdir():
        if item.is_file() and item.name.startswith("sko-"):
            files[f"reports/{item.name}"] = item.read_bytes()
    for item in (PROJECT_ROOT / "docs").rglob("*"):
        if item.is_file():
            files[str(item.relative_to(PROJECT_ROOT))] = item.read_bytes()
    for filename in ("fetch_firms.py", "build_history.py", "render_history.py"):
        files[f"scripts/{filename}"] = (PROJECT_ROOT / "scripts" / filename).read_bytes()
    readme = f"""# Историческая база СКО: MODIS и VIIRS

Период запросов: {summary['requested_start']} — {summary['requested_end']} (UTC).
Всего спутниковых детекций тепловых аномалий: {count:,}.
Источники: MODIS/Terra, MODIS/Aqua, VIIRS/Suomi-NPP, VIIRS/NOAA-20, VIIRS/NOAA-21.

## Как открыть

- Откройте `reports/sko-history.html` в браузере: годовой график, месячный календарь и выбор сенсора работают без сервера и интернета.
- `reports/sko-history.png` — графики для презентации.
- `data/observations.csv` — полная база исходных наблюдений с source, family, processing и platform.
- `data/monthly.csv`, `data/yearly.csv`, `data/summary.json` — агрегаты по отдельным сенсорам, версии данных и доступность источников.
- `docs/` — исследования и результаты проверки гармонизации.
- `data/manifest.json` — реестр {manifest['planned_jobs']} завершённых частей загрузки и их SHA-256. Кэш отдельных частей в архив не включён; основная таблица содержит их объединённые данные.
- `SHA256SUMS` — контрольные суммы файлов этого пакета.

## Что важно для анализа

Это исходная история, ещё не гармонизированная. Детекции не равны числу отдельных пожаров или выгоревшей площади. Стандартный архив SP продолжен NRT только после окончания доступного SP у каждого сенсора. Исходные версии коллекций, тип аномалии, уверенность и спутник сохранены. Нулевое число детекций не подтверждает отсутствие пожаров: пригодность спутникового покрытия не проверялась. Последние сутки, месяц и год неполные. Срок доступности Suomi-NPP отличается от NOAA-20 и NOAA-21.

Граница СКО: geoBoundaries / OpenStreetMap, референсный год 2017, ODbL; подробности в data/boundaries/README.md. Коэффициенты из исследования Оксаны не применялись автоматически к полному архиву.

Для использования готовой базы API-ключ не нужен. Для повторной загрузки из корня пакета запустите `python3 -m scripts.build_history --region sko --start 2000-11-01`; перед этим нужен собственный FIRMS_MAP_KEY в локальном `.env`. Исходный репозиторий: https://github.com/MaximushkaBed/nasa-space-apps-petropavlovsk.

Источник данных: NASA FIRMS / NASA LANCE / ESDIS — https://firms.modaps.eosdis.nasa.gov/. Данные предоставляются как есть.
"""
    files["README.md"] = readme.encode()
    files["SHA256SUMS"] = ("\n".join(
        hashlib.sha256(content).hexdigest() + "  " + name for name, content in sorted(files.items())
    ) + "\n").encode()
    key = read_map_key(PROJECT_ROOT / ".env").encode()
    if any(key in content for content in files.values()):
        raise ValueError("Credential check failed; package was not created.")
    with ZipFile(path, "w", ZIP_DEFLATED, compresslevel=6) as archive:
        for relative, content in sorted(files.items()):
            archive.writestr(name + "/" + relative, content)
    with ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError("Archive integrity check failed.")
        assert not any(Path(item).name in (".env", ".env.example") for item in archive.namelist())
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    checksum_path = path.with_suffix(".zip.sha256")
    checksum_path.write_text(digest + "  " + path.name + "\n")
    print(f"Package: {path}\nSize: {path.stat().st_size:,} bytes\nFiles: {len(files)}\nSHA-256: {digest}")


if __name__ == "__main__":
    main()
