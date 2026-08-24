#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# fix-cline-shell.sh  (Core-Termux / DevCoreX compatible)
#
# Repairs Cline's local command runner on Core-Termux so it stops failing with:
#   Failed to execute command: ENOENT: no such file or directory,
#   posix_spawn '/bin/bash'
#
# Root cause: the platform's command runner spawns /bin/bash literally, but on
# Android/Core-Termux bash lives at $PREFIX/bin/bash
# (/data/data/com.termux/files/usr/bin/bash). /bin is read-only at the root
# filesystem, and $PREFIX is usually not present on the parent process's PATH.
#
# This script:
#   1. Verifies bash exists at $PREFIX/bin/bash (re-installs if missing).
#   2. Ensures SHELL + PREFIX + PATH are exported in the files Core-Termux
#      actually loads (~/.zshrc if present, else ~/.bashrc, plus ~/.profile).
#   3. (Optional, advanced) exposes /bin/bash inside a chroot/proot root so a
#      runner that hardcodes /bin/bash can spawn it.
# =============================================================================
set -u

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
REAL_BASH="$PREFIX/bin/bash"
HOME_DIR="${HOME:-/data/data/com.termux/files/home}"

echo "==> Prefix        : $PREFIX"
echo "==> Real bash     : $REAL_BASH"

# 1) Bash must exist and be executable.
if [ -x "$REAL_BASH" ]; then
  echo "==> bash present : $("$REAL_BASH" --version | head -n1)"
else
  echo "!! '$REAL_BASH' missing. Reinstalling bash..."
  pkg reinstall -y bash || pkg install -y bash
fi
if ! [ -x "$REAL_BASH" ]; then
  echo "!! Could not restore bash at '$REAL_BASH'. Aborting." >&2
  exit 1
fi

# 2) Export for any child process we launch from here.
export SHELL="$REAL_BASH"
export PREFIX
export PATH="$PREFIX/bin:$PREFIX/bin/applets:${PATH:-}"
export BASH_ENV="$HOME_DIR/.bashrc"

# 3) Persist in the rc files Core-Termux actually loads. ZSH is Core-Termux's
#    default interactive shell, so .zshrc comes first (mirrors core env).
rc_files=("$HOME_DIR/.zshrc" "$HOME_DIR/.bashrc" "$HOME_DIR/.profile")
for f in "${rc_files[@]}"; do
  [ -f "$f" ] || continue
  grep -q '^export PREFIX=' "$f" || echo "export PREFIX=$PREFIX" >> "$f"
  grep -q '^export SHELL=' "$f" || echo "export SHELL=$REAL_BASH" >> "$f"
  grep -q "^export PATH=.*\b$HOME_DIR/core/bin\b" "$f" || {
    # add default prefix PATH only if the file has no explicit PATH override yet
    grep -q '^export PATH=' "$f" || echo "export PATH=\"$PREFIX/bin:\$PREFIX/bin/applets:\$HOME/core/bin:\$PATH\"" >> "$f"
  }
  echo "   updated: $f"
done

# 4) Advanced: expose /bin/bash inside an isolated root for hardcoded runners.
echo
echo "NOTE: if your platform runner still hardcodes /bin/bash (posix_spawn),"
echo "      this file on Android cannot be written (root / is read-only)."
echo "      Relaunch Cline with SHELL exported, or run it under"
echo "      'termux-chroot' / 'proot' so its /bin maps to $PREFIX/bin."
echo
echo "OK. Now RESTART Cline and verify with:  echo \"\$SHELL\"  ||  which bash"

