#!/usr/bin/env python3
"""Thin client. The daemon holds the index; each question is a new process."""

from __future__ import annotations

import argparse
import json
import os
import socket
from pathlib import Path

from cite import ask

SOCKET = os.environ.get("CITE_SOCKET", "/tmp/colag-cite.sock")


def index_file() -> Path:
    override = os.environ.get("CITE_INDEX")
    if override:
        return Path(override)
    if os.access("/app", os.W_OK):
        return Path("/app/index.json")
    return Path(__file__).with_name(".index.json")


def output_dir() -> Path:
    override = os.environ.get("CITE_OUTPUT")
    directory = Path(override) if override else Path("/app/output")
    if not override and not os.access("/app", os.W_OK):
        directory = Path(__file__).with_name("output")
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def talk(payload: dict) -> dict:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(25)
    client.connect(SOCKET)
    client.sendall((json.dumps(payload) + "\n").encode())
    chunks = []
    while True:
        piece = client.recv(65536)
        if not piece:
            break
        chunks.append(piece)
        if b"\n" in piece:
            break
    client.close()
    return json.loads(b"".join(chunks).decode())


def write_result(query_id: str, result: dict, to_stdout: bool) -> None:
    body = json.dumps(result)
    if to_stdout:
        print(body)
        return
    target = output_dir() / f"{query_id}_output.json"
    target.write_text(body + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", dest="index_path")
    parser.add_argument("--corpus")
    parser.add_argument("--query-id")
    parser.add_argument("--query")
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args()
    if args.index_path:
        try:
            write_result("index", talk({"cmd": "index", "corpus": args.index_path}), False)
        except OSError:
            from cite import walk_corpus

            docs = walk_corpus(Path(args.index_path))
            index_file().write_text(
                json.dumps([{"path": doc["path"], "text": doc["text"]} for doc in docs]),
                encoding="utf-8",
            )
        return
    corpus = args.corpus or args.index_path
    if not args.query_id or args.query is None or not corpus:
        parser.error("--query-id, --query, and --corpus are required")
    try:
        result = talk({"cmd": "ask", "corpus": corpus, "query": args.query})
    except OSError:
        result = ask(corpus, args.query)
    write_result(args.query_id, result, args.stdout)


if __name__ == "__main__":
    main()
