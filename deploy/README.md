# Общий сервер и автодеплой

Проект: `/root/platforms/projects/nasa-space-apps` на `ssh unik`.
Репозиторий: `repository/`; постоянные данные: `shared/data/firms-global/`.
Код и большие архивы имеют отдельный жизненный цикл. Коммит фронтенда не
останавливает синхронизацию и не удаляет данные. MVP Оксаны сохраняет свою
проверенную область СКО; наличие мирового архива не означает глобальную калибровку.

## Приложение

Komodo: <https://komodo.aican.cloud>, stack `nasa-space-apps`.
Конфигурация ресурса — `komodo-stack.json`, Compose — `compose.yml`.
Вебхук push в `main` запускает deploy. Перед сборкой `update-checkout.sh`
делает fetch + fast-forward. Ветка на сервере не предназначена для ручных правок;
если появились локальные коммиты, деплой останавливается без reset/force.

Для GitHub создан отдельный SSH deploy key, только чтение этой репы.
Приватный ключ — `shared/keys/github-readonly`, права 0600, каталог 0700.
GitHub host keys получены из официального HTTPS API `/meta` и сохранены отдельно.
Ключ вебхука задаётся внутри Komodo и GitHub, в Git не хранится.

Адрес: `nasa.aican.cloud`. Требуется DNS A → `31.97.72.56`; пока DNS не настроен,
приложение доступно по <http://31.97.72.56:18088>. Для проверки vhost без DNS:

```bash
curl --resolve nasa.aican.cloud:80:31.97.72.56 http://nasa.aican.cloud/health
```

`public-nginx.conf` — отдельный vhost общего nginx. Перед reload обязательно
`docker exec nginx nginx -t`. HTTPS включается после настройки DNS и выдачи
сертификата существующим Certbot. Порт 18088 обслуживает только этот проект.

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
```

`update-checkout.sh` перед деплоем автоматически сохраняет предыдущий образ
как `rollback`. Отключить вебхук stack в Komodo, восстановить образ и запустить без сборки:

```bash
docker image tag nasa-space-apps-web:rollback nasa-space-apps-web:current
cd /root/platforms/projects/nasa-space-apps/repository
docker compose -f deploy/compose.yml up -d --no-build
curl -f http://127.0.0.1:18088/health
```

Затем исправить код обычным коммитом и включить вебхук. Постоянное хранилище
при откате не затрагивается. Архивы и контрольные суммы не являются резервной
копией сервера; для уникальных результатов исследования нужен отдельный backup.
