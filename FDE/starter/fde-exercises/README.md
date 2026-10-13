# fde-exercises

My mini-exercises from the AI Forward Deployed Engineer course. One folder per lesson exercise,
named after the module, e.g. `m01_event_loop/`, `m01_async_worker/`, `m10_sdks/`.

## Run

```bash
python -m venv .venv && . .venv/Scripts/activate   # Windows Git Bash; Linux/Mac: .venv/bin/activate
pip install -r requirements-lessons.txt
pytest
```

## Exercises

| Folder | Lesson | What it shows |
|---|---|---|
| m01_async_worker/ | CP1 build | async worker: asyncio + ThreadPoolExecutor |
