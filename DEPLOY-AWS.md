# Deploy the website backend to AWS EC2 (next to the HR software)

The website backend runs on the **same EC2 instance** as the HR software
(`3.109.84.186`) and is managed by PM2, just like the HR backend `server`.

```
Browser ──► Vercel (website)  /site-api/*  ──► EC2 :80 nginx /site-api/ ──► 127.0.0.1:5002  website-api (PM2)
                                                                               │  /api/client/*
                                                                               ▼
                                                                         127.0.0.1:5001  HR backend "server" (PM2)
```

- The website calls `/site-api/...` on its own domain, and Vercel forwards it to EC2.
  This mirrors the HR frontend, which forwards `/api/...` the same way. The browser
  only ever talks HTTPS to Vercel, so there are no mixed-content or CORS problems.
- The HR backend already owns `/api/*` on port 80, so the website backend gets its own
  prefix `/site-api/`. **No new security-group port is opened.**
- Client portal requests go from the website backend to the HR backend over
  `127.0.0.1`, inside the server.

## 1. Connect and check what is running

```bash
ssh -i /path/to/your-key.pem ubuntu@3.109.84.186
```

```bash
pm2 list
```

```bash
node --version
```

Node 20 or newer is required. The HR backend already needs 22, so this is normally fine.

Find the HR backend's port; you need it for `HR_API_BASE_URL`. Run this from the HR
software's `backend` folder (`pm2 describe server` shows the folder):

```bash
node -e "require('dotenv').config(); console.log(process.env.PORT || 5000)"
```

## 2. Get the code

```bash
cd ~
git clone https://github.com/niki08fm/vinalaxbackend.git
cd vinalaxbackend
npm ci --omit=dev
```

## 3. Create `.env`

```bash
cp .env.example .env
nano .env
```

Fill in:

| Name | Value |
|---|---|
| `PORT` | `5002` (must not clash with the HR backend) |
| `MONGO_URI` | your MongoDB Atlas URI — **use a new password** (the old one was committed to Git) |
| `JWT_SECRET` | a new long random value |
| `HR_API_BASE_URL` | `http://127.0.0.1:<HR port from step 1>/api` |
| `CORS_ORIGINS` | your website domain(s) |
| `ADMIN_PASSWORD` | a strong website-admin password (10+ chars) |

MongoDB Atlas: in **Network Access**, allow the EC2 public IP `3.109.84.186`.

If a website admin already exists in MongoDB, set `ADMIN_RESET_PASSWORD=true` for the
first start so the old `admin123` password is replaced. Remove that line again afterwards.

## 4. Start with PM2

```bash
pm2 start ecosystem.config.cjs
```

```bash
pm2 logs website-api --lines 30 --nostream
```

```bash
curl --fail http://127.0.0.1:5002/api/health
```

The response should show `"db":"connected"`. Then save the PM2 list so it survives reboots:

```bash
pm2 save
```

## 5. Add the `/site-api/` route to the existing web server on port 80

Find out which server listens on port 80:

```bash
sudo ss -ltnp | grep ':80 '
```

**If it is nginx** (most likely), find the file with the existing `location /api/` block:

```bash
sudo grep -rn "location /api" /etc/nginx/
```

In that same `server { ... }` block, add:

```nginx
    location /site-api/ {
        proxy_pass http://127.0.0.1:5002/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
```

```bash
sudo nginx -t
```

```bash
sudo systemctl reload nginx
```

```bash
curl --fail http://3.109.84.186/site-api/health
```

Do not change the existing `/api/` block — the HR software keeps using it.

## 6. Switch the website frontend to AWS

The `vinalaxfrontend` repo's `vercel.json` forwards `/site-api/*` to
`http://3.109.84.186/site-api/*`. Merge that change and let Vercel redeploy **after**
step 5 works. Until then, the live website keeps using Render.

Check on the live site:
1. Submit an enquiry on the home page. It should then appear in the website admin dashboard.
2. Open **Client Login** and sign in with a company login. Payrolls and payslips should load.
3. Sign in with an employee login. Their payslips should load and download.

Once everything works on AWS, the Render service can be suspended.

## How clients get their login

Client logins are created in the **HR software** (not the website):

- **Company login:** HR software → **Employee Access** (sidebar) → **Company logins** tab →
  **+ Create company login** → choose the company, enter the email and a password (8+ characters).
- **Employee login:** HR software → **Employee Access** → **Employee logins** tab → grant access
  to an employee (or bulk-grant a whole company), entering the email and password.

Send that email and password to the client. They open the website, click
**Client Login** and sign in. Companies see their payrolls, payslips and PF/ESI/bank
reports. Employees see only their own payslips. Deactivating or changing the login in
**Employee Access** takes effect immediately. HR admin and manager accounts are refused on the
website portal.

## Updating later

```bash
cd ~/vinalaxbackend
git pull --ff-only origin main
npm ci --omit=dev
pm2 restart website-api --update-env
```
