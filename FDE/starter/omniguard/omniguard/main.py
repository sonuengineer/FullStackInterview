"""OmniGuard API entry point.

The capstone harnesses import `omniguard.main:create_app` and `omniguard.main:app`,
so keep both names. Run locally: uvicorn omniguard.main:app --reload
"""
from fastapi import FastAPI


def create_app() -> FastAPI:
    app = FastAPI(title="OmniGuard", version="0.1.0")

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
