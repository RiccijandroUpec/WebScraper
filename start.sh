#!/bin/sh
set -e
# Un "docker restart" (a diferencia de recrear el contenedor) puede dejar el
# lock file de una Xvfb anterior en /tmp, lo que hace que esta arranque
# fallando con "Server is already active for display 99" sin que start.sh
# se entere (corre en segundo plano) — el bot sigue arrancando sin pantalla
# virtual real, y el scraper se rompe en silencio mas tarde.
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp &
export DISPLAY=:99
sleep 1
exec node server.js
