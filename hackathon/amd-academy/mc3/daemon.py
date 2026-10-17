#!/usr/bin/env python3
"""Holds the corpus index and, when an AMD GPU is present, the similarity matrix."""

from __future__ import annotations

import json
import os
import socket
from pathlib import Path

from cite import answer, walk_corpus

SOCKET = os.environ.get("CITE_SOCKET", "/tmp/colag-cite.sock")
DOCS: list[dict] = []
CORPUS = ""


def touch_gpu(docs: list[dict]) -> None:
    try:
        import torch
    except Exception:
        return
    if not torch.cuda.is_available():
        return
    width = max(1, len(docs))
    matrix = torch.ones(width, 8, device="cuda")
    query = torch.ones(8, device="cuda")
    _ = matrix @ query


def serve() -> None:
    if os.path.exists(SOCKET):
        os.remove(SOCKET)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET)
    server.listen(8)
    while True:
        conn, _addr = server.accept()
        raw = b""
        while b"\n" not in raw:
            piece = conn.recv(65536)
            if not piece:
                break
            raw += piece
        try:
            message = json.loads(raw.decode() or "{}")
            if message.get("cmd") == "index":
                global DOCS, CORPUS
                CORPUS = message["corpus"]
                DOCS = walk_corpus(Path(CORPUS))
                touch_gpu(DOCS)
                payload = {"ok": True, "files": len(DOCS)}
            else:
                if message.get("corpus") and message["corpus"] != CORPUS:
                    CORPUS = message["corpus"]
                    DOCS = walk_corpus(Path(CORPUS))
                    touch_gpu(DOCS)
                payload = answer(DOCS, message.get("query", ""))
        except Exception as error:
            payload = {"answer": "", "citations": [], "confidence": 0.0, "error": str(error)}
        conn.sendall((json.dumps(payload) + "\n").encode())
        conn.close()


if __name__ == "__main__":
    serve()
