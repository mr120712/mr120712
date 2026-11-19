# Connettore MCP — AI gratuita (riserva Solco / FreeLLMAPI)

Un server **MCP** (Model Context Protocol) a **zero dipendenze** che espone un endpoint
LLM **OpenAI-compatibile** come strumenti per Claude Code / Claude Desktop e qualunque
client MCP. Richiede **Node 18+**. Si avvia da solo con `node server.mjs`.

## Cosa fa

Due strumenti:

- **`chat`** — manda un prompt al modello gratuito e restituisce la risposta (non-streaming).
- **`list_models`** — elenca i modelli serviti dall'endpoint (usa la chiave per «trovarli»).

## Configurazione — scegli UNA sorgente

Si imposta tutto con due variabili d'ambiente, `LLM_BASE_URL` e `LLM_API_KEY`.

### A) Riserva di Solco — **consigliata** (pubblica, nessun server da tenere acceso)

L'endpoint multi-provider già ospitato da Solco (Groq → OpenRouter/Nemotron → … con
failover automatico):

```
LLM_BASE_URL = https://www.solcomusic.online/api/ai-reserve/v1
LLM_API_KEY  = <il tuo FREELLMAPI_API_KEY>   # il Bearer della riserva, lo stesso impostato su Vercel
```

### B) FreeLLMAPI self-hosted — sul **tuo** computer

> ⚠️ La chiave premium di `freellmapi.co` funziona **solo** con un'istanza FreeLLMAPI che
> gira in locale (è self-hosted, non c'è un'API pubblica da chiamare). Devi avere FreeLLMAPI
> avviato (Docker, porta 3001) sulla stessa macchina dove gira questo connettore.

```
LLM_BASE_URL = http://localhost:3001/v1
LLM_API_KEY  = <la tua chiave unificata/premium FreeLLMAPI>
```

Qualsiasi altra base URL OpenAI-compatibile (`/v1`) funziona allo stesso modo.

## Aggiungerlo a Claude Code

Dalla cartella del progetto, con il comando (la chiave resta nella config utente, non nel repo):

```bash
claude mcp add free-ai \
  -e LLM_BASE_URL=https://www.solcomusic.online/api/ai-reserve/v1 \
  -e LLM_API_KEY=IL_TUO_FREELLMAPI_API_KEY \
  -- node tools/mcp-free-ai/server.mjs
```

Oppure a mano in un `.mcp.json` (in locale — **non** committare la chiave):

```json
{
  "mcpServers": {
    "free-ai": {
      "command": "node",
      "args": ["tools/mcp-free-ai/server.mjs"],
      "env": {
        "LLM_BASE_URL": "https://www.solcomusic.online/api/ai-reserve/v1",
        "LLM_API_KEY": "IL_TUO_FREELLMAPI_API_KEY"
      }
    }
  }
}
```

Poi, in Claude Code: «elenca i modelli con free-ai» usa `list_models`, «chiedi a free-ai …»
usa `chat`.

## Variabili d'ambiente

| Variabile | Obbligatoria | Default | Descrizione |
|---|---|---|---|
| `LLM_BASE_URL` | sì | — | Base URL OpenAI-compatibile che termina con `/v1`. |
| `LLM_API_KEY` | sì (per endpoint autenticati) | — | Il Bearer: `FREELLMAPI_API_KEY` per la riserva Solco, o la chiave FreeLLMAPI per l'istanza locale. |
| `LLM_MODEL` | no | `auto` | Modello di default per `chat` (`auto` lascia scegliere al router). |
| `LLM_TIMEOUT_MS` | no | `60000` | Timeout per richiesta. |

## Note

- **Zero dipendenze**: nessun `npm install`. Parla MCP su stdio (JSON-RPC 2.0 delimitato da newline).
- Non logga mai la chiave; la manda solo come header `Authorization` all'endpoint configurato.
- Verificato: handshake MCP, `tools/list`, e `tools/call` che raggiunge davvero l'endpoint
  (con una chiave finta risponde `401 unauthorized`, con quella vera i modelli reali).
