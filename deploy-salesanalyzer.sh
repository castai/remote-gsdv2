#!/usr/bin/env bash
# ─── Deploy: salesanalyzer remote GSD pod ─────────────────────────────────────
# Usage:
#   ./deploy-salesanalyzer.sh              # install or upgrade (default)
#   ./deploy-salesanalyzer.sh up           # alias for default
#   ./deploy-salesanalyzer.sh down         # SAFE stop — removes workload, keeps PVC + namespace
#   ./deploy-salesanalyzer.sh nuke         # DESTRUCTIVE — deletes PVC and namespace (typed confirmation)
#   ./deploy-salesanalyzer.sh status       # show release + pod + PVC state
#
# Lifecycle model:
#   - `up`    is reversible. Re-running it after `down` reattaches the existing PVC.
#   - `down`  removes the pod/deployment/secrets/RBAC. Data on /home/gsd survives.
#   - `nuke`  is the only path that destroys data. Requires typing the project name.
#
# Inputs:
#   secrets/salesanalyzer.env                              (gitignored secrets)
#   ~/.gsd/agent/models.json                               (machine-local)
#   ../oc_salesanalyzer_control/.gsd/PREFERENCES.md        (sibling repo)
#   ../oc_salesanalyzer_control/.env                       (sibling repo)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_FILE="$SCRIPT_DIR/secrets/salesanalyzer.env"
MODELS_JSON="$HOME/.gsd/agent/models.json"
SALESANALYZER_DIR="$(cd "$SCRIPT_DIR/../oc_salesanalyzer_control" 2>/dev/null && pwd || true)"
PREFERENCES_MD="${SALESANALYZER_DIR:+$SALESANALYZER_DIR/.gsd/PREFERENCES.md}"
PROJECT_ENV="${SALESANALYZER_DIR:+$SALESANALYZER_DIR/.env}"
CHART="$SCRIPT_DIR/chart/gsd-remote"
VALUES="$SCRIPT_DIR/chart/examples/salesanalyzer.yaml"
NAMESPACE="lk-gsd"
RELEASE="salesanalyzer"
PVC_NAME="gsd-${RELEASE}-home"

CMD="${1:-up}"

# ─── Helpers ─────────────────────────────────────────────────────────────────
msg()  { printf '── %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
die()  { printf '❌ %s\n' "$*" >&2; exit 1; }

resolve_helm_namespace() {
  # Returns the namespace where helm tracks this release, or empty if not installed.
  if helm status "$RELEASE" -n "$NAMESPACE" &>/dev/null; then
    echo "$NAMESPACE"
  elif helm status "$RELEASE" -n default &>/dev/null; then
    echo "default"
  elif helm status "$RELEASE" -n gsd-remote &>/dev/null; then
    # Legacy namespace from before the lk-gsd rename
    echo "gsd-remote"
  else
    echo ""
  fi
}

ensure_namespace() {
  if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
    msg "Creating namespace $NAMESPACE (not helm-managed by design)"
    kubectl create namespace "$NAMESPACE"
  fi
}

# ─── status ──────────────────────────────────────────────────────────────────
cmd_status() {
  local helm_ns; helm_ns="$(resolve_helm_namespace)"
  if [ -z "$helm_ns" ]; then
    msg "Release '$RELEASE' is not installed."
  else
    msg "Release '$RELEASE' is installed in namespace: $helm_ns"
    helm status "$RELEASE" -n "$helm_ns" | head -20
  fi
  echo
  msg "Namespace $NAMESPACE:"
  kubectl get all,pvc -n "$NAMESPACE" 2>&1 | head -30 || true
}

# ─── up (install/upgrade) ────────────────────────────────────────────────────
cmd_up() {
  # ── Validate inputs ──
  [ -z "$SALESANALYZER_DIR" ] && die "oc_salesanalyzer_control not found as a sibling of $(dirname "$SCRIPT_DIR")"
  for f in "$SECRETS_FILE" "$MODELS_JSON" "$PREFERENCES_MD" "$PROJECT_ENV"; do
    [ -f "$f" ] || die "Required file not found: $f"
  done

  # ── Load secrets ──
  set -a; source "$SECRETS_FILE"; set +a

  # ── Ensure namespace exists (NOT helm-managed) ──
  ensure_namespace

  # ── Determine action ──
  local helm_ns; helm_ns="$(resolve_helm_namespace)"
  local action
  if [ -n "$helm_ns" ] && [ "$helm_ns" != "$NAMESPACE" ]; then
    die "Release '$RELEASE' is in namespace '$helm_ns', not '$NAMESPACE'.
       Migrate by running: ./deploy-salesanalyzer.sh down
       (this preserves data) then re-run up. If you want to keep the existing
       deployment in '$helm_ns', edit NAMESPACE in this script."
  fi
  action=$([ -n "$helm_ns" ] && echo "upgrade" || echo "install")

  msg "Deploying $RELEASE (action: $action, namespace: $NAMESPACE)"

  helm "$action" "$RELEASE" "$CHART" \
    -f "$VALUES" \
    --namespace "$NAMESPACE" \
    --set namespace="$NAMESPACE" \
    --set githubPAT="$GITHUB_PAT" \
    --set kimchiToken="$KIMCHI_TOKEN" \
    --set-file modelsJSON="$MODELS_JSON" \
    --set-file preferencesMD="$PREFERENCES_MD" \
    --set-file projectEnv="$PROJECT_ENV"

  msg "Waiting for rollout..."
  kubectl rollout status "deployment/gsd-$RELEASE" -n "$NAMESPACE" --timeout=120s

  msg "Verifying models.json..."
  kubectl exec -n "$NAMESPACE" "deploy/gsd-$RELEASE" -- \
    node -e "
const m=require('/home/gsd/.gsd/agent/models.json');
const p=Object.keys(m.providers)[0];
const prov=m.providers[p];
console.log('provider:', p);
console.log('baseUrl:', prov.baseUrl);
console.log('apiKey length:', (prov.apiKey||'').length);
console.log('models:', prov.models.map(x=>x.id).join(', '));
"

  msg "Verifying cluster access..."
  kubectl exec -n "$NAMESPACE" "deploy/gsd-$RELEASE" -- \
    kubectl get nodes --no-headers 2>&1 | awk '{print $1, $2}' | head -5

  msg "Done"
}

# ─── down (safe stop) ────────────────────────────────────────────────────────
cmd_down() {
  local helm_ns; helm_ns="$(resolve_helm_namespace)"
  if [ -z "$helm_ns" ]; then
    msg "Release '$RELEASE' is not installed — nothing to do."
    return 0
  fi

  msg "Stopping $RELEASE in namespace $helm_ns"
  msg "  • Deployment, secrets, RBAC will be removed."
  msg "  • PVC ($PVC_NAME) will be PRESERVED — home directory survives."
  msg "  • Namespace ($helm_ns) will be PRESERVED."

  helm uninstall "$RELEASE" -n "$helm_ns"

  # Confirm PVC survived (resource-policy: keep should have done this)
  if kubectl get pvc "$PVC_NAME" -n "$helm_ns" &>/dev/null; then
    msg "✓ PVC preserved: $PVC_NAME in $helm_ns"
  else
    warn "PVC $PVC_NAME no longer exists in $helm_ns. Data may be lost."
    warn "Check helm.sh/resource-policy annotation on the PVC template."
  fi

  msg "Down. Run './deploy-salesanalyzer.sh up' to bring it back."
}

# ─── nuke (destructive, requires confirmation) ───────────────────────────────
cmd_nuke() {
  local helm_ns; helm_ns="$(resolve_helm_namespace)"
  helm_ns="${helm_ns:-$NAMESPACE}"

  echo
  warn "This will PERMANENTLY DELETE:"
  warn "  • Helm release: $RELEASE (in $helm_ns)"
  warn "  • PVC: $PVC_NAME (the home directory — all session state, models, repo, etc.)"
  warn "  • Namespace: $NAMESPACE (if no other resources remain)"
  warn ""
  warn "The underlying GCE persistent disk will also be deleted (reclaimPolicy: Delete)."
  warn "This action is NOT reversible."
  echo
  printf "Type the project name '%s' to confirm: " "$RELEASE"
  read -r confirmation
  if [ "$confirmation" != "$RELEASE" ]; then
    die "Confirmation mismatch — aborting. Nothing was deleted."
  fi

  # 1. Helm uninstall (workload, secrets, RBAC). PVC has resource-policy: keep
  #    so helm will leave it; we delete it explicitly next.
  if helm status "$RELEASE" -n "$helm_ns" &>/dev/null; then
    msg "Removing helm release..."
    helm uninstall "$RELEASE" -n "$helm_ns"
  fi

  # 2. Delete the PVC (this triggers PV deletion under reclaimPolicy: Delete)
  if kubectl get pvc "$PVC_NAME" -n "$helm_ns" &>/dev/null; then
    msg "Deleting PVC $PVC_NAME (this destroys the underlying disk)..."
    kubectl delete pvc "$PVC_NAME" -n "$helm_ns"
  fi

  # 3. Delete the namespace if nothing else lives in it
  if kubectl get namespace "$helm_ns" &>/dev/null; then
    local remaining
    remaining=$(kubectl get all,pvc,secret,configmap -n "$helm_ns" \
      --no-headers 2>/dev/null \
      | grep -vE '^(NAME|kubernetes|default-token|kube-root-ca\.crt)' \
      | wc -l | tr -d ' ')
    if [ "$remaining" = "0" ]; then
      msg "Deleting empty namespace $helm_ns..."
      kubectl delete namespace "$helm_ns"
    else
      warn "Namespace $helm_ns still has $remaining resources — leaving it intact."
      warn "Delete it manually if you really want it gone: kubectl delete namespace $helm_ns"
    fi
  fi

  msg "Nuke complete."
}

# ─── Dispatch ────────────────────────────────────────────────────────────────
case "$CMD" in
  up|install|upgrade|"") cmd_up ;;
  down|stop)             cmd_down ;;
  nuke|destroy)          cmd_nuke ;;
  status)                cmd_status ;;
  -h|--help|help)
    sed -n '2,20p' "$0"
    ;;
  *)
    die "Unknown command: $CMD. Run with --help for usage."
    ;;
esac
