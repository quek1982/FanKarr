# Imite un seedbox ultra.cc : Debian 13 (trixie), binaire Linux autonome, aucun Node/Bun installé
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY start.sh /start.sh
RUN chmod +x /start.sh

# Lancé hors du dossier du binaire : le .env à côté du binaire est alors chargé (comme sur ultra.cc)
WORKDIR /
CMD ["/start.sh"]
