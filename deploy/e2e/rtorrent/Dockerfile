FROM crazymax/rtorrent-rutorrent:latest
# Modèle copié dans /data/rtorrent au premier démarrage
COPY .rtorrent.rc /tpls/.rtorrent.rc
# XML-RPC protégé par mot de passe, comme sur une seedbox (fankarr / secret)
RUN mkdir -p /passwd && htpasswd -bc /passwd/rpc.htpasswd fankarr secret
