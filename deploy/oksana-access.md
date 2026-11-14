# Доступ Оксаны к NASA

Вход: `ssh oksana@nasa.aican.cloud`, только по личному публичному ключу.
Парольный вход, forwarding и agent forwarding отключены для этого пользователя.

Сеанс SSH и SFTP запускается внутри отдельного контейнера от UID Оксаны.
Доступны:

- `/workspace` — личная редактируемая копия Git-репозитория;
- `/data` — общий мировой архив, только чтение;
- `/results` — постоянные результаты исследований;
- `/home/oksana` — личные настройки и дополнительные Python-пакеты.

Продакшен-checkout, серверные ключи, Docker socket и другие проекты сервера
не смонтированы. У пользователя нет доступа к host shell и группе docker.
Ресурсы контейнера: 1 CPU, 2 ГиБ памяти, 256 процессов.

CI собирает и сканирует рабочий образ. Единственное исключение в
`workspace.trivyignore` относится к CVE-2025-47273: pip содержит только
`pkg_resources` из setuptools, а затронутый `setuptools.package_index`
отсутствует. Dockerfile проверяет отсутствие пакета и файла при каждой сборке;
исключение не применяется к веб-образу и импортёру данных.

Код обновляется обычным `git pull` внутри `/workspace`: создан отдельный
GitHub deploy key только для чтения этой репы, он хранится в её домашнем
каталоге и не даёт доступа к другим репозиториям. Для push пользователь
настраивает собственную авторизацию GitHub внутри рабочего окружения;
серверный ключ администратора туда не передаётся. Push в main запускает Komodo.

Рабочая копия хранится на хосте в
`/root/platforms/projects/nasa-space-apps/workspaces/oksana/repository`,
результаты — в `shared/results/oksana`, домашний каталог — в
`workspaces/oksana/home`. Остановка контейнера их не удаляет.

SSH принудительно вызывает root-owned `/usr/local/sbin/nasa-space-apps-shell`.
Его единственное разрешённое действие — `docker exec` от фиксированного
непривилегированного UID в контейнер `nasa-space-apps-oksana`. Клиентская
команда передаётся аргументом в bash внутри контейнера, на хосте не выполняется.
Настройки UID/GID находятся в `/etc/nasa-space-apps/oksana.json`, sudoers —
в `/etc/sudoers.d/nasa-space-apps-oksana`. Публичные ключи администратор
добавляет в `/etc/ssh/authorized_keys/oksana` (root-owned, 0644).

Для отключения доступа убрать её публичный ключ и остановить только
`nasa-space-apps-oksana`. Для полного отката удалить управляемый Match-блок
NASA из конца sshd_config и её sudoers, выполнить `sshd -t`, затем reload ssh.
Каталоги с кодом и результатами сохранять.

## Windows

В PowerShell (новый ключ с отдельным именем):

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\id_ed25519_nasa_new" -C "oksana-nasa"
Get-Content "$env:USERPROFILE\.ssh\id_ed25519_nasa_new.pub"
```

Администратору передаётся только одна строка `ssh-ed25519 AAAA…` из `.pub`.
Закрытый ключ остаётся на компьютере. Если закрытый ключ был опубликован,
его не использовать: сгенерировать новую пару.

После добавления публичного ключа:

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519_nasa_new" oksana@nasa.aican.cloud
```

Passphrase ключа, если задана, запрашивается локально. Это не пароль сервера.
Для сохранения passphrase можно использовать Windows ssh-agent по
[официальной инструкции Microsoft](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement).
