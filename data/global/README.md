# Мировые наблюдения FIRMS

Большие Parquet находятся на общем сервере `unik`, а не в этом Git-каталоге:
`/root/platforms/projects/nasa-space-apps/shared/data/firms-global/`.

Снимок архива также распространяется через
[GitHub Release data-global-2026-11-14](https://github.com/MaximushkaBed/nasa-space-apps-petropavlovsk/releases/tag/data-global-2026-11-14).
Можно скачать отдельные годы. `release-manifest.json` сопоставляет имена
release assets исходным путям; `SHA256SUMS` содержит контрольные суммы.
Parquet уже сжат, единый ZIP на 12 ГБ не нужен. Релиз сохраняет фиксированный
снимок, серверный каталог продолжает обновляться независимо.

Публикация: `scripts/publish_global_release.py`. На сервере под короткой
блокировкой синхронизации создаются hard links, поэтому обновление исходного
архива не меняет файлы в процессе отправки и не требует второй копии 12 ГБ.
Токен передаётся через stdin по SSH, используется только в окружении дочерних
процессов GitHub CLI и не записывается на диск. Релиз остаётся draft, пока
GitHub не подтвердит размер и SHA-256 всех файлов.

Открытый каталог: <https://nasa.aican.cloud/datasets/catalog.json>.
Полный манифест: <https://nasa.aican.cloud/datasets/manifest.json>.
Если DNS ещё распространяется, временный адрес —
<http://31.97.72.56:18088/datasets/>.

`catalog.json` рядом с этим README — компактный снимок проверки, сохранённый
в Git для совместной работы. Серверный каталог обновляется независимо; для
свежих данных смотреть его время и статус, а не дату последнего Git-коммита.

Данные представляют спутниковые обнаружения, не количество пожаров.
Правила запроса, перекрытие live/архива и известный пробел раннего NOAA-21:
[описание инфраструктуры](../../deploy/README.md).
Национальные реестры и предложенные проверки:
[исследовательские заметки](../../docs/global-data/README.md).

Пример чтения в DuckDB 2.0 (на сервере, одна строка на наблюдение):

```sql
SELECT sensor, satellite, date_trunc('month', acq_datetime) AS month,
       count(*) AS detections
FROM (
    SELECT * FROM read_parquet(
        '/data/observations/year=*/detections.parquet', hive_partitioning=false
    )
    UNION ALL BY NAME
    SELECT * FROM read_parquet('/data/derived/live-tail.parquet', hive_partitioning=false)
)
GROUP BY ALL
ORDER BY month, sensor, satellite;
```

Этот запрос показывает исходные ряды приборов и не выполняет гармонизацию.
