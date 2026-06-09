# FreeQwenApi — локальный OpenAI-API через Qwen Chat

![Contact](https://img.shields.io/badge/Contact-mandrykinsergey@-blue)
![API](https://img.shields.io/badge/API-OpenAI--compatible-green)
![Qwen](https://img.shields.io/badge/Qwen-Chat-purple)

> **Локальный прокси, превращает аккаунт Qwen Chat в стандартный OpenAI API.**  
> Контакты: `mandrykinsergey@gmail.com` | [twitch.tv/dnovitv](https://www.twitch.tv/dnovitv)

## Что это такое?

FreeQwenApi — это мост между вашим локальным компьютером и веб-версией Qwen Chat. Проект запускает скрытый браузер, авторизуется в `chat.qwen.ai`, а затем отдаёт ответы модели по адресу `http://localhost:3264/api` в формате OpenAI.

**Это не скачанная модель на вашу видеокарту** и **не официальный API от Alibaba**. Это удобный инструмент, который позволяет использовать любой OpenAI-совместимый софт (Open WebUI, LiteLLM, Zed Agent) с бесплатным/базовым аккаунтом Qwen.

```text
Ваша программа  →  FreeQwenApi (localhost:3264)  →  Браузер в фоне (Puppeteer)  →  chat.qwen.ai
         ↑_________________________________________________________↓___________________________↓
                              Ответ от ИИ (OpenAI формат)
```

## Как начать работу

Требуется установленный [Node.js](https://nodejs.org/) (версия 18+).

### 1. Установка и первый запуск
```bash
git clone https://github.com/ForgetMeAI/FreeQwenApi
cd FreeQwenApi
npm install
```

### 2. Добавление аккаунта Qwen
Команда запустит браузер Chromium. Войдите в свой аккаунт на `chat.qwen.ai`, затем закройте окно браузера. Токены сохранятся автоматически в папке `session/`.
```bash
npm run auth -- --add
```

### 3. Синхронизация моделей и старт сервера
```bash
npm run models:sync         # скачает актуальный список доступных моделей (qwen3-coder-plus, qwen3-max...)
SKIP_ACCOUNT_MENU=true npm start
```

### 4. Проверка работоспособности
Сервер готов к запросам на порту `3264`. Запустите встроенную проверку:
```bash
npm run smoke
```

## Как пользоваться API

Любой клиент, который умеет работать с OpenAI, подключается через базовый URL:  
`http://localhost:3264/api` (API Key можно указать любой, например `dummy-key`).

### Пример запроса (curl)
```bash
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "messages": [{"role": "user", "content": "Что такое FreeQwenApi?"}],
    "stream": false
  }'
```

### Пример кода (JavaScript / TypeScript)
```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api',
  apiKey: 'dummy-key' // ключ любой, сервер не проверяет его строго
});

const response = await openai.chat.completions.create({
  model: 'qwen3.7-max',
  messages: [{ role: 'user', content: 'Привет! Напиши коротко о проекте.' }]
});

console.log(response.choices[0].message.content);
```

### Подключение Open WebUI
1. Скачайте и запустите локальный [Open WebUI](https://github.com/open-webui/open-webui).
2. Перейдите в настройки провайдера (Providers → OpenAI API Compatible).
3. Введите:
   - **Base URL**: `http://localhost:3264/api` (если Open WebUI стоит в Docker — `http://host.docker.internal:3264/api`)
   - **API Key**: `dummy-key`
   - **Model**: выберите из списка (например, `qwen3.7-max`)

## Работа с инструментами (Tool Calling)

Проект умеет работать со сложными AI-агентами, которые требуют вызова внешних инструментов (`tool_calls`), таких как чтение файлов, выполнение команд в терминале и т.д. 

**Нюанс реализации:** Официальный веб-API Qwen Chat не принимает инструменты в нативном формате OpenAI (если отправить их напрямую — модель вернёт ошибку `"Tool X does not exists"`). Чтобы обойти это ограничение без потери качества:
1. Схемы инструментов безопасно впрыскиваются внутрь системного сообщения и последнего запроса пользователя (`prompt-injection`).
2. Модель генерирует вызовы в виде JSON-блока внутри обычного текстового ответа.
3. FreeQwenApi парсит этот блок, отрезает лишний текст и отдаёт клиенту (Zed Agent, Claude Desktop и др.) чистые `tool_calls` по стандарту OpenAI.

Работает стабильно даже при больших списках инструментов благодаря сжатию схем (`MAX_SCHEMA_LEN=6000`) и встроенной защите от зацикливания повторяющихся запросов (`anti-loop guards`).

## Мультиаккаунты и лимиты (Rate Limits)
Бесплатные и базовые аккаунты Qwen ограничивают количество запросов в минуту/час. FreeQwenApi умеет хранить несколько аккаунтов одновременно:
- `npm run auth -- --add` — добавить новый аккаунт.
- Когда текущий аккаунт упирается в лимит → сервер автоматически переключается на следующий доступный аккаунт (round-robin ротация).
- Статусы аккаунтов отслеживаются: `OK` / `WAIT` / `INVALID`.

## Полезные команды

| Команда | Описание |
|---------|----------|
| `npm start` | Запустить сервер прокси |
| `npm run auth -- --add` | Добавить новый аккаунт Qwen (откроется браузер) |
| `npm run auth -- --list` / `--remove` | Просмотреть или удалить сохранённые аккаунты |
| `npm run auth -- --relogin` | Обновить устаревшие токены без полной перенастройки |
| `npm run models:sync` | Скачать свежий список моделей с сайта Qwen Chat |
| `npm run smoke` | Быстрая проверка живучести API (health + chat) |
| `npm test` | Запуск 46 юнит-тестов (Node.js test runner, без браузера) |
| `npm run lint` / `format` | Проверка стиля кода (ESLint + Prettier) |

## Ограничения и нюансы

- **Неофициальный прокси.** Qwen может менять структуру сайта или внутренние URL API. Код проекта адаптируется под эти изменения, но базовая логика может требовать обновления репозитория.
- **Контекст "грязной" памяти модели.** Если на вашем аккаунте Qwen накопилось много старых диалогов и персонализации — модель (особенно `qwen3.7-max`) может иногда игнорировать инструкции и отвечать просто текстом вместо вызова инструментов. Очистка куков/кэша сайта в браузере или переключение на модель `qwen3-coder-plus` решают проблему мгновенно.
- **Race condition ("in progress").** Qwen обрабатывает SSE-сессии несколько секунд после получения полного ответа. Если вы шлёте следующий запрос через миллисекунды — сервер вернёт `"chat is in progress"`. FreeQwenApi сам делает небольшую паузу (~1-2 сек) и повторяет отправку на тот же чат, чтобы не терять контекст диалога (см. документацию).
- **Память браузера.** При очень долгих непрерывных сессиях (>100 вызовов подряд) Chromium потребляет больше RAM. Встроенный сборщик мусора (GC) закрывает страницы, простаивающие дольше 5 минут, а жёсткий лимит в 5 одновременных страниц не даёт серверу упасть с `OutOfMemory`.

## Документация разработчика

Полная техническая информация о архитектуре, структуре модулей и истории изменений:

- [docs/01_STATUS.md](docs/01_STATUS.md) — текущий статус стабильности системы
- [docs/02_ARCHITECTURE.md](docs/02_ARCHITECTURE.md) — диаграммы потоков данных (нормальный запрос vs agent-loop + race condition fix)
- [docs/03_CODE_MAP.md](docs/03_CODE_MAP.md) — карта модулей, ключевые интерфейсы и константы конфигурации
- [docs/05_CHANGELOG.md](docs/05_CHANGELOG.md) — полная история развития (сессии 1–42)
- [docs/06_OPEN_QUESTIONS.md](docs/06_OPEN_QUESTIONS.md) — открытые задачи, известные quirks и ограничения

## Поддержать автора

Если проект пришёлся по вкусу или сэкономил ваше время — пишите:  
`mandrykinsergey@gmail.com` | [twitch.tv/dnovitv](https://www.twitch.tv/dnovitv)
