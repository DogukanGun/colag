#!/usr/bin/env python3
"""Build the sample corpus shape and check the ten published questions."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from cite import ask

QUESTIONS = [
    ("What is the maximum junction temperature of the TQ-40?", "94", ["specs/tq40_datasheet_r2.pdf"]),
    ("In which quarter does the TQ-60 enter customer sampling?", "Q3 FY27", ["planning/roadmap_fy27.docx"]),
    ("What is the part number of the field-replaceable fan assembly for the TQ-40?", "ORR-FAN-2214-B", ["support/rma_parts.xlsx"]),
    ("Which firmware version fixed ticket ORR-1847?", "4.3.2", ["support/bug_database.csv"]),
    ("What error code is logged when the thermal throttle engages?", "E7731", ["logs/prod_inference_2026-09-02.log"]),
    ("What is the default batch timeout, in seconds, in the ingest service?", "180", ["engineering/ingest_service.py"]),
    ("Which backplane pin carries THERM_ALERT# on the TQ-40?", "B14", ["specs/backplane_pinout.png"]),
    ("What board revision is printed on the asset label?", "REV-C2", ["support/asset_label.jpg"]),
    (
        "The production log shows a thermal throttle incident. Which firmware release fixed the underlying defect?",
        "4.3.2",
        ["logs/prod_inference_2026-09-02.log", "support/bug_database.csv"],
    ),
    ("What is the unit price of the TQ-40 at 10,000 unit volume?", "", []),
]


def pdf(path: Path, text: str, encrypt: bool = False) -> None:
    safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 72 700 Td ({safe}) Tj ET".encode()
    body = b"%PDF-1.4\n"
    if encrypt:
        body += b"1 0 obj << /Encrypt 2 0 R >> endobj\n"
    body += b"<< /Length %d >>\nstream\n" % len(stream)
    body += stream + b"\nendstream\n"
    path.write_bytes(body)


def docx(path: Path, text: str) -> None:
    xml = (
        '<?xml version="1.0"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", xml)


def xlsx(path: Path, rows: list[list[str]]) -> None:
    cells = []
    for r, row in enumerate(rows, start=1):
        for c, value in enumerate(row):
            letter = chr(ord("A") + c)
            cells.append(f'<c r="{letter}{r}" t="inlineStr"><is><t>{value}</t></is></c>')
    sheet = (
        '<?xml version="1.0"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData><row>{''.join(cells)}</row></sheetData></worksheet>"
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/worksheets/sheet1.xml", sheet)


def label(path: Path, text: str) -> None:
    image = Image.new("RGB", (900, 220), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 64)
    draw.text((24, 70), text, fill="black", font=font)
    image.save(path)


def build(root: Path) -> None:
    (root / "archive").mkdir()
    (root / "engineering").mkdir()
    (root / "logs").mkdir()
    (root / "planning").mkdir()
    (root / "specs").mkdir()
    (root / "support").mkdir()
    (root / "vendor").mkdir()
    pdf(
        root / "specs/tq40_datasheet_r2.pdf",
        "TQ-40 datasheet revision 2. Maximum junction temperature of the TQ-40 is 94 C.",
    )
    pdf(
        root / "specs/tq40_datasheet_r1_WITHDRAWN.pdf",
        "TQ-40 withdrawn datasheet. Maximum junction temperature of the TQ-40 is 105 C.",
    )
    docx(root / "planning/roadmap_fy27.docx", "The TQ-60 enters customer sampling in Q3 FY27.")
    xlsx(
        root / "support/rma_parts.xlsx",
        [["assembly", "part"], ["TQ-40 field-replaceable fan assembly", "ORR-FAN-2214-B"]],
    )
    (root / "support/bug_database.csv").write_text("ticket,resolution\nORR-1847,4.3.2\n", encoding="utf-8")
    (root / "logs/prod_inference_2026-09-02.log").write_text(
        "thermal throttle engaged error E7731 ticket ORR-1847\n",
        encoding="utf-8",
    )
    (root / "engineering/ingest_service.py").write_text(
        "DEFAULT_BATCH_TIMEOUT = 180  # seconds\n",
        encoding="utf-8",
    )
    label(root / "specs/backplane_pinout.png", "THERM ALERT B14")
    label(root / "support/asset_label.jpg", "BOARD REV-C2")
    pdf(root / "vendor/supplier_agreement_ENCRYPTED.pdf", "unit price at 10000 units is 12.50", encrypt=True)
    (root / "vendor/telemetry_capture.dat").write_text("unit price 12.50\n", encoding="utf-8")
    secret = root / "vendor/internal_audit.txt"
    secret.write_text("unit price of the TQ-40 at 10000 is 12.50\n", encoding="utf-8")
    os.chmod(secret, 0)


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build(root)
        failed = 0
        for query, expected, citations in QUESTIONS:
            got = ask(str(root), query)
            ok = got["answer"] == expected and sorted(got["citations"]) == sorted(citations)
            if not ok:
                failed += 1
                print("FAIL", query)
                print(" expected", expected, citations)
                print(" got     ", got["answer"], got["citations"])
        client = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("app.py")), "--corpus", str(root), "--query-id", "query_10", "--query", QUESTIONS[-1][0], "--stdout"],
            check=False,
            capture_output=True,
            text=True,
        )
        if client.returncode != 0 or '"answer": ""' not in client.stdout.replace(" ", ""):
            # spacing in json may vary; parse properly below
            pass
        import json
        try:
            payload = json.loads(client.stdout)
        except json.JSONDecodeError:
            payload = None
        if payload != {"answer": "", "citations": [], "confidence": 0.0} and not (
            payload and payload.get("answer") == "" and payload.get("citations") == []
        ):
            failed += 1
            print("FAIL stdout client", client.stdout, client.stderr)
        os.chmod(root / "vendor/internal_audit.txt", stat.S_IRUSR | stat.S_IWUSR)
        if failed:
            raise SystemExit(1)
        print(f"ok {len(QUESTIONS)} questions")


if __name__ == "__main__":
    main()
