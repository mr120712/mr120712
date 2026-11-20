# Skynet — chat e autodifesa

Skynet è la sentinella di sicurezza di Solco: ogni minuto guarda il sito e Vercel
(`src/lib/skynet/sentinel.server.ts`) e avvisa su Telegram. Questo documento spiega le
due funzioni aggiunte per ultime: la **chat**, che prima di rispondere trova tutto da
sola, e l'**autodifesa**, con cui Skynet si protegge senza aspettare nessuno.

Le 4 regole fisse del firewall stanno in [skynet-firewall-rules.md](skynet-firewall-rules.md).

## La chat: «Chiedi a Skynet»

**Dove:** Amministrazione → Monitoraggio → pannello Skynet → «Chiedi a Skynet».
Su Telegram: `/skynet <domanda>`, solo per il proprietario e solo in chat privata (per
chiunque altro il comando non risponde, come `/video`).

### Trova tutto

A ogni domanda il codice raccoglie un fascicolo da **tutte** le fonti, insieme, e solo
dopo lo passa al modello. Non è il modello a decidere dove guardare.

| Fonte | Cosa contiene |
| --- | --- |
| Stato e segnali | tranquillo o incidente, ultimo controllo, anomalie di traffico, `/health`, motore post-quantistico, autodifesa, apprendimento |
| Diario | quanti eventi nel periodo e di che tipo, gli eventi del periodo, quelli che parlano dell'argomento, gli ultimi |
| Firewall di Vercel | acceso o spento, versione, blocco delle AI, regole (nome, stato, azione), verifiche in corso per durata |
| Registro del firewall (24 ore) | richieste bloccate o mandate alla verifica: quante, per quale regola, da quali reti (mascherate) |
| Controlli interni | ultimo giro, controlli in errore, errori ripetuti negli ultimi giri, lavori pianificati |
| Deploy | gli ultimi su Vercel: stato, quando, commit |
| Iscritti | totali e nuovi (24 ore, 7 e 30 giorni), verificati, bloccati, Free e Pro |
| Visite | visitatori e pagine (oggi, 7 e 30 giorni), pagine, Paesi, provenienze, dispositivi |

- **Il periodo** lo capisce dalla domanda: «oggi», «ieri», «l'altro ieri», «nelle ultime
  3 ore», «questa settimana», «il 17 novembre», «17/11». Giorni di calendario italiani.
  Senza indicazioni guarda gli ultimi 7 giorni.
- **L'argomento** (attacchi, hacker, firewall, autodifesa, sito giù, post-quantistico…)
  viene cercato nel diario: in **tutto** lo storico se non ha chiesto un periodo, dentro
  il periodo se l'ha chiesto. Così «quando è stato spento il firewall?» trova anche un
  fatto di mesi fa.
- Ogni fonte ha il suo tempo massimo. Se una non risponde, le altre rispondono lo stesso
  e sotto la risposta c'è scritto quale non è stata letta.
- Il registro del firewall copre solo 24 ore: Vercel non conserva di più. Per il passato
  c'è il diario. Se il registro ha più di 300 voci la chat legge le più recenti e lo dice.

### Chi risponde

1. **Claude** (`SKYNET_AI_MODEL`, lo stesso dei rapporti) sul fascicolo completo.
2. Se Claude non è raggiungibile, la **riserva AI gratuita** su un fascicolo ridotto:
   solo conteggi e stati, senza reti, limiti delle regole, percorsi, provenienze e
   messaggi dei commit.
3. Se nemmeno quella risponde, **i fatti** con parole fisse: Skynet trova comunque tutto.

Sotto ogni risposta si legge chi l'ha scritta e quali fonti sono state lette.

### Come si protegge la chat

- **Chi può usarla:** solo amministratori con email verificata (pannello) o il
  proprietario del bot (Telegram). Stessa origine obbligatoria, corpo limitato,
  conversazione validata.
- **Limite:** 10 domande al minuto e 120 all'ora, per persona.
- **Mai segreti:** nel fascicolo entrano solo campi scelti uno a uno. In più, i valori
  dei segreti dell'ambiente (token, chiavi, `DATABASE_URL`) e tutto ciò che ha la forma
  di una credenziale vengono cancellati da ciò che parte e da ciò che torna. Un segreto
  incollato per sbaglio nella domanda non arriva al modello.
- **Mai un indirizzo IP intero:** solo reti mascherate («104.23.x.x»), anche nella
  risposta. Skynet non conserva gli indirizzi interi.
- **Testi di estranei:** percorsi visitati e siti di provenienza passano ridotti ai soli
  caratteri di un indirizzo web; il modello tratta tutto il fascicolo come dati, non
  come istruzioni, e segnala un testo che sembri un ordine.
- **Nessuna azione:** il modello non ha strumenti e non può cambiare nulla. Le condizioni
  delle regole del firewall non entrano mai nel fascicolo.
- **Niente tracce:** la conversazione resta nella pagina e non viene salvata; le domande
  non finiscono nei log. Su Telegram ogni domanda sta da sola.

### I due comandi

Li riconosce il codice, non l'AI, e solo se il messaggio è **esattamente** il comando:

| Scriva | Effetto |
| --- | --- |
| `pausa autodifesa 2 ore` | autodifesa ferma per quel tempo (da 1 minuto a 24 ore; senza durata, 2 ore) |
| `riprendi autodifesa` | autodifesa di nuovo attiva; fermi e tentativi azzerati |

«Come metto in pausa l'autodifesa?» è una domanda: Skynet spiega, non esegue. Ogni
comando finisce nel diario e arriva su Telegram: se non è stato lei, lo viene a sapere.

## L'autodifesa

Se qualcuno **spegne** una protezione che Skynet aveva visto accesa, Skynet la riaccende
identica a prima, rilegge il firewall per verificare e lo dice su Telegram.

| Protezione | Quando la riaccende |
| --- | --- |
| Firewall di Vercel | spento da 2 controlli di fila |
| Blocco delle AI («AI Bots») | spento o messo in «log» da 2 controlli di fila; torna con l'azione che aveva |
| Regole `Skynet ·` | spente da 2 controlli di fila; tornano con le stesse condizioni |

Che cosa **non** fa, mai:

- non accende ciò che non ha mai visto acceso, né una regola nata spenta;
- non crea, non cancella e non spegne nulla; una regola **cancellata** non la può
  ricreare (resta l'avviso: va rifatta con [skynet-firewall-rules.md](skynet-firewall-rules.md));
- non tocca le regole senza il prefisso `Skynet ·` e quelle messe a mano;
- non accende **Attack Challenge Mode** né il gate UAM: sfidano ogni visitatore e
  fermano l'app e le API. Restano una sua decisione.

### Quando si ferma da sola

- **Tiro alla fune:** dopo 2 ripristini in un'ora, se la protezione viene rispenta
  Skynet si ferma su quella e avvisa. O è lei che la vuole spenta, o qualcuno ha accesso
  al suo Vercel. Riprende da sola quando la protezione torna accesa, o con
  `riprendi autodifesa`.
- **Vercel rifiuta:** riprova 3 volte a distanza di qualche minuto, lo dice la prima
  volta e quando si arrende. Poi va fatto a mano.
- **Fra due tentativi** sulla stessa protezione passano almeno 3 minuti.

### Spegnerla

- **Per un po':** `pausa autodifesa 2 ore` nella chat, **prima** di spegnere una
  protezione di proposito.
- **Del tutto:** variabile `SKYNET_AUTODEFENSE=off` su Vercel (Production) e nuovo
  deploy. Skynet torna ad avvisare soltanto.

Nel pannello la riga «Autodifesa» dice se è attiva, in pausa o spenta, su cosa veglia e
su cosa si è fermata.

### Cosa arriva su Telegram

Uno spegnimento del firewall produce, nell'ordine: «firewall modificato» e l'incidente
(subito), «Autodifesa: ho riacceso il firewall di Vercel» (al controllo dopo) e «tutto
tornato normale» (dopo 3 controlli tranquilli). La modifica fatta da Skynet non viene
scambiata per una manomissione.

## Dove sta il codice

| File | Cosa fa |
| --- | --- |
| `src/lib/skynet/autodefense.ts` | autodifesa, parte pura: cosa è acceso, quando agire, cosa dire |
| `src/lib/skynet/sentinel.server.ts` | il giro: `defend` esegue il ripristino, `switchAutodefense` la pausa |
| `src/lib/skynet/chat.ts` | chat, parte pura: periodo, ricerca, fascicolo, protezioni dei testi |
| `src/lib/skynet/chat.server.ts` | chat, parte server: raccoglie le fonti e interpella i modelli |
| `src/app/api/admin/skynet/chat/route.ts` | la porta della chat nel pannello |
| `src/components/custom/monitoring/skynet-chat.tsx` | la chat nel pannello |
| `src/app/api/telegram/webhook/route.ts` | `/skynet` sul bot |

Il token `SKYNET_VERCEL_TOKEN` resta dentro `sentinel.server.ts`: da lì escono solo
riassunti. Test: `tests/unit/skynet-*.test.ts(x)` e `tests/unit/telegram-bot-webhook.test.ts`.
