"""Runs a command on a pseudo-terminal that it holds as its controlling terminal, and answers its question.

usage: python3 pty-drive.py <action> <question> <program> [args...]

<action> is `answer:<text>` (writes <text> and a line feed once <question> has appeared) or `hangup`
(closes the terminal once <question> has appeared). The driver then waits for the program to end, at
most WAIT_SECONDS, and prints one JSON line: {"output", "asked", "exit", "signal", "timedOut"}, where
`output` is everything the program wrote to the terminal (decoded as UTF-8, invalid bytes replaced).
When <question> never appears, neither action is taken: the driver kills the program and reports
`asked: false` and `timedOut: true`.
`usage: python3 pty-drive.py --probe` only checks that a pseudo-terminal can be created.
"""
import json
import os
import pty
import select
import signal
import sys
import time

WAIT_SECONDS = 10
QUESTION_SECONDS = 30


def read_some(fd, timeout):
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return b''
    try:
        return os.read(fd, 4096)
    except OSError:
        return None


def wait_for(pid, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            return status
        time.sleep(0.05)
    return None


def main(argv):
    if argv == ['--probe']:
        pid, fd = pty.fork()
        if pid == 0:
            os._exit(0)
        os.close(fd)
        status = wait_for(pid, WAIT_SECONDS)
        return 0 if status is not None and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 else 1

    action, question, program = argv[0], argv[1].encode('utf-8'), argv[2:]
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execv(program[0], program)
        finally:
            os._exit(127)

    output = b''
    asked = False
    deadline = time.monotonic() + QUESTION_SECONDS
    while not asked and time.monotonic() < deadline:
        chunk = read_some(fd, 0.1)
        if chunk is None:
            break
        output += chunk
        asked = question in output

    open_fd = fd
    if asked and action.startswith('answer:'):
        os.write(fd, action[len('answer:'):].encode('utf-8') + b'\n')
    elif asked and action == 'hangup':
        os.close(fd)
        open_fd = None

    # Without the question there is nothing to answer or hang up on: the program is killed below.
    end = time.monotonic() + (WAIT_SECONDS if asked else 0)
    status = None
    while time.monotonic() < end:
        if open_fd is not None:
            chunk = read_some(open_fd, 0.05)
            if chunk:
                output += chunk
        done, st = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            status = st
            break
        if open_fd is None:
            time.sleep(0.05)
    if status is not None and open_fd is not None:
        while True:
            chunk = read_some(open_fd, 0.05)
            if not chunk:
                break
            output += chunk

    timed_out = status is None or not asked
    if status is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        status = os.waitpid(pid, 0)[1]
    if open_fd is not None:
        os.close(open_fd)

    report = {
        'output': output.decode('utf-8', 'replace'),
        'asked': asked,
        'exit': os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
        'signal': os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
        'timedOut': timed_out,
    }
    sys.stdout.write(json.dumps(report) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
