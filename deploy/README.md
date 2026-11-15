# Общий сервер и автодеплой

Проект: `/root/platforms/projects/nasa-space-apps` на `ssh unik`.
Репозиторий: `repository/`; постоянные данные: `shared/data/firms-global/`.
Код и большие архивы имеют отдельный жизненный цикл. Коммит фронтенда не
останавливает синхронизацию и не удаляет данные. MVP Оксаны сохраняет свою
проверенную область СКО; наличие мирового архива не означает глобальную калибровку.

## Приложение

Komodo: <https://komodo.aican.cloud>, stack `nasa-space-apps`,
процедура [nasa-space-apps-deploy](https://komodo.aican.cloud/procedures/6af82a7a3434ddcf958fb601).
Конфигурация ресурсов — `komodo-stack.json` и `komodo-procedure.json`, Compose — `compose.yml`.
Вебхук push в `main` запускает процедуру, которая вызывает DeployStack.
Прямой webhook stack отключён. Перед сборкой `update-checkout.sh`
делает fetch + fast-forward. Ветка на сервере не предназначена для ручных правок;
если появились локальные коммиты, деплой останавливается без reset/force.

SSH-доступ Оксаны и изолированная рабочая среда описаны в [oksana-access.md](oksana-access.md).

Для GitHub создан отдельный SSH deploy key, только чтение этой репы.
Приватный ключ — `shared/keys/github-readonly`, права 0600, каталог 0700.
GitHub host keys получены из официального HTTPS API `/meta` и сохранены отдельно.
Ключ вебхука задаётся внутри Komodo и GitHub, в Git не хранится.

Адрес: <https://nasa.aican.cloud>, DNS A → `31.97.72.56`.
Сертификат выдан через существующий аккаунт Let's Encrypt на сервере.
Общий cron сервера продлевает сертификаты. Служба `nasa-space-apps-tls.timer`
раз в час сравнивает сертификат на диске с отдаваемым nginx и делает reload
только при изменении. Контейнеры приложений при этом не перезапускаются.
Приложение также доступно по <http://31.97.72.56:18088>. Для проверки vhost без DNS:

```bash
curl --resolve nasa.aican.cloud:443:31.97.72.56 https://nasa.aican.cloud/health
```

`public-nginx.conf` — отдельный vhost общего nginx. Перед reload обязательно
`docker exec nginx nginx -t`. HTTP перенаправляется на HTTPS, кроме ACME.
Порт 18088 обслуживает только этот проект.

Проверка: `/health` возвращает `ok`, JSON приложения доступен из `/data/`,
контейнер должен иметь статус healthy. Образы баз закреплены по digest;
CI собирает веб-образ, проверяет Compose, запускает тесты и сканирует Trivy.

## Мировой архив FIRMS

Первичный производитель — NASA LANCE FIRMS/ESDIS; зеркало GeoParquet —
[Portolan / Source Cooperative](https://source.coop/portolan-mirrors/firms-catalog).
Зеркало публикует данные как CC0-1.0. Оно не заменяет маски наблюдений и
не является независимым подтверждением спутниковых обнаружений.

`sync_global_firms.py` хранит годовые мировые данные с 2000 года, все
представленные в зеркале платформы, необязательные агрегаты и свежую ленту.
Фактическое покрытие, строки, SHA-256, ETag и время загрузки — в `manifest.json`.
STAC-описание сохраняется отдельно: его размеры и даты могут отставать от файлов.
Файл заменяется только после проверки Parquet; повторный запуск пропускает
неизменившиеся файлы по ETag и размеру. Одновременно работают два загрузчика,
один процесс синхронизации, DuckDB ограничен 512 МБ на соединение.

Структура данных:

```text
observations/year=YYYY/detections.parquet  исходные детекции
aggregate/year=YYYY/aggregate-r*.parquet   сеточные агрегаты издателя
aggregate/alltime-r*.parquet              агрегаты за всю историю
live/year=YYYY/live.parquet               перекрывающаяся свежая лента
derived/live-tail.parquet                 только новые детекции после anti join
metadata/                                исходные STAC-описания
manifest.json                            состояние и происхождение
```

Для анализа объединять `observations/year=*/detections.parquet` с
`derived/live-tail.parquet`, **не с исходным live**. Идентичность детекции
в зеркале — `(sensor, acq_datetime, geometry)`; дубли live выбираются с
приоритетом SP. Если синхронизация incomplete, проверять ошибки и актуальность
live_tail в манифесте. Суточные/годовые агрегаты не содержат sensor × date;
для календаря по спутникам нужны исходные записи. Геометрия — CRS84 lon/lat.

Известный пробел: NOAA-21 в зеркале начинается 17.01.2024, хотя NASA SP
доступен с 01.03.2023. Ранний NOAA-21 требует отдельной догрузки. Нельзя
объявлять зеркало полным архивом всех продуктов NASA. NRT предварительные,
отсутствие строки не подтверждает наблюдение без огня. Поправки СКО не
применяются к миру. Реестры США/Канады и другие исследования перечислены в
[каталоге источников](../docs/global-data/README.md), пока не включены в этот импорт.

Через `/datasets/` доступны только открытые научные файлы. Ключи находятся
за пределами смонтированного каталога. Большие данные не входят в Git.
Оксана может читать общие файлы на сервере или скачивать Parquet и манифест
из `/datasets/`, без повторной выгрузки с ноутбука Максима.

Сервис `global-fires` в основном Compose читает этот же архив. Nginx
проксирует `/api/fires/range` для границ доступных дат и
`/api/fires/YYYY-MM-DD` для одного дня UTC. Сервис исключает низкую
уверенность и известные статические тепловые источники из поля `type`.
Архивные кадры и свежий остаток читаются из подготовленного архива.
Ответы за день сжимаются gzip и кэшируются в памяти по версии файлов.
Для локальной проверки можно задать `FIRMS_DATA_DIR` с той же структурой
каталогов и запустить `python scripts/serve_global_fires.py`.

`/api/fires/period?start=YYYY-MM-DD&end=YYYY-MM-DD` агрегирует включительный
интервал UTC. До 31 дня используется тот же фильтр качества, что и для
суточных кадров, и поддерживается `&satellite=0` (индексы из `/range`).
Пары координат в ответе — взвешенные центры сетки 1°, для СКО и окрестностей
0,08°. Отдельный счётчик `regionalCount` вычисляется по исходным координатам
детекций внутри той же границы СКО, что и на карте.

Длинные интервалы берут годовые сетки Portolan по суточным столбцам, с
добавлением новых детекций из `live-tail`. Эти данные включают все платформы
и весь набор записей издателя. Позиции и счётчик СКО приблизительны, поскольку
опираются на центры ячеек издателя. Ответ передаёт `method`, `regionalExact`, `regionalByPlatform`,
`coveredStart`, `coveredEnd`, `missing` и группы `points` формата
`[longitude, latitude, platform, weight]`. `-1` означает неизвестную или
сгруппированную платформу. Даты покрытия отражают наличие данных в архиве.

Атлас при приближении запрашивает исходные координаты через
`/api/fires/viewport?start=YYYY-MM-DD&end=YYYY-MM-DD&bbox=west,south,east,north`.
Область WGS84 ограничена 20° по долготе и 15° по широте. При пересечении
меридиана ±180° значение `west` больше `east`. У окна до 31 дня те же
фильтры, что у суточной карты, включая `&satellite=0`. За более длинный
период запрос читает все исходные записи доступных годовых Parquet и свежего
остатка. Уровни обзора используют агрегаты издателя, поэтому их счётчики
приблизительны. В ответе `status: ok` массив содержит исходные детекции
`[longitude, latitude, platform, 1, acquiredAt]`, время UTC. Статусы `too_dense`
(свыше 25 000 записей) и `too_slow` (ограничение времени 18 с или занятый
запрос карты) возвращают пустой массив. `coveredStart`, `coveredEnd` и
`missing` описывают доступность архивных файлов в каталоге. Запросы
детализации выполняются отдельно от обычных кадров и сводок.

Сервис `analysis` обслуживает `/api/v1/`: асинхронные пространственные запросы,
календарь, недельную сезонность, сравнение лет, карты отклонений и экспорт.
Веб-приложение открывается на `/`, прежний атлас — на `/atlas.html`.
Методика и контракт описаны в [docs/workbench.md](../docs/workbench.md).
Архив монтируется read-only в `/data`, производный кэш — в `/cache`:

```bash
install -d -o 10001 -g 10001 /root/platforms/projects/nasa-space-apps/shared/cache/analysis
```

Ограничения analysis: 0,75 CPU, 1536 МБ, pids128, один worker и один запрос карты;
первый расчёт новой территории занимает минуты, повтор использует кэш.
При сборке устанавливается DuckDB spatial. Изменения API/web публикует та же
процедура Komodo; загрузчик архива продолжает обновляться независимо.

Служба загрузки работает в отдельном контейнере: 1 CPU, максимум 2 ГиБ,
непривилегированный UID 10001, read-only root, без capabilities. Планировщик
запускает обновление через час после предыдущего завершения.

```bash
systemctl status nasa-space-apps-data.service nasa-space-apps-data.timer
journalctl -u nasa-space-apps-data.service -n 60 --no-pager
systemctl start --no-block nasa-space-apps-data.service
```

При изменении загрузчика пересобрать его отдельно; веб-деплой этого не делает:

```bash
cd /root/platforms/projects/nasa-space-apps/repository
docker build -f deploy/Dockerfile.data -t nasa-space-apps-data:current .
```

## Откат приложения

Перед ручным рискованным обновлением сохранить текущий образ:

```bash
docker image tag nasa-space-apps-web:current nasa-space-apps-web:rollback
docker image tag nasa-space-apps-analysis:current nasa-space-apps-analysis:rollback
```

`update-checkout.sh` перед деплоем автоматически сохраняет предыдущие образы
веба и API анализа как `rollback`. Отключить процедуру автодеплоя в Komodo,
восстановить образы и запустить эти два сервиса без сборки:

```bash
docker image tag nasa-space-apps-web:rollback nasa-space-apps-web:current
docker image tag nasa-space-apps-analysis:rollback nasa-space-apps-analysis:current
cd /root/platforms/projects/nasa-space-apps/repository
docker compose -f deploy/compose.yml up -d --no-build web analysis
curl -f http://127.0.0.1:18088/health
curl -f http://127.0.0.1:18088/api/v1/health
```

Затем исправить код обычным коммитом и включить вебхук. Постоянное хранилище
при откате не затрагивается. Архивы и контрольные суммы не являются резервной
копией сервера; для уникальных результатов исследования нужен отдельный backup.
