// solco-cc-dl — versione Go dello strumento locale di download audio (NON fa parte del sito Solco).
//
// È il gemello in Go di scripts/yt-dlp-cc-download.py e del bot Telegram: stesso perimetro legale.
//   - DEFAULT: scarica SOLO audio con licenza Creative Commons (filtro imposto da yt-dlp sul campo
//     `license`); i brani con licenza standard vengono SALTATI.
//   - -own: contenuti che dichiari TUOI (ne hai i diritti): toglie il filtro CC.
//   - whitelist di domini (default youtube.com/youtu.be), estendibile con -allow-domains.
//   - -urls-file per una lista (un URL per riga, '#' = commento).
//   - ricerca: -search "parole" elenca i risultati Creative Commons (yt-dlp ytsearch).
//   - effetti "slowed / sped up" (il tono segue la velocità, come sul sito): -slow -fast -reverb
//     oppure -speed <fattore>, applicati con ffmpeg dopo il download.
//
// NON è uno strumento per rippare musica protetta di terzi: non aggira protezioni e si limita a ciò
// che è lecito. Richiede yt-dlp nel PATH (e ffmpeg/ffprobe per -mp3 e per gli effetti).
//
// Esempi:
//
//	go run . -search "lofi creative commons" -n 10
//	go run . "https://www.youtube.com/watch?v=XXXX" -slow
//	go run . -urls-file urls.txt -out ./download
//	go run . -own "https://www.youtube.com/@iltuocanale"
package main

import (
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const ccMatchFilter = "license ~= (?i)creative commons"

// Domini consentiti di default (estendibili con -allow-domains). Il filtro CC resta comunque il
// controllo principale sui diritti.
var defaultAllowedDomains = []string{
	"youtube.com",
	"youtu.be",
	"m.youtube.com",
	"music.youtube.com",
	"www.youtube.com",
}

const (
	minSpeed     = 0.5
	maxSpeed     = 2.0
	slowedSpeed  = 0.85
	reverbSpeed  = 0.82
	spedUpSpeed  = 1.25
	searchCount  = 12
	defaultAudio = "bestaudio/best"
)

func clampSpeed(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 1.0
	}
	return math.Min(maxSpeed, math.Max(minSpeed, value))
}

// hostAllowed: l'host dell'URL è uguale a un dominio consentito o un suo vero sottodominio. Così i
// lookalike (evil-youtube.com, youtube.com.attacker.net) vengono rifiutati.
func hostAllowed(rawURL string, allowed []string) bool {
	parsed, err := neturlHostname(rawURL)
	if err != nil || parsed == "" {
		return false
	}
	host := strings.ToLower(parsed)
	for _, domain := range allowed {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	return false
}

func mustTool(tool string) {
	if _, err := exec.LookPath(tool); err != nil {
		fatalf("Manca «%s» nel PATH. Installalo prima (vedi l'intestazione del file).", tool)
	}
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

// readURLsFile legge un file di URL (un per riga, '#' = commento).
func readURLsFile(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var urls []string
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			urls = append(urls, trimmed)
		}
	}
	return urls, nil
}

// searchMusic cerca su YouTube e tiene SOLO i risultati Creative Commons (lo impone yt-dlp). Niente
// --flat-playlist: serve l'estrazione completa perché `license` esista e il filtro possa scartare i
// non-CC. Ritorna righe "titolo\turl" dei soli domini consentiti.
func searchMusic(query string, count int, allowed []string) [][2]string {
	cmd := exec.Command(
		"yt-dlp",
		fmt.Sprintf("ytsearch%d:%s", count, query),
		"--match-filter", ccMatchFilter,
		"--no-download", "--ignore-errors", "--no-warnings",
		"--print", "%(title)s\t%(webpage_url)s",
	)
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		fmt.Fprintln(os.Stderr, "ricerca fallita:", err)
		return nil
	}
	var results [][2]string
	for _, line := range strings.Split(string(out), "\n") {
		title, url, found := strings.Cut(line, "\t")
		if !found {
			continue
		}
		url = strings.TrimSpace(url)
		if (strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://")) && hostAllowed(url, allowed) {
			results = append(results, [2]string{strings.TrimSpace(title), url})
		}
	}
	return results
}

// mp3Set elenca i .mp3 presenti in una cartella (per capire quali sono nuovi dopo un download).
func mp3Set(dir string) map[string]bool {
	set := map[string]bool{}
	matches, _ := filepath.Glob(filepath.Join(dir, "*.mp3"))
	for _, m := range matches {
		set[m] = true
	}
	return set
}

func download(urls []string, own, mp3 bool, format, outDir string) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	args := []string{
		"-f", format,
		"-o", filepath.Join(outDir, "%(uploader)s - %(title)s [%(id)s].%(ext)s"),
		"--no-overwrites", "--ignore-errors",
	}
	if mp3 {
		args = append(args,
			"--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
			"--embed-metadata", "--embed-thumbnail",
		)
	}
	if !own {
		args = append(args, "--match-filter", ccMatchFilter)
	}
	args = append(args, urls...)
	cmd := exec.Command("yt-dlp", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func probeSampleRate(path string) int {
	out, err := exec.Command(
		"ffprobe", "-v", "error", "-select_streams", "a:0",
		"-show_entries", "stream=sample_rate",
		"-of", "default=nokey=1:noprint_wrappers=1", path,
	).Output()
	if err != nil {
		return 0
	}
	value := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	rate, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return rate
}

func speedTag(speed float64, reverb bool) string {
	switch {
	case reverb && speed < 1:
		return "slowed+reverb"
	case reverb:
		return "reverb"
	case speed < 1:
		return "slowed"
	default:
		return "spedup"
	}
}

// applySpeed crea una versione slowed/sped-up: asetrate reinterpreta la frequenza (cambia tempo E
// tono, effetto "giradischi"), aresample riporta a una frequenza standard; reverb = eco leggera.
func applySpeed(src string, speed float64, reverb bool) (string, error) {
	sampleRate := probeSampleRate(src)
	if sampleRate == 0 {
		sampleRate = 44100
	}
	newRate := int(float64(sampleRate) * clampSpeed(speed))
	if newRate < 8000 {
		newRate = 8000
	}
	chain := fmt.Sprintf("asetrate=%d,aresample=%d", newRate, sampleRate)
	if reverb {
		chain += ",aecho=0.8:0.85:60:0.35"
	}
	ext := filepath.Ext(src)
	stem := strings.TrimSuffix(src, ext)
	out := fmt.Sprintf("%s [%s %gx]%s", stem, speedTag(speed, reverb), speed, ext)
	cmd := exec.Command("ffmpeg", "-y", "-i", src, "-filter:a", chain, "-b:a", "192k", out)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return out, nil
}

// stringList è un flag ripetibile / separato da virgola (per -allow-domains).
type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(value string) error {
	for _, part := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(strings.ToLower(part)); trimmed != "" {
			*s = append(*s, trimmed)
		}
	}
	return nil
}

func main() {
	os.Exit(run())
}
