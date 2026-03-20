# AVRA Digital — Deployment Guide

## Štruktúra projektu

```
avra/
├── server/index.js          ← Express backend (API, DB, QR)
├── scripts/parse_floorplan.py ← Python PDF parser
├── public/
│   ├── admin/index.html     ← Admin panel
│   └── viewer/index.html    ← AR Viewer (klient)
├── package.json
├── railway.toml
└── Procfile
```

---

## Nasadenie na Railway (10 minút)

### 1. GitHub — nahrajte kód

```bash
# V priečinku avra/
git init
git add .
git commit -m "AVRA Digital v1.0"
git branch -M main
git remote add origin https://github.com/VAS-UCET/avra-digital.git
git push -u origin main
```

### 2. Railway — vytvorte projekt

1. Choďte na **railway.app** → New Project
2. Kliknite **Deploy from GitHub repo**
3. Vyberte váš `avra-digital` repozitár
4. Railway automaticky detekuje Node.js a spustí build

### 3. Nastavte environment premenné

V Railway dashboarde → **Variables** → pridajte:

```
BASE_URL = https://avra-digital.up.railway.app
PORT     = 3000
```

(URL nájdete v Railway → Settings → Domains → Generate Domain)

### 4. Overte nasadenie

Otvorte `https://vas-projekt.up.railway.app/health`
Mala by sa zobraziť: `{"status":"ok","product":"AVRA Digital"}`

---

## Konfigurácia Admin panelu

1. Otvorte `https://vas-projekt.up.railway.app/admin`
2. Kliknite **Nastavenia** (ozubené koleso)
3. Zadajte **URL backendu**: `https://vas-projekt.up.railway.app`
4. Kliknite **Uložiť**

---

## Použitie

### Pridanie nehnuteľnosti
1. Admin → **Nehnuteľnosti** → **+ Pridať nehnuteľnosť**
2. Vyplňte názov, rozlohu, cenu
3. Nahrajte **PDF pôdorys** (automaticky sa vygeneruje 3D model)
   alebo **glTF model** od architekta
4. Kliknite **Uložiť** — po uložení sa automaticky zobrazí QR kód

### Stiahnutie QR kódu
Admin → **QR kódy** → **Zobraziť** → **Stiahnuť PNG**

### Klient použije AR
1. Naskenuje QR kód mobilom
2. Otvorí sa `https://vas-projekt.up.railway.app/view/ID`
3. Namieri kameru na stôl / podlahu
4. Klepne **Umiestniť model** → vidí 3D byt v AR
5. Klepnutím na miestnosť → info panel

---

## Podpora zariadení

| Zariadenie | Typ |
|------------|-----|
| Android Chrome 81+ | WebXR (plná AR) |
| iOS Safari 15+ | Camera passthrough |
| Desktop | Otočiteľný 3D model |

---

## API Endpoints

```
GET    /health                    → status
GET    /api/properties            → zoznam bytov
POST   /api/properties            → pridanie (multipart/form-data)
GET    /api/properties/:id        → detail + rooms JSON
PUT    /api/properties/:id        → úprava
DELETE /api/properties/:id        → zmazanie
GET    /api/properties/:id/qr     → QR kód (base64)
GET    /view/:id                  → AR viewer
GET    /admin                     → admin panel
```

---

## Ďalší rozvoj

- [ ] Autentifikácia admin panelu (login/password)
- [ ] Vlastné textúry podláh a stien
- [ ] Konfigurátor materiálov v AR
- [ ] Analytics — počet skenovaní QR kódov
- [ ] Export do Apple AR Quick Look (.usdz)
- [ ] Viacero podlaží (výber pôdorysu)
- [ ] White-label pre agentúry (vlastné logo, farby)
