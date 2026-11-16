import io
import json
import uuid

import docx
from fastapi.testclient import TestClient

from app.main import DEFAULT_TEMPLATE, app


def new_client(email=None, password="secret123"):
    c = TestClient(app)
    email = email or f"user-{uuid.uuid4().hex[:8]}@example.com"
    r = c.post("/api/auth/register", json={"email": email, "password": password, "name": "Тест"})
    assert r.status_code == 200, r.text
    return c, email


def set_payload(title="Билеты АТ-224", n=2):
    tickets = [{"number": i, "theory": [f"Т{i}"], "practice": [f"П{i}"]} for i in range(1, n + 1)]
    data = {
        "params": {"count": n, "theory": 1, "practice": 1, "filename": "Билеты"},
        "questions": {"theory": "Т1\nТ2", "practice": "П1\nП2"},
        "fields": {"Группа": "АТ-999"},
        "tickets": tickets,
    }
    return json.dumps({"title": title, "data": data})


def test_register_login_logout():
    c, email = new_client()
    assert c.get("/api/auth/me").json()["user"]["email"] == email
    # Повторная регистрация с той же почтой
    assert c.post("/api/auth/register", json={"email": email.upper(), "password": "secret123"}).status_code == 409
    c.post("/api/auth/logout")
    assert c.get("/api/auth/me").json()["user"] is None
    assert c.post("/api/auth/login", json={"email": email, "password": "wrong-pass"}).status_code == 401
    assert c.post("/api/auth/login", json={"email": email, "password": "secret123"}).status_code == 200
    assert c.get("/api/auth/me").json()["user"]["email"] == email


def test_validation():
    c = TestClient(app)
    assert c.post("/api/auth/register", json={"email": "bad", "password": "secret123"}).status_code == 422
    assert c.post("/api/auth/register", json={"email": "a@b.ru", "password": "short"}).status_code == 422


def test_sets_crud_and_export():
    c, _ = new_client()
    r = c.post("/api/sets", data={"payload": set_payload()})
    assert r.status_code == 200, r.text
    sid = r.json()["set"]["id"]
    assert r.json()["set"]["ticketCount"] == 2

    lst = c.get("/api/sets").json()["sets"]
    assert [s["id"] for s in lst] == [sid]

    r = c.put(f"/api/sets/{sid}", data={"payload": set_payload("Новое", n=3)})
    assert r.json()["set"]["title"] == "Новое" and r.json()["set"]["ticketCount"] == 3
    assert c.patch(f"/api/sets/{sid}", json={"title": "Переименован"}).json()["set"]["title"] == "Переименован"

    full = c.get(f"/api/sets/{sid}").json()["set"]
    assert full["data"]["tickets"][2]["theory"] == ["Т3"] and not full["hasTemplate"]

    r = c.get(f"/api/sets/{sid}/export?format=docx")
    assert r.status_code == 200
    d = docx.Document(io.BytesIO(r.content))
    assert len(d.tables) == 3 and "Группа: АТ-999" in d.tables[0].cell(0, 1).text

    assert c.delete(f"/api/sets/{sid}").status_code == 200
    assert c.get(f"/api/sets/{sid}").status_code == 404


def test_custom_template_saved():
    c, _ = new_client()
    tpl = DEFAULT_TEMPLATE.read_bytes()
    r = c.post("/api/sets", data={"payload": set_payload()}, files={"template": ("мой.docx", tpl)})
    sid = r.json()["set"]["id"]
    assert r.json()["set"]["templateName"] == "мой.docx"
    assert c.get(f"/api/sets/{sid}/template").content == tpl
    r = c.put(f"/api/sets/{sid}", data={"payload": set_payload(), "template_mode": "default"})
    assert r.json()["set"]["templateName"] is None


def test_sets_are_private():
    a, _ = new_client()
    b, _ = new_client()
    sid = a.post("/api/sets", data={"payload": set_payload()}).json()["set"]["id"]
    assert b.get(f"/api/sets/{sid}").status_code == 404
    assert b.delete(f"/api/sets/{sid}").status_code == 404
    assert b.get("/api/sets").json()["sets"] == []
    assert TestClient(app).get("/api/sets").status_code == 401


def test_cross_site_post_rejected():
    c, _ = new_client()
    r = c.post("/api/sets", data={"payload": set_payload()}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_bad_set_payload():
    c, _ = new_client()
    bad = json.dumps({"title": "x", "data": {"tickets": []}})
    assert c.post("/api/sets", data={"payload": bad}).status_code == 422


def test_password_rules():
    c = TestClient(app)
    for pw in ("abcdefgh", "12345678", "a1a1a1a1"):
        r = c.post("/api/auth/register", json={"email": f"{uuid.uuid4().hex[:6]}@ex.ru", "password": pw})
        assert r.status_code == 422, pw
    email = f"{uuid.uuid4().hex[:6]}1@ex.ru"
    r = c.post("/api/auth/register", json={"email": email, "password": email.split("@")[0]})
    assert r.status_code == 422


def test_remember_me_cookie():
    c, email = new_client()
    c.post("/api/auth/logout")
    r = c.post("/api/auth/login", json={"email": email, "password": "secret123", "remember": False})
    assert r.status_code == 200 and "max-age" not in r.headers["set-cookie"].lower()
    r = c.post("/api/auth/login", json={"email": email, "password": "secret123"})
    assert "max-age" in r.headers["set-cookie"].lower()


def test_profile_password_and_delete():
    c, email = new_client()
    other = TestClient(app)
    other.post("/api/auth/login", json={"email": email, "password": "secret123"})
    assert c.patch("/api/auth/profile", json={"name": "  Анна   Петрова "}).json()["user"]["name"] == "Анна Петрова"

    assert c.post("/api/auth/password", json={"current": "wrong", "new": "newpass456"}).status_code == 403
    assert c.post("/api/auth/password", json={"current": "secret123", "new": "short"}).status_code == 422
    assert c.post("/api/auth/password", json={"current": "secret123", "new": "newpass456"}).status_code == 200
    # Текущая сессия жива, другие устройства разлогинены
    assert c.get("/api/auth/me").json()["user"]["email"] == email
    assert other.get("/api/auth/me").json()["user"] is None
    assert TestClient(app).post("/api/auth/login", json={"email": email, "password": "newpass456"}).status_code == 200

    sid = c.post("/api/sets", data={"payload": set_payload()}).json()["set"]["id"]
    assert c.post("/api/auth/delete", json={"password": "secret123"}).status_code == 403
    assert c.post("/api/auth/delete", json={"password": "newpass456"}).status_code == 200
    assert c.get("/api/auth/me").json()["user"] is None
    assert TestClient(app).post("/api/auth/login", json={"email": email, "password": "newpass456"}).status_code == 401
    from app.accounts import connect
    with connect() as con:
        assert con.execute("SELECT COUNT(*) FROM ticket_sets WHERE id = ?", (sid,)).fetchone()[0] == 0
