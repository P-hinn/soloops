#!/usr/bin/env bash
#
# Welche Dienste lauschen gerade auf welchem Port — und wie wird man sie los.
#
#   scripts/ports.sh              Dev-relevante Ports auflisten
#   scripts/ports.sh -a           alles auflisten, auch macOS- und App-Rauschen
#   scripts/ports.sh kill 5173 3000   Prozesse auf diesen Ports beenden
#   scripts/ports.sh kill soloops     alle Ports dieses Projekts freiräumen
#   scripts/ports.sh --json           dieselbe Liste als JSON (nutzt die macOS-App)
#
# Ports, die Docker hält, werden nicht gekillt: dahinter steckt der Docker-
# Daemon, nicht der Dienst. Die betroffenen Container werden gestoppt.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Hintergrunddienste von macOS und installierten Apps. Die stehen nie im Weg
# und würden die Liste nur zumüllen.
NOISE='^(rapportd|ControlCe|sharingd|AirPlayX|remoted|PresentSe|Spotify|Raycast|Dropbox|iCloud|identitys|launchd|cloudd|trustd|apsd|netbiosd|mDNSResp|Code\\x20H|Cursor|Electron|Postman|Slack|zoom|WhatsApp|Signal|Arc|Chrome|firefox|Safari)'

# --- Docker: Host-Port -> Containername ------------------------------------

declare -a DOCKER_PORTS=()
load_docker() {
  command -v docker >/dev/null 2>&1 || return 0
  local raw name ports host
  # `|` als Trenner, weil Containernamen keins enthalten dürfen.
  raw="$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null || true)"
  [ -n "$raw" ] || return 0

  while IFS='|' read -r name ports; do
    [ -n "${ports:-}" ] || continue
    # "0.0.0.0:5174->5173/tcp, [::]:5174->5173/tcp" -> 5174
    for host in $(printf '%s' "$ports" | tr ',' '\n' | sed -n 's/.*:\([0-9][0-9]*\)->.*/\1/p' | sort -u); do
      DOCKER_PORTS+=("$host=$name")
    done
  done <<< "$raw"
}

docker_container_for() {
  local port="$1" entry
  for entry in "${DOCKER_PORTS[@]:-}"; do
    [ "${entry%%=*}" = "$port" ] && { printf '%s' "${entry#*=}"; return 0; }
  done
  return 1
}

# --- Auflisten --------------------------------------------------------------

# Eine Zeile je Port: "port<TAB>pid<TAB>prozess<TAB>adresse"
listening() {
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {
    split($9, a, ":")
    port = a[length(a)]
    addr = substr($9, 1, length($9) - length(port) - 1)
    if (addr == "*") addr = "alle"
    key = port "\t" $2
    if (seen[key]++) next
    print port "\t" $2 "\t" $1 "\t" addr
  }' | sort -n -k1,1 -u
}

# Woran hängt die PID? Bei Docker der Container, sonst das Arbeitsverzeichnis
# bzw. der Befehl — damit man drei node-Prozesse auseinanderhalten kann.
describe() {
  local port="$1" pid="$2" proc="$3" container cwd cmd
  if container="$(docker_container_for "$port")"; then
    printf 'docker: %s' "$container"
    return
  fi
  case "$proc" in
    com.docke*|vpnkit*|docker*) printf 'docker (Container nicht ermittelbar)'; return ;;
  esac
  cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  if [ -n "$cwd" ] && [ "$cwd" != "/" ]; then
    case "$cwd" in
      "$HOME"/*) printf '~/%s' "${cwd#"$HOME"/}" ;;
      *) printf '%s' "$cwd" ;;
    esac
    return
  fi
  cmd="$(ps -o command= -p "$pid" 2>/dev/null | head -1)"
  printf '%s' "${cmd:-$proc}"
}

cmd_list() {
  local show_all="${1:-}"
  load_docker

  printf '\033[1m%-7s %-8s %-14s %-10s %s\033[0m\n' PORT PID PROZESS ADRESSE WOHER
  local port pid proc addr
  while IFS=$'\t' read -r port pid proc addr; do
    [ -n "${port:-}" ] || continue
    if [ -z "$show_all" ]; then
      # Ephemere Ports vergibt das System selbst, die interessieren nie.
      [ "$port" -ge 32768 ] && continue
      printf '%s' "$proc" | grep -qE "$NOISE" && continue
    fi
    printf '%-7s %-8s %-14s %-10s %s\n' "$port" "$pid" "${proc:0:14}" "${addr:0:10}" "$(describe "$port" "$pid" "$proc")"
  done < <(listening)

  [ -z "$show_all" ] && printf '\n\033[2m(nur Dev-Ports — alles inkl. Systemdienste: %s -a)\033[0m\n' "$0"
  return 0
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Dieselbe Auswahl wie cmd_list, nur maschinenlesbar. Die macOS-App liest das
# hier, damit Docker-Erkennung und Filter nicht ein zweites Mal existieren.
cmd_json() {
  load_docker

  local first=1 port pid proc addr container
  printf '['
  while IFS=$'\t' read -r port pid proc addr; do
    [ -n "${port:-}" ] || continue
    [ "$port" -ge 32768 ] && continue
    printf '%s' "$proc" | grep -qE "$NOISE" && continue

    container="$(docker_container_for "$port" || true)"
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"port":%s,"pid":%s,"process":"%s","address":"%s","origin":"%s","container":%s}' \
      "$port" "$pid" \
      "$(json_escape "$proc")" \
      "$(json_escape "$addr")" \
      "$(json_escape "$(describe "$port" "$pid" "$proc")")" \
      "$([ -n "$container" ] && printf '"%s"' "$(json_escape "$container")" || printf 'null')"
  done < <(listening)
  printf ']\n'
}

# --- Beenden ----------------------------------------------------------------

# Ports dieses Projekts, inklusive der in .env überschriebenen.
project_ports() {
  local web=5174 api=3000 db=5433 prod=8090
  if [ -f "$ROOT/.env" ]; then
    web="$(sed -n 's/^WEB_PORT=\([0-9]*\).*/\1/p' "$ROOT/.env" | head -1)" || true
    api="$(sed -n 's/^API_PORT=\([0-9]*\).*/\1/p' "$ROOT/.env" | head -1)" || true
    prod="$(sed -n 's/^SOLOOPS_PORT=\([0-9]*\).*/\1/p' "$ROOT/.env" | head -1)" || true
  fi
  printf '%s\n' "${web:-5174}" "${api:-3000}" "$db" "${prod:-8090}" 5173 | sort -nu
}

kill_port() {
  local port="$1" container pids pid proc
  load_docker

  if container="$(docker_container_for "$port")"; then
    printf 'Port %-5s → Container %s wird gestoppt\n' "$port" "$container"
    docker stop "$container" >/dev/null
    return 0
  fi

  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    printf 'Port %-5s → frei\n' "$port"
    return 0
  fi

  for pid in $pids; do
    proc="$(ps -o comm= -p "$pid" 2>/dev/null | xargs basename 2>/dev/null || echo '?')"
    # Sicherheitsnetz, falls die Container-Zuordnung oben nicht griff: hinter
    # com.docker.backend steckt der Daemon, nicht der Dienst auf dem Port.
    case "$proc" in
      com.docker*|vpnkit*|Docker*)
        printf 'Port %-5s → gehört dem Docker-Daemon. Bitte den Container stoppen.\n' "$port"
        continue
        ;;
    esac
    # Erst höflich fragen: SIGTERM lässt Vite und tsx ihre Watcher aufräumen.
    kill "$pid" 2>/dev/null || true
    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 20 ]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
      printf 'Port %-5s → %s (%s) mit SIGKILL beendet\n' "$port" "$proc" "$pid"
    else
      printf 'Port %-5s → %s (%s) beendet\n' "$port" "$proc" "$pid"
    fi
  done
}

cmd_kill() {
  [ "$#" -gt 0 ] || { echo "Welcher Port? z. B. $0 kill 5173 — oder $0 kill soloops" >&2; exit 1; }
  local arg
  for arg in "$@"; do
    case "$arg" in
      soloops|projekt|project|all)
        while read -r p; do kill_port "$p"; done < <(project_ports)
        ;;
      *[!0-9]*)
        echo "Kein Port: $arg" >&2
        exit 1
        ;;
      *)
        kill_port "$arg"
        ;;
    esac
  done
}

case "${1:-list}" in
  list|ls) cmd_list "" ;;
  --json) cmd_json ;;
  -a|--all) cmd_list all ;;
  kill|stop) shift; cmd_kill "$@" ;;
  -h|--help|help) awk 'NR > 2 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0" ;;
  *) echo "Unbekannt: $1 — siehe $0 --help" >&2; exit 1 ;;
esac
