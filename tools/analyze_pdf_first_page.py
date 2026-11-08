"""Analyze the first page of a PDF stored on Google Drive (G:\\My Drive).

Usage:
    python analyze_pdf_first_page.py "G:\\My Drive\\Docs\\file.pdf"
    python analyze_pdf_first_page.py "G:\\My Drive\\Docs\\file.pdf" --chars 2000 --json

Requires: pip install pypdf
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import IndirectObject

PDF_SIGNATURE = b"%PDF-"

# Reference paper sizes in points (1 pt = 1/72 inch), as (short side, long side).
PAPER_SIZES_PT: dict[str, tuple[float, float]] = {
    "A5": (419.53, 595.28),
    "A4": (595.28, 841.89),
    "A3": (841.89, 1190.55),
    "Letter": (612.0, 792.0),
    "Legal": (612.0, 1008.0),
}
SIZE_TOLERANCE_PT = 3.0

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE_RE = re.compile(r"(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}")
DATE_RE = re.compile(r"\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b")
AMOUNT_RE = re.compile(
    r"(?:[$€£¥]|CAD|USD|EUR)\s?\d[\d,.\s]*\d|\d[\d,.\s]*\d\s?(?:[$€£¥]|CAD|USD|EUR)"
)
FRENCH_HINTS = (" le ", " la ", " les ", " des ", " et ", " pour ", " dans ", " est ")
ENGLISH_HINTS = (" the ", " and ", " for ", " with ", " is ", " of ", " to ")


@dataclass
class FirstPageAnalysis:
    file: str
    file_size_bytes: int
    pdf_version: str
    total_pages: int
    encrypted: bool
    metadata: dict[str, str] = field(default_factory=dict)
    page_width_pt: float = 0.0
    page_height_pt: float = 0.0
    page_size_label: str = ""
    orientation: str = ""
    rotation_degrees: int = 0
    has_text: bool = False
    char_count: int = 0
    word_count: int = 0
    line_count: int = 0
    image_count: int = 0
    annotation_count: int = 0
    link_count: int = 0
    fonts: list[str] = field(default_factory=list)
    language_guess: str = ""
    emails: list[str] = field(default_factory=list)
    phone_numbers: list[str] = field(default_factory=list)
    dates: list[str] = field(default_factory=list)
    amounts: list[str] = field(default_factory=list)
    text_preview: str = ""


def check_signature(path: Path) -> None:
    with path.open("rb") as fh:
        header = fh.read(1024)
    if PDF_SIGNATURE not in header:
        raise ValueError("file is not a PDF (missing %PDF- signature)")


def describe_size(width: float, height: float) -> tuple[str, str]:
    """Return a paper size label (or 'Custom') and the page orientation."""
    short, long_ = sorted((width, height))
    label = "Custom"
    for name, (ref_short, ref_long) in PAPER_SIZES_PT.items():
        if (
            abs(short - ref_short) <= SIZE_TOLERANCE_PT
            and abs(long_ - ref_long) <= SIZE_TOLERANCE_PT
        ):
            label = name
            break
    if width > height:
        orientation = "landscape"
    elif height > width:
        orientation = "portrait"
    else:
        orientation = "square"
    return label, orientation


def guess_language(text: str) -> str:
    sample = f" {text.lower()} "
    fr = sum(sample.count(h) for h in FRENCH_HINTS)
    en = sum(sample.count(h) for h in ENGLISH_HINTS)
    if fr == 0 and en == 0:
        return "unknown"
    if fr > en * 1.5:
        return "French"
    if en > fr * 1.5:
        return "English"
    return "mixed/unknown"


def unique_limited(matches: list[str], limit: int = 20) -> list[str]:
    seen: dict[str, None] = {}
    for match in matches:
        seen.setdefault(match.strip(), None)
        if len(seen) >= limit:
            break
    return list(seen)


def count_annotations(page) -> tuple[int, int]:
    total = 0
    links = 0
    for ref in page.get("/Annots") or []:
        obj = ref.get_object() if isinstance(ref, IndirectObject) else ref
        total += 1
        if obj.get("/Subtype") == "/Link":
            links += 1
    return total, links


def collect_fonts(page) -> list[str]:
    fonts: set[str] = set()
    font_dict = (page.get("/Resources") or {}).get("/Font") or {}
    for font_ref in font_dict.values():
        font = font_ref.get_object() if isinstance(font_ref, IndirectObject) else font_ref
        base = font.get("/BaseFont")
        if base:
            fonts.add(str(base).lstrip("/"))
    return sorted(fonts)


def analyze_first_page(path: Path, preview_chars: int) -> FirstPageAnalysis:
    check_signature(path)
    reader = PdfReader(str(path))
    if reader.is_encrypted:
        reader.decrypt("")  # Works for owner-password-only files; raises otherwise.
    if not reader.pages:
        raise ValueError("the PDF contains no pages")

    page = reader.pages[0]
    width = float(page.mediabox.width)
    height = float(page.mediabox.height)
    size_label, orientation = describe_size(width, height)

    text = page.extract_text() or ""
    words = text.split()
    lines = [line for line in text.splitlines() if line.strip()]

    metadata = {str(k).lstrip("/"): str(v) for k, v in (reader.metadata or {}).items()}

    try:
        image_count = len(page.images)
    except Exception:  # Some embedded images cannot be decoded; count is best-effort.
        image_count = 0

    annotation_count, link_count = count_annotations(page)

    return FirstPageAnalysis(
        file=str(path),
        file_size_bytes=path.stat().st_size,
        pdf_version=reader.pdf_header.replace("%", ""),
        total_pages=len(reader.pages),
        encrypted=bool(reader.is_encrypted),
        metadata=metadata,
        page_width_pt=round(width, 2),
        page_height_pt=round(height, 2),
        page_size_label=size_label,
        orientation=orientation,
        rotation_degrees=int(page.get("/Rotate", 0)),
        has_text=bool(words),
        char_count=len(text),
        word_count=len(words),
        line_count=len(lines),
        image_count=image_count,
        annotation_count=annotation_count,
        link_count=link_count,
        fonts=collect_fonts(page),
        language_guess=guess_language(text),
        emails=unique_limited(EMAIL_RE.findall(text)),
        phone_numbers=unique_limited(PHONE_RE.findall(text)),
        dates=unique_limited(DATE_RE.findall(text)),
        amounts=unique_limited(AMOUNT_RE.findall(text)),
        text_preview=text[:preview_chars].strip(),
    )


def print_report(result: FirstPageAnalysis) -> None:
    print(f"File:            {result.file}")
    print(f"Size:            {result.file_size_bytes / 1024:.1f} KB")
    print(f"PDF version:     {result.pdf_version}")
    print(f"Total pages:     {result.total_pages}")
    print(f"Encrypted:       {result.encrypted}")
    print()
    print("First page")
    print(
        f"  Size:          {result.page_size_label} {result.orientation} "
        f"({result.page_width_pt} x {result.page_height_pt} pt)"
    )
    print(f"  Rotation:      {result.rotation_degrees} deg")
    print(f"  Text layer:    {'yes' if result.has_text else 'no (likely scanned image)'}")
    print(f"  Words/lines:   {result.word_count} / {result.line_count}")
    print(f"  Images:        {result.image_count}")
    print(f"  Annotations:   {result.annotation_count} (links: {result.link_count})")
    print(f"  Fonts:         {', '.join(result.fonts) or 'none'}")
    print(f"  Language:      {result.language_guess}")
    print()
    print("Detected entities")
    print(f"  Emails:        {', '.join(result.emails) or '-'}")
    print(f"  Phone numbers: {', '.join(result.phone_numbers) or '-'}")
    print(f"  Dates:         {', '.join(result.dates) or '-'}")
    print(f"  Amounts:       {', '.join(result.amounts) or '-'}")
    if result.metadata:
        print()
        print("Metadata")
        for key, value in result.metadata.items():
            print(f"  {key}: {value}")
    print()
    print("Text preview")
    print(result.text_preview or "(no extractable text)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze the first page of a PDF.")
    parser.add_argument("pdf", type=Path, help='Path to the PDF, e.g. "G:\\My Drive\\file.pdf"')
    parser.add_argument("--chars", type=int, default=800, help="Text preview length (default 800)")
    parser.add_argument("--json", action="store_true", help="Output JSON instead of a text report")
    args = parser.parse_args()

    if not args.pdf.is_file():
        print(f"Error: file not found: {args.pdf}", file=sys.stderr)
        return 1

    try:
        result = analyze_first_page(args.pdf, args.chars)
    except Exception as exc:  # Report any parse failure without a stack trace.
        print(f"Error: could not analyze '{args.pdf.name}': {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(asdict(result), indent=2, ensure_ascii=False))
    else:
        print_report(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
