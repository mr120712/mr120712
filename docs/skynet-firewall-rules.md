# Skynet — le 4 regole firewall di Vercel

La sentinella di Skynet (`src/lib/skynet/signals.ts`, `EXPECTED_SKYNET_RULES = 4`)
controlla che su Vercel siano **attive 4 regole personalizzate** il cui nome
inizia con **`Skynet ·`** (`SKYNET_RULE_PREFIX`). Se ne trova meno, segnala
«regole attive N su 4» su Telegram e nel pannello **Amministrazione → Monitoraggio**.

Queste 4 regole sono lo **strato fisso** al bordo (bloccano/sfidano *prima* che
parta una funzione). Le regole IP **temporanee** dei recidivi le crea Skynet da
solo via API (fino a 80: `MAX_SKYNET_IP_RULES`) e **non** contano in questo conto.

## ⚠️ Prima di crearle — due avvertenze

- **App in revisione su Google Play:** queste 4 regole sono **sicure** per la
  revisione (non sfidano i browser normali né Googlebot/Bingbot). Il **gate UAM**
  (`UAM_MODE` / Attack Challenge Mode), invece, sfida *tutti*: tenerlo **spento
  finché l'app non è approvata**.
- **Nome esatto:** ogni regola deve iniziare con `Skynet · ` (con lo spazio dopo
  il punto medio «·»), altrimenti la sentinella non la conta.

## Dove

Vercel → progetto → **Firewall → Custom Rules → New Rule** (una per regola).
Condizioni e azioni sono quelle del costruttore di regole di Vercel.

---

## 1) `Skynet · Sonde da scanner` — Deny (403)

**Condizione:** *Request Path* contiene uno di (OR):

```
/.env, /.git, /.aws, /wp-admin, /wp-login.php, /xmlrpc.php, /phpmyadmin,
/vendor/, /config.json, /backup
```

più i path che **finiscono** in: `.php` `.asp` `.aspx` `.sql` `.bak`

**Azione:** Deny.

Solco non ha PHP/WordPress: nessun utente o crawler legittimo chiede questi path.
**Non** includere `/.well-known/` (serve per gli assetlinks e la revisione Play).
Rispecchia al bordo il «cacciatore» (`src/lib/skynet/hunter.ts`).

## 2) `Skynet · Agenti AI e scraper TDM` — Challenge

**Condizione:** *User-Agent* contiene uno di (OR):

```
GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, anthropic-ai, Claude-Web,
CCBot, PerplexityBot, Perplexity-User, Bytespider, Amazonbot,
Meta-ExternalAgent, Diffbot, ImagesiftBot, Omgilibot, cohere-ai, Scrapy
```

**Azione:** Challenge (verifica gestita).

**Non** include Googlebot/Bingbot/Applebot (motori leciti, servono per SEO e per
la revisione Google). Gli agenti AI risolvono la verifica come chiunque, coerente
con «challenge-only». Per escluderli del tutto: mettere **Deny**.

## 3) `Skynet · Automazione e headless` — Challenge

**Condizione:** *User-Agent* contiene uno di (OR):

```
HeadlessChrome, PhantomJS, Puppeteer, Playwright, Selenium, python-requests,
curl/, wget/, Go-http-client, node-fetch, axios/, libwww-perl, Java/, okhttp
```

**E** *Request Path* **non** inizia con `/api` **E non** inizia con `/_next`.

**Azione:** Challenge.

Esclude `/api` (app nativa + webhook) e gli asset: un browser automatico che
sfoglia le pagine deve superare la verifica, un vero utente mai.

## 4) `Skynet · Limite di frequenza` — Rate Limit → Challenge

**Condizione:** *Request Path* **non** inizia con `/api` **E non** inizia con `/_next`.

**Azione:** Rate Limit **200 richieste / 10 s per IP**, al superamento **Challenge**
(non Deny).

Soglia ampia per una persona, strettissima per uno scraper. Al superamento
**sfida**, non blocca: un utente pesante non resta fuori. Esclude `/api` (molte
chiamate legittime) e gli asset statici.

---

## Dopo averle create

- Il pannello **Amministrazione → Monitoraggio** deve mostrare **regole 4 su 4**.
- Niente avviso Telegram «regole attive 3 su 4».
- Il gate UAM resta una scelta a parte: accenderlo (`UAM_MODE=first-visit` +
  `UAM_SECRET` ≥ 32 caratteri, poi redeploy) **solo dopo** l'approvazione su Play.
- Da quando Skynet le ha viste attive, le **protegge da solo**: se una viene spenta
  (o il firewall, o il blocco delle AI) la riaccende identica dopo due controlli di
  fila e avvisa. Prima di spegnerne una di proposito scriva a Skynet
  `pausa autodifesa 2 ore`. Una regola **cancellata** invece va rifatta a mano da qui.
  Dettagli in [skynet.md](skynet.md).
