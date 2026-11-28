# ARTEX pentest toolbox

Un'immagine Docker con un set **curato e standard** di strumenti di pentest, pensata per il
**self-test autorizzato** che fai con ARTEX. È **separata** dallo stack ARTEX bloccato
(`ops/artex/docker-compose.yml` non viene toccato): la costruisci e la avvii **sul tuo VPS**, a mano,
puntandola **solo al tuo host autorizzato** — lo stesso scope di ARTEX.

> ⚠️ **Scope.** Usa questi strumenti solo su host che **possiedi o sei autorizzato a testare**.
> Puntarli altrove è accesso non autorizzato, a prescindere da chi ti ha colpito per primo. L'immagine
> lo ricorda a ogni avvio e, se le passi `ARTEX_TARGET_HOST`, espone quell'host come `$TARGET` per
> ridurre il rischio di mirare al bersaglio sbagliato. La disciplina dello scope resta tua: la toolbox
> non impone un confine di rete.

## Cosa contiene

| Categoria | Strumenti |
|---|---|
| DNS / sottodomini | `dig`/`dnsutils`, `whois`, `subfinder`, `dnsx`, `amass` |
| Scoperta host/porte | `nmap`, `masscan` |
| Discovery / fuzzing web | `ffuf`, `gobuster`, `feroxbuster`, `dirb`, `katana`, `httpx` (`httpx-toolkit`) |
| Scanner web | `nikto`, `nuclei`, `whatweb`, `wafw00f` |
| TLS | `sslscan`, `testssl.sh` |
| Injection | `sqlmap` |
| CMS | `wpscan` |
| Credential testing | `hydra` |
| Wordlist | `seclists` (in `/usr/share/seclists`) |
| Utilità | `curl`, `wget`, `jq`, `openssl`, `netcat`, `python3` |

**Non** incluso di proposito: `metasploit-framework` (molto pesante). Per aggiungerlo nel container:
`apt-get update && apt-get install -y metasploit-framework`.

## Build (sul VPS)

```bash
cd ops/artex/toolbox
docker build -t artex-toolbox .
```

## Uso

Shell interattiva, con il tuo host autorizzato esposto come `$TARGET`:

```bash
docker run --rm -it \
  -e ARTEX_TARGET_HOST="solco-git-....vercel.app" \
  -v "$PWD/loot:/work" \
  artex-toolbox
```

- `-v "$PWD/loot:/work"` monta una cartella locale come working dir, così gli output restano sul VPS.
- Dentro il container, i comandi possono usare `$TARGET`. Esempi (SOLO sul tuo host autorizzato):

```bash
subfinder -d "$TARGET" -silent | httpx -silent        # sottodomini vivi
nmap -sV -Pn "$TARGET"                                  # servizi
whatweb "https://$TARGET" ; wafw00f "https://$TARGET"   # tech stack / WAF
nuclei -u "https://$TARGET" -severity medium,high,critical
ffuf -u "https://$TARGET/FUZZ" -w /usr/share/seclists/Discovery/Web-Content/common.txt
testssl.sh "https://$TARGET"
```

Per leggere il target direttamente dal `.env` di ARTEX (stessa cartella `ops/artex`):

```bash
docker run --rm -it --env-file ../.env -v "$PWD/loot:/work" artex-toolbox
# ARTEX_TARGET_HOST dal .env diventa $TARGET
```

### Opzionale: eseguire un singolo comando

```bash
docker run --rm -e ARTEX_TARGET_HOST="$T" artex-toolbox nmap -sV -Pn "$T"
```

### Aggiornare i template di nuclei

```bash
docker run --rm -it artex-toolbox nuclei -update-templates
# (o, dentro la shell) nuclei -ut
```

## Note

- **Non è ARTEX.** ARTEX ha i suoi worker/tool interni; questa toolbox è per l'uso **manuale**
  dell'operatore (o da collegare ad ARTEX solo se la sua versione espone un worker "esegui comando").
- Alcuni provider segnalano il tooling di pentest negli scan anti-abuso anche su host tuoi: tieni il
  VPS su un account separato, come già consiglia il README di ARTEX.
- L'immagine è grande (base Kali + wordlist): mettila in build una volta e riusala.
