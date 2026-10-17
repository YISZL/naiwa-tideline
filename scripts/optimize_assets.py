import argparse
from pathlib import Path

from PIL import Image


ASSET_DIR = Path(__file__).resolve().parents[1] / "dist" / "assets"
MAX_EDGE = 640
WEBP_QUALITY = 70


def optimize(source: Path, target: Path) -> None:
    temporary = target.with_name(f"{target.stem}.tmp{target.suffix}")
    output = temporary if source == target else target

    with Image.open(source) as image:
        image = image.convert("RGBA")
        image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
        image.save(output, "WEBP", quality=WEBP_QUALITY, method=6, exact=True)

    if source == target:
        temporary.replace(target)

    print(f"{source.name} -> {target.name}: {target.stat().st_size} bytes")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create lightweight WebP game artwork.")
    parser.add_argument(
        "--recompress-webp",
        action="store_true",
        help="Resize and recompress the existing WebP files in place.",
    )
    args = parser.parse_args()

    sources = ASSET_DIR.glob("*.webp" if args.recompress_webp else "*.png")
    for source in sources:
        target = source if args.recompress_webp else source.with_suffix(".webp")
        optimize(source, target)


if __name__ == "__main__":
    main()
