# Step 1 — Website backend on AWS EC2 at https://api.vinalaxhrsolutions.com

The website backend runs on the **same EC2 instance** as the HR software
(`3.109.84.186`), managed by PM2 next to the HR backend `server`. nginx gives it
its own HTTPS address, `api.vinalaxhrsolutions.com`. The HR software's existing
setup is not changed.

```
Browser ─► vinalaxhrsolutions.com (website) ─► https://api.vinalaxhrsolutions.com ─► nginx :443 ─► 127.0.0.1:5002 website-api (PM2)
                                                                                                          │ /api/client/*
                                                                                                          ▼
                                                                                              127.0.0.1:<HR port> HR backend "server" (PM2)
```

Render keeps running during this step. The live website does not change until
step 2, so nothing breaks while you set this up.

## 1.1 Before you start (AWS console and DNS)

1. **Elastic IP:** go to AWS → EC2 → **Elastic IPs**. Check that `3.109.84.186` is listed and
   associated with the instance. If it is not, the IP changes when the instance restarts.
   Allocate an Elastic IP and associate it first, then use that IP below and update the
   HR frontend's `vercel.json`.
2. **Security group:** go to EC2 → instance → **Security** → security group → **Inbound rules**.
   Make sure there are rules for **HTTP 80** and **HTTPS 443** from `0.0.0.0/0`. Port 443 is
   probably new, and certbot needs port 80.
3. **DNS:** where vinalaxhrsolutions.com is managed, add:

   | Type | Name | Value | Notes |
   |---|---|---|---|
   | A | `api` | `3.109.84.186` | On Cloudflare set **DNS only** (grey cloud), at least until the certificate is issued |

   Then check from any computer (allow a few minutes):

   ```bash
   nslookup api.vinalaxhrsolutions.com
   ```

   It must answer `3.109.84.186` before you go to 1.6.
4. **MongoDB Atlas:** go to **Network Access** → Add IP Address → `3.109.84.186`.

## 1.2 Connect and check

```bash
ssh -i /path/to/your-key.pem ubuntu@3.109.84.186
```

```bash
pm2 list
```

```bash
node --version
```

You need Node 20 or newer. Next, find the HR backend's port, which `HR_API_BASE_URL` needs.
`pm2 describe server` shows its folder. `cd` into that `backend` folder, then run:

```bash
node -e "require('dotenv').config(); console.log(process.env.PORT || 5000)"
```

Next, see what serves port 80:

```bash
sudo ss -ltnp | grep -E ':(80|443) '
```

- If it shows **nginx**, continue.
- If nothing is listening, install nginx: `sudo apt update && sudo apt install -y nginx`.
- If it shows **anything else** (for example `node`), stop here and send me the output.

## 1.3 Get the code

```bash
cd ~
```

Until the branch is merged into `main`, clone the branch that contains the AWS changes:

```bash
git clone -b claude/stoic-ptolemy-3cjt4n https://github.com/niki08fm/vinalaxbackend.git
```

After it is merged (in step 2), switch the server to `main` with
`git switch main && git pull --ff-only origin main`.

```bash
cd ~/vinalaxbackend && npm ci --omit=dev
```

## 1.4 Create `.env`

```bash
cp .env.example .env
```

```bash
nano .env
```

| Name | Value |
|---|---|
| `PORT` | `5002` |
| `MONGO_URI` | the Atlas URI, **with a new database password** (the old one was public in Git; change it in Atlas → Database Access) |
| `JWT_SECRET` | a new value, from `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `HR_API_BASE_URL` | `http://127.0.0.1:<HR port from 1.2>/api` |
| `CORS_ORIGINS` | `https://vinalaxhrsolutions.com,https://www.vinalaxhrsolutions.com` plus the current website `*.vercel.app` address while testing |
| `ADMIN_EMAIL` | `admin@vinalax.com` |
| `ADMIN_PASSWORD` | a strong new website-admin password (10+ characters) |
| `ADMIN_RESET_PASSWORD` | `true` **for the first start only** (replaces the old `admin123`) |

Note: changing the Atlas password also breaks the Render copy, unless you update
`MONGO_URI` on Render as well. Update it there too so the live site keeps working
until step 2.

## 1.5 Start with PM2

```bash
pm2 start ecosystem.config.cjs
```

```bash
pm2 logs website-api --lines 30 --nostream
```

Look for "running on port 5002" and "Website admin … password reset". Then:

```bash
curl http://127.0.0.1:5002/api/health
```

It should show `"db":"connected"`. If it shows `disconnected`, check the Atlas Network Access
and `MONGO_URI`. Now remove the one-time reset line and restart:

```bash
sed -i '/^ADMIN_RESET_PASSWORD=/d' .env && pm2 restart website-api --update-env
```

```bash
pm2 save
```

Check that PM2 starts again after a reboot (it is probably already set up for the HR
backend). If `pm2 startup` prints a `sudo env PATH=...` command, run that command:

```bash
pm2 startup
```

## 1.6 nginx site for api.vinalaxhrsolutions.com

This creates a **new, separate** file. The HR software's nginx file is not touched.

```bash
sudo tee /etc/nginx/sites-available/website-api >/dev/null <<'EOF'
server {
    listen 80;
    server_name api.vinalaxhrsolutions.com;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:5002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
EOF
```

```bash
sudo ln -s /etc/nginx/sites-available/website-api /etc/nginx/sites-enabled/website-api
```

```bash
sudo nginx -t
```

Continue only if it says `syntax is ok` and `test is successful`. Then:

```bash
sudo systemctl reload nginx
```

```bash
curl http://api.vinalaxhrsolutions.com/api/health
```

Then check that the HR software still answers as before:

```bash
curl http://3.109.84.186/api/health
```

## 1.7 HTTPS certificate (free, auto-renewing)

```bash
sudo apt install -y certbot python3-certbot-nginx
```

```bash
sudo certbot --nginx -d api.vinalaxhrsolutions.com
```

Give an email address, accept the terms, and choose **redirect HTTP to HTTPS** if it asks.

```bash
curl https://api.vinalaxhrsolutions.com/api/health
```

```bash
sudo certbot renew --dry-run
```

## 1.8 Final checks (from your own computer)

1. Open `https://api.vinalaxhrsolutions.com/api/health` in a browser. It should show a padlock and `"db":"connected"`.
2. Test a client login with a real company login created in HR software → Employee Access:

   ```bash
   curl -X POST https://api.vinalaxhrsolutions.com/api/client/login -H "Content-Type: application/json" -d '{"email":"COMPANY_EMAIL","password":"COMPANY_PASSWORD"}'
   ```

   It should return `"success":true` with a token. An HR admin account must return a 403 message instead.
3. The HR software still works as before at `vinalaxhrsoftware.vercel.app`.

Step 1 is done when all three pass. **Step 2** points the website frontend at this
address, and only then is Render switched off.

## Updating later

```bash
cd ~/vinalaxbackend && git pull --ff-only origin main && npm ci --omit=dev && pm2 restart website-api --update-env
```

## Troubleshooting

- **certbot fails:** check that DNS answers `3.109.84.186` (on Cloudflare, use DNS only) and that port 80 is open in the security group.
- **`502 Bad Gateway`:** check `pm2 list` (is `website-api` online?) and `pm2 logs website-api`.
- **Client login says it "could not reach the HR system":** `HR_API_BASE_URL` has the wrong port. Check it with `curl http://127.0.0.1:<port>/api/health`.

## How clients get their login

Client logins are created in the HR software → **Employee Access**:

- **Company logins** tab → **+ Create company login**.
- **Employee logins** tab → grant access.

The same email and password work on the website's Client Login and directly in the HR
software.
