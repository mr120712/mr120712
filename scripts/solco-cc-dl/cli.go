package main

import (
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// neturlHostname estrae l'host da un URL (vuoto se non parsabile).
func neturlHostname(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	return parsed.Hostname(), nil
}

func run() int {
	out := flag.String("out", "download", "Cartella di output.")
	mp3 := flag.Bool("mp3", true, "Estrai l'audio in MP3 (serve ffmpeg). -mp3=false per il file originale.")
	format := flag.String("format", defaultAudio, "Selettore di formato yt-dlp.")
	own := flag.Bool("own", false, "Gli URL sono TUOI: toglie il filtro Creative Commons.")
	urlsFile := flag.String("urls-file", "", "File con un URL per riga ('#' = commento).")
	search := flag.String("search", "", "Cerca brani Creative Commons ed elenca i risultati (niente download).")
	count := flag.Int("n", searchCount, "Numero di risultati per -search.")
	slow := flag.Bool("slow", false, "Effetto rallentato (x0.85, il tono scende).")
	fast := flag.Bool("fast", false, "Effetto accelerato / nightcore (x1.25, il tono sale).")
	reverb := flag.Bool("reverb", false, "Rallentato + eco (slowed + reverb).")
	speed := flag.Float64("speed", 0, "Velocità a scelta (0.5–2); ha priorità sulle scorciatoie. 0 = nessun effetto.")
	var allowDomains stringList
	flag.Var(&allowDomains, "allow-domains", "Domini consentiti extra (ripetibile o separati da virgola).")
	flag.Parse()

	allowed := append([]string{}, defaultAllowedDomains...)
	allowed = append(allowed, allowDomains...)

	mustTool("yt-dlp")

	// Ricerca: elenca i risultati CC e termina (il download avviene passando poi gli URL).
	if strings.TrimSpace(*search) != "" {
		results := searchMusic(*search, *count, allowed)
		if len(results) == 0 {
			fmt.Println("Nessun risultato Creative Commons. Prova altre parole.")
			return 0
		}
		fmt.Printf("Risultati Creative Commons per «%s»:\n\n", *search)
		for i, r := range results {
			fmt.Printf("%2d. %s\n    %s\n", i+1, r[0], r[1])
		}
		return 0
	}

	// Velocità effettiva: -speed esplicito, altrimenti le scorciatoie, altrimenti 1 (nessun effetto).
	effSpeed := 1.0
	effReverb := *reverb
	switch {
	case *speed > 0:
		effSpeed = clampSpeed(*speed)
	case *reverb:
		effSpeed = reverbSpeed
	case *slow:
		effSpeed = slowedSpeed
	case *fast:
		effSpeed = spedUpSpeed
	}
	wantsEffect := effReverb || effSpeed != 1.0

	// Gli effetti lavorano su file audio: con un effetto forziamo l'estrazione MP3.
	useMP3 := *mp3 || wantsEffect
	if wantsEffect {
		mustTool("ffmpeg")
	}

	urls := append([]string{}, flag.Args()...)
	if *urlsFile != "" {
		fromFile, err := readURLsFile(*urlsFile)
		if err != nil {
			fatalf("Non riesco a leggere %s: %v", *urlsFile, err)
		}
		urls = append(urls, fromFile...)
	}
	if len(urls) == 0 {
		fatalf("Nessun URL. Passane uno, usa -urls-file, oppure cerca con -search \"parole\".")
	}

	// Whitelist: tiene solo gli URL da domini consentiti.
	var kept []string
	for _, u := range urls {
		if hostAllowed(u, allowed) {
			kept = append(kept, u)
		} else {
			host, _ := neturlHostname(u)
			if host == "" {
				host = u
			}
			fmt.Fprintf(os.Stderr, "⛔ Dominio non consentito, salto: %s\n", host)
		}
	}
	if len(kept) == 0 {
		fatalf("Nessun URL da un dominio consentito. Aggiungine con -allow-domains se sei sicuro.")
	}

	if *own {
		fmt.Println("⚠️  -own: scarichi contenuti che dichiari TUOI. Procedi solo se ne hai i diritti.")
	} else {
		fmt.Println("ℹ️  Scarico SOLO audio con licenza Creative Commons; gli altri vengono saltati.")
	}

	before := mp3Set(*out)
	if err := download(kept, *own, useMP3, *format, *out); err != nil {
		fmt.Fprintln(os.Stderr, "yt-dlp:", err)
	}

	if !wantsEffect {
		return 0
	}
	// Applica l'effetto ai soli MP3 appena creati.
	after := mp3Set(*out)
	for path := range after {
		if before[path] {
			continue
		}
		fmt.Printf("🎚️  Applico «%s» (x%g) a %s\n", speedTag(effSpeed, effReverb), effSpeed, path)
		result, err := applySpeed(path, effSpeed, effReverb)
		if err != nil {
			fmt.Fprintln(os.Stderr, "ffmpeg:", err)
			continue
		}
		fmt.Println("✅", result)
	}
	return 0
}
