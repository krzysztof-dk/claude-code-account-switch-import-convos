#!/bin/sh
# Stand-in for ssh in the CLI tests (CCAS_SSH points here). It skips the
# options and the host ccas passes (see sshArguments in src/ssh-host.ts),
# then runs the script from standard input with the fake host's home
# (CCAS_TEST_HOST_HOME) as HOME, the way ssh runs "sh -s" on a real host.
# It refuses to run without that directory, and when it is the real home, so
# a test can never touch the ~/.claude of the machine it runs on. A host
# name containing "unreachable" fails like a refused connection (exit 255).
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-p|-i) shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
host=${1:-}
if [ -z "${CCAS_TEST_HOST_HOME:-}" ] || [ ! -d "$CCAS_TEST_HOST_HOME" ]; then
  echo "fake-ssh: CCAS_TEST_HOST_HOME is not a directory" >&2
  exit 97
fi
if [ "$CCAS_TEST_HOST_HOME" = "${HOME:-}" ]; then
  echo "fake-ssh: refusing to use the real home directory" >&2
  exit 97
fi
case "$host" in
  *unreachable*)
    echo "ssh: connect to host $host port 22: Connection refused" >&2
    exit 255
    ;;
esac
unset CLAUDE_CONFIG_DIR
HOME=$CCAS_TEST_HOST_HOME exec /bin/sh -s
