# Riserva AI gratuita — freellmapi.co

[freellmapi.co](https://freellmapi.co) è un proxy **OpenAI-compatibile** che mette insieme le
free-tier di molti provider LLM. In Solco è la **riserva gratuita** delle funzioni AI di testo:
**Claude resta primario** (qualità), ma se la chiave Claude manca, è rifiutata, è sopra il tetto di
spesa o il servizio è occupato, le funzioni ripiegano su freellmapi.co **senza far pagare nulla**.

> freellmapi.co dichiara di non essere un substrato di inferenza stabile o garantito: per questo è
> solo riserva *best-effort*, mai il motore primario, e usa un modello **aperto** (non OpenAI).

## Variabili d'ambiente (segreti server-side su Vercel)

| Variabile | Obbligo | Valore |
|---|---|---|
| `FREELLMAPI_API_KEY` | sì (per attivare la riserva) | il token `freellmapi-…` dalla dashboard di freellmapi.co |
| `FREELLMAPI_MODEL` | consigliata | un id di modello **aperto** da [freellmapi.co/models](https://freellmapi.co/models) (es. un Llama/Mistral/Qwen). Predefinito: `auto` (il proxy sceglie un modello gratuito disponibile) |
| `FREELLMAPI_BASE_URL` | solo self-hosting | l'URL `/v1` del tuo router freellmapi; predefinito `https://freellmapi.co/v1` |

Se `FREELLMAPI_API_KEY` non è impostata, la riserva è semplicemente spenta: non è un guasto e le
funzioni restano su Claude.

## Dove interviene

- **Cerca con l'AI** (`/api/music/ai-search`): se Claude non è disponibile, il piano di ricerca
  arriva da freellmapi.co con lo **stesso** schema (intro, ricerche YouTube/Audius, tag radio,
  podcast, generi). Non interviene su un rifiuto di sicurezza di Claude.
- Le funzioni che richiedono il contesto lungo di Claude (es. «Organizza con l'AI», 1M token) **non**
  usano la riserva: i modelli gratuiti non reggono quel contesto.

## Verifica e monitoraggio

- Il monitoraggio ha il controllo **«Riserva AI gratuita (freellmapi.co)»**: fa un `GET /models`
  (non spende token). Non configurata = avviso (non è un guasto); chiave rifiutata o errore = guasto.
- Nessun log registra mai la chiave, il prompt o la risposta.

## Privacy

Quando la riserva entra in gioco, la richiesta dell'utente (la descrizione di ricerca) viene inviata
a freellmapi.co. Resta valido il resto del modello di Solco: la funzione è comunque riservata ai piani
Premium e con limite di frequenza, e nessun dato personale dell'account viene inoltrato.
