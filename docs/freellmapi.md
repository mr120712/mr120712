# Riserva AI gratuita — freellmapi

[freellmapi](https://freellmapi.co) è un proxy **OpenAI-compatibile** **self-hosted** che mette
insieme le free-tier di molti provider LLM. In Solco è la **riserva gratuita** delle funzioni AI di
testo: **Claude resta primario** (qualità), ma se la chiave Claude manca, è rifiutata, è sopra il
tetto di spesa o il servizio è occupato, le funzioni ripiegano su freellmapi **senza far pagare
nulla**.

> È *best-effort*: freellmapi non è un substrato di inferenza garantito. Usa un modello **aperto**
> (non OpenAI).

## ⚠️ freellmapi è self-hosted: serve un endpoint PUBBLICO

**Non esiste un'API ospitata.** `https://freellmapi.co/v1` è solo il **sito/dashboard** e risponde
**404** a `/v1/models`: non è un endpoint API. L'API la serve il **router freellmapi** che installi
tu.

Perché la riserva funzioni **sul sito live (Vercel)**, il router dev'essere raggiungibile da internet:

- Un router su **`localhost:3001`** (come quello che configura `freellmapi setup-claude` per il tuo
  Claude Code locale) **non funziona**: i server di Vercel non raggiungono il tuo computer.
- Devi **pubblicare il router su un URL pubblico** (es. un piccolo deploy su un host tuo) e usare
  quell'URL.

## Variabili d'ambiente (segreti server-side su Vercel → Production)

| Variabile | Obbligo | Valore |
|---|---|---|
| `FREELLMAPI_BASE_URL` | **sì** | l'URL **`/v1` pubblico** del tuo router freellmapi (es. `https://il-tuo-router.example/v1`). **Mai** `localhost`. Senza questa, la riserva è «non configurata». |
| `FREELLMAPI_API_KEY` | **sì** | il token del router (formato `fla_…`), valido **per quell'endpoint**. |
| `FREELLMAPI_MODEL` | consigliata | un id di modello **aperto** disponibile sul router; predefinito `auto`. |

Dopo ogni modifica su Vercel serve un **Redeploy** perché le variabili vengano lette.

## Verifica rapida della chiave + endpoint

Dalla macchina dove gira il router (o verso l'URL pubblico):
```
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <LA-TUA-CHIAVE>" <BASE_URL>/models
```
- **200** → chiave ed endpoint validi → su Vercel metti quello stesso `FREELLMAPI_BASE_URL` + chiave, Redeploy.
- **404** → quell'URL non è un'API freellmapi (es. stai puntando a `freellmapi.co/v1`).
- **401/403** → chiave non valida per quell'endpoint.

## Monitoraggio

Il controllo **«Riserva AI gratuita (freellmapi.co)»** fa un `GET <BASE_URL>/models` (non spende
token):
- **non configurata** (manca chiave o URL) = **avviso**, non guasto;
- chiave rifiutata, 404, o router irraggiungibile = **guasto**.

## Se non hai un router pubblico

La riserva è **facoltativa**. Lascia pure `FREELLMAPI_API_KEY` e `FREELLMAPI_BASE_URL` **vuote**: il
check resta «non configurata» (avviso), il sito è verde e **Claude continua a funzionare** come
motore primario.

## Privacy

Quando la riserva entra in gioco, la richiesta dell'utente (la descrizione di ricerca) va al tuo
router freellmapi. La funzione resta riservata ai piani Premium e con limite di frequenza; nessun
dato personale dell'account viene inoltrato. Nessun log registra la chiave, il prompt o la risposta.
