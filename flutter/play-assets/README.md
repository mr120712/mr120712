# Asset grafici per Google Play Console — Solco

Ricavati dall'icona ufficiale dell'app (`flutter/assets/icon/solco-icon.png`):
onda lime **#C5ED72** su blu notte **#08151F**.

| File | Formato | Dove si carica in Play Console |
|---|---|---|
| `icona-512.png` | PNG 512×512 (quadro pieno) | Scheda dello Store principale → **Icona dell'app** |
| `feature-graphic-1024x500.png` | PNG 1024×500 (senza trasparenza) | Scheda dello Store principale → **Immagine in primo piano** (obbligatoria) |

## Screenshot del telefono (ancora da fare)

Play Console richiede **almeno 2** screenshot del telefono (consigliati 4–8):
- proporzioni 16:9 o 9:16, lato tra 320 px e 3840 px (es. 1080×1920);
- devono mostrare l'esperienza reale dell'app.

Il modo più fedele e conforme alle regole di Google: **catturare gli screenshot dal
telefono con l'app Solco in funzione** (Home, Cerca, Radio, Libreria, player a tutto
schermo). Inviali e li trasformo in screenshot «da vetrina» con cornice del dispositivo,
sfondo coordinato e una breve didascalia per ciascuno.

## Note

- L'icona è a tutto riquadro: Play applica da sé angoli arrotondati e ombra, non serve
  arrotondarla a mano.
- Gli asset seguono l'identità dell'icona dell'app (lime su blu notte). Se in futuro
  l'icona dell'app cambia, questi vanno rigenerati per restare coerenti.
