default:
    @just --list

# Base64-encode dev-values.yaml and copy it to the clipboard (macOS pbcopy) --
# paste as the DEV_VALUES_YAML Gitea Actions secret (software-engineer-vinokurov/dives
# -> Settings -> Actions -> Secrets). dev-values.yaml carries real secrets
# (email_host_password, DIVES_ADMIN_PASSWORD) so it's .gitignore'd -- the CI
# checkout never has it, .gitea/workflows/deploy.yml decodes this secret back
# to dev-values.yaml before running helm upgrade (same pattern idea-146/birds
# use, see pumpking/changelog/2026-08-06-onboard-idea-146-gitea-actions.md).
dev-values-secret:
    #!/usr/bin/env bash
    set -euo pipefail
    base64 < dev-values.yaml | tr -d '\n' | pbcopy
    echo "Copied base64-encoded dev-values.yaml to clipboard."
    echo "Paste as the DEV_VALUES_YAML secret (repo -> Settings -> Actions -> Secrets)."
