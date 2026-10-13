from fastapi.testclient import TestClient

from omniguard.main import create_app


def test_health():
    r = TestClient(create_app()).get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}
