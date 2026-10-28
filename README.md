# Sagha API (Step 2) — local SQLite

Express + TypeScript + Drizzle on a **local SQLite file**. No Docker or Postgres required.

## Quick start (Windows)

```powershell
cd api
copy .env.example .env
npm install
npm run seed:admin
npm run dev
```

- API: http://localhost:4000  
- Health: http://localhost:4000/health  
- DB file: `api/data/sagha.db` (auto-created)

Default admin (from `.env`):

- email: `admin@sagha.local`  
- password: `ChangeMeNow1!`

## Endpoints

| Area | Base path |
| --- | --- |
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` |
| Users / verification | `/api/users/...` |
| Products | `/api/products/...` |
| Orders | `/api/orders/...` |
| Returns | `/api/returns/...` |

Send `Authorization: Bearer <token>` after login.

Full route table: `../replica/architecture.md`.
