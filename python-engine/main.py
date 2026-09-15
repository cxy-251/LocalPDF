import argparse
import json
import sys
from pathlib import Path

import fitz
from pdf2docx import Converter


def emit(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)


def fail(message: str) -> None:
    emit("error", message=message)
    sys.exit(1)


def require_exists(path: str) -> Path:
    p = Path(path)
    if not p.exists():
        fail(f"input file not found: {path}")
    return p


def convert(input_path: str, output_path: str, start: int | None, end: int | None) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    try:
        cv = Converter(str(src))
        cv.convert(output_path, start=start or 0, end=end)
        cv.close()
    except Exception as exc:
        fail(str(exc))
    emit("done", output=output_path)


def to_images(input_path: str, out_dir: str, fmt: str, dpi: int) -> None:
    src = require_exists(input_path)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    emit("start", input=str(src), output=out_dir)
    doc = fitz.open(str(src))
    outputs = []
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=dpi)
        out_file = str(Path(out_dir) / f"page-{i + 1}.{fmt}")
        pix.save(out_file)
        outputs.append(out_file)
        emit("progress", page=i + 1, total=doc.page_count)
    emit("done", output=out_dir, files=outputs)


def from_images(output_path: str, image_paths: list[str]) -> None:
    for p in image_paths:
        require_exists(p)
    emit("start", output=output_path)
    doc = fitz.open()
    page_w, page_h = 595, 842  # A4 in points
    margin = 24
    frame = fitz.Rect(margin, margin, page_w - margin, page_h - margin)
    for i, img_path in enumerate(image_paths):
        page = doc.new_page(width=page_w, height=page_h)
        page.insert_image(frame, filename=img_path, keep_proportion=True)
        emit("progress", page=i + 1, total=len(image_paths))
    doc.save(output_path)
    emit("done", output=output_path)


def compress(input_path: str, output_path: str) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    before = src.stat().st_size
    doc = fitz.open(str(src))
    doc.save(output_path, garbage=4, deflate=True, clean=True)
    after = Path(output_path).stat().st_size
    emit("done", output=output_path, size_before=before, size_after=after)


def watermark(
    input_path: str,
    output_path: str,
    text: str,
    opacity: float,
    font_size: float,
    angle: float,
) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    doc = fitz.open(str(src))
    matrix = fitz.Matrix(1, 1).prerotate(angle)
    for page in doc:
        center = fitz.Point(page.rect.width / 2, page.rect.height / 2)
        page.insert_text(
            center,
            text,
            fontsize=font_size,
            color=(0.6, 0.6, 0.6),
            fill_opacity=opacity,
            morph=(center, matrix),
        )
    doc.save(output_path)
    emit("done", output=output_path)


def page_numbers(input_path: str, output_path: str, start: int, position: str) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    doc = fitz.open(str(src))
    margin = 24
    for i, page in enumerate(doc):
        label = str(start + i)
        w, h = page.rect.width, page.rect.height
        anchors = {
            "bottom-center": fitz.Point(w / 2, h - margin),
            "bottom-right": fitz.Point(w - margin, h - margin),
            "bottom-left": fitz.Point(margin, h - margin),
        }
        point = anchors.get(position, anchors["bottom-center"])
        page.insert_text(point, label, fontsize=10, color=(0, 0, 0))
    doc.save(output_path)
    emit("done", output=output_path)


def encrypt(input_path: str, output_path: str, user_password: str, owner_password: str | None) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    doc = fitz.open(str(src))
    doc.save(
        output_path,
        encryption=fitz.PDF_ENCRYPT_AES_256,
        user_pw=user_password,
        owner_pw=owner_password or user_password,
    )
    emit("done", output=output_path)


def decrypt(input_path: str, output_path: str, password: str) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    doc = fitz.open(str(src))
    if doc.is_encrypted:
        if not doc.authenticate(password):
            fail("incorrect password")
    doc.save(output_path, encryption=fitz.PDF_ENCRYPT_NONE)
    emit("done", output=output_path)


def redact(input_path: str, output_path: str, regions_json: str) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    try:
        regions = json.loads(regions_json)
    except json.JSONDecodeError as exc:
        fail(f"invalid --regions JSON: {exc}")
        return
    doc = fitz.open(str(src))
    for region in regions:
        page = doc[region["page"]]
        for rect in region["rects"]:
            page.add_redact_annot(fitz.Rect(*rect), fill=(0, 0, 0))
        page.apply_redactions()
    doc.save(output_path)
    emit("done", output=output_path)


def split(input_path: str, out_dir: str, pages_per_file: int) -> None:
    src = require_exists(input_path)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    emit("start", input=str(src), output=out_dir)
    doc = fitz.open(str(src))
    stem = src.stem
    outputs = []
    part = 0
    for start in range(0, doc.page_count, pages_per_file):
        part += 1
        end = min(start + pages_per_file, doc.page_count)
        chunk = fitz.open()
        chunk.insert_pdf(doc, from_page=start, to_page=end - 1)
        out_file = str(Path(out_dir) / f"{stem}-part{part}.pdf")
        chunk.save(out_file)
        outputs.append(out_file)
        emit("progress", page=end, total=doc.page_count)
    emit("done", output=out_dir, files=outputs)


def extract_text(input_path: str, output_path: str) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    doc = fitz.open(str(src))
    parts = [f"--- Page {i + 1} ---\n{page.get_text()}" for i, page in enumerate(doc)]
    Path(output_path).write_text("\n\n".join(parts), encoding="utf-8")
    emit("done", output=output_path)


def extract_images(input_path: str, out_dir: str) -> None:
    src = require_exists(input_path)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    emit("start", input=str(src), output=out_dir)
    doc = fitz.open(str(src))
    seen = set()
    outputs = []
    for page in doc:
        for img in page.get_images(full=True):
            xref = img[0]
            if xref in seen:
                continue
            seen.add(xref)
            info = doc.extract_image(xref)
            out_file = str(Path(out_dir) / f"image-{len(outputs) + 1}.{info['ext']}")
            Path(out_file).write_bytes(info["image"])
            outputs.append(out_file)
    emit("done", output=out_dir, files=outputs)


def get_metadata(input_path: str) -> None:
    src = require_exists(input_path)
    doc = fitz.open(str(src))
    emit("done", metadata=doc.metadata)


def set_metadata(
    input_path: str,
    output_path: str,
    title: str | None,
    author: str | None,
    subject: str | None,
    keywords: str | None,
) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    doc = fitz.open(str(src))
    meta = doc.metadata
    if title is not None:
        meta["title"] = title
    if author is not None:
        meta["author"] = author
    if subject is not None:
        meta["subject"] = subject
    if keywords is not None:
        meta["keywords"] = keywords
    doc.set_metadata(meta)
    doc.save(output_path)
    emit("done", output=output_path)


def get_toc(input_path: str) -> None:
    src = require_exists(input_path)
    doc = fitz.open(str(src))
    emit("done", toc=doc.get_toc())


def set_toc(input_path: str, output_path: str, toc_json: str) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    try:
        toc = json.loads(toc_json)
    except json.JSONDecodeError as exc:
        fail(f"invalid --toc JSON: {exc}")
        return
    doc = fitz.open(str(src))
    doc.set_toc(toc)
    doc.save(output_path)
    emit("done", output=output_path)


def grayscale(input_path: str, output_path: str, dpi: int) -> None:
    """Rasterizes every page to a grayscale image. Text is no longer
    selectable/searchable afterwards — this trades editability for a
    true grayscale result, since PDF content streams mix color models
    that aren't safely convertible in place without a much larger
    color-management effort."""
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    doc = fitz.open(str(src))
    out = fitz.open()
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
        new_page = out.new_page(width=page.rect.width, height=page.rect.height)
        new_page.insert_image(new_page.rect, pixmap=pix)
        emit("progress", page=i + 1, total=doc.page_count)
    out.save(output_path)
    emit("done", output=output_path)


def remove_blank_pages(input_path: str, output_path: str) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    doc = fitz.open(str(src))
    blank = [
        i
        for i, page in enumerate(doc)
        if not page.get_text().strip() and not page.get_images(full=True) and not page.get_drawings()
    ]
    if len(blank) == doc.page_count:
        fail("every page looks blank; refusing to produce an empty PDF")
        return
    doc.delete_pages(blank)
    doc.save(output_path)
    emit("done", output=output_path, removed_pages=[p + 1 for p in blank])


def unify_page_size(input_path: str, output_path: str, width: float, height: float) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    doc = fitz.open(str(src))
    out = fitz.open()
    rect = fitz.Rect(0, 0, width, height)
    for i in range(doc.page_count):
        new_page = out.new_page(width=width, height=height)
        new_page.show_pdf_page(rect, doc, i, keep_proportion=True)
        emit("progress", page=i + 1, total=doc.page_count)
    out.save(output_path)
    emit("done", output=output_path)


def strip_text(input_path: str, output_path: str, text: str) -> None:
    src = require_exists(input_path)
    emit("start", input=str(src), output=output_path)
    doc = fitz.open(str(src))
    removed = 0
    for page in doc:
        hits = page.search_for(text)
        for rect in hits:
            page.add_redact_annot(rect)
        if hits:
            page.apply_redactions()
        removed += len(hits)
    doc.save(output_path)
    emit("done", output=output_path, removed=removed)


def main() -> None:
    parser = argparse.ArgumentParser(prog="pdf-engine")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p = subparsers.add_parser("convert", help="Convert a PDF into an editable Word document")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--start", type=int, default=None, help="0-indexed first page")
    p.add_argument("--end", type=int, default=None, help="0-indexed page to stop before")

    p = subparsers.add_parser("to-images", help="Render each page to an image file")
    p.add_argument("input")
    p.add_argument("out_dir")
    p.add_argument("--format", default="png", choices=["png", "jpg"])
    p.add_argument("--dpi", type=int, default=150)

    p = subparsers.add_parser("from-images", help="Combine images into a new PDF, one per page")
    p.add_argument("output")
    p.add_argument("images", nargs="+")

    p = subparsers.add_parser("compress", help="Shrink a PDF by removing redundant objects and deflating streams")
    p.add_argument("input")
    p.add_argument("output")

    p = subparsers.add_parser("watermark", help="Stamp diagonal text across every page")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--text", required=True)
    p.add_argument("--opacity", type=float, default=0.3)
    p.add_argument("--font-size", type=float, default=40)
    p.add_argument("--angle", type=float, default=45)

    p = subparsers.add_parser("page-numbers", help="Stamp page numbers onto every page")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--start", type=int, default=1)
    p.add_argument("--position", default="bottom-center", choices=["bottom-center", "bottom-left", "bottom-right"])

    p = subparsers.add_parser("encrypt", help="Add password protection")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--user-password", required=True)
    p.add_argument("--owner-password", default=None)

    p = subparsers.add_parser("decrypt", help="Remove password protection (password required)")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--password", required=True)

    p = subparsers.add_parser("redact", help="Permanently blank out regions of content")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--regions", required=True, help='JSON: [{"page": 0, "rects": [[x0,y0,x1,y1]]}]')

    p = subparsers.add_parser("split", help="Split into multiple PDFs, N pages each")
    p.add_argument("input")
    p.add_argument("out_dir")
    p.add_argument("--pages-per-file", type=int, default=1)

    p = subparsers.add_parser("extract-text", help="Extract plain text to a .txt file")
    p.add_argument("input")
    p.add_argument("output")

    p = subparsers.add_parser("extract-images", help="Extract embedded raster images as-is")
    p.add_argument("input")
    p.add_argument("out_dir")

    p = subparsers.add_parser("get-metadata", help="Print document metadata")
    p.add_argument("input")

    p = subparsers.add_parser("set-metadata", help="Edit document metadata")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--title", default=None)
    p.add_argument("--author", default=None)
    p.add_argument("--subject", default=None)
    p.add_argument("--keywords", default=None)

    p = subparsers.add_parser("get-toc", help="Print the table of contents/bookmarks")
    p.add_argument("input")

    p = subparsers.add_parser("set-toc", help="Replace the table of contents/bookmarks")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--toc", required=True, help='JSON: [[level, title, page], ...]')

    p = subparsers.add_parser("grayscale", help="Rasterize every page to grayscale")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--dpi", type=int, default=200)

    p = subparsers.add_parser("remove-blank-pages", help="Delete pages with no text, images, or drawings")
    p.add_argument("input")
    p.add_argument("output")

    p = subparsers.add_parser("unify-page-size", help="Fit every page onto one uniform page size")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--width", type=float, required=True)
    p.add_argument("--height", type=float, required=True)

    p = subparsers.add_parser("strip-text", help="Find and permanently remove matching text (e.g. a text watermark)")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--text", required=True)

    args = parser.parse_args()

    if args.command == "convert":
        convert(args.input, args.output, args.start, args.end)
    elif args.command == "to-images":
        to_images(args.input, args.out_dir, args.format, args.dpi)
    elif args.command == "from-images":
        from_images(args.output, args.images)
    elif args.command == "compress":
        compress(args.input, args.output)
    elif args.command == "watermark":
        watermark(args.input, args.output, args.text, args.opacity, args.font_size, args.angle)
    elif args.command == "page-numbers":
        page_numbers(args.input, args.output, args.start, args.position)
    elif args.command == "encrypt":
        encrypt(args.input, args.output, args.user_password, args.owner_password)
    elif args.command == "decrypt":
        decrypt(args.input, args.output, args.password)
    elif args.command == "redact":
        redact(args.input, args.output, args.regions)
    elif args.command == "split":
        split(args.input, args.out_dir, args.pages_per_file)
    elif args.command == "extract-text":
        extract_text(args.input, args.output)
    elif args.command == "extract-images":
        extract_images(args.input, args.out_dir)
    elif args.command == "get-metadata":
        get_metadata(args.input)
    elif args.command == "set-metadata":
        set_metadata(args.input, args.output, args.title, args.author, args.subject, args.keywords)
    elif args.command == "get-toc":
        get_toc(args.input)
    elif args.command == "set-toc":
        set_toc(args.input, args.output, args.toc)
    elif args.command == "grayscale":
        grayscale(args.input, args.output, args.dpi)
    elif args.command == "remove-blank-pages":
        remove_blank_pages(args.input, args.output)
    elif args.command == "unify-page-size":
        unify_page_size(args.input, args.output, args.width, args.height)
    elif args.command == "strip-text":
        strip_text(args.input, args.output, args.text)


if __name__ == "__main__":
    main()
