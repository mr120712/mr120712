# Riserva AI gratuita — FreeLLMAPI ospitato da Solco

La **riserva gratuita** delle funzioni AI di testo: **Claude resta primario** (qualità), ma se la
chiave Claude manca, è rifiutata, è sopra il tetto di spesa o il servizio è occupato, le funzioni
ripiegano qui **senza far pagare nulla**. È *best-effort*: usa modelli **aperti** (non OpenAI).

## Self-hosted su Solco

Il router FreeLLMAPI è **ospitato dentro Solco**: un endpoint **OpenAI-compatibile** davanti alle
free-tier di più provider, con failover automatico.

```
https://www.solcomusic.online/api/ai-reserve/v1/chat/completions   (POST, Bearer)
https://www.solcomusic.online/api/ai-reserve/v1/models             (GET,  Bearer)
https://www.solcomusic.online/api/ai-reserve/health                (GET,  pubblico: quali provider sono attivi)
```

- **Dentro Solco** la riserva chiama i provider **in-process** (`src/lib/business/ai-reserve-connector.server.ts`):
  nessun giro HTTP sull'app, quindi niente firewall di Vercel, cold-start o redirect.
- **Da fuori** (Claude Code, il connettore MCP in `tools/mcp-free-ai/`, uno script) si usa l'URL qui
  sopra con il Bearer `FREELLMAPI_API_KEY`.
- Un provider si accende da solo quando la sua chiave è su Vercel: `GROQ_API_KEY`,
  `CEREBRAS_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`.

Non serve installare né pubblicare un router a parte: `freellmapi.co` è solo il sito del progetto
(404 a `/v1/models`), e un router su `localhost` non è raggiungibile dai server di Vercel.

## Variabili d'ambiente (Vercel → Settings → Environment Variables → Production)

| Variabile | Obbligo | Valore |
|---|---|---|
| `FREELLMAPI_API_KEY` | **sì** | il segreto condiviso (Bearer) che i chiamanti esterni presentano all'endpoint. Generalo tu, lungo e casuale, ad esempio con `openssl rand -hex 32`. Alias accettato: `FREELLMAPI_TOKEN`. |
| `FREELLMAPI_BASE_URL` | no | `https://www.solcomusic.online/api/ai-reserve/v1` (self-host). Si può anche lasciare vuota: il default è già il router di Solco su `NEXT_PUBLIC_APP_URL`. Con o senza `www`, con o senza `/` finale, l'URL di Solco è sempre servito in-process. |
| `FREELLMAPI_MODEL` | no | predefinito `auto` (ogni provider sceglie un suo modello, con scorta). Imposta un id preciso solo per forzare un modello. |
| almeno una chiave provider | **sì** | `GROQ_API_KEY` basta per partire; le altre aggiungono failover. |

Solo un URL **HTTPS pubblico di un altro dominio** in `FREELLMAPI_BASE_URL` fa usare un router
esterno. Valori non usabili (`localhost`, `http`, IP privati, `freellmapi.co`) sono ignorati e resta il
router di Solco, così una variabile sbagliata non spegne la riserva.

Dopo ogni modifica su Vercel serve un **Redeploy** perché le variabili vengano lette.

## Verifica

```
# pubblico: quali provider rispondono
curl -s https://www.solcomusic.online/api/ai-reserve/health

# con la chiave: 200 = chiave giusta
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://www.solcomusic.online/api/ai-reserve/v1/chat/completions \
  -H "Authorization: Bearer $FREELLMAPI_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"ciao"}]}'
```

- **200** → riserva pronta.
- **401** → `FREELLMAPI_API_KEY` diversa da quella su Vercel (o non ancora ridistribuita).
- **503** → `reserve_not_configured` (manca `FREELLMAPI_API_KEY` su Vercel) oppure
  `upstream_not_configured` (nessuna chiave provider): aggiungi la variabile che manca.
- **502** → tutti i provider hanno fallito in quel momento: riprova più tardi.

Il controllo **«Riserva AI gratuita»** in Amministrazione → Monitoraggio fa la stessa verifica senza
spendere token: «non configurata» è un avviso, non un guasto.

## Privacy

Quando la riserva entra in gioco, la richiesta (per esempio la descrizione di ricerca) va al provider
gratuito che risponde. La funzione resta riservata ai piani Premium e con limite di frequenza; nessun
dato personale dell'account viene inoltrato. Nessun log registra la chiave, il prompt o la risposta.
