"""Disposable network-isolated CKB devnet, never the user's testnet node."""

import http.client
import hashlib
import io
import json
import re
import subprocess
import tarfile
import time
import tempfile
from pathlib import Path
import warnings

IMAGE = (
    "nervos/ckb@sha256:4d6e113b4e95d5b4802e36b9199c585666c0e66ff400b398f3117f36d4f304f8"
)
RPC_TRANSPORT = r"""
export LC_ALL=C
IFS= read -r request
exec 3<>/dev/tcp/127.0.0.1/8114
printf 'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: %s\r\n\r\n%s' "${#request}" "$request" >&3
cat <&3
"""


class DockerError(subprocess.CalledProcessError):
    def __str__(self):
        return f"{super().__str__()}: {self.stderr.decode(errors='replace')}"


def docker(*args, data=None, timeout=30):
    result = subprocess.run(
        ["docker", *args], input=data, capture_output=True, check=False, timeout=timeout
    )
    if result.returncode:
        raise DockerError(result.returncode, result.args, result.stdout, result.stderr)
    return result.stdout


class _ResponseSocket:
    def __init__(self, wire: bytes):
        self.wire = wire

    def makefile(self, _mode):
        return io.BytesIO(self.wire)


def decode_response(wire: bytes) -> dict:
    response = http.client.HTTPResponse(_ResponseSocket(wire))
    response.begin()
    if response.status != 200:
        raise RuntimeError(f"RPC HTTP status {response.status}")
    return json.loads(response.read())


class IsolatedNode:
    """Own exactly one disposable container; no configurable external RPC URL."""

    def __init__(self, branch="first", *, daowow=False):
        if branch not in ("first", "second"):
            raise ValueError("Unknown isolated fixture branch")
        self.branch = branch
        self.daowow = daowow
        self.protocol_codes = {}
        self.container_id = None
        self._cid_directory = None
        self._cid_file = None

    def __enter__(self):
        self._cid_directory = tempfile.TemporaryDirectory(prefix="daowow-node-id-")
        self._cid_file = Path(self._cid_directory.name) / "container.id"
        try:
            return self._start()
        except BaseException:
            try:
                self.close()
            except Exception as cleanup_error:
                warnings.warn(
                    f"Node cleanup failed; retained ID at {self._cid_file}: {cleanup_error}",
                    RuntimeWarning,
                )
            raise

    def _start(self):
        startup = (
            "ckb init -C /tmp --chain dev --genesis-message daowow-isolated-validation-v2 "
            f"--ba-message 0x{('daowow-' + self.branch).encode().hex()} "
            "--ba-arg 0x0000000000000000000000000000000000000000 --log-to stdout "
            "&& mkdir /tmp/daowow-ready && exec sleep infinity"
        )
        identifier = (
            docker(
                "run",
                "-d",
                "--rm",
                "--cidfile",
                str(self._cid_file),
                "--pull",
                "never",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--memory",
                "2g",
                "--cpus",
                "2",
                "--pids-limit",
                "256",
                "--tmpfs",
                "/tmp:rw,nosuid,size=1g",
                "--entrypoint",
                "sh",
                IMAGE,
                "-c",
                startup,
            )
            .decode()
            .strip()
        )
        if not re.fullmatch(r"[0-9a-f]{64}", identifier):
            raise RuntimeError("Docker did not return a container ID")
        self.container_id = identifier
        self.fixture_code = (
            Path(__file__).resolve().parents[2]
            / "target/riscv64imac-unknown-none-elf/release/smoke-minimal"
        ).read_bytes()
        if self.daowow:
            binary_dir = (
                Path(__file__).resolve().parents[2]
                / "target/riscv64imac-unknown-none-elf/release"
            )
            self.protocol_codes = {
                name: (binary_dir / name).read_bytes()
                for name in (
                    "round-type",
                    "entry-shard-type",
                    "entry-lock",
                    "dao-lock",
                    "settlement-type",
                )
            }
        try:
            deadline = time.monotonic() + 15
            while True:
                try:
                    docker(
                        "exec", identifier, "test", "-d", "/tmp/daowow-ready", timeout=3
                    )
                    break
                except subprocess.CalledProcessError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
            # docker cp cannot read this tmpfs on the current daemon. Stream
            # only known configuration files and fixture code into that tmpfs.
            archive_bytes = io.BytesIO()
            with tarfile.open(fileobj=archive_bytes, mode="w") as archive:
                for relative in ["ckb.toml", "specs/dev.toml"]:
                    config = docker(
                        "exec", identifier, "cat", f"/tmp/{relative}"
                    ).decode()
                    if relative == "ckb.toml":
                        config, count = re.subn(
                            r"(modules\s*=\s*\[)",
                            r'\1"IntegrationTest", ',
                            config,
                            count=1,
                        )
                    else:
                        config, count = re.subn(
                            r"max_block_cycles\s*=\s*10_000_000_000",
                            "max_block_cycles = 3_500_000_000",
                            config,
                            count=1,
                        )
                        fixture_hash = hashlib.blake2b(
                            self.fixture_code,
                            digest_size=32,
                            person=b"ckb-default-hash",
                        ).hexdigest()
                        config += (
                            "\n[[genesis.system_cells]]\n"
                            'file = { file = "/tmp/fixture-lock" }\n'
                            "create_type_id = false\ncapacity = 10000000000000\n"
                            "[[genesis.issued_cells]]\ncapacity = 10000000000000\n"
                            f'lock.code_hash = "0x{fixture_hash}"\n'
                            'lock.args = "0x64616f776f772d66697874757265"\n'
                            'lock.hash_type = "data1"\n'
                        )
                        for name, code in self.protocol_codes.items():
                            config += (
                                "\n[[genesis.system_cells]]\n"
                                f'file = {{ file = "/tmp/{name}" }}\n'
                                "create_type_id = false\n"
                                f"capacity = {(len(code) + 100) * 100_000_000}\n"
                            )
                    if count != 1:
                        raise RuntimeError(
                            f"Unexpected generated configuration: {relative}"
                        )
                    data = config.encode()
                    member = tarfile.TarInfo(relative)
                    member.size = len(data)
                    member.mode = 0o600
                    archive.addfile(member, io.BytesIO(data))
                member = tarfile.TarInfo("fixture-lock")
                member.size = len(self.fixture_code)
                member.mode = 0o600
                archive.addfile(member, io.BytesIO(self.fixture_code))
                for name, code in self.protocol_codes.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(code)
                    member.mode = 0o600
                    archive.addfile(member, io.BytesIO(code))
            docker(
                "exec",
                "-i",
                identifier,
                "tar",
                "-x",
                "-C",
                "/tmp",
                data=archive_bytes.getvalue(),
            )
            docker("exec", "-d", identifier, "ckb", "run", "-C", "/tmp")
            deadline = time.monotonic() + 30
            while True:
                try:
                    self.rpc("get_tip_block_number")
                    return self
                except (
                    subprocess.SubprocessError,
                    OSError,
                    ValueError,
                    http.client.HTTPException,
                ):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
        except BaseException:
            raise

    def __exit__(self, _kind, original_error, _traceback):
        try:
            self.close()
        except Exception as cleanup_error:
            if original_error is None:
                raise
            warnings.warn(
                f"Node cleanup failed for {self.container_id}: {cleanup_error}",
                RuntimeWarning,
            )
        return False

    def rpc(self, method, params=None):
        if self.container_id is None:
            raise RuntimeError("Node is not running")
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": [] if params is None else params,
            },
            ensure_ascii=True,
        )
        wire = docker(
            "exec",
            "-i",
            self.container_id,
            "bash",
            "-euc",
            RPC_TRANSPORT,
            data=(request + "\n").encode(),
            timeout=10,
        )
        response = decode_response(wire)
        if "error" in response:
            raise RuntimeError(f"{method}: {response['error']}")
        return response["result"]

    def close(self):
        if (
            self.container_id is None
            and self._cid_file is not None
            and self._cid_file.exists()
        ):
            identifier = self._cid_file.read_text().strip()
            if not re.fullmatch(r"[0-9a-f]{64}", identifier):
                raise RuntimeError("Refusing cleanup of invalid persisted container ID")
            self.container_id = identifier
        if self.container_id is not None:
            try:
                docker("rm", "-f", self.container_id)
            except DockerError as error:
                missing = f"error response from daemon: no such container: {self.container_id}"
                if error.stderr.decode(errors="replace").strip().lower() != missing:
                    raise
            self.container_id = None
        if self._cid_directory is not None:
            self._cid_directory.cleanup()
            self._cid_directory = None
            self._cid_file = None
