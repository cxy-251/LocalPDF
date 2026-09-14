import argparse
import json
import sys
from pathlib import Path

from pdf2docx import Converter


def emit(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)


def convert(input_path: str, output_path: str, start: int | None, end: int | None) -> None:
    src = Path(input_path)
    if not src.exists():
        emit("error", message=f"input file not found: {input_path}")
        sys.exit(1)

    emit("start", input=str(src), output=output_path)
    try:
        cv = Converter(str(src))
        cv.convert(output_path, start=start or 0, end=end)
        cv.close()
    except Exception as exc:
        emit("error", message=str(exc))
        sys.exit(1)

    emit("done", output=output_path)


def main() -> None:
    parser = argparse.ArgumentParser(prog="pdf-engine")
    subparsers = parser.add_subparsers(dest="command", required=True)

    convert_parser = subparsers.add_parser(
        "convert", help="Convert a PDF into an editable Word document"
    )
    convert_parser.add_argument("input", help="Path to the source PDF file")
    convert_parser.add_argument("output", help="Path to write the resulting .docx file")
    convert_parser.add_argument(
        "--start", type=int, default=None, help="0-indexed first page to convert"
    )
    convert_parser.add_argument(
        "--end", type=int, default=None, help="0-indexed page to stop before"
    )

    args = parser.parse_args()

    if args.command == "convert":
        convert(args.input, args.output, args.start, args.end)


if __name__ == "__main__":
    main()
