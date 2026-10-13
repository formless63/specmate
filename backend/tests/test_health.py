import pytest
from django.test import Client


def test_health_reports_liveness_and_version():
    response = Client().get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"] == "0.0.0"


def test_openapi_schema_is_generated_from_the_api():
    response = Client().get("/api/openapi.json")
    assert response.status_code == 200
    assert "/api/health" in response.json()["paths"]


@pytest.mark.parametrize("available,status", [(True, 200), (False, 503)])
def test_readiness_is_separate_from_liveness(monkeypatch, available, status):
    monkeypatch.setattr("specmate.operations.startup.schema_ready", lambda: available)
    client = Client()
    assert client.get("/api/ready").status_code == status
    assert client.get("/api/health").status_code == 200
