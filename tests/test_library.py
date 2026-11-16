import os

from fastapi.testclient import TestClient

from app.main import DEFAULT_TEMPLATE, app
from tests.test_accounts import new_client

TPL = DEFAULT_TEMPLATE.read_bytes()


def submit(c, title="Мой шаблон", consent="true", data=TPL):
    return c.post(
        "/api/templates/submissions",
        data={"title": title, "institution": "КМП", "description": "Описание", "consent": consent},
        files={"template": ("мой.docx", data)},
    )


def test_submission_flow(monkeypatch):
    admin, admin_email = new_client()
    user, _ = new_client()
    monkeypatch.setenv("ADMIN_EMAILS", admin_email)

    assert TestClient(app).post("/api/templates/submissions", data={"title": "x"}).status_code in (401, 422)
    assert submit(user, consent="false").status_code == 422
    assert submit(user, data=b"not a docx").status_code == 422
    r = submit(user)
    assert r.status_code == 200 and r.json()["submission"]["status"] == "pending"
    sid = r.json()["submission"]["id"]

    assert [s["id"] for s in user.get("/api/templates/submissions/mine").json()["submissions"]] == [sid]
    assert all(t["id"] != sid for t in TestClient(app).get("/api/templates/library").json()["templates"])

    # Обычный пользователь не может модерировать
    assert user.get("/api/admin/submissions").status_code == 403
    assert admin.get("/api/auth/me").json()["user"]["isAdmin"] is True
    pending = admin.get("/api/admin/submissions").json()["submissions"]
    assert sid in [s["id"] for s in pending]
    assert admin.get(f"/api/admin/submissions/{sid}/file").content == TPL

    r = admin.post(f"/api/admin/submissions/{sid}/review", json={"action": "approve", "title": "Шаблон КМП"})
    assert r.json()["submission"]["status"] == "approved"
    lib = TestClient(app).get("/api/templates/library").json()["templates"]
    assert any(t["id"] == sid and t["title"] == "Шаблон КМП" for t in lib)
    assert TestClient(app).get(f"/api/templates/library/{sid}/file").content == TPL
    # Одобренный нельзя отозвать
    assert user.delete(f"/api/templates/submissions/{sid}").status_code == 409

    admin.post(f"/api/admin/submissions/{sid}/review", json={"action": "remove", "note": "устарел"})
    assert TestClient(app).get(f"/api/templates/library/{sid}/file").status_code == 404
    mine = user.get("/api/templates/submissions/mine").json()["submissions"][0]
    assert mine["status"] == "removed" and mine["note"] == "устарел"


def test_withdraw_pending():
    user, _ = new_client()
    sid = submit(user).json()["submission"]["id"]
    other, _ = new_client()
    assert other.delete(f"/api/templates/submissions/{sid}").status_code == 404
    assert user.delete(f"/api/templates/submissions/{sid}").status_code == 200
    assert user.get("/api/templates/submissions/mine").json()["submissions"] == []
