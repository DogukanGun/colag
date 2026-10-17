"""Answer from a folder of documents, or say nothing.

A citation is kept only when dropping that file would make the answer impossible.
A file that cannot be read is not a source.
"""

from __future__ import annotations

import csv
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ALLOWED = {".pdf", ".docx", ".xlsx", ".csv", ".txt", ".log", ".py", ".png", ".jpg", ".jpeg"}
STOP = {
    "what", "which", "when", "where", "who", "how", "many", "does", "did", "the",
    "of", "a", "an", "in", "on", "at", "to", "for", "and", "or", "is", "are",
    "was", "were", "be", "by", "from", "that", "this", "with", "into", "it",
    "its", "as", "show", "shows", "shown",
}

NUMBER = re.compile(r"(?<![A-Za-z0-9-])\d{1,4}(?![A-Za-z0-9-])")
PATTERNS = {
    "quarter": re.compile(r"Q[1-4]\s*FY\s*\d{2}", re.I),
    "part": re.compile(r"\b[A-Z]{2,}(?:-[A-Z0-9]+){2,}\b"),
    "version": re.compile(r"\b\d+\.\d+\.\d+\b"),
    "error": re.compile(r"\bE\d{3,}\b"),
    "pin": re.compile(r"\b[A-Z]\d{1,3}\b"),
    "revision": re.compile(r"\bREV-[A-Z0-9]+\b", re.I),
    "temperature": NUMBER,
    "price": NUMBER,
    "timeout": NUMBER,
    "number": NUMBER,
}
ANCHORS = {
    "quarter": ["sampling", "quarter"],
    "part": ["fan", "part", "assembly"],
    "version": ["firmware", "version", "fixed", "release"],
    "error": ["error", "throttle"],
    "pin": ["alert", "therm", "pin"],
    "revision": ["board", "revision"],
    "temperature": ["temperature", "junction"],
    "price": ["price", "cost"],
    "timeout": ["timeout", "seconds", "batch"],
    "number": ["days", "within"],
}
IDENT = re.compile(r"\b(?:[A-Z]{2,}-\d+|[A-Z]\d{3,})\b")


def intent_of(query: str) -> str:
    q = query.lower()
    if "quarter" in q or "sampling" in q:
        return "quarter"
    if "part number" in q or "fan" in q:
        return "part"
    if "firmware" in q or "version" in q:
        return "version"
    if "error code" in q:
        return "error"
    if "pin" in q:
        return "pin"
    if "revision" in q:
        return "revision"
    if "temperature" in q or "junction" in q:
        return "temperature"
    if "price" in q or "cost" in q:
        return "price"
    if "timeout" in q or "seconds" in q:
        return "timeout"
    return "number"


def tokens(text: str) -> set[str]:
    return {
        word
        for word in re.findall(r"[a-z0-9]+", text.lower())
        if word not in STOP and len(word) > 1
    }


def _pdf_text(raw: bytes) -> str:
    if b"/Encrypt" in raw[:65536]:
        raise PermissionError("encrypted")
    parts = re.findall(rb"\((?:\\.|[^\\)])*\)", raw)
    out = []
    for part in parts:
        piece = part[1:-1].replace(b"\\(", b"(").replace(b"\\)", b")")
        out.append(piece.decode("latin1", "ignore"))
    return "\n".join(out)


def _docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml")
    root = ET.fromstring(xml)
    return " ".join("".join(node.itertext()) for node in root.iter() if node.tag.endswith("}t") or node.tag == "t")


def _xlsx_text(path: Path) -> str:
    rows: list[str] = []
    with zipfile.ZipFile(path) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for node in root.iter():
                if node.tag.endswith("}t") or node.tag == "t":
                    shared.append("".join(node.itertext()))
        for name in archive.namelist():
            if not name.startswith("xl/worksheets/"):
                continue
            sheet = ET.fromstring(archive.read(name))
            for cell in sheet.iter():
                if not (cell.tag.endswith("}c") or cell.tag == "c"):
                    continue
                kind = cell.attrib.get("t")
                value = next((child for child in cell if child.tag.endswith("}v") or child.tag == "v"), None)
                inline = "".join(cell.itertext())
                if kind == "s" and value is not None and value.text and value.text.isdigit():
                    index = int(value.text)
                    if index < len(shared):
                        rows.append(shared[index])
                elif value is not None and value.text:
                    rows.append(value.text)
                elif inline:
                    rows.append(inline)
    return "\n".join(rows)


def _image_text(path: Path) -> str:
    import shutil
    import subprocess

    if not shutil.which("tesseract"):
        return ""
    result = subprocess.run(
        ["tesseract", str(path), "stdout", "--psm", "6"],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    return result.stdout or ""


def read_file(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return _pdf_text(path.read_bytes())
    if suffix == ".docx":
        return _docx_text(path)
    if suffix == ".xlsx":
        return _xlsx_text(path)
    if suffix == ".csv":
        with path.open(newline="", encoding="utf-8", errors="ignore") as handle:
            return "\n".join(" ".join(row) for row in csv.reader(handle))
    if suffix in {".png", ".jpg", ".jpeg"}:
        return _image_text(path)
    return path.read_text(encoding="utf-8", errors="ignore")


def walk_corpus(corpus: Path) -> list[dict]:
    docs = []
    for dirpath, _dirs, names in os.walk(corpus):
        for name in names:
            path = Path(dirpath) / name
            if path.suffix.lower() not in ALLOWED:
                continue
            if "WITHDRAWN" in path.name.upper():
                continue
            relative = path.relative_to(corpus).as_posix()
            try:
                text = read_file(path)
            except (OSError, zipfile.BadZipFile, ET.ParseError, PermissionError, ValueError):
                continue
            if text.strip():
                docs.append({"path": relative, "text": text, "tokens": tokens(text)})
    return docs


def _clean(value: str, kind: str) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    if kind == "quarter":
        match = re.search(r"Q([1-4])\s*FY\s*(\d{2})", value, re.I)
        if match:
            return f"Q{match.group(1)} FY{match.group(2)}"
    if kind == "revision":
        return value.upper()
    return value


def _placement(text: str, start: int, anchors: list[str]) -> tuple[int, int] | None:
    low = text.lower()
    followed = None
    preceded = None
    for anchor in anchors:
        anchor = anchor.lower()
        at = 0
        while True:
            found = low.find(anchor, at)
            if found < 0:
                break
            if found + len(anchor) <= start:
                distance = start - (found + len(anchor))
                if distance <= 64 and (followed is None or distance < followed):
                    followed = distance
            elif found >= start:
                distance = found - start
                if distance <= 32 and (preceded is None or distance < preceded):
                    preceded = distance
            at = found + len(anchor)
    if followed is not None:
        return (0, followed)
    if preceded is not None:
        return (1, preceded)
    return None


def _hits(text: str, kind: str, anchors: list[str]) -> list[tuple[tuple[int, int], str, str]]:
    found = []
    for match in PATTERNS[kind].finditer(text):
        place = _placement(text, match.start(), anchors)
        if place is None:
            continue
        window = text[max(0, match.start() - 80) : match.end() + 80]
        ident = " ".join(IDENT.findall(window))
        found.append((place, _clean(match.group(), "quarter" if kind == "quarter" else kind), ident))
    return found


def answer(docs: list[dict], query: str) -> dict:
    kind = intent_of(query)
    query_tokens = tokens(query)
    extra = IDENT.findall(query) if kind in {"version", "error", "part"} else []
    anchors = ANCHORS.get(kind, []) + extra
    ranked = sorted(
        docs,
        key=lambda doc: len(query_tokens & doc["tokens"]),
        reverse=True,
    )
    best: tuple[tuple[int, int], str, str] | None = None
    for doc in ranked:
        for place, value, _ident in _hits(doc["text"], kind, anchors):
            if best is None or place < best[0]:
                best = (place, value, doc["path"])
    bridge = _bridge(ranked, query, kind, anchors)

    def overlap(path: str) -> int:
        doc = next((item for item in ranked if item["path"] == path), None)
        return len(query_tokens & doc["tokens"]) if doc else 0

    if bridge and (best is None or overlap(bridge[1]) > overlap(best[2])):
        return {
            "answer": bridge[0],
            "citations": sorted({bridge[1], bridge[2]}),
            "confidence": 0.8,
        }
    if best:
        return {"answer": best[1], "citations": [best[2]], "confidence": 0.9}
    return {"answer": "", "citations": [], "confidence": 0.0}


def _bridge(docs: list[dict], query: str, kind: str, anchors: list[str]):
    """Follow an identifier the question does not already name."""
    if kind not in {"version", "error", "number", "part", "timeout"}:
        return None
    query_tokens = tokens(query)
    for source in docs:
        if len(query_tokens & source["tokens"]) == 0:
            continue
        for ident in IDENT.findall(source["text"]):
            if ident.lower() in query.lower():
                continue
            for doc in docs:
                if doc["path"] == source["path"] or ident not in doc["text"]:
                    continue
                hits = _hits(doc["text"], kind, anchors + [ident])
                if hits:
                    hits.sort()
                    return hits[0][1], source["path"], doc["path"]
    return None


def ask(corpus: str, query: str) -> dict:
    return answer(walk_corpus(Path(corpus)), query)
