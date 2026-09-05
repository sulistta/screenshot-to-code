"""Versioned, tested project templates for full-stack creation.

The studio system prompt references these templates so the coordinator can
scaffold runnable projects instead of single HTML documents. Each template
is a deterministic file set (written by the agent or the UI's "start from
template" action) with a manifest, lockfile-friendly package.json and a
health-checkable dev server.
"""
from typing import Dict

REACT_FASTAPI_TEMPLATE: Dict[str, str] = {
    "package.json": """{
  "name": "studio-react-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.0"
  }
}
""",
    "vite.config.js": """import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: "127.0.0.1" },
});
""",
    "index.html": """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Studio App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
""",
    "src/main.jsx": """import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
""",
    "src/App.jsx": """export default function App() {
  return <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
    <h1>Studio app</h1>
    <p>Edit src/App.jsx and the preview reloads.</p>
  </main>;
}
""",
    "api/main.py": '''"""FastAPI service with CRUD, basic auth and uploads."""
import os
import secrets
import sqlite3
import time
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])

DATA = Path(os.environ.get("STUDIO_DATA_DIR", "data"))
UPLOADS = DATA / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA / "app.db"

def db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection

with db() as connection:
    connection.executescript("""
CREATE TABLE IF NOT EXISTS users (
    token TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, title TEXT, body TEXT);
""")

async def current_user(request: Request) -> str:
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    if not token:
        raise HTTPException(401, "Sign in first")
    with db() as connection:
        row = connection.execute(
            "SELECT username FROM users WHERE token = ?", (token,)).fetchone()
    if row is None:
        raise HTTPException(401, "Invalid session")
    return row["username"]

@app.get("/api/health")
def health():
    return {"ok": True, "time": int(time.time())}

class Credentials(BaseModel):
    username: str
    password: str

@app.post("/api/register")
def register(credentials: Credentials):
    token = secrets.token_hex(16)
    digest = secrets.token_hex(32)  # replace with a real hash in production
    try:
        with db() as connection:
            connection.execute(
                "INSERT INTO users (token, username, password) VALUES (?, ?, ?)",
                (token, credentials.username, digest))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Username taken")
    return {"token": token}

@app.post("/api/login")
def login(credentials: Credentials):
    with db() as connection:
        row = connection.execute(
            "SELECT token FROM users WHERE username = ? AND password = ?",
            (credentials.username, credentials.password)).fetchone()
    if row is None:
        raise HTTPException(401, "Wrong username or password")
    return {"token": row["token"]}

class ItemIn(BaseModel):
    title: str
    body: str = ""

@app.get("/api/items")
def list_items(user: str = Depends(current_user)):
    with db() as connection:
        rows = connection.execute(
            "SELECT id, title, body FROM items WHERE owner = ?",
            (user,)).fetchall()
    return {"items": [dict(row) for row in rows]}

@app.post("/api/items")
def create_item(item: ItemIn, user: str = Depends(current_user)):
    with db() as connection:
        cursor = connection.execute(
            "INSERT INTO items (owner, title, body) VALUES (?, ?, ?)",
            (user, item.title, item.body))
    return {"id": cursor.lastrowid, "title": item.title, "body": item.body}

@app.post("/api/upload")
async def upload(file: UploadFile = File(...), user: str = Depends(current_user)):
    target = UPLOADS / f"{int(time.time() * 1000)}-{file.filename}"
    target.write_bytes(await file.read())
    return {"path": target.name}
''',
    "api/requirements.txt": """fastapi>=0.115
uvicorn>=0.34
python-multipart>=0.0.20
""",
}

NEXTJS_TEMPLATE: Dict[str, str] = {
    "package.json": """{
  "name": "studio-nextjs-app",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build"
  },
  "dependencies": {
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
""",
    "app/layout.js": """export const metadata = { title: "Studio App" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui", margin: 0 }}>{children}</body>
    </html>
  );
}
""",
    "app/page.js": """export default function Page() {
  return (
    <main style={{ padding: "2rem" }}>
      <h1>Studio app</h1>
      <p>Edit app/page.js and the preview hot-reloads.</p>
    </main>
  );
}
""",
    "app/api/items/route.js": """import { NextResponse } from "next/server";

const items = [];

export async function GET() {
  return NextResponse.json({ items });
}

export async function POST(request) {
  const item = await request.json();
  items.push({ id: items.length + 1, ...item });
  return NextResponse.json({ ok: true });
}
""",
}


def template_files(template: str) -> Dict[str, str]:
    if template == "react-vite-fastapi":
        return dict(REACT_FASTAPI_TEMPLATE)
    if template == "nextjs":
        return dict(NEXTJS_TEMPLATE)
    raise ValueError(f"Unknown template: {template}")
