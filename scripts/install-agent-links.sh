#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
timestamp="$(date +%Y%m%d%H%M%S)"

codex_home="${CODEX_HOME:-$HOME/.codex}"
claude_home="${CLAUDE_HOME:-$HOME/.claude}"

link_path() {
  local source_path="$1"
  local target_path="$2"

  mkdir -p "$(dirname "$target_path")"

  if [ -L "$target_path" ]; then
    local current_target
    current_target="$(readlink "$target_path")"
    if [ "$current_target" = "$source_path" ]; then
      echo "Already linked: $target_path -> $source_path"
      return
    fi
    rm "$target_path"
  elif [ -e "$target_path" ]; then
    local backup_path="${target_path}.bak.${timestamp}"
    mv "$target_path" "$backup_path"
    echo "Backed up existing path: $backup_path"
  fi

  ln -s "$source_path" "$target_path"
  echo "Linked: $target_path -> $source_path"
}

link_path "$repo_root/agents/claude/camofox.md" "$claude_home/agents/camofox.md"
link_path "$repo_root/agents/codex/camofox-browser" "$codex_home/skills/camofox-browser"
