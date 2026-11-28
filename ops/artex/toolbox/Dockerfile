# ops/artex/toolbox — cassetta degli attrezzi di pentest per il self-test AUTORIZZATO di ARTEX.
#
# Base Kali rolling: i tool standard arrivano dai repo ufficiali Kali (nessun binario scaricato a
# caso). È un'immagine SEPARATA dallo stack ARTEX bloccato (docker-compose.yml non viene toccato):
# la avvii a mano sul TUO VPS e la punti SOLO al tuo host autorizzato (lo stesso scope di ARTEX).
#
# Uso consentito: host che possiedi / sei autorizzato a testare. Puntata altrove è accesso non
# autorizzato, a prescindere. L'entrypoint lo ricorda a ogni avvio.
FROM kalilinux/kali-rolling

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# Set curato e standard: ricognizione DNS/sottodomini, discovery/fuzzing web, scanner web, TLS,
# injection, credential testing. NIENTE metasploit nella base (è enorme): vedi README per aggiungerlo.
RUN apt-get update && apt-get install -y \
      ca-certificates curl wget git jq python3 python3-pip openssl \
      dnsutils whois \
      nmap masscan \
      subfinder dnsx amass \
      httpx-toolkit katana \
      whatweb wafw00f nikto nuclei \
      ffuf gobuster feroxbuster dirb \
      sqlmap \
      sslscan testssl.sh \
      wpscan \
      hydra \
      netcat-traditional \
      seclists \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/toolbox-entrypoint
RUN chmod +x /usr/local/bin/toolbox-entrypoint

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/toolbox-entrypoint"]
CMD ["bash"]
