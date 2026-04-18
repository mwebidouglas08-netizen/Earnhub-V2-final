# EarnHub 💰

**Your Gateway to Online Earnings** — A fullstack earning platform with user dashboard and admin control panel.

---

## 🚀 Quick Start (Local)

```bash
npm install
npm start
# Visit http://localhost:3000
```

---

## 🔐 Default Admin Credentials

| Field    | Value        |
|----------|--------------|
| URL      | `/admin/login` |
| Username | `admin`      |
| Password | `Admin@2024` |

> ⚠️ Change this password after first login via the database or by adding a change-password route.

---

## 🚂 Deploy to Railway (Step by Step)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial EarnHub commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/earnhub.git
git push -u origin main
```

### 2. Deploy on Railway
1. Go to [railway.app](https://railway.app) → **New Project**
2. Click **Deploy from GitHub repo**
3. Select your `earnhub` repository
4. Railway auto-detects Node.js — no extra config needed
5. *(Optional but recommended)* Add environment variable:
   - Key: `SESSION_SECRET`
   - Value: any long random string e.g. `myS3cur3S3cr3t2024XyZ`
6. Click **Deploy** ✅

Railway will use `nixpacks.toml` + `railway.toml` automatically.
The `/health` endpoint ensures the health check passes every time.

---

## 🌍 Environment Variables

| Variable         | Default                              | Description                        |
|-----------------|--------------------------------------|------------------------------------|
| `PORT`          | `3000`                               | Auto-set by Railway                |
| `SESSION_SECRET`| `earnhub_s3cr3t_k3y_2024_xK9mPqRt` | Change this in production!         |
| `DATA_DIR`      | project root                         | Where SQLite DB files are stored   |

---

## 📁 Project Structure

```
earnhub/
├── server.js                    # Main Express server
├── package.json                 # Dependencies
├── railway.toml                 # Railway deployment config
├── nixpacks.toml                # Build config (Node 20 + native deps)
├── Procfile                     # Fallback process declaration
├── .gitignore
├── README.md
├── backend/
│   ├── db.js                    # SQLite schema + seeding
│   ├── middleware/
│   │   └── auth.js              # Session auth guards
│   └── routes/
│       ├── auth.js              # Register, login, activate, me
│       ├── admin.js             # Full admin CRUD API
│       └── user.js              # Withdraw, spin, downlines
└── public/
    └── pages/
        ├── index.html           # Landing page
        ├── login.html           # User login
        ├── register.html        # User registration
        ├── activate.html        # Activation fee / M-Pesa
        ├── dashboard.html       # User dashboard (all sections)
        ├── admin-login.html     # Admin login (hidden from nav)
        └── admin-dashboard.html # Full admin control panel
```

---

## 🛠️ Admin Capabilities

- 📊 Live stats: users, revenue, withdrawals
- 👥 View, edit, activate, ban/unban, delete any user
- 💰 Manually adjust any user's balance & earnings breakdown
- 💸 Approve or reject withdrawal requests (auto-adjusts balance)
- 💳 View all activation payments
- 🔔 Send global or targeted notifications to users
- ⚙️ Adjust: activation fee, referral bonus, min withdrawal, site name, welcome bonus

---

## 📝 Notes

- **Admin portal** is completely hidden from the landing page — only at `/admin/login`
- **M-Pesa STK push** is simulated for demo. Integrate with [Safaricom Daraja API](https://developer.safaricom.co.ke/) for production
- **SQLite** is used for zero-config storage. For high traffic, migrate to PostgreSQL (Railway offers it free)
- All passwords are **bcrypt hashed**
- Sessions are stored in a separate `sessions.db` SQLite file
