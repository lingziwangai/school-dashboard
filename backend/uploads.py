"""图片上传处理：校验、压缩、去 EXIF。

安全要点：
- 文件名由服务端生成（uuid），绝不使用客户端提供的文件名。
- 按 magic bytes 判断类型，只放行 Pillow 能当位图打开的格式；
  SVG 带脚本、Pillow 也打不开，自然被挡在外面。
- 一律重编码成 JPEG：动画变成静态图，EXIF 全部丢掉，恶意内容没有落脚点。
- 剥离 EXIF：学校活动照片常带 GPS，属隐私雷区。
"""
from __future__ import annotations

import io
import uuid
from pathlib import Path

from PIL import Image, ImageFile, UnidentifiedImageError

from .db import MEDIA_DIR, now_iso

ImageFile.LOAD_TRUNCATED_IMAGES = True
Image.MAX_IMAGE_PIXELS = 80_000_000

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_DIMENSION = 1600

# Pillow 报出来的格式名 -> 收下以后存成什么。
# MPO / MPO2 是苹果手机拍的照片用的容器：文件名后缀是 .jpg/.PNG，里面第一个
# 画面其实就是普通 JPEG，但 Pillow 报的名字是 "MPO"，以前不在名单里，
# 于是老被说成「格式不对」。现在按 JPEG 收。
ACCEPTED_FORMATS = {
    "JPEG": "image/jpeg",
    "MPO": "image/jpeg",
    "MPO2": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
    "BMP": "image/bmp",
    "TIFF": "image/tiff",
    "GIF": "image/gif",
    "AVIF": "image/avif",
}

# 遇到这些格式就直接告诉用户怎么办，别只丢一句「格式不对」
FORMAT_HINTS = {
    "HEIC": "这是 iPhone 的 HEIC 格式。请在 macOS 上双击打开，再「文件→导出为→JPEG」，或者直接把截图发上来。",
    "HEIF": "这是 iPhone 的 HEIC 格式。请在 macOS 上双击打开，再「文件→导出为→JPEG」，或者直接把截图发上来。",
    "PDF": "这个是 PDF，不是图片。请先在预览里导出成图片，或者发截图。",
}


class UploadError(Exception):
    pass


def _sniff(fmt: str) -> str:
    mime = ACCEPTED_FORMATS.get(fmt)
    if mime is not None:
        return mime
    hint = FORMAT_HINTS.get(fmt, "")
    name = fmt or "未知"
    raise UploadError(
        f"看不懂的图片格式「{name}」。{hint}"
        "请换成 JPG / PNG / WebP 再上传（macOS 上双击图片→另存为→JPEG）。"
    )


def save_image(raw: bytes, original_name: str = "") -> dict:
    if not raw:
        raise UploadError("文件是空的")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise UploadError("图片太大了，请压缩到 8MB 以内")

    try:
        probe = Image.open(io.BytesIO(raw))
        fmt = (probe.format or "").upper()
        probe.verify()
    except (UnidentifiedImageError, OSError):
        raise UploadError("这不是一张有效的图片（文件可能损坏了）")
    except Image.DecompressionBombError:
        raise UploadError("图片像素太大了，请压缩后再上传")

    _sniff(fmt)

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError):
        raise UploadError("图片读取失败，请换一张试试")
    except Image.DecompressionBombError:
        raise UploadError("图片像素太大了，请压缩后再上传")

    # 统一转成 RGB（PNG 的透明通道转成白色底）
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img, mask=img.split()[-1])
        img = background
    elif img.mode != "RGB":
        img = img.convert("RGB")

    if max(img.size) > MAX_DIMENSION:
        ratio = MAX_DIMENSION / max(img.size)
        img = img.resize(
            (max(1, int(img.width * ratio)), max(1, int(img.height * ratio))),
            Image.LANCZOS,
        )

    # 重新编码即等于丢掉 EXIF
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=82, optimize=True)
    data = out.getvalue()

    filename = f"{uuid.uuid4().hex}.jpg"
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    path = MEDIA_DIR / filename
    path.write_bytes(data)

    return {
        "filename": filename,
        "path": str(path),
        "mime": "image/jpeg",
        "width": img.width,
        "height": img.height,
        "bytes": len(data),
        "original_name": original_name,
        "created_at": now_iso(),
    }


def media_path(filename: str) -> Path:
    """只允许访问 media 目录下的文件名，防止路径穿越。"""
    safe = Path(filename).name
    if safe != filename or not safe:
        raise UploadError("非法的文件名")
    return MEDIA_DIR / safe
