# Connettore MCP — AI gratuita (riserva FreeLLMAPI di Solco)

Un server **MCP** (Model Context Protocol) a **zero dipendenze** che espone un endpoint
LLM **OpenAI-compatibile** come strumenti per Claude Code / Claude Desktop e qualunque
client MCP. Richiede **Node 18+**. Si avvia da solo con `node server.mjs`.

## Cosa fa

Due strumenti:

- **`chat`** — manda un prompt al modello gratuito e restituisce la risposta (non-streaming).
- **`list_models`** — elenca i modelli serviti dall'endpoint (usa la chiave per «trovarli»).

## Configurazione — solo la riserva di Solco

La rete FreeLLMAPI gira **solo su Solco**: il connettore parla esclusivamente con il router
multi-provider ospitato dal sito (Groq, Cerebras, OpenRouter, … con failover automatico).

```
LLM_API_KEY  = <il tuo FREELLMAPI_API_KEY>   # il Bearer della riserva, lo stesso impostato su Vercel
LLM_BASE_URL = https://www.solcomusic.online/api/ai-reserve/v1   # facoltativa: è già il default
```

`LLM_BASE_URL` accetta solo un host di Solco (`solcomusic.online` o `www.solcomusic.online`) in
HTTPS: qualunque altro indirizzo (un'istanza su `localhost`, un router esterno) viene rifiutato,
così la chiave non esce mai da Solco.

> La chiave «premium» di `freellmapi.co` non apre nulla da sola: la riserva di Solco accetta solo il
> valore di `FREELLMAPI_API_KEY` impostato su Vercel. Puoi usare quella stringa come
> `FREELLMAPI_API_KEY`: basta che sia identica su Vercel e qui.

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
| `LLM_API_KEY` | sì | — | Il Bearer della riserva: `FREELLMAPI_API_KEY`, lo stesso valore impostato su Vercel. |
| `LLM_BASE_URL` | no | `https://www.solcomusic.online/api/ai-reserve/v1` | Solo un host di Solco in HTTPS; altri indirizzi sono rifiutati. |
| `LLM_MODEL` | no | `auto` | Modello di default per `chat` (`auto` lascia scegliere al router). |
| `LLM_TIMEOUT_MS` | no | `60000` | Timeout per richiesta. |

## Note

- **Zero dipendenze**: nessun `npm install`. Parla MCP su stdio (JSON-RPC 2.0 delimitato da newline).
- Non logga mai la chiave; la manda solo come header `Authorization` all'endpoint configurato.
- Verificato: handshake MCP, `tools/list`, e `tools/call` che raggiunge davvero l'endpoint
  (con una chiave finta risponde `401 unauthorized`, con quella vera i modelli reali).
